#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MIX="$HOME/.asdf/shims/mix"
TRIGGER_FILE=/tmp/lattice-township-live-trigger

rm -f "$TRIGGER_FILE"

cd "$ROOT/apps/township_web"
MIX_ENV=test "$MIX" assets.build
SECRET_KEY_BASE=$(MIX_ENV=test "$MIX" phx.gen.secret)

case "$SECRET_KEY_BASE" in
  *'
'*)
    echo "mix phx.gen.secret produced unexpected multiline output" >&2
    exit 1
    ;;
esac

if [ "${#SECRET_KEY_BASE}" -lt 64 ]; then
  echo "mix phx.gen.secret produced a key shorter than 64 bytes" >&2
  exit 1
fi

export SECRET_KEY_BASE

cd "$ROOT"
exec env \
  MIX_ENV=test \
  PHX_SERVER=true \
  PORT="${PORT:-4114}" \
  TOWNSHIP_LIVE_TRIGGER_FILE="$TRIGGER_FILE" \
  "$MIX" run --no-start scripts/township_live_instrument_server.exs
