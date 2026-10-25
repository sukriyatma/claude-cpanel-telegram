#!/usr/bin/env bash

# Stop All Instances of claude-cpanel-telegram and associated subprocesses
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/bot.pid"

echo "🔍 Scanning for all running instances of claude-cpanel-telegram..."

# 1. Kill via bot.pid if exists
if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "• Stopping instance from PID file: $PID"
    kill "$PID" 2>/dev/null
  fi
  rm -f "$PID_FILE"
fi

# 2. Find and kill all node bot.js and project claude processes
PIDS=$(ps -eo pid,command 2>/dev/null | grep -E "bot\.js|$DIR/node_modules/\.bin/claude" | grep -v grep | grep -v "$$" | awk '{print $1}')

if [ -z "$PIDS" ]; then
  echo "✅ No running instances found."
  exit 0
fi

echo "🛑 Terminating instances: $PIDS"
kill -15 $PIDS 2>/dev/null
sleep 1.5

# Force kill any stubborn processes
REMAINING=$(ps -eo pid,command 2>/dev/null | grep -E "bot\.js|$DIR/node_modules/\.bin/claude" | grep -v grep | grep -v "$$" | awk '{print $1}')
if [ -n "$REMAINING" ]; then
  echo "⚠️ Force killing remaining processes: $REMAINING"
  kill -9 $REMAINING 2>/dev/null
fi

echo "🎉 All instances stopped successfully."
