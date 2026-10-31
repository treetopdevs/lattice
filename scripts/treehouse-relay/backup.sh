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

# restic archives a symlink without following it, so a linked carrier directory would
# pass the seed checks below while the snapshot holds no seed.
if [ ! -d /var/lib/treehouse-relay ] || [ -L /var/lib/treehouse-relay ]; then
  echo "required backup path is not a real directory: /var/lib/treehouse-relay" >&2
  exit 1
fi

# The carrier service identity seed (created 2026-10-23, OD-1) is binding-critical
# and restic is its only off-host copy. check_seed FILE passes only for a regular file
# of 64 lowercase hex characters plus a newline that derives the public key the
# binding names (docs/research/evidence/treehouse-service-identity-2026-10-23.md).
# The live seed is checked before the first attempt and before every attempt. After
# a successful backup, the seed is read back out of the pending snapshot and checked
# there, so a snapshot only becomes daily if the copy it holds is the bound seed.
seed=/var/lib/treehouse-relay/service-identity.seed
expected_public_key=qJ7tfzm+Gvc1O1lgfj/ZwdPgSAC/jcuxXMHoA2qVbB4=
check_seed() {
  if [ ! -f "$1" ] || [ -L "$1" ] || [ "$(wc -c < "$1")" -ne 65 ] ||
    ! grep -Eqx '[0-9a-f]{64}' "$1"; then
    echo "service identity seed missing or malformed: $1" >&2
    return 1
  fi
  # Wrap the raw seed in the Ed25519 PKCS#8 DER prefix and let OpenSSL derive the
  # public half. awk turns the hex into octal escapes so xxd is not needed.
  der_escapes=$({ printf '%s' 302e020100300506032b657004220420; tr -d '\n' < "$1"; } |
    awk '{ h = "0123456789abcdef"
           for (i = 1; i < length($0); i += 2)
             printf "\\%03o", (index(h, substr($0, i, 1)) - 1) * 16 + index(h, substr($0, i + 1, 1)) - 1 }')
  # shellcheck disable=SC2059
  actual_public_key=$(printf "$der_escapes" |
    openssl pkey -inform DER -pubout -outform DER | tail -c 32 | base64)
  unset der_escapes
  if [ "$actual_public_key" != "$expected_public_key" ]; then
    echo "service identity seed does not derive the bound public key: $1" >&2
    return 1
  fi
}
check_seed "$seed" || exit 1

# Private scratch space on tmpfs for the snapshot's copy of the seed; removed on exit.
snapshot_dir=$(mktemp -d /run/treehouse-backup.XXXXXX)
trap 'rm -rf "$snapshot_dir"' EXIT
# dash skips the EXIT trap when killed by a signal (systemd stop sends TERM), so turn
# signals into an exit and let the trap remove any seed copy.
trap 'exit 1' HUP INT TERM

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
    # A seed that changed since the last check stops the run; retrying cannot help.
    check_seed "$seed" || exit 1
    set +e
    # shellcheck disable=SC2086
    timeout --signal=INT --kill-after=10m 1h restic backup --tag pending $paths \
      > "$snapshot_dir/backup.log" 2>&1
    status=$?
    set -e
    cat "$snapshot_dir/backup.log"

    if [ "$status" -eq 0 ]; then
      # Check and later promote only the snapshot this attempt wrote, named by
      # restic's "snapshot <id> saved" line. A pending snapshot an earlier quarantine
      # failed to retag is never promoted. The live seed may have changed while restic
      # read it, so check the copy the snapshot actually holds; quarantine on failure.
      # A missing id or a failed or timed-out dump is a failed attempt and is retried;
      # a seed copy that fails check_seed stops the run, since retrying cannot help.
      snapshot_id=$(sed -n 's/^snapshot \([0-9a-f]\{8,64\}\) saved$/\1/p' "$snapshot_dir/backup.log" | tail -n 1)
      if [ -z "$snapshot_id" ]; then
        echo "restic reported success but no snapshot id was found" >&2
        status=1
      elif ! (umask 077 && timeout --signal=INT --kill-after=1m 10m \
        restic dump "$snapshot_id" "$seed" > "$snapshot_dir/seed"); then
        echo "could not read the seed back from snapshot $snapshot_id" >&2
        status=1
      elif ! check_seed "$snapshot_dir/seed"; then
        rm -f "$snapshot_dir/seed"
        echo "snapshot $snapshot_id holds a seed that fails the check; quarantining" >&2
        restic tag --tag pending --set incomplete || true
        exit 1
      else
        rm -f "$snapshot_dir/seed"
        break
      fi
      rm -f "$snapshot_dir/seed"
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
  restic tag --set daily "$snapshot_id"
  restic forget --tag daily --group-by host --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune
fi

# Keep only the five newest incomplete snapshots for diagnosis. Group by host, not
# by path set, so the policy still applies after the carrier path is added.
restic forget --tag incomplete --group-by host --keep-last 5 --prune
exit "$status"
