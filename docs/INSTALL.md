# Installation Guide (detailed)

> Goal: automatically capture conversation memory from **OpenCode / CodeBuddy / pi / Hermes**
> and write it into one local claude-mem worker (`127.0.0.1:37701`).
> All agents go through the unified `claude-mem-worker.py` in this repository
> (OpenCode/pi ship native reference implementations with identical fields).

---

## 0. Architecture (read this first)

```
  opencode  ─┐
  CodeBuddy ─┼─► claude-mem-worker.py (single source of truth) ─► claude-mem worker :37701 ─► SQLite + Chroma
  pi        ─┤      (init/observation/summarize)                     (summary/embedding/search)
  Hermes    ─┘
```

- The worker handles LLM summarization, embeddings, vector search and dedupe. **All four agents share one memory store.**
- Each agent only captures its conversation and calls the worker; no memory logic is duplicated.
- Session isolation: every agent is prefixed (`opencode-` / `codebuddy-` / `pi-` / `hermes-`), so identical sessionIds never collide.

---

## 1. Prerequisites: get the repo and start the worker

### 1.1 Get the code

```bash
git clone <repo-url> agent-memory-bridge
cd agent-memory-bridge
ls                      # claude-mem-worker.py  install.sh  README.md  agents/
```

### 1.2 Install and start the claude-mem worker

The worker is the memory backend and **must be running first**; otherwise every agent capture fails silently (without blocking the agent).

```bash
# Install claude-mem (if not already installed)
npx claude-mem install

# Check whether the worker is already running
systemctl --user status claude-mem-worker 2>/dev/null \
  || (curl -s -m 2 http://127.0.0.1:37701/api/health >/dev/null \
        && echo "worker already running" \
        || echo "worker not running; start it")

# Health check
curl -s http://127.0.0.1:37701/api/health
# expected: {"status":"ok","initialized":true,...,"dependencies":{"degraded":false,...}}
```

**Run it as a service (recommended)** — a systemd user unit (adjust the worker path):

```bash
# Typical path: ~/.codebuddy/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/claude-mem-worker.service <<'EOF'
[Unit]
Description=claude-mem worker
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/bun /home/yourname/.codebuddy/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs
Restart=on-failure
Environment=CLAUDE_MEM_WORKER_HOST=127.0.0.1
Environment=CLAUDE_MEM_WORKER_PORT=37701

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now claude-mem-worker
```

> **Port pitfall:** the real port is usually **not** 37777, but `37701`.
> Always trust `curl :37701/api/health`, and set `CLAUDE_MEM_WORKER_PORT: 37701`
> (a **number**, without quotes) in `~/.claude-mem/settings.json`.

> settings.json **must be valid JSON** (no `//` comments) or the pi plugin silently falls back to 37777.

> **An AI provider is required:** the worker only captures; it does not summarize until a provider is configured
> (`CLAUDE_MEM_OPENROUTER_API_KEY` etc. in `~/.claude-mem/settings.json`).
> Without it the worker is reachable but produces no memories (sessions stay `active`).

> **Agent mode requires `CLAUDE_CODE_PATH` (the biggest pitfall):** with the default
> `CLAUDE_MEM_PROVIDER=claude`, observations/summaries run through the three-layer chain
> **Agent SDK → spawned claude CLI subprocess → upstream LLM**, so the machine **must find the claude executable**.
> The worker service PATH often does not include the directory containing `claude`, causing
> `degraded=true`, error `claude_cli setup_required`, and **observations/summaries never growing**
> (user_prompts still work, which is misleading).
> Fix: add `"CLAUDE_CODE_PATH": "/absolute/path/to/claude"` to settings.json and restart the worker.
> **Full rationale and troubleshooting: [AGENT-RUNTIME-ARCH.md](./AGENT-RUNTIME-ARCH.md).**

---

## 2. Install the agent adapters

```bash
cd agent-memory-bridge
./install.sh --all        # all 4 agents
# or pick:
./install.sh --agent opencode
./install.sh --agent codebuddy
./install.sh --agent hermes
# debugging:
./install.sh --dry-run                  # print actions only
./install.sh --prefix /opt/claude-mem   # custom root (default ~/.local/share/claude-mem)
```

`install.sh` will:
1. copy `claude-mem-worker.py` into the install root (default `~/.local/share/claude-mem/`);
2. generate the `.env` template (host/port/timeouts/retries);
3. place each chosen adapter in its real location (table below).

| Agent | Install destination | Manual enable step still needed? |
|---|---|---|
| **opencode** | `~/.config/opencode/plugins/claude-mem-capture/` | yes — register the plugin in `opencode.json` (§3.1) |
| **pi** | install root `agents/pi/` (reference impl + DEPLOY.md) | yes — deploy into the npm package per DEPLOY.md (§3.3) |
| **codebuddy** | `~/.codebuddy/hooks.claude-mem.json` | yes — merge into `settings.json` (§3.2) |
| **Hermes** | install root `agents/hermes/engine.py.example` | yes — paste into engine.py event points (§3.4) |

> Overrides: `CLAUDE_MEM_WORKER_HOST` / `CLAUDE_MEM_WORKER_PORT` / `CLAUDE_MEM_INSTALL_ROOT`

---

## 3. Per-agent enablement

### 3.1 OpenCode (native plugin, unit-tested)

**Two ways to enable (option B is recommended and matches the verified setup):**

**Option B (recommended, reference this repo directly — edits take effect immediately):** add the `agents/opencode` directory to the `"plugin"` array in `~/.config/opencode/opencode.json`:

```json
{
  "plugin": [
    "/ABS/PATH/agent-memory-bridge/agents/opencode"
  ]
}
```

> Pro: editing the repo code takes effect immediately with no second copy. Con: the path must exist on each machine.

**Option A (copy into the opencode config directory):** `install.sh` already placed `index.js` (+ test/package.json) at `~/.config/opencode/plugins/claude-mem-capture/`:

```json
{
  "plugin": [
    "/home/yourname/.config/opencode/plugins/claude-mem-capture"
  ]
}
```

**Double-capture pitfall:** the official shim `~/.config/opencode/plugins/claude-mem.js` overlaps this plugin's hooks.
**Keep exactly one** — remove the official `./plugins/claude-mem.js` from the `plugin` array; never run both.

**Plugin export shape:** this plugin follows the official `PluginModule` contract: `export default { id, server }`.
If opencode does not recognize it (no `[claude-mem] capture plugin loading` log), an old/official shim is probably loaded — check the plugin array.

Restart opencode.

**Run the unit tests (optional):**

```bash
cd /ABS/PATH/agent-memory-bridge/agents/opencode
bun run index.test.js     # or: node index.test.js
```

---

### 3.2 CodeBuddy (hooks calling the worker script)

`install.sh` generates `~/.codebuddy/hooks.claude-mem.json` (the placeholder path is replaced with the real absolute path).

**Effective location (key pitfall):** CodeBuddy hooks **must be merged into the `"hooks"` field of `~/.codebuddy/settings.json`**.
A standalone `~/.codebuddy/hooks.json` (user-level) is **not read** — only settings.json counts. The `hooks.json.example` / `hooks.claude-mem.json` files are content sources, not the active location.

**Enable:** merge the `"hooks"` object from hooks.claude-mem.json into the `"hooks"` field of `~/.codebuddy/settings.json` (do not overwrite existing hooks, and remember settings.json must be **valid JSON with no comments** — delete the template's `_comment` key first).

Verified working config (four events, all pointing at the unified script):

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

`<ABSOLUTE>` is the machine's absolute path to `claude-mem-worker.py` (e.g. `/home/yourname/.local/share/claude-mem/claude-mem-worker.py`).

---

### 3.3 pi (native extension, local-path package)

pi loads the extension straight from this repo as a **local-path package** —
nothing is copied into `node_modules` and there is no sync step. Follow
[`agents/pi/DEPLOY.md`](../agents/pi/DEPLOY.md). Key points:

```bash
# 1) Install pi (the real package name is @earendil-works/pi-coding-agent)
npm install -g @earendil-works/pi-coding-agent
export PATH="$HOME/.npm-global/bin:$PATH"     # otherwise `pi` is command not found

# 2) Register this repo's agents/pi dir as a local-path package
cd agent-memory-bridge/agents/pi
pi install "$PWD"
#    confirm ~/.pi/agent/settings.json packages now contains the absolute
#    path .../agent-memory-bridge/agents/pi

# 3) Restart pi and verify (the extension loads once at startup)
pi
> /memory-status
# expected: connected to worker v13.18.0 @ http://127.0.0.1:37701
```

> Full pitfall list in `agents/pi/DEPLOY.md` (37777 fallback, settings.json validity, missing provider, etc.).

---

### 3.4 Hermes (engine.py injection)

`install.sh` generates `~/.local/share/claude-mem/agents/hermes/engine.py.example`.

**Enable:** paste the capture function into Hermes' real `engine.py` and call it at the turn event point:

```python
from your.path import hermes_capture_turn

# after one conversation turn ends
hermes_capture_turn(session_id, user_text, assistant_text)
```

The call runs on a background thread and fails silently — it **never blocks the Hermes main flow**.
Set the script's absolute path via the `CLAUDE_MEM_WORKER_PY` env var or the constant at the top of `engine.py.example`.

> Two Hermes capture points may exist depending on your deployment: the Web UI engine and the message gateway (`gateway/run_turn.py`). The gateway is the one used by `hermes gateway run`; patch the entry your deployment actually executes and restart that service.

---

## 4. Unified script reference (for any shell-based agent)

```bash
python3 claude-mem-worker.py init        <agent> <sessionId> [cwd] [project] [prompt]
python3 claude-mem-worker.py observation <agent> <sessionId> <text> [cwd] [toolName] [platformSource]
python3 claude-mem-worker.py summarize   <agent> <sessionId> [lastAssistantMessage] [platformSource]
python3 claude-mem-worker.py turn        <agent> <sessionId> <transcriptPath> [cwd] [platformSource]
python3 claude-mem-worker.py search      <query> [limit]
python3 claude-mem-worker.py health
```

`<agent>` identifies the source (`codebuddy` / `hermes` / ...) and is prepended to form `${agent}-${sessionId}`.

**Environment variables:** `CLAUDE_MEM_WORKER_HOST` (127.0.0.1) / `CLAUDE_MEM_WORKER_PORT` (37701) /
`CLAUDE_MEM_HTTP_TIMEOUT` (8s) / `CLAUDE_MEM_HTTP_RETRIES` (2) / `CLAUDE_MEM_QUIET` (0).

When the worker is unreachable the script **silently exits 0**; it never blocks an agent.

---

## 5. End-to-end verification

### 5.1 Smoke test (no real conversation needed)

```bash
W="python3 ~/.local/share/claude-mem/claude-mem-worker.py"
for a in opencode codebuddy pi hermes; do
  $W init $a s1 /tmp
  $W observation $a s1 "test text $a" /tmp assistant_message $a
  $W summarize $a s1 "" $a
done

curl -s http://127.0.0.1:37701/api/stats
# expected: sessions / observations increase
```

### 5.2 Real-conversation verification

- **opencode**: start a session, chat a little; after idle a "Memory saved" toast appears; `curl :37701/api/stats` shows observations+.
- **CodeBuddy**: one normal turn; stats should show an observation for that session.
- **pi**: `/memory-status` shows connected; check summaries grow after chatting.
- **Hermes**: after a turn, check worker stats.

### 5.3 Semantic search

```bash
curl -s "http://127.0.0.1:37701/api/search/observations?query=your-keyword&limit=5"
```

---

## 6. Troubleshooting cheat sheet

| Symptom | Cause | Fix |
|---|---|---|
| no memory from any agent | worker not started | `curl :37701/api/health` should be ok; start the worker |
| reachable but no memories | AI provider not configured | set `CLAUDE_MEM_OPENROUTER_API_KEY` etc., restart the worker |
| opencode double writes | official shim and this plugin coexist | keep one entry in the `plugin` array |
| CodeBuddy double writes | MCP version + hook version coexist | keep the hook version only |
| pi fails connecting to 37777 | invalid settings.json / string port | valid JSON + numeric port 37701 |
| `pi` command not found | `~/.npm-global/bin` not in PATH | `export PATH="$HOME/.npm-global/bin:$PATH"` |
| hook command errors | placeholder path not replaced / wrong var names | check the path in `hooks.claude-mem.json`; adapt to CodeBuddy's actual variables |

---

## 7. Uninstall / reinstall

```bash
# Reinstall the unified script (overwrite)
./install.sh --agent codebuddy --prefix ~/.local/share/claude-mem

# opencode: remove the plugin dir from the plugin array in opencode.json
# CodeBuddy: remove the matching command from settings.json hooks
# pi:        pi remove /abs/path/agent-memory-bridge/agents/pi
# Hermes:    remove the injected function calls from engine.py
```
