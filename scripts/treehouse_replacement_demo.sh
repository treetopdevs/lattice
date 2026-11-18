#!/usr/bin/env bash
# Plan 316 row 316: watch a client that trusts the base catalog accept an admin-signed
# replacement catalog without the old catalog signer's key, in BEAM and in TS.
# Disposable keys; no production caller; nothing is dialled. Needs Node 22 for the TS half.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    set +u
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"
    nvm use 22 >/dev/null
    set -u
  else
    echo "Node 22 is required for the TS half (install it or use nvm)." >&2
    exit 1
  fi
fi

if [ -n "${MIX:-}" ]; then
  mix_bin="$MIX"
elif [ -x "$HOME/.asdf/shims/mix" ]; then
  mix_bin="$HOME/.asdf/shims/mix"
else
  mix_bin="$(command -v mix)"
fi
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Row 528: both files under --only, so the D-881/D-882 "BEAM equals TS" test runs too (CI runs
# this script in the flagship unit job).
if MIX_ENV=test "$mix_bin" test apps/lattice_core/test/treehouse/catalog_replacement_trust_demo_test.exs \
  apps/lattice_core/test/treehouse/catalog_replacement_trust_test.exs \
  --only replacement_demo >"$log" 2>&1; then
  grep -E '^(\[beam\]|\[ts\]|BEAM == TS)' "$log"
else
  cat "$log"
  exit 1
fi
