# CodeBuddy adapter

CodeBuddy supports Claude-Code-style hooks: each event runs a command and delivers its payload as JSON on stdin. The single command `python3 claude-mem-worker.py hook codebuddy` parses that payload and forwards it to the worker.

## Files

| File | Purpose |
|---|---|
| `hooks.json.example` | Hook template; the installer renders the absolute script path into `hooks.claude-mem.json` |

## Events mapped

| Hook | Worker action |
|---|---|
| `SessionStart` | `init` (create the session) |
| `UserPromptSubmit` | observation (user prompt) |
| `PostToolUse` | observation (tool name + input/output) |
| `Stop` | `summarize` |

## Enable

The root installer produces `~/.codebuddy/hooks.claude-mem.json`. Merge its `"hooks"` object into the **`"hooks"` field of `~/.codebuddy/settings.json`** — a standalone `~/.codebuddy/hooks.json` is **not read**.

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABSOLUTE>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABSOLUTE>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABSOLUTE>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABSOLUTE>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }]
  }
}
```

Requirements:

- settings.json must be **valid JSON with no comments** — delete the template's `_comment` key before merging.
- Keep the three-layer shape `event name -> matcher -> hooks[]`; a flat shape never fires.
- Replace `<ABSOLUTE>` with the real path (the installer does this automatically).
- Avoid double capture: if an MCP-based memory integration is installed, remove it and keep the hook version only.

See [`../../docs/INSTALL.md`](../../docs/INSTALL.md) §3.2.
