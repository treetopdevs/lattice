#!/usr/bin/env bash
set -euo pipefail

# Launches the Township Phoenix LiveView + Vue causal-replay instrument pointed at
# the unified local demo relay (`scripts/demo_ecosystem_relay.sh`).
#
# Usage:
#   scripts/demo_ecosystem_township_live.sh [port] [demo_dir]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
MIX="$HOME/.asdf/shims/mix"

PORT="${1:-4120}"
DEMO_DIR="${2:-${DEMO_ECOSYSTEM_DIR:-output/demo_ecosystem}}"

export PORT
export PHX_SERVER=true
export SECRET_KEY_BASE="${SECRET_KEY_BASE:-$("$MIX" phx.gen.secret)}"

echo "Starting Township LiveView instrument on http://localhost:${PORT}/township (connected to ${DEMO_DIR})..."
exec "$MIX" run --no-start --no-halt scripts/demo_ecosystem_township_live.exs "$DEMO_DIR"
