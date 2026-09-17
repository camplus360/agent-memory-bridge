# OpenCode adapter

A capture-only OpenCode plugin. It talks directly to the claude-mem worker over HTTP (pure Node/Bun built-in `fetch`, zero dependencies) and never summarizes locally — the worker at `127.0.0.1:37701` does summarization, embeddings and vector search.

## Files

| File | Purpose |
|---|---|
| `index.js` | The plugin (`export default { id, server }`) |
| `index.test.js` | Unit tests (run with `bun run index.test.js` or `node index.test.js`) |
| `package.json` | Plugin package metadata |

## Captured events

- `chat.message` — user message -> session init; assistant reply -> observation
- `tool.execute.after` — tool calls (name + input/output) -> observation
- `session.idle` — trigger worker summarization (polled, with toast feedback)
- `session.deleted` — clear local session maps
- `tool.claude_mem_search` — recall tool, proxies `GET /api/search/observations`

POSTs use exponential backoff (up to 3 tries: 2s / 4s / 8s) so a transient worker hiccup or rate limit does not drop observations. Every payload is tagged `platformSource: "opencode"`.

## Enable

Add this directory to the `"plugin"` array of `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "/ABS/PATH/agent-memory-bridge/agents/opencode"
  ]
}
```

Restart opencode; on load it logs `[claude-mem] capture plugin loading`.

**Double-capture pitfall:** remove the official shim `./plugins/claude-mem.js` from the `plugin` array — keep exactly one memory plugin.

See [`../../docs/INSTALL.md`](../../docs/INSTALL.md) §3.1 for the copy-based alternative.

## License

[MIT](../../LICENSE). This is an **independent implementation** written against
the public OpenCode plugin contract and the claude-mem worker HTTP protocol; it
contains no source copied from the official claude-mem OpenCode plugin. It only
interoperates, over local HTTP, with the separately installed Apache-2.0-licensed
claude-mem worker (which is not bundled here). See the root [NOTICE](../../NOTICE).
