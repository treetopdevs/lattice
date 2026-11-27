#!/usr/bin/env bash
set -euo pipefail

# One-command launcher for the unified local Lattice multi-app demo ecosystem:
#   1. Shared LatticeCarrierServer relay (Treehouse + Township + Toolshed) on 127.0.0.1:4200..4205
#   2. Township Phoenix LiveView + Vue causal-replay instrument on http://127.0.0.1:4120/township
#   3. Lattice Browser Starter (Treehouse + Township + Toolshed live web apps) on http://127.0.0.1:5180/
#
# Usage:
#   scripts/demo_ecosystem_up.sh [--reset] [--web-port <port>] [--liveview-port <port>]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RESET_ARG=()
WEB_PORT=5180
LIVEVIEW_PORT=4120

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)
      RESET_ARG+=("--reset")
      shift
      ;;
    --web-port)
      WEB_PORT="$2"
      shift 2
      ;;
    --liveview-port)
      LIVEVIEW_PORT="$2"
      shift 2
      ;;
    *)
      echo "usage: $0 [--reset] [--web-port <port>] [--liveview-port <port>]" >&2
      exit 64
      ;;
  esac
done

RELAY_IN="$(mktemp -u)"
RELAY_OUT="$(mktemp -u)"
mkfifo "$RELAY_IN" "$RELAY_OUT"

RELAY_PID=""
LV_PID=""
WEB_PID=""

cleanup() {
  echo ""
  echo "Shutting down Lattice demo ecosystem..."
  [[ -n "$WEB_PID" ]] && kill "$WEB_PID" 2>/dev/null || true
  [[ -n "$LV_PID" ]] && kill "$LV_PID" 2>/dev/null || true
  exec 4>&- 2>/dev/null || true
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  rm -f "$RELAY_IN" "$RELAY_OUT"
}
trap cleanup EXIT
# The supervising loop below is not interrupted by a signal the way a bare `wait` is, so exit here
# and let the EXIT trap stop the services.
trap 'exit 130' INT TERM

# Name the first required service that is no longer running, if any.
exited_service() {
  if ! kill -0 "$RELAY_PID" 2>/dev/null; then echo "relay"; return 0; fi
  if [[ -n "$LV_PID" ]] && ! kill -0 "$LV_PID" 2>/dev/null; then echo "Township LiveView"; return 0; fi
  if [[ -n "$WEB_PID" ]] && ! kill -0 "$WEB_PID" 2>/dev/null; then echo "browser starter"; return 0; fi
  return 1
}

# Wait until <url> answers, failing as soon as any required service has exited.
wait_until_serving() {
  local label="$1" url="$2" deadline=$((SECONDS + $3)) gone
  until curl --silent --fail --output /dev/null --max-time 2 "$url"; do
    if gone="$(exited_service)"; then
      echo "The $gone process exited before $label was ready; see its output above." >&2
      exit 1
    fi
    if (( SECONDS >= deadline )); then
      echo "$label did not answer at $url within $3 seconds." >&2
      exit 1
    fi
    sleep 1
  done
}

scripts/demo_ecosystem_relay.sh ${RESET_ARG[@]+"${RESET_ARG[@]}"} < "$RELAY_IN" > "$RELAY_OUT" 2>&1 &
RELAY_PID=$!
exec 4> "$RELAY_IN"

READY=0
while IFS= read -r -t 30 line; do
  echo "[relay] $line"
  if [[ "$line" == PILOT_READY* ]]; then
    READY=1
    break
  fi
done < "$RELAY_OUT"

if [[ "$READY" -ne 1 ]]; then
  echo "Demo relay failed to start." >&2
  exit 1
fi

# Drain relay logs in background so its pipe never blocks.
(while IFS= read -r line; do echo "[relay] $line"; done < "$RELAY_OUT") &

scripts/demo_ecosystem_township_live.sh "$LIVEVIEW_PORT" &
LV_PID=$!

# --strictPort: the URL printed below must be the one the starter listens on.
npm --prefix clients/lattice-browser-starter run dev -- --port "$WEB_PORT" --strictPort &
WEB_PID=$!

# The first LiveView start may compile, so it gets the longer wait.
wait_until_serving "Browser starter" "http://127.0.0.1:${WEB_PORT}/" 60
wait_until_serving "Township LiveView" "http://127.0.0.1:${LIVEVIEW_PORT}/township" 300

echo ""
echo "============================================================================"
echo "  Lattice Multi-App Demo Ecosystem is running!"
echo "============================================================================"
echo "  Browser Starter (Founder):   http://127.0.0.1:${WEB_PORT}/?role=founder"
echo "  Browser Starter (Neighbor):  http://127.0.0.1:${WEB_PORT}/?role=neighbor"
echo "  Township LiveView Inspector: http://localhost:${LIVEVIEW_PORT}/township"
echo "  Relay Health:                http://127.0.0.1:4200/readyz"
echo "  Optional Desktop Treehouse:  scripts/demo_ecosystem_treehouse.sh founder"
echo "============================================================================"
echo "Press Ctrl-C to stop all services."
echo ""

# Supervise: the demo needs all three, so one of them exiting stops the rest (macOS ships bash 3.2,
# which has no `wait -n`).
while true; do
  if gone="$(exited_service)"; then
    echo "The $gone process exited; stopping the demo ecosystem." >&2
    exit 1
  fi
  sleep 1
done
