#!/usr/bin/env bash
# Local Linux operator entry wrapper. No service activation, signing, or seed inputs.
# Usage: treehouse_operator_locked.sh OPERATOR_ROOT COMMAND [ARG...]
# COMMAND must perform all journal/staging mutations in this process lifetime.
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
lock="$root/operator.lock"
if [[ ! -e "$lock" && ! -L "$lock" ]]; then
  ( set -o noclobber; : > "$lock" ) 2>/dev/null || true
fi
if [[ ! -f "$lock" || -L "$lock" || "$(stat -c %u -- "$lock")" != "$uid" ||
      "$(stat -c %h -- "$lock")" != 1 || "$(stat -c %a -- "$lock")" != 600 ]]; then
  echo "unsafe_operator_lock" >&2
  exit 78
fi
# --no-fork keeps the OS lock descriptor in the executed command. Kernel release,
# never PID-file removal, determines ownership after that command exits or dies.
exec flock --exclusive --nonblock --conflict-exit-code 75 --no-fork "$lock" "$@"
