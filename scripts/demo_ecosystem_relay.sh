#!/usr/bin/env bash
set -euo pipefail

# Unified local demo relay for the Lattice multi-app demo ecosystem
# (Treehouse Space+Thread, Township Matter, Toolshed Shed+Tool).
#
# Usage:
#   scripts/demo_ecosystem_relay.sh [--reset] [--dir <path>] [--base-port <port>]
#
# Assisted demo only: plaintext loopback WebSocket, static routes, deterministic demo keys.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck source=scripts/demo_ecosystem_env.sh
source "$ROOT_DIR/scripts/demo_ecosystem_env.sh"

DEMO_DIR="${DEMO_ECOSYSTEM_DIR:-output/demo_ecosystem}"
PREPARE_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)
      PREPARE_ARGS+=("--reset")
      shift
      ;;
    --dir)
      DEMO_DIR="$2"
      PREPARE_ARGS+=("--dir" "$2")
      shift 2
      ;;
    --base-port)
      PREPARE_ARGS+=("--base-port" "$2")
      shift 2
      ;;
    *)
      echo "usage: $0 [--reset] [--dir <path>] [--base-port <port>]" >&2
      exit 64
      ;;
  esac
done

"$MIX" run scripts/demo_ecosystem_prepare.exs ${PREPARE_ARGS[@]+"${PREPARE_ARGS[@]}"}

MANIFEST_PATH="$ROOT_DIR/$DEMO_DIR/manifest.json"
if [[ "$DEMO_DIR" = /* ]]; then
  MANIFEST_PATH="$DEMO_DIR/manifest.json"
fi

echo ""
echo "Starting unified Lattice demo relay (Ctrl-C to stop)..."
echo "Endpoints summary: ${MANIFEST_PATH%manifest.json}demo-endpoints.json"
echo ""

# Preload all three product Replica schemas so their command/role atoms are interned
# before `Log.restore/1` (`[:safe]`) and wire decoding run in this fresh BEAM VM.
exec "$MIX" run --no-compile --no-start -e '
  Enum.each([Treehouse.Space, Treehouse.Thread, Township.Matter, Toolshed.Shed, Toolshed.Tool], &Code.ensure_loaded!/1)
  Code.require_file("apps/lattice_carrier_server/priv/pilot_node.exs")
' -- "$MANIFEST_PATH"
