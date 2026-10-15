#!/bin/sh
# Daily encrypted off-host backup for treehouse-relay. Run by restic-backup.timer
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

# shellcheck disable=SC2086
restic backup --tag daily $paths
# Retention applies only to scheduled daily snapshots, so manual recovery snapshots survive.
restic forget --tag daily --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
