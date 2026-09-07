#!/usr/bin/env bash
# Local Linux operator entry wrapper. No service activation, signing, or seed inputs.
# Usage: treehouse_operator.sh OPERATOR_ROOT COMMAND [ARG...]
# COMMAND uses the Journal/Staging APIs; each mutation is owned by the Python helper.
set -euo pipefail
umask 077
if [[ "$(uname -s)" != Linux ]]; then
  echo "unsupported_operator_platform" >&2
  exit 78
fi
if [[ $# -lt 2 ]]; then
  echo "invalid_operator_command" >&2
  exit 64
fi
root=$1
shift
uid=$(id -u)
if [[ "$root" != /* || ! -d "$root" || -L "$root" ]]; then
  echo "unsafe_operator_directory" >&2
  exit 78
fi
if [[ "$(readlink -f -- "$root")" != "$root" ]]; then
  echo "unsafe_operator_directory" >&2
  exit 78
fi
cursor=$root
while :; do
  if [[ ! -d "$cursor" || -L "$cursor" ]]; then exit 78; fi
  owner=$(stat -c %u -- "$cursor")
  mode=$(stat -c %a -- "$cursor")
  if [[ "$owner" != "$uid" && "$owner" != 0 ]] || (( (8#$mode & 8#022) != 0 )); then
    echo "unsafe_operator_directory" >&2
    exit 78
  fi
  [[ "$cursor" == / ]] && break
  cursor=$(dirname -- "$cursor")
done
# The mutation API owns its own helper/flock. An outer flock here would deadlock
# that helper and could not protect direct API calls.
command -v python3 >/dev/null || { echo "operator_python3_unavailable" >&2; exit 78; }
exec "$@"
