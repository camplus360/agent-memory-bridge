# pi-claude-mem × claude-mem Deployment Guide

> Purpose: reproduce a complete pi + claude-mem environment on a new machine and
> load this directory as pi's memory extension.
> This package is a **local-path package** (not an npm registry package); there is
> no `node_modules` patch/sync step.

---

## 1. Environment

| Component | Reference version | Typical path / note |
|---|---|---|
| Node.js | v20+ (tested v24) | `node --version` |
| Bun (optional) | 1.4.x | only needed to run the OpenCode tests / build TS |
| pi | `@earendil-works/pi-coding-agent` 0.85+ | `~/.npm-global/bin/pi` |
| claude-mem worker | 13.18.x | the claude-mem plugin's `scripts/worker-service.cjs` |
| claude-mem data | — | `~/.claude-mem/` (db, logs, settings) |

> The extension's peer dependencies are named `@mariozechner/pi-coding-agent`
> and `@mariozechner/pi-ai`; the `@earendil-works` pi distribution exposes the
> same extension API and loads the package as-is.

> **PATH pitfall:** if typing `pi` gives `command not found`, add the global bin
> dir to PATH:
>
> ```bash
> export PATH="$HOME/.npm-global/bin:$PATH"   # consider adding to ~/.bashrc
> ```

---

## 2. Install pi

```bash
npm install -g @earendil-works/pi-coding-agent
export PATH="$HOME/.npm-global/bin:$PATH"
pi --version
```

pi keeps its config under `~/.pi/agent/`; the memory extension is listed in the
`packages` array of `~/.pi/agent/settings.json`.

---

## 3. Install claude-mem and start the worker

```bash
npx claude-mem install
# confirm the worker is up (default port is 37701, not the extension's 37777 fallback):
curl -s http://127.0.0.1:37701/api/health
ss -tlnp | grep -E '37701|bun'
grep -E "CLAUDE_MEM_WORKER_(PORT|HOST)" ~/.claude-mem/settings.json
```

### Configure the AI provider (required for memories to be generated)

Reachable worker + **no AI provider** means observations are stored but never
summarized. Configure one of:

```bash
# A. any OpenAI-compatible endpoint:
#    edit ~/.claude-mem/settings.json and set
#    CLAUDE_MEM_OPENROUTER_API_KEY + CLAUDE_MEM_OPENROUTER_BASE_URL + CLAUDE_MEM_OPENROUTER_MODEL

# B. claude provider — install the CLI first (or set CLAUDE_CODE_PATH):
npm install -g @anthropic-ai/claude-code@latest
```

Restart the worker after changing settings:

```bash
curl -X POST http://127.0.0.1:37701/api/admin/restart
```

### Key `~/.claude-mem/settings.json` entries

| Entry | Example | Notes |
|---|---|---|
| `CLAUDE_MEM_WORKER_PORT` | `37701` | Worker listen port |
| `CLAUDE_MEM_WORKER_HOST` | `127.0.0.1` | |
| `CLAUDE_MEM_CHROMA_ENABLED` | `true` | Vector retrieval |
| `CLAUDE_MEM_QUEUE_ENGINE` | `sqlite` | |
| `CLAUDE_MEM_MODE` | `code` | |

> `settings.json` may contain comments for claude-mem itself, but this extension
> parses it with standard `JSON.parse`; on failure it silently falls back to the
> default port `37777`. If you rely on the settings-file port, keep it valid JSON.
> The maintained extension accepts the port in **both number and string form**
> (FIX-1), so `"37701"` works here.

---

## 4. Load this extension as a local-path package

From the `agents/pi` directory of a clone of this repo:

```bash
cd /path/to/agent-memory-bridge/agents/pi
pi install "$PWD"
```

This appends the absolute path to the `packages` array:

```json
{
  "packages": [
    "/path/to/agent-memory-bridge/agents/pi"
  ]
}
```

pi reads the package manifest to find the resources:

```json
{
  "pi": { "extensions": ["./extensions"], "skills": ["./skills"] }
}
```

so both the extension and the bundled `mem-search` skill load directly from this
directory. No files are copied into `node_modules`, and `pi update` never
overwrites the code.

### Alternative: edit settings.json manually

Add the absolute path to `packages` yourself, then restart pi. Relative paths
are resolved against `~/.pi/agent/npm/`; prefer an absolute path.

---

## 5. Restart pi and verify

Launch pi. At startup it prints the resolved worker URL:

```
[pi-claude-mem] worker → http://127.0.0.1:37701 (port source: settings.json)
```

Run the slash command:

```
/memory-status
```

Expected: worker v13.18.x reachable, `degraded: false`, project derived from
cwd. A `claude_cli` dependency-degraded warning means step 3's AI provider is
not configured.

The `memory_recall` tool is also registered (the `mem-search` skill tells the
model when to call it).

---

## 6. Verification checklist

```bash
# 1. worker health (look for "status":"ok", "degraded":false)
curl -s http://127.0.0.1:37701/api/health

# 2. extension is registered
grep -n 'agents/pi' ~/.pi/agent/settings.json

# 3. sessions are being written with the pi-agent source (run a pi turn first)
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.claude-mem/claude-mem.db", { readOnly: true });
console.table(db.prepare("SELECT id,project,platform_source,status FROM sdk_sessions ORDER BY id DESC LIMIT 5").all());
'
```

---

## 7. Known pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `/memory-status` says worker unreachable | Port fell back to `37777` | Keep `~/.claude-mem/settings.json` valid JSON; or `export CLAUDE_MEM_PORT=37701` |
| Connects but produces no memory | No AI provider configured | Configure an OpenAI-compatible endpoint or the claude CLI, then restart the worker |
| Sessions stay `active`, never complete | Same — the summarizer cannot start | Same as above |
| Logs spam `/api/sessions/complete` errors | That endpoint was removed in worker v12.4.4+ | This maintained fork already drops the call (FIX-2); ignore |
| Semantic search throws a chroma error | Chroma collection not ready | Check `curl "http://127.0.0.1:37701/api/chroma/status?deep=1"`, or disable `CLAUDE_MEM_CHROMA_ENABLED` |
| `pi` command not found | Global bin not on PATH | `export PATH="$HOME/.npm-global/bin:$PATH"` |
| Edits to the extension seem ignored | pi wasn't restarted, or path is relative | Use an absolute path in `packages` and restart pi |

---

## 8. Uninstall / rollback

```bash
pi remove /path/to/agent-memory-bridge/agents/pi
```

then restart pi. Because nothing is copied into `node_modules`, removing the
`packages` entry fully detaches the extension; your data in `~/.claude-mem` is
untouched.

---

## 9. Required restarts

| Component | Method | Notes |
|---|---|---|
| claude-mem worker | `curl -X POST http://127.0.0.1:37701/api/admin/restart` | After changing `settings.json` |
| pi | quit and relaunch | After installing/removing the package or editing the `.ts` |

> A worker restart clears in-memory active-session state and the pending queue;
> already-persisted observations are unaffected.
