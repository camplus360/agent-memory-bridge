#!/usr/bin/env python3
#
# mem0 variant of the unified worker client (thin wrapper)
# ============================================================================
# Equivalent to: CLAUDE_MEM_BACKEND=mem0 python3 claude-mem-worker.py ...
#
# Shares the exact same implementation as claude-mem-worker.py; it only pins
# the backend to mem0, so there is no second copy of the protocol logic.
# To capture once and write to both memory stores, run claude-mem-worker.py
# directly with CLAUDE_MEM_BACKEND=both.
#
# Protocol differences between mem0 and claude-mem:
#   claude-mem : session-based  init -> observation -> summarize (LLM summary in the worker)
#   mem0       : flat           observation = one POST /memories (facts inferred server-side)
#   => init / summarize are no-ops with the mem0 backend
#
# Usage (identical to claude-mem-worker.py):
#   python3 mem0-worker.py init         <agent> <sessionId> [cwd] [project] [prompt]
#   python3 mem0-worker.py observation  <agent> <sessionId> <text> [cwd] [toolName] [platformSource]
#   python3 mem0-worker.py summarize    <agent> <sessionId> [lastAssistantMessage] [platformSource]
#   python3 mem0-worker.py search       <query> [limit]
#   python3 mem0-worker.py hook         <agent>     # reads CodeBuddy/Claude Code hook JSON from stdin
#
# Environment (optional overrides):
#   MEM0_HOST         default localhost
#   MEM0_PORT         default 8000
#   MEM0_API_KEY      default empty (no auth); required if auth is enabled
#   MEM0_USER_ID      default $USER
#   MEM0_INFER        default true (mem0 server extracts facts)
#   CLAUDE_MEM_QUIET  set to 1 to silence stderr logging
#
import os
import sys

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    unified = os.path.join(here, "claude-mem-worker.py")

    if not os.path.isfile(unified):
        print("[mem0-worker] unified script not found: %s" % unified, file=sys.stderr)
        sys.exit(1)

    os.environ["CLAUDE_MEM_BACKEND"] = "mem0"
    os.execvp(sys.executable, [sys.executable, unified] + sys.argv[1:])
