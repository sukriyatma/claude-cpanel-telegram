#!/usr/bin/env bash

# Claude Code cPanel Telegram Service Stopper
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$SCRIPT_DIR/bot.pid"

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" | tr -d '[:space:]')
  if kill -0 "$PID" 2>/dev/null; then
    echo "🛑 Stopping Claude Code service (PID: $PID)..."
    kill "$PID" 2>/dev/null
    sleep 1
    if kill -0 "$PID" 2>/dev/null; then
      echo "⚠️ Force killing PID: $PID..."
      kill -9 "$PID" 2>/dev/null
    fi
    rm -f "$PID_FILE"
    echo "✅ Service stopped."
    exit 0
  else
    echo "ℹ️ Process PID $PID is not running. Removing stale PID file."
    rm -f "$PID_FILE"
  fi
fi

# Fallback check
RUNNING_PIDS=$(pgrep -f "node.*bot.js" 2>/dev/null || true)
if [ -n "$RUNNING_PIDS" ]; then
  echo "🛑 Found running bot.js process(es): $RUNNING_PIDS. Stopping..."
  kill $RUNNING_PIDS 2>/dev/null
  echo "✅ Service stopped."
else
  echo "ℹ️ No running Claude Code service found."
fi
