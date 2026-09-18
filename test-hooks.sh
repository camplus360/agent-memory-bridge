#!/usr/bin/env bash
#
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 yeah <camplus360@163.com>
#
# Hook trigger verifier
# ============================================================================
# Purpose: verify that each agent's hooks actually fire with correct fields.
# Method: start a local mock worker, simulate each agent's events, execute
#         the real hook commands, and inspect what the mock receives.
#         This bypasses AI provider rate limits (limits affect storage, not
#         hook dispatch).
#
# Usage: ./test-hooks.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOCK_PORT=37997
LOG="/tmp/claude-mem-hooktest.log"
WORKER_PY="${CLAUDE_MEM_WORKER_PY:-$HOME/.local/share/claude-mem/claude-mem-worker.py}"

if [ ! -f "$WORKER_PY" ]; then
  WORKER_PY="$SCRIPT_DIR/claude-mem-worker.py"
fi

# ---------- start the mock worker ----------
cat > /tmp/mock_worker_hooktest.py <<PY
import http.server, json, sys
OUT="$LOG"
open(OUT,"w").close()
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def do_POST(self):
        n=int(self.headers.get("Content-Length",0)); b=self.rfile.read(n).decode() if n else ""
        try: body=json.loads(b) if b else None
        except: body=b
        with open(OUT,"a") as f: f.write(json.dumps({"m":"POST","p":self.path,"body":body},ensure_ascii=False)+"\n")
        self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
        self.wfile.write(b'{"status":"ok"}')
    def do_GET(self):
        with open(OUT,"a") as f: f.write(json.dumps({"m":"GET","p":self.path},ensure_ascii=False)+"\n")
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"status":"ok"}')
http.server.HTTPServer(("127.0.0.1",$MOCK_PORT),H).serve_forever()
PY

python3 /tmp/mock_worker_hooktest.py & MOCK_PID=$!
sleep 0.8
export CLAUDE_MEM_WORKER_PORT=$MOCK_PORT
export CLAUDE_MEM_QUIET=1

echo "=== hook trigger test (mock worker :$MOCK_PORT) ==="
echo "worker script: $WORKER_PY"
echo

# ---------- 1. Run the commands from hooks.json (mimic CodeBuddy) ----------
HOOKS_FILE="${HOOKS_FILE:-$HOME/.codebuddy/hooks.claude-mem.json}"
if [ -f "$HOOKS_FILE" ] && command -v jq >/dev/null 2>&1; then
  echo "[1] Run hook commands defined in $HOOKS_FILE (with simulated CodeBuddy vars)"
  # CodeBuddy injects these variables; simulate them here
  export sessionId="cb-test-$$"
  export cwd="$(pwd)"
  export projectName="hooktest-project"
  export firstUserMessage="first user message"
  export message="a conversation message from CodeBuddy"
  export lastAssistantMessage="last assistant reply"

  # CodeBuddy / Claude Code style: event -> matcher -> hooks[].command
  # Data is delivered as stdin JSON; build a realistic payload per event
  for evt in $(jq -r '.hooks | keys[]' "$HOOKS_FILE" 2>/dev/null); do
    cmd=$(jq -r --arg e "$evt" '.hooks[$e][0].hooks[0].command // empty' "$HOOKS_FILE" 2>/dev/null)
    if [ -z "$cmd" ]; then
      echo "    -> $evt has no command configured"
      continue
    fi
    # build the payload for this event type
    case "$evt" in
      SessionStart)
        payload="{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$sessionId\",\"cwd\":\"$cwd\",\"prompt\":\"$firstUserMessage\"}"
        ;;
      UserPromptSubmit)
        payload="{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$sessionId\",\"cwd\":\"$cwd\",\"prompt\":\"$message\"}"
        ;;
      PostToolUse)
        payload="{\"hook_event_name\":\"PostToolUse\",\"session_id\":\"$sessionId\",\"cwd\":\"$cwd\",\"tool_name\":\"Write\",\"tool_input\":{\"path\":\"/tmp/t.txt\"},\"tool_response\":\"file written\"}"
        ;;
      Stop)
        payload="{\"hook_event_name\":\"Stop\",\"session_id\":\"$sessionId\",\"cwd\":\"$cwd\"}"
        ;;
      *)
        payload="{\"hook_event_name\":\"$evt\",\"session_id\":\"$sessionId\",\"cwd\":\"$cwd\"}"
        ;;
    esac
    echo "    -> fire $evt"
    printf '%s' "$payload" | CLAUDE_MEM_WORKER_PORT=$MOCK_PORT CLAUDE_MEM_QUIET=1 eval "$cmd" 2>&1 | sed 's/^/      /'
  done
else
  echo "[1] skip hooks.json test (file missing or jq unavailable)"
fi
echo

# ---------- 1b. Codex CLI hooks (real 0.142.4 stdin payload shape) ----------
echo "[1b] Run Codex hook commands from agents/codex/hooks.json.example (real payload shape)"
SCRIPT_DIR="$SCRIPT_DIR" WORKER_PY="$WORKER_PY" python3 - <<'PY'
import json, os, subprocess
sd = os.environ["SCRIPT_DIR"]; worker = os.environ["WORKER_PY"]
tpl = open(os.path.join(sd, "agents", "codex", "hooks.json.example"), encoding="utf-8").read()
tpl = tpl.replace("/ABS/PATH/agent-memory-bridge/claude-mem-worker.py", worker)
hooks = json.loads(tpl)["hooks"]
cwd = os.getcwd(); sid = "codex-hooktest-%d" % os.getpid()
payloads = {
  "SessionStart":    {"session_id": sid, "transcript_path": "/tmp/rollout.jsonl", "cwd": cwd, "hook_event_name": "SessionStart", "model": "gpt-5.5", "permission_mode": "bypassPermissions", "source": "startup"},
  "UserPromptSubmit": {"session_id": sid, "turn_id": "t1", "transcript_path": "/tmp/rollout.jsonl", "cwd": cwd, "hook_event_name": "UserPromptSubmit", "model": "gpt-5.5", "permission_mode": "bypassPermissions", "prompt": "codex hook test prompt"},
  "PostToolUse":     {"session_id": sid, "turn_id": "t1", "cwd": cwd, "hook_event_name": "PostToolUse", "tool_name": "shell", "tool_use_id": "u1", "tool_input": {"command": ["echo", "zqcodexprobe"]}, "tool_response": {"stdout": "zqcodexprobe\n", "exit_code": 0}},
  "Stop":            {"session_id": sid, "turn_id": "t1", "cwd": cwd, "hook_event_name": "Stop", "last_assistant_message": "ran echo, got zqcodexprobe"},
}
for evt in ("SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"):
    cmd = hooks[evt][0]["hooks"][0]["command"]
    p = subprocess.run(cmd, input=json.dumps(payloads[evt]), shell=True,
                       capture_output=True, text=True, env=os.environ)
    print(f"    -> fire {evt:16s} rc={p.returncode}")
    if p.returncode != 0:
        print("      stderr:", p.stderr[:200])
print("    note: SessionStart is a no-op (no POST); the other three map to init/observation/summarize")
PY
echo

# ---------- 2. Hermes injection points ----------
echo "[2] Simulate the Hermes engine.py injection points"
python3 "$WORKER_PY" init hermes "hermes-test-$$" "$(pwd)" "hermesproj" "hermes first message"
python3 "$WORKER_PY" observation hermes "hermes-test-$$" "Hermes assistant reply" "$(pwd)" assistant_message hermes
python3 "$WORKER_PY" summarize hermes "hermes-test-$$" "Hermes done" hermes
echo "    -> called init/observation/summarize"
echo

# ---------- 3. Generic subcommands ----------
echo "[3] Verify health / search subcommands"
python3 "$WORKER_PY" health >/dev/null 2>&1 && echo "    -> health fired"
python3 "$WORKER_PY" search "hook test" 3 >/dev/null 2>&1 && echo "    -> search fired"
echo

# ---------- results ----------
sleep 0.5
kill $MOCK_PID 2>/dev/null
rm -f /tmp/mock_worker_hooktest.py

echo "=== requests received by the mock worker ==="
if [ -s "$LOG" ]; then
  python3 - "$LOG" <<'PY'
import json,sys
for i,line in enumerate(open(sys.argv[1]),1):
    try: d=json.loads(line)
    except: continue
    print(f"{i:2d}. {d['m']} {d['p']}")
    b=d.get('body')
    if isinstance(b,dict):
        for k in ('contentSessionId','tool_name','platformSource','agentType','project'):
            if k in b and b[k] not in (None,''):
                print(f"      {k} = {b[k]}")
        if b.get('tool_response'): print(f"      tool_response = {str(b['tool_response'])[:60]}")
        if b.get('last_assistant_message'): print(f"      last_assistant_message = {b['last_assistant_message'][:60]}")
        if b.get('prompt'): print(f"      prompt = {b['prompt'][:60]}")
print(f"\ntotal {i} requests")
PY
  echo
  echo "PASS hooks fired correctly - mock worker received the requests above"
else
  echo "FAIL no request reached the mock worker - hooks did not fire"
fi
rm -f "$LOG"
