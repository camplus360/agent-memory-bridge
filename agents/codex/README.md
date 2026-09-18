# Codex CLI adapter

Codex CLI (≥ 0.131, verified on **0.142.4**) supports the same Claude-Code-style
hooks as CodeBuddy: each event runs a command and receives its payload as JSON on
**stdin**. The single command
`/usr/bin/python3 …/claude-mem-worker.py hook codex` parses that payload and
forwards it to the unified worker. No memory logic is duplicated.

## Files

| File | Purpose |
|---|---|
| `hooks.json.example` | Hook template for the four lifecycle events; the installer renders the absolute worker path and merges it into `~/.codex/hooks.json` |

## Events mapped

| Hook | Worker action |
|---|---|
| `SessionStart` | no-op (accepted, not uploaded — avoids an empty session; the session is created on the first prompt, exactly like the CodeBuddy adapter) |
| `UserPromptSubmit` | `init` (create session) + store the user prompt |
| `PostToolUse` | observation (tool name + input/output) |
| `Stop` | `summarize` (forwards `last_assistant_message`) |

Verified real Codex payload fields (0.142.4):

- `SessionStart` → `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `model`, `permission_mode`, `source`
- `UserPromptSubmit` → adds `turn_id`, `prompt`
- `PostToolUse` → adds `tool_name`, `tool_use_id`, `tool_input`, `tool_response`
- `Stop` → adds `last_assistant_message`

The generic `hook` parser in `claude-mem-worker.py` consumes these unchanged.

## Enable

1. Turn hooks on in `~/.codex/config.toml` (the installer does this for you):

   ```toml
   [features]
   hooks = true
   ```

2. Install the hook definitions into `~/.codex/hooks.json` (the installer merges
   them, preserving any hooks already there — e.g. the `herdr-agent-state.sh`
   `SessionStart` hook). The shape is `event name -> matcher group -> hooks[]`.

> Unlike CodeBuddy, Codex reads a standalone **`~/.codex/hooks.json`** directly;
> it is **not** merged into `config.toml`. `hooks.json` must be strict JSON —
> Codex uses `deny_unknown_fields`, so it cannot carry a `_comment` key.

## Hook trust (read this — it is the one real gotcha)

Non-managed command hooks **must be reviewed and trusted before they run**.
Codex records trust against a hash of the exact hook definition in
`[hooks.state]` of `config.toml`.

- **Interactive (persistent):** launch `codex`, open `/hooks`, review and trust
  the entries once. Trust survives restarts. Re-review is only requested if the
  hook definition changes (its hash changes).
- **Headless / `codex exec` (runtime only):** pass
  `--dangerously-bypass-hook-trust`. There is intentionally **no durable
  config setting** for this (upstream PR openai/codex#21768); it applies to a
  single invocation and is meant for automation that already vets its hooks.

```bash
codex exec --dangerously-bypass-hook-trust "your task"
```

The hook command runs with normal user privileges and can reach
`127.0.0.1:37701` (verified end-to-end: a Codex session produced
prompt + observation + summary in the shared store).

## Coexistence with other tools

Multiple hooks for the same event all run (concurrently); adding this adapter
does not remove existing hooks. If `~/.codex/hooks.json` already contains a
`SessionStart` hook (for example `herdr-agent-state.sh`), the installer keeps it
and adds the worker hook alongside it.

Avoid double capture: do not run a second memory integration against Codex at
the same time.

See [`../../docs/INSTALL.md`](../../docs/INSTALL.md) §3 and
[`../../docs/CONFIG-REFERENCE.md`](../../docs/CONFIG-REFERENCE.md).
