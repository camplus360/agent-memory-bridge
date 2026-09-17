# claude-mem Four-Agent Reusable Configuration Reference (verified)

> This document captures the four-agent integration configuration **verified to work on a real machine**, plus the pitfalls surfaced during troubleshooting.
> It complements `INSTALL.md` (installation flow) and `AGENT-RUNTIME-ARCH.md` (worker internals);
> this file is a **directly copyable configuration snapshot**. Check against it when deploying to a new machine.

---

## 0. Prerequisite: the worker must be healthy (the foundation of everything)

```bash
curl -s http://127.0.0.1:37701/api/health | python3 -m json.tool
# expected: status=ok, initialized=true, dependencies.degraded=false
```

**Three worker health checks** (look at these first when troubleshooting — do not suspect the wiring first):

| health field | Normal value | Meaning when abnormal |
|---|---|---|
| `ai.lastInteraction` | non-null (there are LLM call records) | null = the LLM was never called successfully |
| `dependencies.degraded` | false | true = claude CLI missing (`claude_cli setup_required`) |
| `ai.provider` | claude / openrouter / gemini | Determines which pipeline is used |

**Required worker config (two mutually exclusive options; see §5 of AGENT-RUNTIME-ARCH.md):**
- Option 1 claude (default): install Claude Code and point `CLAUDE_CODE_PATH` at the absolute path of the claude binary
- Option 2 openrouter/gemini: no claude CLI dependency; configure key + model

```json
// ~/.claude-mem/settings.json (key entries; the rest can stay default)
{
  "CLAUDE_MEM_RUNTIME": "worker",
  "CLAUDE_MEM_WORKER_PORT": 37701,
  "CLAUDE_MEM_WORKER_HOST": "127.0.0.1",
  "CLAUDE_MEM_PROVIDER": "claude",
  "CLAUDE_CODE_PATH": "/home/yourname/.npm-global/bin/claude",
  "ANTHROPIC_BASE_URL": "https://your-gateway.example.com/api/plan",
  "ANTHROPIC_AUTH_TOKEN": "<your-token>"
}
```

---

## 1. opencode (native plugin, recommended option)

**Effective file:** `~/.config/opencode/opencode.json` -> the `"plugin"` array

```json
{
  "plugin": [
    "/ABS/PATH/agent-memory-bridge/agents/opencode"
  ]
}
```

| Pitfall | Explanation |
|---|---|
| Double capture | Remove the official `./plugins/claude-mem.js`; keep only this plugin |
| Export shape | Must be `export default { id, server }` (the PluginModule contract) |
| Load verification | On startup it should log `[claude-mem] capture plugin loading` |
| Restart | opencode must be restarted to reload after changing config |

**Captured events:** `chat.message` (user -> init, assistant -> observation), `tool.execute.after` (tool results), `session.idle` (summarize).

---

## 2. CodeBuddy (hook mode — location is the critical part)

**Effective file:** the **`"hooks"` field of `~/.codebuddy/settings.json`** (not a standalone hooks.json!)

```json
{
  "hooks": {
    "SessionStart":     [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABS>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABS>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "PostToolUse":      [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABS>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }],
    "Stop":             [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 <ABS>/claude-mem-worker.py hook codebuddy", "timeout": 10000 }] }]
  }
}
```
`<ABS>` = the machine's absolute path to `claude-mem-worker.py` (e.g. `/home/yourname/.local/share/claude-mem/claude-mem-worker.py`).

| Pitfall | Explanation |
|---|---|
| Effective location | **the `hooks` field of settings.json**; a standalone `~/.codebuddy/hooks.json` is not read |
| JSON validity | settings.json must be valid JSON with **no comments** (remove the example's `_comment` before merging) |
| Event mapping | SessionStart->init; UserPromptSubmit->observation(user); PostToolUse->observation(tool); Stop->summarize |
| Three-layer shape | Must be `event name -> matcher -> hooks[]`; a flat shape never fires |
| Double capture | Remove the MCP-based memory integration; keep only the hook version |

---

## 3. pi (native extension, local-path package)

**Effective:** the `packages` array of `~/.pi/agent/settings.json` contains the absolute path to this repo's `agents/pi` directory. The package's `pi.extensions` manifest points at `extensions/pi-claude-mem.ts`, which pi loads directly from the repo — no copy, no sync step.

```bash
# Install pi (the real package name)
npm install -g @earendil-works/pi-coding-agent
export PATH="$HOME/.npm-global/bin:$PATH"

# Register the memory extension as a local-path package (from a clone of this repo)
cd agent-memory-bridge/agents/pi
pi install "$PWD"

# Verify (restart pi first)
pi > /memory-status
# expected: connected to worker v13.18.0 @ http://127.0.0.1:37701
```

By default the extension spawns the unified `claude-mem-worker.py` shim for every
worker call (`CLAUDE_MEM_TRANSPORT=py`); set `CLAUDE_MEM_TRANSPORT=http` to use the
legacy in-process fetch. See [`agents/pi/DEPLOY.md`](../agents/pi/DEPLOY.md).

| Pitfall | Explanation |
|---|---|
| Port | Verified 37701 (not 37777); the extension accepts a number or string in settings.json |
| Reload | Editing the `.ts` or the `packages` path requires quitting and relaunching pi (the extension loads once at startup) |
| Provider | If the worker has no LLM configured -> it connects but produces no memory |

---

## 4. Hermes (gateway injection)

**Effective:** `_capture_claude_mem_turn` in `hermes-agent/gateway/run_turn.py` (not hermes-hudui/engine.py!).

**Hermes has two capture points:**
1. `hermes-hudui/backend/chat/engine.py` -> `_capture_turn_claude_mem` (Web UI)
2. `hermes-agent/gateway/run_turn.py` -> `_capture_claude_mem_turn` (**the message gateway actually running**)

**Both places must be patched**; fixing only one leaves the other producing data. The running entry is `hermes_cli.main gateway run` (`hermes-gateway.service`), which loads run_turn.py.

**Capture key point** (subprocess call inside run_turn.py):
```python
if str(user_content or "").strip():        # init only when non-empty
    subprocess.run([sys.executable, CLAUDE_MEM_WORKER_PY, "init", "hermes", session_id, cwd, "",
                    str(user_content)], ...)   # 5th arg = prompt; if omitted the worker falls back to [media prompt]
```

| Pitfall | Explanation |
|---|---|
| Missing prompt | Omitting init's 5th positional argument -> the worker falls back to `[media prompt]` |
| Empty init | No user text means no session is created (`if user_content.strip()`) |
| Service restart | After editing run_turn.py you **must restart** `hermes-gateway.service`; the agent cannot restart the gateway itself — do it from an external terminal |
| Verification entry point | `_capture_claude_mem_turn` only fires asynchronously after a gateway turn ends; the `hermes chat -q` CLI does not pass through it — do not use that to verify |

---

## 5. Quick acceptance checklist (four-agent full chain)

```sql
-- In ~/.claude-mem/claude-mem.db, check the latest triplet (epoch is milliseconds; divide by 1000)
SELECT 'user_prompt', max(datetime(created_at_epoch/1000,'unixepoch','+8 hours'))
  FROM user_prompts WHERE content_session_id LIKE 'opencode-%'
UNION ALL SELECT 'observation', max(datetime(created_at_epoch/1000,'unixepoch','+8 hours'))
  FROM observations WHERE project='opencode';
-- Same for codebuddy/pi/hermes; hermes/codebuddy observations often have project='unknown'
```

**General rules:**
- user_prompts are fine but observations/summaries do not grow -> the worker LLM path is broken (check CLAUDE_CODE_PATH / health.degraded)
- `[media prompt]` appears -> some agent sent an empty init (identify it from the user_prompts prefix)
- Post-restart increment assertion: `SELECT count(*) FROM user_prompts WHERE prompt_text LIKE '%[media prompt]%' AND created_at_epoch > <restart-time-ms>` should be 0

---

## 6. Verified results

| Agent | Integration | user_prompt | observation | summary | Status |
|---|---|---|---|---|---|
| opencode | plugin | recorded | ✅ | ✅ | ✅ |
| codebuddy | hook | recorded | ✅ | init passed | ✅ |
| pi | extension | recorded | ✅ | — | ✅ |
| hermes | gateway | recorded | ✅ | ✅ | ✅ |

After the fixes, the `[media prompt]` increment was **0**. Two fixes: (1) empty init in run_turn.py; (2) the worker's CLAUDE_CODE_PATH.
