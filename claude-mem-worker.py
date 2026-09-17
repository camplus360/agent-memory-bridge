#!/usr/bin/env python3
#
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 yeah <camplus360@163.com>
#
# Unified claude-mem worker client (single source of truth)
# ============================================================
# Every "shell-callable" agent (CodeBuddy / Hermes / any hook-based agent
# that can only execute external commands) calls THIS script, which talks
# to the claude-mem worker HTTP API (default 127.0.0.1:37701).
#
# This avoids each agent re-implementing HTTP logic and the protocol
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
#   python3 claude-mem-worker.py init         <agent> <sessionId> [cwd] [project] [prompt]
#   python3 claude-mem-worker.py observation  <agent> <sessionId> <text> [cwd] [toolName] [platformSource]
#   python3 claude-mem-worker.py summarize    <agent> <sessionId> [lastAssistantMessage] [platformSource]
#   python3 claude-mem-worker.py turn         <agent> <sessionId> <transcriptPath> [cwd] [platformSource]
#   python3 claude-mem-worker.py search       <query> [limit]
#   python3 claude-mem-worker.py health
#   python3 claude-mem-worker.py api          <POST|GET> <path>   # generic passthrough; POST reads full JSON body from stdin
#   python3 claude-mem-worker.py hook         <agent>          # reads Claude Code/CodeBuddy hook JSON from stdin, auto-maps
#
# Environment (optional overrides):
#   CLAUDE_MEM_WORKER_HOST  default 127.0.0.1
#   CLAUDE_MEM_WORKER_PORT  default 37701
#   CLAUDE_MEM_HTTP_TIMEOUT timeout in seconds, default 8 (hooks must return fast)
#   CLAUDE_MEM_HTTP_RETRIES retry count for failed POSTs, default 2
#   CLAUDE_MEM_QUIET        set to 1 to silence stderr logging
#
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime

WORKER_HOST = os.environ.get("CLAUDE_MEM_WORKER_HOST", "127.0.0.1")
WORKER_PORT = os.environ.get("CLAUDE_MEM_WORKER_PORT", "37701")
BASE = "http://%s:%s" % (WORKER_HOST, WORKER_PORT)
HTTP_TIMEOUT = float(os.environ.get("CLAUDE_MEM_HTTP_TIMEOUT", "8"))
HTTP_RETRIES = int(os.environ.get("CLAUDE_MEM_HTTP_RETRIES", "2"))
QUIET = os.environ.get("CLAUDE_MEM_QUIET", "0") == "1"

SELF = [sys.executable, os.path.abspath(__file__)]


def log(msg):
    if QUIET:
        return
    print("[claude-mem-worker] %s" % msg, file=sys.stderr)


# Exit silently when the worker is unreachable (a hook must never block the agent).
def worker_unavailable(msg):
    log("worker unreachable (%s): %s" % (BASE, msg))
    sys.exit(0)


def _request(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    req.add_header("Content-Type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return resp.read()


# POST JSON with retries. An HTTP error status still counts as "delivered"
# (curl without -f returns success on any server response); only connection
# failures / timeouts trigger a retry. Returns True on success.
def worker_post(path, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    attempts = HTTP_RETRIES + 1
    for attempt in range(attempts):
        try:
            _request(BASE + path, data=body)
            return True
        except urllib.error.HTTPError:
            return True
        except (urllib.error.URLError, OSError):
            if attempt < attempts - 1:
                time.sleep(0.3)
    log("POST %s failed (retried %d times)" % (path, HTTP_RETRIES))
    return False


# Single-shot GET; returns raw response bytes, or None when unreachable.
def worker_get(path):
    try:
        return _request(BASE + path)
    except urllib.error.HTTPError as e:
        return e.read()
    except (urllib.error.URLError, OSError):
        return None


# ============================================================================
# Pluggable backends: claude-mem (default) / mem0 / both
# ============================================================================
#   claude-mem : session-based, init -> observation -> summarize, LLM summary in the worker
#   mem0       : flat memory, one observation = one POST /memories
#   both       : dual-write to both memory stores
BACKEND = os.environ.get("CLAUDE_MEM_BACKEND", "claude-mem")

MEM0_API_KEY = os.environ.get("MEM0_API_KEY", "")
MEM0_USER_ID = os.environ.get("MEM0_USER_ID") or os.environ.get("USER", "default")
MEM0_INFER = os.environ.get("MEM0_INFER", "true")


def _build_mem0_base():
    base_url = os.environ.get("MEM0_BASE_URL")
    if base_url:
        return base_url
    h = os.environ.get("MEM0_HOST", "localhost")
    for scheme in ("http://", "https://"):
        if h.startswith(scheme):
            h = h[len(scheme):]
    h = h.split("/", 1)[0].split(":", 1)[0]
    return "http://%s:%s" % (h, os.environ.get("MEM0_PORT", "8000"))


MEM0_BASE = _build_mem0_base()


def wants_mem0():
    return BACKEND in ("mem0", "both")


def wants_cmem():
    return BACKEND in ("claude-mem", "both")


def _mem0_headers():
    headers = {"Content-Type": "application/json"}
    if MEM0_API_KEY:
        headers["X-API-Key"] = MEM0_API_KEY
    return headers


# Write one message to mem0. args: role text agent sessionId. Single attempt,
# no retries (matches the original curl call); returns True on delivery.
def mem0_add(role, text, agent="unknown", sid=""):
    payload = {
        "messages": [{"role": role, "content": text}],
        "user_id": MEM0_USER_ID,
        "agent_id": agent,
        "infer": MEM0_INFER == "true",
        "metadata": {"session_id": sid, "source": "agent-memory-bridge"},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        _request(MEM0_BASE + "/memories", data=body, headers=_mem0_headers())
        return True
    except Exception:
        return False


# mem0 semantic search. args: query limit; returns raw bytes or None.
def mem0_search(q, limit=5):
    payload = {
        "query": q,
        "top_k": int(limit),
        "filters": {"user_id": MEM0_USER_ID},
    }
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        return _request(MEM0_BASE + "/search", data=body, headers=_mem0_headers())
    except Exception:
        return None


# Map a claude-mem tool_name to a mem0 role
def mem0_role(tool_name):
    if tool_name in ("user_prompt", "user", "UserPromptSubmit"):
        return "user"
    return "assistant"


def run_self(args):
    # Return (do not swallow) the child exit code so callers can surface a
    # failed upload. Previously a failing inner init/observation/summarize was
    # hidden because the outer hook always exited 0 even when the POST failed.
    return subprocess.run(SELF + args, timeout=None).returncode


# ----------------------------------------------------------------------------
# subcommands
# ----------------------------------------------------------------------------

def cmd_init(av):
    # args: agent sessionId [cwd] [project] [prompt]
    agent = av[0] if len(av) > 0 else "unknown"
    sid = av[1] if len(av) > 1 else ""
    cwd = av[2] if len(av) > 2 else os.getcwd()
    project = av[3] if len(av) > 3 else ""
    prompt = av[4] if len(av) > 4 else ""
    if not sid:
        log("init: missing sessionId")
        sys.exit(1)
    # mem0 has no session concept; init is a no-op for the mem0-only backend
    if BACKEND == "mem0":
        log("mem0 backend: init is a no-op (mem0 has no session concept)")
        return
    payload = {
        "contentSessionId": "%s-%s" % (agent, sid),
        "project": project,
        "prompt": prompt,
        "cwd": cwd,
        "platformSource": agent,
    }
    sys.exit(0 if worker_post("/api/sessions/init", payload) else 1)


def cmd_observation(av):
    # args: agent sessionId text [cwd] [toolName] [platformSource]
    agent = av[0] if len(av) > 0 else "unknown"
    sid = av[1] if len(av) > 1 else ""
    text = av[2] if len(av) > 2 else ""
    cwd = av[3] if len(av) > 3 else os.getcwd()
    tool_name = av[4] if len(av) > 4 else "assistant_message"
    platform = av[5] if len(av) > 5 else agent
    if not sid:
        log("observation: missing sessionId")
        sys.exit(1)

    # mem0 backend: one observation = one POST /memories
    if wants_mem0():
        role = mem0_role(tool_name)
        if mem0_add(role, text, agent, sid):
            log("mem0: written (%s, %d chars)" % (role, len(text)))
        else:
            log("mem0: write failed (silently degraded)")
        if BACKEND == "mem0":
            return
        # both mode: continue through the claude-mem path

    payload = {
        "contentSessionId": "%s-%s" % (agent, sid),
        "tool_name": tool_name,
        "tool_input": {},
        "tool_response": text,
        "cwd": cwd,
        "platformSource": platform,
        "agentType": agent,
    }
    sys.exit(0 if worker_post("/api/sessions/observations", payload) else 1)


def cmd_summarize(av):
    # args: agent sessionId [lastAssistantMessage] [platformSource]
    agent = av[0] if len(av) > 0 else "unknown"
    sid = av[1] if len(av) > 1 else ""
    last = av[2] if len(av) > 2 else ""
    platform = av[3] if len(av) > 3 else agent
    if not sid:
        log("summarize: missing sessionId")
        sys.exit(1)
    # mem0 already extracts facts at write time via infer; no separate summarize
    if BACKEND == "mem0":
        log("mem0 backend: summarize is a no-op (facts extracted at write time)")
        return
    payload = {
        "contentSessionId": "%s-%s" % (agent, sid),
        "last_assistant_message": last,
        "platformSource": platform,
    }
    sys.exit(0 if worker_post("/api/sessions/summarize", payload) else 1)


def _last_assistant_text(tpath):
    last = None
    try:
        with open(tpath, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if obj.get("type") != "assistant":
                    continue
                msg = obj.get("message", {}) or {}
                for block in (msg.get("content", []) or []):
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "text" and str(block.get("text", "")).strip():
                        last = block["text"]
    except Exception:
        return ""
    return last or ""


def cmd_turn(av):
    # args: agent sessionId transcriptPath [cwd] [platformSource]
    # Extract the last assistant text from a JSONL transcript -> observation + summarize
    agent = av[0] if len(av) > 0 else "unknown"
    sid = av[1] if len(av) > 1 else ""
    tpath = av[2] if len(av) > 2 else ""
    cwd = av[3] if len(av) > 3 else os.getcwd()
    platform = av[4] if len(av) > 4 else agent
    if not sid:
        log("turn: missing sessionId")
        sys.exit(1)
    rc = 0
    if tpath and os.path.isfile(tpath):
        text = _last_assistant_text(tpath)
        if text:
            # Best-effort: a failed observation must not block summarize.
            run_self(["observation", agent, sid, text, cwd, "assistant_message", platform])
    rc = run_self(["summarize", agent, sid, "", platform])
    if rc:
        sys.exit(rc)


def cmd_search(av):
    # args: query [limit]
    q = av[0] if len(av) > 0 else ""
    limit = av[1] if len(av) > 1 else "5"
    if not q:
        log("search: missing query")
        sys.exit(1)
    # mem0 backend uses POST /search
    if wants_mem0():
        raw = mem0_search(q, limit)
        if raw is not None:
            sys.stdout.buffer.write(raw)
            sys.stdout.buffer.flush()
        else:
            log("mem0: search failed")
        if BACKEND == "mem0":
            return
    enc_q = urllib.parse.quote(q)
    raw = worker_get("/api/search/observations?query=%s&limit=%s" % (enc_q, limit))
    if raw is None:
        worker_unavailable("search failed")
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def cmd_health(av):
    raw = worker_get("/api/health")
    if raw is None:
        worker_unavailable("health failed")
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def cmd_api(av):
    # args: METHOD PATH
    # Generic, field-lossless passthrough for native adapters (opencode/pi) that
    # build the full request JSON themselves. POST reads the complete JSON body
    # from stdin and forwards it unchanged; the worker response body is written
    # to stdout verbatim. Exit codes let the caller distinguish outcomes:
    #   0 = delivered (2xx)   3 = worker answered with non-2xx   4 = unreachable
    method = (av[0] if len(av) > 0 else "GET").upper()
    path = av[1] if len(av) > 1 else ""
    if method not in ("POST", "GET"):
        log("api: method must be POST or GET")
        sys.exit(2)
    # Only proxy to the local worker's own API surface (SSRF guard).
    if not path.startswith("/api/"):
        log("api: path must start with /api/")
        sys.exit(2)

    if method == "GET":
        try:
            raw = _request(BASE + path)
        except urllib.error.HTTPError as e:
            body = e.read()
            sys.stdout.buffer.write(body)
            sys.stdout.buffer.flush()
            sys.exit(3)
        except (urllib.error.URLError, OSError) as e:
            log("api: worker unreachable: %s" % e)
            sys.exit(4)
        sys.stdout.buffer.write(raw)
        sys.stdout.buffer.flush()
        return

    body = sys.stdin.buffer.read()
    try:
        json.loads(body.decode("utf-8"))  # validate; forwarding malformed JSON is pointless
    except Exception:
        log("api: stdin is not a valid JSON object")
        sys.exit(2)
    try:
        raw = _request(BASE + path, data=body)
    except urllib.error.HTTPError as e:
        sys.stdout.buffer.write(e.read())
        sys.stdout.buffer.flush()
        sys.exit(3)
    except (urllib.error.URLError, OSError) as e:
        log("api: worker unreachable: %s" % e)
        sys.exit(4)
    sys.stdout.buffer.write(raw)
    sys.stdout.buffer.flush()


def cmd_hook(av):
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
    agent = av[0] if len(av) > 0 else "codebuddy"
    raw = sys.stdin.read()

    # Empty stdin: skip without blocking the agent
    if not raw.strip():
        return

    evt = sid = cwd = txt = ""
    tool_name = "tool_use"
    try:
        d = json.loads(raw)
    except Exception:
        d = {}
    if isinstance(d, dict):
        evt = d.get("hook_event_name") or d.get("hookEventName") or ""
        sid = d.get("session_id") or d.get("sessionId") or ""
        cwd = d.get("cwd") or ""
        # Extract the text to record
        if evt == "UserPromptSubmit":
            txt = d.get("prompt") or ""
        elif evt in ("PostToolUse", "PreToolUse"):
            ti = d.get("tool_input") or {}
            tr = d.get("tool_response") or {}
            if not isinstance(ti, str):
                ti = json.dumps(ti, ensure_ascii=False)
            if not isinstance(tr, str):
                tr = json.dumps(tr, ensure_ascii=False)
            txt = "[tool:%s] in=%s out=%s" % (str(d.get("tool_name", "unknown")), ti, tr)
        elif evt == "SessionStart":
            txt = d.get("prompt") or ""
        elif evt == "Stop":
            txt = ""
        tool_name = d.get("tool_name") or "tool_use"

    if not sid:
        log("hook: stdin JSON missing session_id")
        return

    # Hook audit log (not affected by CLAUDE_MEM_QUIET; write failures are silent)
    hook_log = os.environ.get(
        "CLAUDE_MEM_HOOK_LOG",
        os.path.expanduser("~/.claude-mem/logs/hook-calls.log"),
    )
    line = "%s\tagent=%s\tevent=%s\tsession=%s\tcwd=%s\n" % (
        datetime.now().astimezone().isoformat(timespec="seconds"),
        agent, evt, sid, cwd or os.getcwd(),
    )
    try:
        os.makedirs(os.path.dirname(hook_log), exist_ok=True)
        with open(hook_log, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass

    if evt == "SessionStart":
        # The SessionStart payload carries no user prompt (Claude/CodeBuddy style);
        # creating a session here would produce an empty prompt (the worker falls
        # back to "[media prompt]"). Session creation + prompt storage happen on
        # UserPromptSubmit, matching the native pi/opencode plugins. No upload here.
        return
    rc = 0
    if evt == "UserPromptSubmit":
        if not txt:
            return
        # init creates the session and stores the prompt in user_prompts (idempotent)
        rc = run_self(["init", agent, sid, cwd or os.getcwd(), "", txt])
    elif evt == "PostToolUse":
        if not txt:
            return
        rc = run_self(["observation", agent, sid, txt, cwd or os.getcwd(), tool_name, agent])
    elif evt == "Stop":
        rc = run_self(["summarize", agent, sid, "", agent])
    # Unknown event: ignore and exit silently; propagate a real upload failure.
    if rc:
        sys.exit(rc)


COMMANDS = {
    "init": cmd_init,
    "observation": cmd_observation,
    "summarize": cmd_summarize,
    "turn": cmd_turn,
    "search": cmd_search,
    "health": cmd_health,
    "api": cmd_api,
    "hook": cmd_hook,
}


def main():
    argv = sys.argv[1:]
    cmd = argv[0] if argv else ""
    handler = COMMANDS.get(cmd)
    if handler is None:
        log("usage: claude-mem-worker.py {init|observation|summarize|turn|search|health|hook} ...")
        sys.exit(1)
    handler(argv[1:])


if __name__ == "__main__":
    main()
