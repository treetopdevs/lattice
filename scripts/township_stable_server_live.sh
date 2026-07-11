#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MIX="$HOME/.asdf/shims/mix"
TRIGGER_FILE=/tmp/lattice-township-stable-server-trigger

rm -f "$TRIGGER_FILE"

cd "$ROOT/apps/township_web"
MIX_ENV=test "$MIX" assets.build

cd "$ROOT"
exec env \
  MIX_ENV=test \
  PHX_SERVER=true \
  PORT="${PORT:-4115}" \
  TOWNSHIP_STABLE_TRIGGER_FILE="$TRIGGER_FILE" \
  "$MIX" run --no-start scripts/township_stable_server_live.exs
