#!/usr/bin/env bash
# Start (or restart) DailyUs server on port 7878
set -e
cd "$(dirname "$0")"
pkill -f "node server.mjs" 2>/dev/null || true
sleep 0.3
nohup node server.mjs > dailyus.log 2>&1 &
echo "DailyUs running at http://127.0.0.1:7878  (log: ./dailyus.log)"
