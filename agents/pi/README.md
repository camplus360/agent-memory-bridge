# pi adapter

Persistent cross-session memory for [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) (pi-coding-agent) via a native TypeScript extension loaded by the `pi-agent-memory` npm package. It connects to the claude-mem worker HTTP API; pi itself does no summarization.

## Files

| File | Purpose |
|---|---|
| `pi-claude-mem.ts` | Master copy of the extension (source of truth) |
| `pi-claude-mem.patch` | Same changes as a reviewable patch against the v0.3.4 original |
| `install.sh` | Syncs the master copy into pi's node_modules (with auto-backup / revert / diff / status) |
| [`DEPLOY.md`](./DEPLOY.md) | Full from-scratch deployment guide |

## Compatibility fixes over the v0.3.4 original

1. Port/host parsing accepts the string form (original required a number and silently fell back to 37777).
2. Drops the removed `/api/sessions/complete` call (degrades silently on newer workers).
3. `/memory-status` shows the worker URL, port source and dependency degradation.
4. Logs the actual worker URL at startup to diagnose port mismatches.

## Quick start

```bash
npm install -g @earendil-works/pi-coding-agent
export PATH="$HOME/.npm-global/bin:$PATH"

pi install npm:pi-agent-memory

./install.sh sync      # master copy -> ~/.pi/agent/npm/node_modules/pi-agent-memory/extensions/
./install.sh status    # confirm in sync
```

Restart pi and run `/memory-status`; it should report the worker at `http://127.0.0.1:37701`.

> **Never edit the copy inside node_modules directly** — `pi install` / package updates overwrite it. Edit `pi-claude-mem.ts` here and run `./install.sh sync`; roll back with `./install.sh revert`.

Two settings constraints (details in [`DEPLOY.md`](./DEPLOY.md)):

- `~/.claude-mem/settings.json` must be valid JSON (no comments), or the extension's `JSON.parse` fails and it falls back to 37777.
- `CLAUDE_MEM_WORKER_PORT` should be the number `37701`.
