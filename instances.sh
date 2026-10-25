#!/usr/bin/env bash

# Claude Code cPanel - Active Instances Inspector
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# If Node.js is available, delegate to instances.js for rich parsing & formatting
if command -v node >/dev/null 2>&1; then
  node "$SCRIPT_DIR/instances.js" "$@"
  exit $?
fi

# Pure Bash Fallback
echo "================================================================="
echo "          Claude Code cPanel - Active Instances Inspector        "
echo "================================================================="
PID_FILE="$SCRIPT_DIR/bot.pid"

if [ -f "$PID_FILE" ]; then
  FILE_PID=$(cat "$PID_FILE" | tr -d '[:space:]')
  if kill -0 "$FILE_PID" 2>/dev/null; then
    echo "📄 bot.pid Status : Active & alive (PID: $FILE_PID)"
  else
    echo "📄 bot.pid Status : Stale PID file (PID: $FILE_PID not alive)"
  fi
else
  echo "📄 bot.pid Status : Not found"
fi

echo ""
echo "ACTIVE PROCESSES:"
echo "-----------------------------------------------------------------"
ps -eo pid,ppid,%cpu,%mem,etime,command 2>/dev/null | grep -E "(bot\.js|claude)" | grep -v grep || \
ps aux 2>/dev/null | grep -E "(bot\.js|claude)" | grep -v grep || \
echo "🟢 No active bot instances found."
echo "================================================================="
