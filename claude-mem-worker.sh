#!/usr/bin/env bash
#
# Unified claude-mem worker client (single source of truth)
# ============================================================
# Every "shell-callable" agent (CodeBuddy / Hermes / any hook-based agent
# that can only execute external commands) calls THIS script, which talks
# to the claude-mem worker HTTP API (default 127.0.0.1:37701).
#
# This avoids each agent re-implementing curl logic and the protocol
# drifting. Agents with native HTTP clients (opencode / pi) use their own
# plugins, but the protocol fields stay identical (see agents/*/).
#
# Protocol (aligned with claude-mem SessionRoutes.ts):
#   POST /api/sessions/init         { contentSessionId, project?, prompt?, platformSource? }
#   POST /api/sessions/observations { contentSessionId, tool_name, tool_input?, tool_response?, cwd?, platformSource?, agentType? }
#   POST /api/sessions/summarize    { contentSessionId, last_assistant_message?, platformSource? }
#   GET  /api/search/observations   ?query=&limit=
#   GET  /api/health
#
# Usage:
#   claude-mem-worker.sh init         <agent> <sessionId> [cwd] [project] [prompt]
#   claude-mem-worker.sh observation  <agent> <sessionId> <text> [cwd] [toolName] [platformSource]
#   claude-mem-worker.sh summarize    <agent> <sessionId> [lastAssistantMessage] [platformSource]
#   claude-mem-worker.sh turn         <agent> <sessionId> <transcriptPath> [cwd] [platformSource]
#   claude-mem-worker.sh search       <query> [limit]
#   claude-mem-worker.sh health
#   claude-mem-worker.sh hook         <agent>          # reads Claude Code/CodeBuddy hook JSON from stdin, auto-maps
#
# Environment (optional overrides):
#   CLAUDE_MEM_WORKER_HOST  default 127.0.0.1
#   CLAUDE_MEM_WORKER_PORT  default 37701
#   CLAUDE_MEM_HTTP_TIMEOUT curl timeout in seconds, default 8 (hooks must return fast)
#   CLAUDE_MEM_HTTP_RETRIES retry count for failed POSTs, default 2
#   CLAUDE_MEM_QUIET        set to 1 to silence stderr logging
#
set -uo pipefail

WORKER_HOST="${CLAUDE_MEM_WORKER_HOST:-127.0.0.1}"
WORKER_PORT="${CLAUDE_MEM_WORKER_PORT:-37701}"
BASE="http://${WORKER_HOST}:${WORKER_PORT}"
HTTP_TIMEOUT="${CLAUDE_MEM_HTTP_TIMEOUT:-8}"
HTTP_RETRIES="${CLAUDE_MEM_HTTP_RETRIES:-2}"

log() {
  [ "${CLAUDE_MEM_QUIET:-0}" = "1" ] && return
  echo "[claude-mem-worker] $*" >&2
}

# Exit silently when the worker is unreachable (a hook must never block the agent).
worker_unavailable() {
  log "worker unreachable (${BASE}): $1"
  exit 0
}

# POST JSON via curl with retries. JSON body is read from stdin.
# usage: echo "$json" | worker_post "/api/..."
worker_post() {
  local path="$1"
  local attempt=0
  local max=$(( HTTP_RETRIES + 1 ))
  local body
  body="$(cat)"
  while [ "$attempt" -lt "$max" ]; do
    if curl -sS -m "$HTTP_TIMEOUT" -X POST "$BASE$path" \
        -H "Content-Type: application/json" -d "$body" >/dev/null 2>&1; then
      return 0
    fi
    attempt=$(( attempt + 1 ))
    [ "$attempt" -lt "$max" ] && sleep 0.3
  done
  log "POST $path failed (retried $HTTP_RETRIES times)"
  return 1
}

# Safely build a JSON string field with jq; avoids manual quote/backslash escaping bugs.
json_str() {
  # Read raw text from stdin, trim one trailing newline (always present via heredoc/CLI),
  # then emit the JSON-encoded string literal (including quotes).
  jq -Rs 'rtrimstr("\n")'
}

# ============================================================================
# Pluggable backends: claude-mem (default) / mem0 / both
# ============================================================================
#   claude-mem : session-based, init -> observation -> summarize, LLM summary in the worker
#   mem0       : flat memory, one observation = one POST /memories
#   both       : dual-write to both memory stores
BACKEND="${CLAUDE_MEM_BACKEND:-claude-mem}"

MEM0_API_KEY="${MEM0_API_KEY:-}"                    # usually pre-set in the environment
MEM0_USER_ID="${MEM0_USER_ID:-${USER:-default}}"
MEM0_INFER="${MEM0_INFER:-true}"                    # facts extracted server-side by mem0

# Build the mem0 base URL. Note: MEM0_HOST in the environment may already carry a scheme
# (e.g. http://localhost:8000); naive concatenation would yield a malformed http://http:// URL.
if [ -n "${MEM0_BASE_URL:-}" ]; then
  MEM0_BASE="$MEM0_BASE_URL"
else
  _h="${MEM0_HOST:-localhost}"
  _h="${_h#http://}"; _h="${_h#https://}"            # strip scheme
  _h="${_h%%/*}"                                      # strip path
  _h="${_h%%:*}"                                      # strip any embedded port
  MEM0_BASE="http://${_h}:${MEM0_PORT:-8000}"
fi

# Does the current backend include mem0?
_wants_mem0() { [ "$BACKEND" = "mem0" ] || [ "$BACKEND" = "both" ]; }
# Does the current backend include claude-mem?
_wants_cmem() { [ "$BACKEND" = "claude-mem" ] || [ "$BACKEND" = "both" ]; }

# Write one message to mem0. args: role text agent sessionId
mem0_add() {
  local role="$1" text="$2" agent="${3:-unknown}" sid="${4:-}"
  local body hdr=(-H "Content-Type: application/json")
  [ -n "$MEM0_API_KEY" ] && hdr+=(-H "X-API-Key: $MEM0_API_KEY")

  body=$(python3 -c '
import json,sys
role,text,uid,aid,session,infer = sys.argv[1:7]
print(json.dumps({
    "messages": [{"role": role, "content": text}],
    "user_id": uid,
    "agent_id": aid,
    "infer": infer == "true",
    "metadata": {"session_id": session, "source": "agent-memory-bridge"}
}, ensure_ascii=False))
' "$role" "$text" "$MEM0_USER_ID" "$agent" "$sid" "$MEM0_INFER")

  curl -sS -m "$HTTP_TIMEOUT" -X POST "$MEM0_BASE/memories" \
      "${hdr[@]}" -d "$body" >/dev/null 2>&1
  return $?
}

# mem0 semantic search. args: query limit
mem0_search() {
  local q="$1" limit="${2:-5}"
  local body hdr=(-H "Content-Type: application/json")
  [ -n "$MEM0_API_KEY" ] && hdr+=(-H "X-API-Key: $MEM0_API_KEY")
  body=$(python3 -c '
import json,sys
q, limit, uid = sys.argv[1], int(sys.argv[2]), sys.argv[3]
print(json.dumps({"query": q, "top_k": limit, "filters": {"user_id": uid}}, ensure_ascii=False))
' "$q" "$limit" "$MEM0_USER_ID")
  curl -sS -m "$HTTP_TIMEOUT" -X POST "$MEM0_BASE/search" \
      "${hdr[@]}" -d "$body" 2>/dev/null
  return $?
}

# Map a claude-mem tool_name to a mem0 role
_mem0_role() {
  case "$1" in
    user_prompt|user|UserPromptSubmit) echo "user" ;;
    *) echo "assistant" ;;
  esac
}

cmd="${1:-}"; shift || true

case "$cmd" in
  init)
    # args: agent sessionId [cwd] [project] [prompt]
    agent="${1:-unknown}"; sid="${2:-}"; cwd="${3:-$(pwd)}"
    project="${4:-}"; prompt="${5:-}"
    [ -z "$sid" ] && { log "init: missing sessionId"; exit 1; }
    # mem0 has no session concept; init is a no-op for the mem0-only backend
    if [ "$BACKEND" = "mem0" ]; then
      log "mem0 backend: init is a no-op (mem0 has no session concept)"
      exit 0
    fi
    csid="${agent}-${sid}"
    json_str <<<"$csid" | {
      csid_json=$(cat)
      json_str <<<"$project" | {
        proj_json=$(cat)
        json_str <<<"$prompt" | {
          prompt_json=$(cat)
          json_str <<<"$cwd" | {
            cwd_json=$(cat)
            json_str <<<"$agent" | {
              agent_json=$(cat)
              jq -n \
                --argjson csid "$csid_json" \
                --argjson proj "$proj_json" \
                --argjson prompt "$prompt_json" \
                --argjson cwd "$cwd_json" \
                --argjson agent "$agent_json" \
                '{contentSessionId:$csid, project:($proj//""), prompt:($prompt//""), cwd:($cwd//""), platformSource:($agent)}' \
                | worker_post "/api/sessions/init" && exit 0
              exit $?
            }
          }
        }
      }
    }
    exit $?
    ;;

  observation)
    # args: agent sessionId text [cwd] [toolName] [platformSource]
    agent="${1:-unknown}"; sid="${2:-}"; text="${3:-}"
    cwd="${4:-$(pwd)}"; toolName="${5:-assistant_message}"; platform="${6:-$agent}"
    [ -z "$sid" ] && { log "observation: missing sessionId"; exit 1; }

    # mem0 backend: one observation = one POST /memories
    if _wants_mem0; then
      role="$(_mem0_role "$toolName")"
      mem0_add "$role" "$text" "$agent" "$sid" \
        && log "mem0: written ($role, ${#text} chars)" \
        || log "mem0: write failed (silently degraded)"
      [ "$BACKEND" = "mem0" ] && exit 0
      # both mode: continue through the claude-mem path
    fi

    csid="${agent}-${sid}"
    json_str <<<"$csid" | {
      csid_json=$(cat)
      json_str <<<"$text" | {
        text_json=$(cat)
        json_str <<<"$cwd" | {
          cwd_json=$(cat)
          json_str <<<"$toolName" | {
            tool_json=$(cat)
            json_str <<<"$platform" | {
              plat_json=$(cat)
              json_str <<<"$agent" | {
                agent_json=$(cat)
                jq -n \
                  --argjson csid "$csid_json" \
                  --argjson text "$text_json" \
                  --argjson cwd "$cwd_json" \
                  --argjson tool "$tool_json" \
                  --argjson plat "$plat_json" \
                  --argjson agent "$agent_json" \
                  '{contentSessionId:$csid, tool_name:$tool, tool_input:{}, tool_response:$text, cwd:($cwd//""), platformSource:$plat, agentType:$agent}' \
                  | worker_post "/api/sessions/observations" && exit 0
                exit $?
              }
            }
          }
        }
      }
    }
    exit $?
    ;;

  summarize)
    # args: agent sessionId [lastAssistantMessage] [platformSource]
    agent="${1:-unknown}"; sid="${2:-}"
    last="${3:-}"; platform="${4:-$agent}"
    [ -z "$sid" ] && { log "summarize: missing sessionId"; exit 1; }
    # mem0 already extracts facts at write time via infer; no separate summarize
    if [ "$BACKEND" = "mem0" ]; then
      log "mem0 backend: summarize is a no-op (facts extracted at write time)"
      exit 0
    fi
    csid="${agent}-${sid}"
    json_str <<<"$csid" | {
      csid_json=$(cat)
      json_str <<<"$last" | {
        last_json=$(cat)
        json_str <<<"$platform" | {
          plat_json=$(cat)
          jq -n \
            --argjson csid "$csid_json" \
            --argjson last "$last_json" \
            --argjson plat "$plat_json" \
            '{contentSessionId:$csid, last_assistant_message:($last//""), platformSource:$plat}' \
            | worker_post "/api/sessions/summarize" && exit 0
          exit $?
        }
      }
    }
    exit $?
    ;;

  turn)
    # args: agent sessionId transcriptPath [cwd] [platformSource]
    # Extract the last assistant text from a JSONL transcript -> observation + summarize
    agent="${1:-unknown}"; sid="${2:-}"; tpath="${3:-}"
    cwd="${4:-$(pwd)}"; platform="${5:-$agent}"
    [ -z "$sid" ] && { log "turn: missing sessionId"; exit 1; }
    csid="${agent}-${sid}"
    if [ -n "$tpath" ] && [ -f "$tpath" ]; then
      text=$(python3 - "$tpath" <<'PY'
import json, sys
try:
    last=None
    with open(sys.argv[1]) as f:
        for line in f:
            line=line.strip()
            if not line: continue
            try: o=json.loads(line)
            except: continue
            if o.get("type")=="assistant":
                msg=o.get("message",{})
                for b in msg.get("content",[]):
                    if b.get("type")=="text" and b.get("text","").strip():
                        last=b["text"]
    print(last or "")
except Exception:
    print("")
PY
)
      if [ -n "$text" ]; then
        "$0" observation "$agent" "$sid" "$text" "$cwd" "assistant_message" "$platform"
      fi
    fi
    "$0" summarize "$agent" "$sid" "" "$platform"
    exit 0
    ;;

  search)
    # args: query [limit]
    q="${1:-}"; limit="${2:-5}"
    [ -z "$q" ] && { log "search: missing query"; exit 1; }
    # mem0 backend uses POST /search
    if _wants_mem0; then
      mem0_search "$q" "$limit" || log "mem0: search failed"
      [ "$BACKEND" = "mem0" ] && exit 0
    fi
    enc_q=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$q")
    curl -sS -m "$HTTP_TIMEOUT" "$BASE/api/search/observations?query=$enc_q&limit=$limit" \
      || worker_unavailable "search failed"
    exit 0
    ;;

  health)
    curl -sS -m "$HTTP_TIMEOUT" "$BASE/api/health" \
      || worker_unavailable "health failed"
    exit 0
    ;;

  hook)
    # args: agent
    # Reads Claude Code / CodeBuddy hook JSON from stdin and maps it to the API.
    #
    # Claude Code style hooks pass JSON via stdin, typical fields:
    #   { hook_event_name, session_id, transcript_path, cwd,
    #     prompt (UserPromptSubmit), tool_name/tool_input/tool_response (PostToolUse) }
    #
    # Event mapping:
    #   SessionStart      -> init
    #   UserPromptSubmit  -> observation (user message)
    #   PostToolUse       -> observation (tool call)
    #   Stop              -> summarize
    agent="${1:-codebuddy}"
    raw="$(cat)"

    # Empty stdin: skip without blocking the agent
    [ -z "$raw" ] && exit 0

    # Parse JSON with python (more robust than pure shell for nesting/escaping)
    eval "$(printf '%s' "$raw" | python3 -c '
import json,sys,shlex
try:
    d=json.load(sys.stdin)
except Exception:
    print("evt="); print("sid="); print("cwd="); print("txt=")
    sys.exit(0)
evt=d.get("hook_event_name") or d.get("hookEventName") or ""
sid=d.get("session_id") or d.get("sessionId") or ""
cwd=d.get("cwd") or ""
# Extract the text to record
txt=""
if evt=="UserPromptSubmit":
    txt=d.get("prompt") or ""
elif evt in ("PostToolUse","PreToolUse"):
    ti=d.get("tool_input") or {}
    tr=d.get("tool_response") or {}
    if not isinstance(ti,str): ti=json.dumps(ti,ensure_ascii=False)
    if not isinstance(tr,str): tr=json.dumps(tr,ensure_ascii=False)
    txt="[tool:" + str(d.get("tool_name","unknown")) + "] in=" + ti + " out=" + tr
elif evt=="SessionStart":
    txt=d.get("prompt") or ""
elif evt=="Stop":
    txt=""
tn=d.get("tool_name") or "tool_use"
print("evt="+shlex.quote(evt))
print("sid="+shlex.quote(sid))
print("cwd="+shlex.quote(cwd))
print("txt="+shlex.quote(txt))
print("tool_name="+shlex.quote(tn))
')"

    [ -z "$sid" ] && { log "hook: stdin JSON missing session_id"; exit 0; }

    # Hook audit log (not affected by CLAUDE_MEM_QUIET; write failures are silent)
    HOOK_CALL_LOG="${CLAUDE_MEM_HOOK_LOG:-$HOME/.claude-mem/logs/hook-calls.log}"
    { mkdir -p "$(dirname "$HOOK_CALL_LOG")" && \
      printf '%s\tagent=%s\tevent=%s\tsession=%s\tcwd=%s\n' \
        "$(date +%Y-%m-%dT%H:%M:%S%:z)" "$agent" "$evt" "$sid" "${cwd:-$(pwd)}" >> "$HOOK_CALL_LOG"; } 2>/dev/null || true

    case "$evt" in
      SessionStart)
        # The SessionStart payload carries no user prompt (Claude/CodeBuddy style);
        # creating a session here would produce an empty prompt (the worker falls
        # back to "[media prompt]"). Session creation + prompt storage happen on
        # UserPromptSubmit, matching the native pi/opencode plugins. No upload here.
        exit 0
        ;;
      UserPromptSubmit)
        [ -z "$txt" ] && exit 0
        # init creates the session and stores the prompt in user_prompts (idempotent)
        "$0" init "$agent" "$sid" "${cwd:-$(pwd)}" "" "$txt"
        ;;
      PostToolUse)
        [ -z "$txt" ] && exit 0
        "$0" observation "$agent" "$sid" "$txt" "${cwd:-$(pwd)}" "${tool_name:-tool_use}" "$agent"
        ;;
      Stop)
        "$0" summarize "$agent" "$sid" "" "$agent"
        ;;
      *)
        # Unknown event: ignore and exit silently
        exit 0
        ;;
    esac
    exit 0
    ;;

  *)
    log "usage: claude-mem-worker.sh {init|observation|summarize|turn|search|health|hook} ..."
    exit 1
    ;;
esac
