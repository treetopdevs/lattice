#!/bin/sh
set -eu

shell_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
npm_bin="${TOWNSHIP_NPM_BIN:-}"

if [ -n "$npm_bin" ]; then
  if [ ! -x "$npm_bin" ]; then
    printf '%s\n' 'Township iOS build cannot find executable npm; set TOWNSHIP_NPM_BIN.' >&2
    exit 127
  fi
else
  npm_bin="$(command -v npm 2>/dev/null || true)"

  if [ -z "$npm_bin" ]; then
    fallback_paths="${TOWNSHIP_NPM_FALLBACK_PATHS:-/opt/homebrew/bin/npm:/usr/local/bin/npm}"
    saved_ifs="$IFS"
    IFS=:
    set -f
    for candidate in $fallback_paths; do
      if [ -x "$candidate" ]; then
        npm_bin="$candidate"
        break
      fi
    done
    set +f
    IFS="$saved_ifs"
  fi
fi

if [ -z "$npm_bin" ] || [ ! -x "$npm_bin" ]; then
  printf '%s\n' 'Township iOS build cannot find executable npm; set TOWNSHIP_NPM_BIN.' >&2
  exit 127
fi

npm_dir="$(CDPATH= cd -- "$(dirname -- "$npm_bin")" && pwd)"
tool_path="$npm_dir:/opt/homebrew/opt/rustup/bin"
if [ -n "${HOME:-}" ]; then
  tool_path="$tool_path:$HOME/.cargo/bin"
fi
if [ -n "${PATH:-}" ]; then
  PATH="$tool_path:$PATH"
else
  PATH="$tool_path"
fi
export PATH

cd "$shell_root"
exec "$npm_bin" run -- tauri ios xcode-script "$@"
