# claude-mem Architecture & Deployment

> Key distinction: **the claude-mem worker has two independent pipelines — do not conflate them.**
> One only stores/retrieves data (no dependency on the claude CLI); the other does intelligent compression (depends on the claude CLI).

---

## 1. Core architecture: two pipelines

### Pipeline 1 — REST persistence (no claude CLI dependency)
Handles session initialization, receiving hook-delivered conversations, enqueueing, and persisting to SQLite / the vector store.
**It only stores and queues data; it does no summarization or fact extraction.** This part keeps working even if the `claude` executable cannot be found.

```
IDE Hook -> worker(37701) -> storage (SQLite / Chroma)
```

### Pipeline 2 — Agent intelligent compression (with `CLAUDE_MEM_PROVIDER=claude`, hard-depends on the claude CLI)
Generates observations, session summaries, fact extraction and structured XML output — **the core memory-compression logic**.

```
claude-mem worker
|  Agent SDK orchestration, spawns a subprocess
v
claude CLI (Agent Runtime: agent loop, permission control, built-in system prompt, tool flow)
|  reads environment ANTHROPIC_BASE_URL / AUTH_TOKEN
v
LLM backend (Anthropic / an ARK-compatible proxy gateway)
```

> **Important:** `ANTHROPIC_BASE_URL` only points the claude CLI at an upstream gateway; it **cannot replace the claude CLI itself**.
> Here the SDK is not a plain HTTP client — it **launches, supervises, and exchanges a stdio JSON stream** with the CLI.
> If the claude executable cannot be found -> `degraded=true`, error `claude_cli setup_required`.

> **Port:** the worker actually listens on **`37701`** (not 37777). Trust `curl :37701/api/health` returning `ok`,
> and set `CLAUDE_MEM_WORKER_PORT: 37701` in `~/.claude-mem/settings.json` (a number, without quotes).

---

## 2. Two run modes (mutually exclusive — pick one)

### Mode A: Claude Agent SDK mode (default `claude` provider)
- Capabilities: full intelligent compression, observation extraction, structured memory
- Requirements:
  - **Claude Code CLI** (`claude` binary) must be installed on the machine
  - `CLAUDE_CODE_PATH` correctly points at the claude executable
  - `claude` is on PATH, **or** `CLAUDE_CODE_PATH` is explicitly set
  - these env vars are passed to the claude subprocess: `ANTHROPIC_BASE_URL`, `AUTH_TOKEN`
- Without the claude CLI: the summary path degrades and stops working; **only ingestion stays available**

**Process signature:** the worker spawns a subprocess like:
```
claude --model xxx --output-format stream-json --permission-mode dontAsk
```

```json
{
  "CLAUDE_MEM_PROVIDER": "claude",
  "CLAUDE_CODE_PATH": "/home/yourname/.npm-global/bin/claude",
  "ANTHROPIC_BASE_URL": "https://your-gateway.example.com/api/plan",
  "ANTHROPIC_AUTH_TOKEN": "<your-token>"
}
```

### Mode B: Direct LLM mode (switch to a non-claude provider)
- Capabilities: directly calls an OpenAI-compatible endpoint over HTTP to summarize
- Dependency: **no claude CLI installation needed**
- Pairs well with OpenCode and custom model backends
- Limitation: it no longer runs the Claude Agent SDK agent loop, so there are no built-in tools or permission system

```json
{
  "CLAUDE_MEM_PROVIDER": "openrouter",
  "CLAUDE_MEM_OPENROUTER_API_KEY": "<your-key>",
  "CLAUDE_MEM_OPENROUTER_MODEL": "your/model-name",
  "CLAUDE_MEM_OPENROUTER_BASE_URL": ""
}
```
(Per the worker source, the only selectable providers are `claude` / `openrouter` / `gemini`;
`CLAUDE_MEM_OPENROUTER_API_KEY` can also be read from the `OPENROUTER_API_KEY` environment variable.)

---

## 3. Key environment variables

| Variable | Purpose | Notes |
|---|---|---|
| `CLAUDE_MEM_PROVIDER` | Selects the backend | `claude` = needs the CLI; `openrouter`/`gemini` connect directly without the CLI |
| `CLAUDE_CODE_PATH` | Path to the claude executable | Required when `claude` is not on PATH; prevents startup degradation |
| `ANTHROPIC_BASE_URL` | Upstream API address | Passed to the claude subprocess; **the worker itself does not use it to send model requests** |
| `AUTH_TOKEN` | API auth | Read by the claude CLI and sent to the upstream LLM |

---

## 4. IDE hooks (OpenCode example)

```bash
npx claude-mem install --ide opencode
```

1. Installing = registering IDE lifecycle hooks (capturing the session, user input, tool results)
2. Hooks only **grab context and post it to worker:37701**
3. OpenCode itself does no summarization/extraction and **never calls the LLM directly**

> **Common misconception:** the name "claude-mem" does **not** mean it always depends on a Claude model;
> only the `provider=claude` branch binds the claude CLI as its agent runtime.

---

## 5. Common symptoms -> root cause

| Symptom | Root cause |
|---|---|
| Queue accepts items and curl queries work, but no observation / summary is produced | The agent pipeline degraded — most likely **the claude executable cannot be found** |
| Log line `Generator auto-starting (init) using Claude SDK` | Currently on the compression branch that **spawns the claude CLI** |
| Status `degraded=true` + `claude_cli setup_required` | The worker detected a **missing claude CLI executable**, not missing API / gateway config |

Also: the log `SDK returned non-XML idle response - ignoring queued batch` is just a normal **first retry being ignored** —
the worker expects an `<observation>...</observation>` XML payload; the first attempt returns idle so it retries, and the second usually returns valid XML that gets persisted
(followed by the log `STORED | obsCount=1`). Once `CLAUDE_CODE_PATH` is set correctly the pipeline recovers; do not mistake this for a model failure.

---

## 6. Deployment pitfall checklist

**If using `CLAUDE_MEM_PROVIDER=claude`:**
- Pre-install the Claude Code CLI
- Verify `which claude`, or set `CLAUDE_CODE_PATH`
- Ensure env vars reach the subprocess (`ANTHROPIC_BASE_URL`, `AUTH_TOKEN`)

**If you do not want to maintain the claude CLI:**
- Switch the provider to an OpenAI-compatible direct mode (`openrouter` / `gemini`)
- The Agent SDK + claude subprocess pipeline is never started

**Inspect the process tree first when troubleshooting** — whether the worker spawns a claude child is the most direct evidence of which pipeline is active:
```bash
PID=$(systemctl --user show claude-mem-worker -p MainPID --value)
pstree -p $PID
```

---

## 7. One-line selection guide

- Need built-in agent extraction and XML observations -> `provider=claude`, **must deploy the claude CLI**
- Only need simple context summarization and do not want to maintain the claude CLI -> an **OpenAI-compatible direct provider**
