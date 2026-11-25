#!/usr/bin/env bash
set -euo pipefail

# On Fly.io, mounted volumes at /data start owned by root. Fix ownership once and
# immediately drop privileges to the non-root `lattice` user (uid 1000) so
# LatticeCarrierServer.Manifest's 0700/0600 uid checks and Linux fsync work natively.
if [[ "$(id -u)" -eq 0 ]]; then
  mkdir -p /data
  chown -R lattice:lattice /data
  chmod 755 /data
  exec setpriv --reuid=1000 --regid=1000 --clear-groups -- /app/entrypoint.sh "$@"
fi

cd /app
export HOME=/home/lattice
export MIX_ENV=prod
export SECRET_KEY_BASE="${SECRET_KEY_BASE:-$(openssl rand -hex 48)}"
export LIVE_VIEW_SIGNING_SALT="${LIVE_VIEW_SIGNING_SALT:-$(openssl rand -hex 16)}"

DEMO_DIR="${DEMO_ECOSYSTEM_DIR:-/data/demo_ecosystem}"
FLY_HOST="${PHX_HOST:-${FLY_APP_NAME:+${FLY_APP_NAME}.fly.dev}}"
PUBLIC_ORIGIN="${DEMO_PUBLIC_ORIGIN:-${FLY_HOST:+https://${FLY_HOST}}}"

mkdir -p "$DEMO_DIR"
chmod 700 "$DEMO_DIR"

echo "Preparing demo ecosystem in ${DEMO_DIR} (public origin: ${PUBLIC_ORIGIN:-loopback})..."
PREP_ARGS=(--dir "$DEMO_DIR" --export-demo-seeds)
if [[ -n "$PUBLIC_ORIGIN" ]]; then
  PREP_ARGS+=(--public-origin "$PUBLIC_ORIGIN")
fi
mix run --no-compile scripts/demo_ecosystem_prepare.exs "${PREP_ARGS[@]}"

RELAY_IN="$(mktemp -u)"
mkfifo "$RELAY_IN"
exec 4<> "$RELAY_IN"

echo "Starting LatticeCarrierServer (all 5 replicas on loopback 4201..4205, health on 4200)..."
mix run --no-compile --no-start -e '
  Enum.each([Treehouse.Space, Treehouse.Thread, Township.Matter, Toolshed.Shed, Toolshed.Tool], &Code.ensure_loaded!/1)
  Code.require_file("apps/lattice_carrier_server/priv/pilot_node.exs")
' -- "${DEMO_DIR}/manifest.json" < "$RELAY_IN" &
RELAY_PID=$!

cleanup() {
  echo "Shutting down..."
  [[ -n "${LV_PID:-}" ]] && kill "$LV_PID" 2>/dev/null || true
  exec 4>&- 2>/dev/null || true
  kill "$RELAY_PID" 2>/dev/null || true
  rm -f "$RELAY_IN"
}
trap cleanup EXIT INT TERM

READY=0
for _ in $(seq 1 45); do
  CODE="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4200/readyz || echo 0)"
  if [[ "$CODE" == "204" ]]; then
    READY=1
    break
  fi
  sleep 1
done

if [[ "$READY" -ne 1 ]]; then
  echo "Carrier relay failed to become ready (/readyz != 204)" >&2
  exit 1
fi
echo "Carrier relay ready (/readyz=204)."

export PORT=4120
export PHX_SERVER=true
export PHX_HOST="${FLY_HOST:-localhost}"

echo "Starting Township Phoenix LiveView on 127.0.0.1:4120 (PHX_HOST=${PHX_HOST})..."
mix run --no-compile --no-start --no-halt scripts/demo_ecosystem_township_live.exs "$DEMO_DIR" &
LV_PID=$!

for _ in $(seq 1 30); do
  CODE="$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4120/township || echo 0)"
  if [[ "$CODE" == "200" ]]; then
    echo "Township LiveView ready."
    break
  fi
  sleep 1
done

echo "Starting Caddy reverse proxy on :8080..."
exec caddy run --config /app/Caddyfile --adapter caddyfile
