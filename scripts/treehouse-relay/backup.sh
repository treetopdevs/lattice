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
seed=/var/lib/treehouse-relay/service-identity.seed
if [ ! -s "$seed" ]; then
  echo "required backup file missing or empty: $seed" >&2
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
