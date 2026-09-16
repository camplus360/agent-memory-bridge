#!/usr/bin/env bash
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
WORKER_SH="${CLAUDE_MEM_WORKER_SH:-$HOME/.local/share/claude-mem/claude-mem-worker.sh}"

if [ ! -f "$WORKER_SH" ]; then
  WORKER_SH="$SCRIPT_DIR/claude-mem-worker.sh"
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
echo "worker script: $WORKER_SH"
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

# ---------- 2. Hermes injection points ----------
echo "[2] Simulate the Hermes engine.py injection points"
"$WORKER_SH" init hermes "hermes-test-$$" "$(pwd)" "hermesproj" "hermes first message"
"$WORKER_SH" observation hermes "hermes-test-$$" "Hermes assistant reply" "$(pwd)" assistant_message hermes
"$WORKER_SH" summarize hermes "hermes-test-$$" "Hermes done" hermes
echo "    -> called init/observation/summarize"
echo

# ---------- 3. Generic subcommands ----------
echo "[3] Verify health / search subcommands"
"$WORKER_SH" health >/dev/null 2>&1 && echo "    -> health fired"
"$WORKER_SH" search "hook test" 3 >/dev/null 2>&1 && echo "    -> search fired"
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
