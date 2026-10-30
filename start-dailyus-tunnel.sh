#!/usr/bin/env bash
# DailyUs tunnel supervisor: poll dailyus-tunnel.pages.dev -> 127.0.0.1:7878
# PID-file based (pkill -f membunuh pemanggil sendiri bila command line cocok).
set -u
cd /home/hatch/dailyus

kill_pid() {
  if [ -f "$1" ]; then
    local old=$(cat "$1" 2>/dev/null || true)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then kill "$old" 2>/dev/null || true; fi
    rm -f "$1"
  fi
}

kill_pid /home/hatch/dailyus/.tunnel-supervisor.pid
kill_pid /home/hatch/dailyus/.tunnel-client.pid

setsid nohup bash -c '
  while true; do
    TUNNEL_BASE_URL="https://dailyus-tunnel.pages.dev" \
    TUNNEL_KEY_FILE="/home/hatch/dailyus/.tunnel-key" \
    TUNNEL_LOCAL="http://127.0.0.1:7878" \
    node /home/hatch/workspace/Hermuse-serenhope/tunnel-client.mjs >> /home/hatch/dailyus/tunnel.log 2>&1 &
    echo $! > /home/hatch/dailyus/.tunnel-client.pid
    wait $!
    echo "[$(date -u "+%H:%M:%S")] tunnel client exited, restarting in 5s..." >> /home/hatch/dailyus/tunnel.log
    sleep 5
  done
' > /dev/null 2>&1 < /dev/null &

SUPER=$!
echo $SUPER > /home/hatch/dailyus/.tunnel-supervisor.pid
echo "DailyUs tunnel supervisor started (PID $SUPER)"
