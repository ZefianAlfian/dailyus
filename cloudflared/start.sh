#!/usr/bin/env bash
# Start cloudflared tunnel for DailyUs (rizdev.ai.id) — intended for a host
# with working DNS (NOT this sandbox VM, which blocks cloudflared DNS SRV/DoH).
#
# Usage:
#   ./start.sh            # foreground
#   ./start.sh --daemon   # background (nohup)
set -euo pipefail
cd "$(dirname "$0")"

TOKEN="$(cat tunnel-token 2>/dev/null || true)"
[ -n "$TOKEN" ] || { echo "tunnel-token tidak ada. Buat ulang via: cloudflared tunnel token dailyus" >&2; exit 1; }

if [ "${1:-}" = "--daemon" ]; then
  setsid nohup cloudflared tunnel run --token "$TOKEN" > tunnel.log 2>&1 &
  echo "cloudflared dailyus tunnel started (PID $!) -> https://dailyus.rizdev.ai.id"
  echo "log: $(pwd)/tunnel.log"
else
  exec cloudflared tunnel run --token "$TOKEN"
fi
