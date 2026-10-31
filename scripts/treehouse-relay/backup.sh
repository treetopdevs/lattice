#!/bin/sh
# Daily encrypted off-host backup for treehouse-relay. Run by restic-backup.service
# as root. Credentials come from /etc/restic/env; nothing secret lives in this file.
#
# TREEHOUSE_BACKUP_* values are snapshotted from the process environment before
# restic/env is sourced, so that file cannot retarget host paths, the retry
# budget, or the bound public key. Production systemd does not set them.
set -eu

__tb_caddy_etc=${TREEHOUSE_BACKUP_CADDY_ETC:-/etc/caddy}
__tb_caddy_lib=${TREEHOUSE_BACKUP_CADDY_LIB:-/var/lib/caddy}
__tb_restic_etc=${TREEHOUSE_BACKUP_RESTIC_ETC:-/etc/restic}
__tb_relay_lib=${TREEHOUSE_BACKUP_RELAY_LIB:-/var/lib/treehouse-relay}
__tb_restic_env=${TREEHOUSE_BACKUP_RESTIC_ENV:-/etc/restic/env}
__tb_expected_public_key=${TREEHOUSE_BACKUP_EXPECTED_PUBLIC_KEY:-qJ7tfzm+Gvc1O1lgfj/ZwdPgSAC/jcuxXMHoA2qVbB4=}
__tb_scratch_root=${TREEHOUSE_BACKUP_SCRATCH_DIR:-/run}
__tb_retry_seconds=${TREEHOUSE_BACKUP_RETRY_SECONDS:-1800}
__tb_attempts=${TREEHOUSE_BACKUP_ATTEMPTS:-4}
# dash readonly: a sourced restic/env assignment cannot replace these.
readonly __tb_caddy_etc __tb_caddy_lib __tb_restic_etc __tb_relay_lib \
  __tb_restic_env __tb_expected_public_key __tb_scratch_root \
  __tb_retry_seconds __tb_attempts

set -a
# shellcheck source=/dev/null
. "$__tb_restic_env"
set +a

caddy_etc=$__tb_caddy_etc
caddy_lib=$__tb_caddy_lib
restic_etc=$__tb_restic_etc
relay_lib=$__tb_relay_lib
expected_public_key=$__tb_expected_public_key
scratch_root=$__tb_scratch_root
retry_seconds=$__tb_retry_seconds
attempts=$__tb_attempts

is_uint() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

if ! is_uint "$retry_seconds"; then
  echo "invalid TREEHOUSE_BACKUP_RETRY_SECONDS: $retry_seconds" >&2
  exit 1
fi
if ! is_uint "$attempts" || [ "$attempts" -lt 1 ]; then
  echo "invalid TREEHOUSE_BACKUP_ATTEMPTS: $attempts" >&2
  exit 1
fi
if [ -z "$expected_public_key" ]; then
  echo "service identity expected public key is empty" >&2
  exit 1
fi
if [ ! -d "$scratch_root" ] || [ -L "$scratch_root" ]; then
  echo "backup scratch directory missing: $scratch_root" >&2
  exit 1
fi

# Required paths must exist. A missing path fails the run instead of being left
# out of a snapshot that still reports success. Whitespace or glob characters
# are refused so a TREEHOUSE_BACKUP_* override cannot split across restic argv.
for p in "$caddy_etc" "$caddy_lib" "$restic_etc" "$relay_lib"; do
  case "$p" in
    *[!/A-Za-z0-9._+-]*)
      echo "required backup path has unsafe characters: $p" >&2
      exit 1
      ;;
  esac
  if [ ! -e "$p" ]; then
    echo "required backup path missing: $p" >&2
    exit 1
  fi
done

# restic archives a symlink without following it, so a linked carrier directory would
# pass the seed checks below while the snapshot holds no seed.
if [ ! -d "$relay_lib" ] || [ -L "$relay_lib" ]; then
  echo "required backup path is not a real directory: $relay_lib" >&2
  exit 1
fi

# The carrier service identity seed (created 2026-10-23, OD-1) is binding-critical
# and restic is its only off-host copy. check_seed FILE passes only for a regular file
# of 64 lowercase hex characters plus a newline that derives the public key the
# binding names (docs/research/evidence/treehouse-service-identity-2026-10-23.md).
# The live seed is checked before the first attempt and before every attempt. After
# a successful backup, the seed is read back out of the pending snapshot and checked
# there, so a snapshot only becomes daily if the copy it holds is the bound seed.
seed=$relay_lib/service-identity.seed
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
snapshot_dir=$(mktemp -d "$scratch_root/treehouse-backup.XXXXXX")
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
    timeout --signal=INT --kill-after=10m 1h restic backup --tag pending \
      "$caddy_etc" "$caddy_lib" "$restic_etc" "$relay_lib" \
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
    sleep "$retry_seconds"
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
