#!/usr/bin/env bash
#
# agent-memory-bridge installer
# ============================================================================
# Installs the unified worker script (single source of truth) and the
# adapter for each selected agent into its real runtime location.
# Every agent ends up talking to the same claude-mem worker.
#
# Usage:
#   ./install.sh                  # interactively choose agents
#   ./install.sh --all            # install all (opencode/pi/codebuddy/hermes)
#   ./install.sh --agent opencode # install one agent
#   ./install.sh --prefix /opt/claude-mem   # custom install root
#   ./install.sh --dry-run        # print actions without writing
#
# Environment:
#   CLAUDE_MEM_WORKER_HOST / CLAUDE_MEM_WORKER_PORT  worker address (written to .env)
#   CLAUDE_MEM_INSTALL_ROOT   install root (default: ~/.local/share/claude-mem)
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_ROOT="${CLAUDE_MEM_INSTALL_ROOT:-$HOME/.local/share/claude-mem}"
WORKER_PY="$SCRIPT_DIR/claude-mem-worker.py"
DRY_RUN=0
TARGET_AGENTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --all) TARGET_AGENTS=(opencode pi codebuddy hermes) ;;
    --agent) TARGET_AGENTS+=("$2"); shift ;;
    --prefix) INSTALL_ROOT="$2"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
  shift
done

if [ ${#TARGET_AGENTS[@]} -eq 0 ]; then
  echo "Select agents to install (space-separated numbers, Enter = all):"
  echo "  1) opencode   2) pi   3) codebuddy   4) hermes"
  read -r sel
  case "$sel" in
    *1*) TARGET_AGENTS+=(opencode) ;;
  esac
  case "$sel" in
    *2*) TARGET_AGENTS+=(pi) ;;
  esac
  case "$sel" in
    *3*) TARGET_AGENTS+=(codebuddy) ;;
  esac
  case "$sel" in
    *4*) TARGET_AGENTS+=(hermes) ;;
  esac
  [ ${#TARGET_AGENTS[@]} -eq 0 ] && TARGET_AGENTS=(opencode pi codebuddy hermes)
fi

run() {
  if [ "$DRY_RUN" = "1" ]; then echo "[dry-run] $*"
  else eval "$@"; fi
}

echo "=== agent-memory-bridge install ==="
echo "install root: $INSTALL_ROOT"
echo "target agents: ${TARGET_AGENTS[*]}"
echo

# 1) Always install the unified script (single source of truth)
run "mkdir -p '$INSTALL_ROOT'"
run "cp '$WORKER_PY' '$INSTALL_ROOT/claude-mem-worker.py'"
run "cp '$SCRIPT_DIR/mem0-worker.py' '$INSTALL_ROOT/mem0-worker.py'"
run "chmod +x '$INSTALL_ROOT/claude-mem-worker.py' '$INSTALL_ROOT/mem0-worker.py'"
echo "[ok] unified script -> $INSTALL_ROOT/claude-mem-worker.py"
echo "[ok] mem0 wrapper   -> $INSTALL_ROOT/mem0-worker.py"

# Generate the .env template (host/port/timeouts/backend selection)
ENV_FILE="$INSTALL_ROOT/.env"
if [ ! -f "$ENV_FILE" ] || [ "$DRY_RUN" = "1" ]; then
  run "cat > '$ENV_FILE' <<EOF
# ---------- backend ----------
# claude-mem (default, session-based) | mem0 (flat) | both (dual-write)
CLAUDE_MEM_BACKEND=${CLAUDE_MEM_BACKEND:-claude-mem}

# ---------- claude-mem worker ----------
CLAUDE_MEM_WORKER_HOST=${CLAUDE_MEM_WORKER_HOST:-127.0.0.1}
CLAUDE_MEM_WORKER_PORT=${CLAUDE_MEM_WORKER_PORT:-37701}
CLAUDE_MEM_HTTP_TIMEOUT=8
CLAUDE_MEM_HTTP_RETRIES=2

# ---------- mem0 ----------
# Note: if MEM0_HOST already exists in the environment with an http:// prefix,
# the script strips it automatically.
MEM0_HOST=${MEM0_HOST:-localhost}
MEM0_PORT=${MEM0_PORT:-8000}
# Leave empty to omit the X-API-Key header (works when auth is disabled).
MEM0_API_KEY=${MEM0_API_KEY:-}
MEM0_USER_ID=${MEM0_USER_ID:-$USER}
MEM0_INFER=true
EOF"
  echo "[ok] env template -> $ENV_FILE"
fi

# .env.example is always refreshed (we never overwrite a user-edited .env)
run "cat > '$INSTALL_ROOT/.env.example' <<'EOF'
# ---------- backend ----------
# claude-mem (default, session-based) | mem0 (flat) | both (dual-write)
CLAUDE_MEM_BACKEND=claude-mem

# ---------- claude-mem worker ----------
CLAUDE_MEM_WORKER_HOST=127.0.0.1
CLAUDE_MEM_WORKER_PORT=37701
CLAUDE_MEM_HTTP_TIMEOUT=8
CLAUDE_MEM_HTTP_RETRIES=2

# ---------- mem0 ----------
MEM0_HOST=localhost
MEM0_PORT=8000
# Leave empty to omit the X-API-Key header. Note: the key is bound to a
# specific user view; writes and searches must use the same view.
MEM0_API_KEY=
MEM0_USER_ID=
MEM0_INFER=true
EOF"
echo "[ok] latest template -> $INSTALL_ROOT/.env.example"

for ag in "${TARGET_AGENTS[@]}"; do
  echo
  case "$ag" in
    opencode)
      DST="$HOME/.config/opencode/plugins/claude-mem-capture"
      run "mkdir -p '$DST'"
      run "cp '$SCRIPT_DIR/agents/opencode/index.js' '$DST/'"
      run "cp '$SCRIPT_DIR/agents/opencode/index.test.js' '$DST/' 2>/dev/null || true"
      run "cp '$SCRIPT_DIR/agents/opencode/package.json' '$DST/' 2>/dev/null || true"
      echo "[ok] opencode plugin -> $DST (register it in your opencode config)"
      ;;
    pi)
      # pi is a local-path package: register this repo's agents/pi directory
      # directly via `pi install <abs path>`. Nothing is copied into node_modules,
      # and `pi update` never overwrites the code (see agents/pi/DEPLOY.md).
      PI_PKG="$SCRIPT_DIR/agents/pi"
      PI_SETTINGS="$HOME/.pi/agent/settings.json"
      if [ "$DRY_RUN" = "1" ]; then
        echo "[dry-run] pi install '$PI_PKG'"
      elif ! command -v pi >/dev/null 2>&1; then
        echo "[warn] pi not found on PATH; register manually by adding this to" >&2
        echo "       $PI_SETTINGS packages array:\"$PI_PKG\"" >&2
      elif grep -qF "\"$PI_PKG\"" "$PI_SETTINGS" 2>/dev/null; then
        echo "[ok] pi package already registered -> $PI_PKG"
      else
        run "pi install '$PI_PKG'"
        echo "[ok] pi local-path package registered -> $PI_PKG"
      fi
      ;;
    codebuddy)
      DST="$HOME/.codebuddy"
      run "mkdir -p '$DST'"
      # Render hooks.json.example to hooks.claude-mem.json (never overwrite hooks.json)
      run "sed 's#/ABS/PATH/agent-memory-bridge/claude-mem-worker.py#$INSTALL_ROOT/claude-mem-worker.py#g' '$SCRIPT_DIR/agents/codebuddy/hooks.json.example' > '$DST/hooks.claude-mem.json'"
      echo "[ok] codebuddy hooks -> $DST/hooks.claude-mem.json (merge into settings.json to enable)"
      ;;
    hermes)
      DST="$INSTALL_ROOT/agents/hermes"
      run "mkdir -p '$DST'"
      run "cp '$SCRIPT_DIR/agents/hermes/engine.py.example' '$DST/engine.py.example'"
      echo "[ok] hermes snippet -> $DST/engine.py.example (paste into the Hermes engine event points)"
      ;;
    *) echo "unknown agent: $ag" >&2 ;;
  esac
done

echo
echo "=== done ==="
echo "unified script: $INSTALL_ROOT/claude-mem-worker.py"
echo "make sure the worker is running: python3 $INSTALL_ROOT/claude-mem-worker.py health"
