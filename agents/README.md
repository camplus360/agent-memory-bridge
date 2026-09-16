# Agent Adapters

One adapter per agent. Every adapter **only captures conversation events and sends them to the unified `claude-mem-worker.sh` / worker**; no memory logic is duplicated. Summarization, embeddings and search all live in the claude-mem worker (`127.0.0.1:37701`).

| Directory | Agent | Integration style | Enablement |
|---|---|---|---|
| [`opencode/`](./opencode/) | OpenCode | Native plugin (`PluginModule`) | Add the directory to the `"plugin"` array of `opencode.json` |
| [`codebuddy/`](./codebuddy/) | CodeBuddy | Claude-Code-style hooks calling the worker script | Merge the `hooks` object into `~/.codebuddy/settings.json` |
| [`pi/`](./pi/) | pi (pi-coding-agent) | Native TypeScript extension (npm package) | `pi install npm:pi-agent-memory` + `./install.sh sync` |
| [`hermes/`](./hermes/) | Hermes | Python snippet injected into the engine/gateway | Paste into the engine event point |

## Session isolation

The unified script prefixes every session id with its agent, so identical ids never collide in the shared store:

```
opencode-<sessionId>   codebuddy-<sessionId>   pi-<sessionId>   hermes-<sessionId>
```

## Full documentation

- Install flow: [`../../docs/INSTALL.md`](../../docs/INSTALL.md)
- Worker internals / the `claude` CLI dependency: [`../../docs/AGENT-RUNTIME-ARCH.md`](../../docs/AGENT-RUNTIME-ARCH.md)
- Copyable config per agent: [`../../docs/CONFIG-REFERENCE.md`](../../docs/CONFIG-REFERENCE.md)
- Regression baseline: [`../../docs/REGRESSION-TEST-STANDARD.md`](../../docs/REGRESSION-TEST-STANDARD.md)
