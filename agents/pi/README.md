# pi-claude-mem

A self-maintained memory extension for
[pi-coding-agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent).
It is a thin client for the local **claude-mem worker** HTTP API: it records
tool activity to the worker, injects relevant past context each turn, and
registers a `memory_recall` search tool. pi itself does no summarization — the
worker at `127.0.0.1:37701` handles summarization, embeddings and vector search.

> **This is a fork, not an independent reimplementation.** It derives from the
> ArtemisAI `pi-agent-memory@0.3.4` adapter, which itself derives from the
> OpenClaw plugin shipped with claude-mem. See [NOTICE](./NOTICE) for the full
> provenance and the list of modifications.

## License

**AGPL-3.0-or-later** — see [LICENSE](./LICENSE). The original copyright and
notices must be retained. Note this is stricter than the rest of
`agent-memory-bridge`, which is MIT; this `agents/pi/` subdirectory is a
self-contained AGPL-licensed component.

The claude-mem **worker backend is a separate program** (Apache-2.0) that this
extension only talks to over a local HTTP API; it is neither contained in nor
published by this package.

## Install as a local-path package

This package is `"private": true"` and is **not published to any npm registry**.
pi loads the whole directory as a local-path package, so it is never overwritten
by `pi update`.

```bash
# 1. make sure the worker is up
curl -s http://127.0.0.1:37701/api/health

# 2. install THIS directory as a local package (run from agents/pi, or pass an absolute path)
pi install "$PWD"
```

`pi install` appends the path to the `packages` array of
`~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/absolute/path/to/agent-memory-bridge/agents/pi"
  ]
}
```

Restart pi. At startup it logs the resolved worker URL, e.g.
`[pi-claude-mem] worker → http://127.0.0.1:37701 (端口来源: settings.json)`.
Then run the `/memory-status` slash command — it should report the worker
version and `degraded: false`.

### Uninstall

```bash
pi remove /absolute/path/to/agent-memory-bridge/agents/pi
```

then restart pi.

## How it works

```text
pi-coding-agent
   └── this extension (extensions/pi-claude-mem.ts)
        session start      local session id / project name
        before agent start -> POST /api/sessions/init        (with prompt)
        context            -> GET  /api/context/inject
        tool result        -> POST /api/sessions/observations (fire-and-forget)
        agent end          -> POST /api/sessions/summarize
        memory_recall tool -> GET  /api/search
        /memory-status     -> GET  /api/health
                              │
                              ▼
                local claude-mem worker (default 127.0.0.1:37701)
                SQLite (FTS5) + Chroma, shared across engines
```

Every observation is tagged `platformSource: "pi-agent"`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `CLAUDE_MEM_HOST` | `127.0.0.1` | Worker host |
| `CLAUDE_MEM_PORT` | `37777` (fallback) | Worker port; the extension also reads `CLAUDE_MEM_WORKER_PORT` from `~/.claude-mem/settings.json` (accepts both number and numeric-string) |
| `CLAUDE_MEM_DATA_DIR` | `~/.claude-mem` | Worker data dir (where `settings.json` is read from) |
| `PI_MEM_PROJECT` | derived from cwd (`pi-<dir>`) | Project grouping for observations |
| `PI_MEM_DISABLED` | — | Set to `1` to disable the extension |

Resolution order for the port: `CLAUDE_MEM_PORT` env →
`CLAUDE_MEM_WORKER_PORT` in `~/.claude-mem/settings.json` → fallback `37777`.

The runtime only imports the two peer modules pi injects
(`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`) plus Node built-ins, so
the directory needs no `node_modules`. The `@earendil-works` pi distribution
exposes compatible extension APIs and loads the package as-is.

## Modifying

Edit `extensions/pi-claude-mem.ts` in place and restart pi — there is no copy to
sync (unlike an npm-package patch workflow). Verify with `/memory-status`.

## Files

```text
extensions/pi-claude-mem.ts   extension body (event hooks + memory_recall + /memory-status)
skills/mem-search/SKILL.md    skill that guides the model to use memory_recall
package.json                  private local-package manifest (pi.extensions / pi.skills)
LICENSE                       AGPL-3.0 full text + copyright header
NOTICE                        provenance and modification list
```

For a from-scratch machine setup (installing pi, the worker and the AI provider)
see [DEPLOY.md](./DEPLOY.md).
