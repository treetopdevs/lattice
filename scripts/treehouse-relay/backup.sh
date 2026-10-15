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
for p in /etc/caddy /var/lib/caddy /etc/restic; do
  if [ ! -e "$p" ]; then
    echo "required backup path missing: $p" >&2
    exit 1
  fi
  paths="$paths $p"
done

# /var/lib/treehouse-relay is reserved for the carrier's data directory. It stays
# optional until R21b configures that path; then move it into the required list.
if [ -e /var/lib/treehouse-relay ]; then
  paths="$paths /var/lib/treehouse-relay"
fi

# A snapshot becomes daily only after restic exits 0. Exit 3 means restic wrote a
# snapshot but could not read some source data, so that snapshot is tagged incomplete
# and restores never select it. Snapshots still pending from an interrupted run are
# quarantined first, because their completeness is unknown. If that fails, the run
# stops: promoting an unverified leftover to daily would be worse than a late backup.
restic tag --tag pending --set incomplete

set +e
# shellcheck disable=SC2086
restic backup --tag pending $paths
status=$?
set -e

if [ "$status" -eq 0 ]; then
  restic tag --tag pending --set daily
  restic forget --tag daily --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
else
  restic tag --tag pending --set incomplete || true
  echo "restic backup exited $status; this run is excluded from restores" >&2
fi

# Keep only the five newest incomplete snapshots for diagnosis.
restic forget --tag incomplete --keep-last 5 --prune
exit "$status"
