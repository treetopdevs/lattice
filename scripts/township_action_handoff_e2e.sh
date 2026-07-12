#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)

if [ -x "$HOME/.asdf/shims/mix" ]; then
  MIX_BIN="$HOME/.asdf/shims/mix"
  PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
  export PATH
else
  MIX_BIN=${MIX_BIN:-mix}
fi

cd "$ROOT"
MIX_ENV=test "$MIX_BIN" compile

cd "$ROOT/apps/township_web"
MIX_ENV=test "$MIX_BIN" assets.build

cd "$ROOT/clients/township-tauri-shell"
VITE_TOWNSHIP_DEV_TRACE= VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT= npm run build

cd "$ROOT"
exec npx --no-install playwright test --config playwright.township-action-handoff.config.mjs
