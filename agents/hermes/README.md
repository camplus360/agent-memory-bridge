# Hermes adapter

A Python snippet that records each Hermes conversation turn through the unified `claude-mem-worker.sh` script. It uses only `subprocess` + a background daemon thread (no `requests` dependency), runs asynchronously, and fails silently — it **never blocks the Hermes main flow**.

## Files

| File | Purpose |
|---|---|
| `engine.py.example` | Functions to paste into the Hermes engine / gateway entry point |

## Integration

Paste the snippet into Hermes' real entry point and call `hermes_capture_turn()` after each assistant turn finishes:

```python
from your.module import hermes_capture_turn

hermes_capture_turn(session_id, user_text, assistant_text)
```

Per turn it performs: `init` (user prompt) -> observation (assistant reply) -> `summarize`.

## Two mistakes to avoid

1. **Pass the raw `session_id`.** The script itself builds the content session id as `hermes-<sessionId>`; adding your own prefix produces a double `hermes-hermes-` id.
2. **Capture both sides.** Recording only assistant replies loses the user prompt and its conversational context. An empty user content skips `init` (never send an empty prompt, which the worker would store as `[media prompt]`).

## Configuration

The script path defaults to `~/.local/share/claude-mem/claude-mem-worker.sh` and can be overridden with the `CLAUDE_MEM_WORKER_SH` environment variable or the constant at the top of `engine.py.example`.

## Which entry point to patch

Depending on the deployment, Hermes may have two capture points — the Web UI engine and the message gateway (`gateway/run_turn.py`, used by `hermes gateway run`). Patch the entry your deployment actually executes and restart that service; `hermes chat -q` does not pass through the gateway path.

See [`../../docs/INSTALL.md`](../../docs/INSTALL.md) §3.4 and [`../../docs/CONFIG-REFERENCE.md`](../../docs/CONFIG-REFERENCE.md) §4.
