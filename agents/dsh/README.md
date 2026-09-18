# @camplus360/agent-memory-bridge-dsh

A capture-only memory adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).
It is the **dsh adapter** of the [agent-memory-bridge](../../../README.md) project and connects a running
`dsh` agent to the shared, locally hosted **claude-mem worker**, so conversations and tool use are
remembered across sessions and shared with every other supported engine (Claude Code, pi, opencode, …).

The adapter only **captures and sends**. Summarization, embedding, and hybrid (FTS5 + vector) search all
stay inside the claude-mem worker; this package performs none of that itself.

## How it works

The plugin is a standard Cordis function plugin (`export default function (ctx, config)`) written against
the installed dsh 0.1.1-rc.2 event/tool contract. It subscribes to the durable `session/event` firehose
(`ctx.on("session/event", (session, event) => …)`, where `event = { type, seq, time, data }`):

```text
dsh (Cordis)
  session/event
    turn/start        local per-session state only
    user/message       POST /api/sessions/init          (once, carries the real human prompt)
    assistant/message  POST /api/sessions/observations   (assistant reply text)
    tool/call          cache { name, arguments } by callId
    tool/result        POST /api/sessions/observations   (tool name + input + result text)
    turn/end           POST /api/sessions/summarize      (worker summarizes + embeds)
  agent/pre-step (waterfall)
                     GET  /api/context/inject           (injected as one extra recall message)
  memory_recall tool
                     GET  /api/search                   (cross-engine hybrid recall)
                         │
                         ▼
        local claude-mem worker (default http://127.0.0.1:37701)
        SQLite (FTS5) + vector store, shared across engines
```

Notes:

- `user/message` events with `source.kind` other than `"user"` (tool results and this plugin's own injected
  recall context) are never used as the init prompt, so injected memory text cannot be mistaken for a human
  prompt.
- The plugin's own `memory_recall` results are not re-recorded, preventing a capture feedback loop.
- Observation POSTs are fire-and-forget and retried with exponential backoff (`0.5s, 1s, 2s, 4s`, four
  tries); init/summarize are awaited. If the worker is not running, capture is skipped silently rather than
  blocking the agent.
- Every payload is tagged `platformSource: "dsh"`.
- Zero runtime dependencies — only Node's built-in `fetch` (and `node:crypto`).

## Prerequisites

A claude-mem worker must be running and reachable:

```bash
curl -s http://127.0.0.1:37701/api/health   # "status":"ok"
```

## Install

`dsh plugin` is a thin pnpm forwarder into the chosen profile. Add the package to a profile with:

```bash
dsh plugin --profile <name> add @camplus360/agent-memory-bridge-dsh
```

For local development you can install this directory directly (pnpm resolves a path/tarball/git spec to the
real package name):

```bash
dsh plugin --profile <name> add /absolute/path/to/agent-memory-bridge/agents/dsh
```

Then restart dsh with that profile; on load it logs:

```text
[@camplus360/agent-memory-bridge-dsh] loaded → claude-mem worker at http://127.0.0.1:37701
```

The memory adapter is a plain Cordis plugin (not a profile *bundle* patch), so it is activated by the
profile's plugin configuration the same way any third-party dsh plugin is.

## Configuration

All configuration is optional; sensible defaults are built in.

| Variable / config key | Default | Meaning |
|---|---|---|
| `CLAUDE_MEM_HOST` | `127.0.0.1` | Worker host (also accepts `CLAUDE_MEM_WORKER_HOST`) |
| `CLAUDE_MEM_PORT` | `37701` | Worker port (also accepts `CLAUDE_MEM_WORKER_PORT`) |
| `DSH_MEM_PROJECT` | `dsh-<cwd-basename>` | Override the project label used for scoping |
| `DSH_MEM_DISABLED` | unset | Set to `1` to disable the plugin |
| `config.host` / `config.port` / `config.disabled` | — | Same knobs via the Cordis plugin `config` object |

Environment variables take precedence through the `CLAUDE_MEM_HOST` / `CLAUDE_MEM_PORT` names used across
agent-memory-bridge; the worker-side `CLAUDE_MEM_WORKER_*` names are accepted as fallbacks.

## License

[MIT](../../LICENSE) — author `camplus <camplus360@163.com>`. This is an independent implementation written
against the public dsh (Cordis) plugin contract and the claude-mem worker HTTP protocol; it bundles no
third-party source. It interoperates over local HTTP with the separately installed claude-mem worker, which
is not bundled here. See the root [NOTICE](../../NOTICE).
