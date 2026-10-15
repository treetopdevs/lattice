#!/bin/sh
# Daily encrypted off-host backup for treehouse-relay. Run by restic-backup.timer
# as root. Credentials come from /etc/restic/env; nothing secret lives in this file.
set -eu

set -a
# shellcheck source=/dev/null
. /etc/restic/env
set +a

# Back up only paths that exist. /var/lib/treehouse-relay is reserved for the
# carrier's data directory; it is added here once R21b configures that path.
paths=""
for p in /etc/caddy /var/lib/caddy /etc/restic /var/lib/treehouse-relay; do
  [ -e "$p" ] && paths="$paths $p"
done

# shellcheck disable=SC2086
restic backup --tag daily $paths
restic forget --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
