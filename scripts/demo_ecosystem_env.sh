#!/usr/bin/env bash
# Sourced by the demo ecosystem launchers: resolves the `mix` they run into $MIX.
#
# Order: an explicit $MIX, then the asdf shim when this machine has one, then `mix` on PATH.
# No particular version manager is required.

if [[ -z "${MIX:-}" ]]; then
  if [[ -x "$HOME/.asdf/shims/mix" ]]; then
    MIX="$HOME/.asdf/shims/mix"
  else
    MIX="$(command -v mix || true)"
  fi
fi

if [[ -z "$MIX" ]]; then
  echo "mix not found: install Elixir, or set MIX to the mix executable to use." >&2
  exit 127
fi
