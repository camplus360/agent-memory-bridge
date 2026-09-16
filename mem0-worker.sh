#!/usr/bin/env bash
#
# mem0 variant of the unified worker client (thin wrapper)
# ============================================================================
# Equivalent to: CLAUDE_MEM_BACKEND=mem0 claude-mem-worker.sh ...
#
# Shares the exact same implementation as claude-mem-worker.sh; it only pins
# the backend to mem0, so there is no second copy of the protocol logic.
# To capture once and write to both memory stores, run claude-mem-worker.sh
# directly with CLAUDE_MEM_BACKEND=both.
#
# Protocol differences between mem0 and claude-mem:
#   claude-mem : session-based  init -> observation -> summarize (LLM summary in the worker)
#   mem0       : flat           observation = one POST /memories (facts inferred server-side)
#   => init / summarize are no-ops with the mem0 backend
#
# Usage (identical to claude-mem-worker.sh):
#   mem0-worker.sh init         <agent> <sessionId> [cwd] [project] [prompt]
#   mem0-worker.sh observation  <agent> <sessionId> <text> [cwd] [toolName] [platformSource]
#   mem0-worker.sh summarize    <agent> <sessionId> [lastAssistantMessage] [platformSource]
#   mem0-worker.sh search       <query> [limit]
#   mem0-worker.sh hook         <agent>     # reads CodeBuddy/Claude Code hook JSON from stdin
#
# Environment (optional overrides):
#   MEM0_HOST         default localhost
#   MEM0_PORT         default 8000
#   MEM0_API_KEY      default empty (no auth); required if auth is enabled
#   MEM0_USER_ID      default $USER
#   MEM0_INFER        default true (mem0 server extracts facts)
#   CLAUDE_MEM_QUIET  set to 1 to silence stderr logging
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIFIED="$SCRIPT_DIR/claude-mem-worker.sh"

if [ ! -f "$UNIFIED" ]; then
  echo "[mem0-worker] unified script not found: $UNIFIED" >&2
  exit 1
fi

CLAUDE_MEM_BACKEND=mem0 exec bash "$UNIFIED" "$@"
