#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
MIX="$HOME/.asdf/shims/mix"

cd "$ROOT/apps/township_web"
MIX_ENV=test "$MIX" assets.build

cd "$ROOT"
exec env MIX_ENV=test PHX_SERVER=true PORT="${PORT:-4113}" "$MIX" run --no-halt
