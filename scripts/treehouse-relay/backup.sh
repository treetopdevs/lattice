#!/bin/sh
# Daily encrypted off-host backup for treehouse-relay. Run by restic-backup.service
# as root. Credentials come from /etc/restic/env; nothing secret lives in this file.
set -eu

set -a
# shellcheck source=/dev/null
. /etc/restic/env
set +a

# Required paths must exist. A missing path fails the run instead of being left
# out of a snapshot that still reports success.
paths=""
for p in /etc/caddy /var/lib/caddy /etc/restic /var/lib/treehouse-relay; do
  if [ ! -e "$p" ]; then
    echo "required backup path missing: $p" >&2
    exit 1
  fi
  paths="$paths $p"
done

# The carrier service identity seed (created 2026-10-23, OD-1) is binding-critical
# and restic is its only off-host copy. Fail rather than let retention prune the
# last snapshot that still holds it.
# The seed must be a regular file of 64 lowercase hex characters plus a newline that
# derives the public key the binding names (docs/research/evidence/
# treehouse-service-identity-2026-10-23.md); a replaced or corrupt seed fails the run.
seed=/var/lib/treehouse-relay/service-identity.seed
expected_public_key=qJ7tfzm+Gvc1O1lgfj/ZwdPgSAC/jcuxXMHoA2qVbB4=
if [ ! -f "$seed" ] || [ -L "$seed" ] || [ "$(wc -c < "$seed")" -ne 65 ] ||
  ! grep -Eqx '[0-9a-f]{64}' "$seed"; then
  echo "service identity seed missing or malformed: $seed" >&2
  exit 1
fi
# Wrap the raw seed in the Ed25519 PKCS#8 DER prefix and let OpenSSL derive the
# public half. awk turns the hex into octal escapes so xxd is not needed.
der_escapes=$({ printf '%s' 302e020100300506032b657004220420; tr -d '\n' < "$seed"; } |
  awk '{ h = "0123456789abcdef"
         for (i = 1; i < length($0); i += 2)
           printf "\\%03o", (index(h, substr($0, i, 1)) - 1) * 16 + index(h, substr($0, i + 1, 1)) - 1 }')
# shellcheck disable=SC2059
actual_public_key=$(printf "$der_escapes" |
  openssl pkey -inform DER -pubout -outform DER | tail -c 32 | base64)
unset der_escapes
if [ "$actual_public_key" != "$expected_public_key" ]; then
  echo "service identity seed does not derive the bound public key" >&2
  exit 1
fi

# A run makes up to four attempts, 30 minutes apart. Each attempt is limited to one
# hour. timeout sends SIGINT, which restic handles by releasing its repository lock.
# A snapshot becomes daily only after an attempt exits 0. Exit 3 means restic wrote a
# snapshot but could not read some source data, so that attempt is tagged incomplete
# and restores never select it. Snapshots still pending from an interrupted run are
# quarantined before each attempt. If that fails, the run stops: promoting an
# unverified leftover to daily would be worse than a late backup.
attempts=4
attempt=1
status=1
while [ "$attempt" -le "$attempts" ]; do
  # Quarantine first. A failed quarantine counts as a failed attempt, and no backup
  # starts until one succeeds, so a leftover cannot be promoted.
  set +e
  restic tag --tag pending --set incomplete
  status=$?
  set -e

  if [ "$status" -eq 0 ]; then
    set +e
    # shellcheck disable=SC2086
    timeout --signal=INT --kill-after=10m 1h restic backup --tag pending $paths
    status=$?
    set -e

    if [ "$status" -eq 0 ]; then
      break
    fi
    restic tag --tag pending --set incomplete || true
  fi
  echo "attempt $attempt ended with status $status; it is excluded from restores" >&2
  if [ "$attempt" -lt "$attempts" ]; then
    sleep 1800
  fi
  attempt=$((attempt + 1))
done

if [ "$status" -eq 0 ]; then
  restic tag --tag pending --set daily
  restic forget --tag daily --group-by host --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
fi

# Keep only the five newest incomplete snapshots for diagnosis. Group by host, not
# by path set, so the policy still applies after the carrier path is added.
restic forget --tag incomplete --group-by host --keep-last 5 --prune
exit "$status"
