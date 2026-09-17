# Contributing to agent-memory-bridge

Thanks for your interest in improving the bridge! It is a small, dependency-free
project, and contributions are welcome.

## Ground rules

- **Keep one protocol.** Every adapter must capture events and map them to the
  unified `claude-mem-worker.py` subcommands (or the identical JSON payload).
  Do not re-implement HTTP/retry logic inside an adapter.
- **A hook must never block the agent.** Default to short timeouts, retries with
  backoff, and a silent exit when the worker is down.
- **Build JSON safely** with `jq` / `python3` / the platform's JSON API — never
  by string concatenation of user/tool text.
- Match the existing code style (no new runtime dependencies unless essential).

## Adding a new agent adapter

An adapter only has to capture the lifecycle and map it to the unified script:

| Lifecycle event | Unified command |
|---|---|
| first user prompt | `init <agent> <sessionId> <cwd> <project> <prompt>` |
| tool call / assistant reply | `observation <agent> <sessionId> <text> <cwd> [tool] [source]` |
| turn end / idle | `summarize <agent> <sessionId> [lastAssistant] [source]` |

Namespace the session as `<agent>-<sessionId>` (the script already does this),
and add a short `README.md` under `agents/<name>/`.

## Tests

Please add coverage for new capture logic:

```bash
# OpenCode adapter unit tests (mocked fetch; needs node or bun)
node agents/opencode/index.test.js
# or: bun test agents/opencode/index.test.js

# Every shell hook against a local mock worker
./test-hooks.sh
```

The test harness starts a throwaway mock worker on port 37997 and needs
`python3` (and `jq` for the CodeBuddy hooks.json path).

## Commit / pull request

- Keep commits focused and write a clear message (`feat:`, `fix:`, `docs:`,
  `chore:` prefixes are welcome).
- Make sure `./test-hooks.sh` and the OpenCode unit tests pass before opening a PR.
- Update docs (`README.md`, `README.zh-CN.md`, `docs/`) when behavior changes.

## Developer Certificate of Origin

By contributing you certify, per the [Developer Certificate of Origin 1.1](https://developercertificate.org/),
that you have the right to license your contribution under the license of the
file you touch — MIT for repository-original files, **AGPL-3.0-or-later** for
anything under `agents/pi/`. You may acknowledge this by signing commits:

```bash
git commit -s   # adds "Signed-off-by: Your Name <email>"
```

## License of contributions

Contributions to MIT-licensed files are accepted under the MIT License;
contributions inside `agents/pi/` are accepted under AGPL-3.0-or-later, matching
each file's declared license (see [NOTICE](./NOTICE)).
