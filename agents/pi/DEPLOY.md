# pi-agent-memory x claude-mem Deployment Guide

> Purpose: reproduce a complete pi-agent-memory + claude-mem environment on a new machine.
> Companion files: the master copy `pi-claude-mem.ts`, the sync helper `install.sh`, and the patch `pi-claude-mem.patch` (for review / cherry-pick).

---

## 1. Environment

| Component | Reference version | Typical path |
|---|---|---|
| Node.js | v24.x | `/usr/bin/node` |
| Bun | 1.4.x | `~/.bun/bin/bun` |
| pi (pi-coding-agent) | 0.84.x | `~/.npm-global/bin/pi` -> `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js` |
| pi-agent-memory | 0.3.x | `~/.pi/agent/npm/node_modules/pi-agent-memory` |
| claude-mem worker | 13.18.x | the claude-mem plugin's `scripts/worker-service.cjs` |
| claude-mem data | — | `~/.claude-mem/` (db, logs, settings) |

> **pi's real package name** is `@earendil-works/pi-coding-agent`, while pi-agent-memory's peerDependencies list `@mariozechner/pi-coding-agent`. The extension APIs are compatible and it loads fine, but make sure you install the `earendil-works` package.

> **PATH pitfall:** `~/.npm-global/bin` is not on PATH by default, so typing `pi` gives `command not found`. Run:
>
> ```bash
> export PATH="$HOME/.npm-global/bin:$PATH"   # consider adding to ~/.bashrc
> ```

---

## 2. pi configuration

### `~/.pi/agent/settings.json`

```json
{
  "theme": "dark",
  "defaultProvider": "your-provider",
  "defaultModel": "your-model",
  "defaultProjectTrust": "ask",
  "packages": [
    "npm:pi-agent-memory"
  ]
}
```

Key entries:

| Field | Value | Notes |
|---|---|---|
| `packages` | npm packages | `npm:pi-agent-memory` is this plugin; pi auto-loads it at startup |
| `defaultProvider` / `defaultModel` | provider/model | pi's own model config (unrelated to the memory plugin's LLM) |

### pi directory layout

```
~/.pi/agent/
├── settings.json              # config above
├── auth.json                  # credentials
├── models.json / models-store.json
├── npm/node_modules/          # packages installed via `pi install` (includes pi-agent-memory)
├── skills/                    # user-level skills
└── sessions/                  # session data
```

> pi-agent-memory's bundled `mem-search` skill is declared via the `pi.skills` field in the package's `package.json`
> and loaded by pi directly from the package directory — **no need** to copy it into `~/.pi/agent/skills/`.

### Package layout (pi-agent-memory)

```
pi-agent-memory/
├── package.json          # pi.extensions=["./extensions"], pi.skills=["./skills"]
├── extensions/
│   └── pi-claude-mem.ts  # <- the extension body (deployment target, overwritten by the master copy)
├── skills/
│   └── mem-search/SKILL.md
└── README.md
```

---

## 3. claude-mem configuration

### Key entries (`~/.claude-mem/settings.json`)

| Entry | Example | Notes |
|---|---|---|
| `CLAUDE_MEM_WORKER_PORT` | `37701` (a **number**) | Worker listen port; must match what the plugin resolves |
| `CLAUDE_MEM_WORKER_HOST` | `127.0.0.1` | |
| `CLAUDE_MEM_PROVIDER` | `openrouter` | AI provider (`claude` / `openrouter` / `gemini`) |
| `CLAUDE_MEM_OPENROUTER_BASE_URL` | `https://your-openai-compatible-endpoint/v1` | Any OpenAI-compatible base URL |
| `CLAUDE_MEM_OPENROUTER_MODEL` | `your-model` | |
| `CLAUDE_MEM_OPENROUTER_API_KEY` | `""` (empty) | **Must be filled**, otherwise AI summarization does not work |
| `CLAUDE_CODE_PATH` | `""` (empty) | If using the claude provider, point it at the claude executable |
| `CLAUDE_MEM_DATA_DIR` | `/home/yourname/.claude-mem` | |
| `CLAUDE_MEM_CHROMA_ENABLED` | `true` | Vector retrieval |
| `CLAUDE_MEM_CHROMA_PORT` | `8000` | |
| `CLAUDE_MEM_QUEUE_ENGINE` | `sqlite` | |
| `CLAUDE_MEM_MODE` | `code` | |

### Two mandatory configuration constraints

1. **settings.json must be valid JSON** — no `//` comments.
   claude-mem itself parses JSONC and tolerates comments, but pi-agent-memory uses standard `JSON.parse`;
   on parse failure it silently falls back to the default port 37777.

2. **Write `CLAUDE_MEM_WORKER_PORT` as a number** (`37701`, not `"37701"`).
   The original plugin's type check requires `number`; a string triggers the fallback. (The master copy fixes this,
   but keeping the numeric form stays compatible with unpatched versions.)

---

## 4. Deploy from scratch

### Step 1: install pi

```bash
npm install -g @earendil-works/pi-coding-agent
export PATH="$HOME/.npm-global/bin:$PATH"
pi --version          # should print your installed version
```

### Step 2: install claude-mem and start the worker

```bash
npx claude-mem install
# confirm the worker is up:
ss -tlnp | grep bun
curl -s http://127.0.0.1:37701/api/health
```

Record the worker's actual port (**usually not 37777**):

```bash
grep -E "CLAUDE_MEM_WORKER_(PORT|HOST)" ~/.claude-mem/settings.json
```

### Step 3: configure the claude-mem AI provider

Choose one:

```bash
# A. openrouter / any OpenAI-compatible endpoint
#    edit ~/.claude-mem/settings.json and fill CLAUDE_MEM_OPENROUTER_API_KEY + BASE_URL + MODEL

# B. claude provider — install the CLI first
npm install -g @anthropic-ai/claude-code@latest
# and/or set CLAUDE_CODE_PATH in settings.json
```

**Without a provider, AI summarization and memory compression are all skipped** — the worker is reachable but produces no memories.

Restart the worker for the config to take effect.

### Step 4: install the plugin

```bash
pi install npm:pi-agent-memory
```

Confirm `npm:pi-agent-memory` appears in the `packages` array of `~/.pi/agent/settings.json`.

### Step 5: sync the master copy (apply local fixes)

```bash
cd agent-memory-bridge/agents/pi
./install.sh sync        # pi-claude-mem.ts -> the pi deployment location
./install.sh status      # confirm synced
```

Sync target:

```
~/.pi/agent/npm/node_modules/pi-agent-memory/extensions/pi-claude-mem.ts
```

### Step 6: restart pi and verify

```bash
pi
> /memory-status
```

Expected output (enhanced master copy):

```
pi-mem: connected to worker v13.18.0 @ http://127.0.0.1:37701 (port source: settings.json)
session: pi-<project>-<ts> | project: pi-<project>
AI provider: openrouter
```

If it shows a `claude_cli` dependency-degraded warning, Step 3 was not completed.

---

## 5. Verification checklist

```bash
# 1. worker health
curl -s http://127.0.0.1:37701/api/health

# 2. actual worker port
ss -tlnp | grep bun

# 3. plugin synced
cd agent-memory-bridge/agents/pi && ./install.sh status

# 4. sessions written correctly (platform_source should be pi-agent)
node -e '
const {DatabaseSync}=require("node:sqlite");
const db=new DatabaseSync(process.env.HOME+"/.claude-mem/claude-mem.db",{readOnly:true});
console.table(db.prepare("SELECT id,project,platform_source,status FROM sdk_sessions ORDER BY id DESC LIMIT 5").all());
'

# 5. no dependency degradation
curl -s http://127.0.0.1:37701/api/health | grep -o '"degraded":[a-z]*'
# expected: "degraded":false

# 6. no queue backlog
tail -100 ~/.claude-mem/logs/claude-mem-$(date +%F).log | grep -iE "queueDepth|degraded|Claude executable"
```

---

## 6. Known pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| `/memory-status` says the worker is unreachable | Port resolution fell back to 37777 | Ensure settings.json is valid JSON and the port is numeric; or `export CLAUDE_MEM_PORT=37701`; or sync the master copy |
| Connects but produces no memory | Missing AI dependency (claude CLI not installed / empty openrouter key) | Configure a provider and restart the worker |
| Sessions stay `active`, never `completed` | Same as above — the AI generator cannot start, so summarize never runs | Same as above |
| Logs spam `/api/sessions/complete` errors | That endpoint was removed in newer worker versions | The master copy degrades silently (FIX-2) |
| Semantic search throws a chroma connection error | Chroma collection not ready | `curl "http://127.0.0.1:37701/api/chroma/status?deep=1"`; or disable `CLAUDE_MEM_CHROMA_ENABLED` |
| Typing `pi` gives command not found | `~/.npm-global/bin` not on PATH | `export PATH="$HOME/.npm-global/bin:$PATH"` |
| Plugin changes disappear | `pi install` overwrote node_modules | Re-sync with `./install.sh sync` from this directory |

---

## 7. Files and rollback

| File | Location | Notes |
|---|---|---|
| Master copy | `agents/pi/pi-claude-mem.ts` (this repo) | Source of truth |
| Patch | `agents/pi/pi-claude-mem.patch` | Convenient for review / cherry-pick |
| Auto-backup | `~/.pi/agent/npm/node_modules/pi-agent-memory/extensions/pi-claude-mem.ts.bak-<timestamp>` | Created automatically before each sync |

Roll back the plugin:

```bash
cd agent-memory-bridge/agents/pi && ./install.sh revert
```

---

## 8. Required restarts after deployment

| Component | Restart method | Notes |
|---|---|---|
| claude-mem worker | `curl -X POST http://127.0.0.1:37701/api/admin/restart` | Required after changing settings.json |
| pi | quit and relaunch manually | Required after syncing the master copy to load the new extension |

> A worker restart clears in-memory active-session objects and the pending queue — this is normal; already-persisted observations are unaffected.
