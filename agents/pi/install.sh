#!/usr/bin/env bash
#
# pi-agent-memory patch applier
#
# Workflow:
#   pi-claude-mem.ts in THIS directory is the source of truth;
#   the copy inside pi's node_modules is only the deployment target.
#
#   1. Edit pi-claude-mem.ts here
#   2. Run ./install.sh sync to deploy it into pi
#   3. Restart pi
#
#   WARNING: never edit the file inside node_modules directly:
#      `pi install` / package updates overwrite it and your changes are lost.
#
# Usage:
#   ./install.sh sync     sync this directory's pi-claude-mem.ts into pi (auto-backup; most common)
#   ./install.sh apply    alias for sync
#   ./install.sh revert   roll back to the latest backup
#   ./install.sh diff     diff the installed version against this directory
#   ./install.sh status   show current sync status
#
set -euo pipefail

PLUGIN_DIR="$HOME/.pi/agent/npm/node_modules/pi-agent-memory/extensions"
TARGET="$PLUGIN_DIR/pi-claude-mem.ts"
BACKUP="$PLUGIN_DIR/pi-claude-mem.ts.bak-$(date +%Y%m%d-%H%M%S)"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXED="$SRC_DIR/pi-claude-mem.ts"
LATEST_BACKUP="$(ls -t "$PLUGIN_DIR"/pi-claude-mem.ts.bak-* 2>/dev/null | head -1 || true)"

if [[ ! -f "$TARGET" ]]; then
  echo "ERROR plugin file not found: $TARGET"
  echo "      run first: pi install npm:pi-agent-memory"
  exit 1
fi

if [[ ! -f "$FIXED" ]]; then
  echo "ERROR patched file not found: $FIXED"
  exit 1
fi

case "${1:-status}" in
  sync|apply)
    if cmp -s "$FIXED" "$TARGET"; then
      echo "OK already in sync; the pi copy matches this directory"
      exit 0
    fi
    cp "$TARGET" "$BACKUP"
    cp "$FIXED" "$TARGET"
    echo "OK synced: pi-claude-mem.ts in this directory -> $TARGET"
    echo "   backup: $BACKUP"
    echo ""
    echo "!! Restart pi to reload the extension, then run /memory-status"
    ;;

  revert)
    if [[ -z "$LATEST_BACKUP" ]]; then
      echo "ERROR no backup found, cannot revert"
      exit 1
    fi
    cp "$LATEST_BACKUP" "$TARGET"
    echo "OK reverted to: $LATEST_BACKUP"
    echo "!! Restart pi to reload the extension"
    ;;

  diff)
    if cmp -s "$FIXED" "$TARGET"; then
      echo "OK installed pi copy matches this directory"
    else
      diff -u --label "installed pi copy" --label "this directory" "$TARGET" "$FIXED" || true
    fi
    ;;

  status)
    echo "source (this dir): $FIXED"
    echo "target (pi)      : $TARGET"
    if cmp -s "$FIXED" "$TARGET"; then
      echo "sync status:       OK in sync"
    else
      echo "sync status:       !! NOT in sync (run ./install.sh sync)"
    fi
    if [[ -n "$LATEST_BACKUP" ]]; then
      echo "latest backup:     $LATEST_BACKUP"
    else
      echo "latest backup:     none"
    fi
    ;;

  *)
    echo "usage: $0 {sync|revert|diff|status}"
    exit 1
    ;;
esac
