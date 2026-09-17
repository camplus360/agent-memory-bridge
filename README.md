# agent-memory-bridge

**One bridge that captures conversations from every AI coding agent you use and feeds them into a shared, searchable memory.**

[English](./README.md) · [简体中文](./README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0--or--later-red)](./agents/pi/LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**Mirrors —** [Gitee](https://gitee.com/camplus/agent-memory-bridge) · [GitHub](https://github.com/yeah365/agent-memory-bridge)

## Why

If you run several AI coding agents — OpenCode, CodeBuddy, pi, Hermes — each one invents its own memory capture: different hooks, different HTTP payloads, different corner cases. Maintaining four curl snippets means the protocol drifts, and one broken hook silently stops remembering anything.

**agent-memory-bridge** collapses all of that into a **single source of truth**:

- one unified script (`claude-mem-worker.py`) speaks the exact worker protocol;
- every agent has a tiny adapter that only captures events and delegates to that script;
- a failed capture **never blocks your agent** — hooks return instantly and degrade silently.

The memory backend is [claude-mem](https://github.com/thedotmack/claude-mem) (a local worker that summarizes, embeds and semantically searches conversations). A [mem0](https://github.com/mem0ai/mem0) backend is also built in, and you can dual-write to both.

## Features

- **One repository, pick your agents** — install adapters for OpenCode, CodeBuddy, pi and/or Hermes with a single `./install.sh --agent <name>`.
- **One protocol, four adapters** — session id namespacing (`<agent>-<sessionId>`) prevents cross-agent collisions; payload fields are identical everywhere.
- **Pluggable backends** — `claude-mem` (session-based, LLM summaries), `mem0` (flat, server-side fact extraction), or `both` (dual-write), switched with one environment variable.
- **Hook-safe by design** — short timeouts, retries with backoff, and a silent `exit 0` when the worker is down. Your editor never hangs on a memory call.
- **Correct JSON** — built with `jq` / `python3`, so quotes, backslashes and multiline tool output cannot corrupt a payload.
- **Tested** — the OpenCode plugin ships with 8 mocked tests covering capture, dedupe, retries and search; `test-hooks.sh` runs every shell hook against a local mock worker.

## Architecture

```mermaid
flowchart LR
    subgraph Agents
        OC[OpenCode<br/>native plugin]
        CB[CodeBuddy<br/>hooks.json]
        PI[pi<br/>local-path extension]
        HM[Hermes<br/>engine.py snippet]
    end

    OC --> W
    CB -->|hook JSON on stdin| W
    PI --> W
    HM -->|subprocess| W

    W["claude-mem-worker.py<br/>(single source of truth)<br/>init / observation / summarize / search"]

    W -->|CLAUDE_MEM_BACKEND=claude-mem| CM["claude-mem worker :37701<br/>LLM summary + embeddings"]
    W -->|CLAUDE_MEM_BACKEND=mem0| M0["mem0 :8000<br/>POST /memories + /search"]
    W -->|CLAUDE_MEM_BACKEND=both| CM
    W --> M0

    CM --> DB[("SQLite + Chroma")]
```

All four agents share **one memory store**, so something you told OpenCode can be recalled from CodeBuddy.

## Quick start

### Prerequisites

- `bash`, `curl`, [`jq`](https://jqlang.github.io/jq/), `python3`
- a running memory backend:
  - **claude-mem** (default): install and start the worker, then verify
    `curl -s http://127.0.0.1:37701/api/health` returns `"status":"ok"`;
  - **mem0** (optional): a mem0 server on port 8000.

```bash
# Gitee (faster in mainland China)
git clone https://gitee.com/camplus/agent-memory-bridge.git
# or GitHub
git clone https://github.com/yeah365/agent-memory-bridge.git
cd agent-memory-bridge
```

### Install

```bash
./install.sh --all                 # every supported agent
./install.sh --agent codebuddy     # just one
./install.sh --dry-run             # preview every action without writing
```

The installer copies `claude-mem-worker.py` to `~/.local/share/claude-mem/`, writes a `.env` / `.env.example` template, and places each chosen adapter in the agent's real config location. Override the root with `--prefix` or `CLAUDE_MEM_INSTALL_ROOT`.

### Verify

```bash
python3 ~/.local/share/claude-mem/claude-mem-worker.py health   # backend reachable
./test-hooks.sh                                              # exercise every hook with a mock worker
```

Then follow the **one-time enable step** for your agent (register the plugin, merge hooks into `settings.json`, etc.) — see [docs/INSTALL.md](./docs/INSTALL.md).

## Supported agents

| Agent | Adapter | Integration style | Via unified script |
|---|---|---|---|
| **OpenCode** | [`agents/opencode`](./agents/opencode) | native plugin with unit tests; spawns the unified `.py` shim by default | **yes** (default; `CLAUDE_MEM_TRANSPORT=http` bypasses) |
| **pi** | [`agents/pi`](./agents/pi) | native TS extension loaded as a **local-path package**; spawns the unified `.py` shim by default | **yes** (default; `CLAUDE_MEM_TRANSPORT=http` bypasses) |
| **CodeBuddy** | [`agents/codebuddy`](./agents/codebuddy) | `hooks.json` command hooks, JSON on stdin | **yes** |
| **Hermes** | [`agents/hermes`](./agents/hermes) | `engine.py` subprocess snippet | **yes** |

Agents with a native HTTP client call the worker directly; agents that can only execute external commands go through the shell wrapper. Both produce the exact same protocol.

## Choosing a memory backend

Set `CLAUDE_MEM_BACKEND` (default `claude-mem`):

| Backend | Behaviour |
|---|---|
| `claude-mem` | session lifecycle: `init` → `observation` → `summarize`; the worker runs LLM summarization |
| `mem0` | flat: one `observation` = one `POST /memories` (facts inferred server-side); `init`/`summarize` are no-ops |
| `both` | dual-write to both stores |

```bash
CLAUDE_MEM_BACKEND=mem0 python3 claude-mem-worker.py observation codebuddy s1 "..." /tmp user_prompt codebuddy
CLAUDE_MEM_BACKEND=both python3 claude-mem-worker.py search "keyword" 5
```

`mem0-worker.py` is a thin wrapper equivalent to `CLAUDE_MEM_BACKEND=mem0`. mem0 variables: `MEM0_HOST` (localhost), `MEM0_PORT` (8000), `MEM0_API_KEY` (optional), `MEM0_USER_ID` ($USER), `MEM0_INFER` (true), or a full `MEM0_BASE_URL`.

> **mem0 tenancy pitfall:** an API key is bound to a specific user view. Writes and searches must use the same view, or a stored memory will never show up in search.

## Unified script reference

```bash
python3 claude-mem-worker.py init        <agent> <sessionId> [cwd] [project] [prompt]
python3 claude-mem-worker.py observation <agent> <sessionId> <text> [cwd] [toolName] [platformSource]
python3 claude-mem-worker.py summarize   <agent> <sessionId> [lastAssistantMessage] [platformSource]
python3 claude-mem-worker.py turn        <agent> <sessionId> <transcriptPath> [cwd] [platformSource]
python3 claude-mem-worker.py search      <query> [limit]
python3 claude-mem-worker.py health
python3 claude-mem-worker.py hook        <agent>   # reads Claude Code/CodeBuddy hook JSON from stdin
```

`hook` maps stdin events automatically:

| stdin `hook_event_name` | Forwards to |
|---|---|
| `SessionStart` | ignored (the first real session is created on prompt, avoiding empty sessions) |
| `UserPromptSubmit` | `init` + prompt storage |
| `PostToolUse` | `observation` (`tool_name=<tool>`) |
| `Stop` | `summarize` |

Environment overrides: `CLAUDE_MEM_WORKER_HOST` (127.0.0.1), `CLAUDE_MEM_WORKER_PORT` (37701), `CLAUDE_MEM_HTTP_TIMEOUT` (8s), `CLAUDE_MEM_HTTP_RETRIES` (2), `CLAUDE_MEM_QUIET` (0).

## Documentation

- [docs/INSTALL.md](./docs/INSTALL.md) — full step-by-step install and per-agent enablement
- [docs/CONFIG-REFERENCE.md](./docs/CONFIG-REFERENCE.md) — copy-ready config snapshots + pitfalls per agent
- [docs/AGENT-RUNTIME-ARCH.md](./docs/AGENT-RUNTIME-ARCH.md) — the worker's two data paths (REST storage vs. Claude-CLI-based compression)
- [docs/REGRESSION-TEST-STANDARD.md](./docs/REGRESSION-TEST-STANDARD.md) — acceptance baseline: hook events, recall and summaries
- [agents/pi/DEPLOY.md](./agents/pi/DEPLOY.md) — deploying the pi local-path memory extension

> Chinese originals of the four guides are kept under [`docs/zh/`](./docs/zh).

## Roadmap

- more agent adapters (Claude Code CLI, Gemini CLI, Cursor, ...)
- a packaged release with checksums
- end-to-end tests against an ephemeral worker container

## Contributing

Issues and PRs are welcome. A new agent adapter needs only two things: capture its lifecycle events (session start, user prompt, tool calls, assistant reply, session end) and map them to the unified script or the equivalent JSON payload. Please add a mock-based test or a `test-hooks.sh` case.

## License

This is a **multi-licensed** repository (see [NOTICE](./NOTICE) for the full
component inventory):

- the unified worker client, installer, tests, and the CodeBuddy / Hermes /
  OpenCode adapters are original work under the **MIT License** — [LICENSE](./LICENSE);
- the [`agents/pi/`](./agents/pi) adapter is a derivative fork kept under
  **GNU AGPL-3.0-or-later** (it derives from the AGPL-era claude-mem /
  pi-agent-memory) — [agents/pi/LICENSE](./agents/pi/LICENSE) and
  [agents/pi/NOTICE](./agents/pi/NOTICE).

The components communicate only by spawning separate processes and over local
HTTP; they are separate programs aggregated in one repository, so the AGPL
component does not propagate to the MIT-licensed parts. The claude-mem and
mem0 workers are external Apache-2.0 programs, merely interoperated with and
not bundled in this repository.
