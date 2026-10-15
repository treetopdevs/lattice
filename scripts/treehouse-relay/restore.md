# Restoring treehouse-relay from backup

The backup is restic, encrypted, in the DigitalOcean Spaces bucket
`treehouse-relay-backup-nyc3` (nyc3). It runs daily from `restic-backup.timer`.
The repository password and the Spaces key live in `/etc/restic/env` on the host and
in the owner's 1Password vault. Without the password the backup cannot be read.

## Restore on a clean machine

Use a machine that has never held this data, such as a laptop. Never restore over
the live host's `/etc` or `/var/lib` paths.

1. Install restic: `brew install restic`.
2. Put the contents of `restic.env` from 1Password in a local file, with mode 600.
   Do not commit it.
3. List the scheduled snapshots. Manual recovery snapshots carry no `daily` tag and
   are not selected by this runbook. Run it as one block, so the repository password
   and Spaces credentials never reach your interactive shell:

   ```bash
   (
     set -a; . ./restic.env; set +a
     restic snapshots --tag daily --compact
   )
   ```

4. Restore the latest daily snapshot into a new temporary directory, and check the
   restored Caddy config against the config the host was built with. Run it as one
   block. `mktemp -d` makes a fresh directory on every run, and the `trap` removes the
   restored copy and the local env file however the check ends, including a failed
   diff or an interrupted restore. The diff is empty if the Caddyfile is intact. The
   `printf` text is the cloud-init content, so the check also flags any later hand edit.

   ```bash
   (
     set -e
     set -a; . ./restic.env; set +a
     RESTORE_DIR=$(mktemp -d)
     trap 'rm -rf "$RESTORE_DIR" ./restic.env' EXIT
     # A nonzero exit (for example, a missing pack) stops the check before the diff.
     restic restore latest --tag daily --target "$RESTORE_DIR"
     diff "$RESTORE_DIR/etc/caddy/Caddyfile" <(printf '%s\n' \
       'treehouse-relay.rootaccess.to {' \
       '  respond "Treehouse relay host: no service is deployed yet" 503' \
       '}')
   )
   ```

## Restore on the host

Stop Caddy first if the restore replaces `/etc/caddy` or `/var/lib/caddy`:
`systemctl stop caddy`. Restore into a staging directory, check it, then move the
files into place and start Caddy again. Do not restore `/etc/restic` over the live
copy unless the env file is lost.

## Schedule and retention

- Twice a day, at 00:00 and 12:00 UTC, with `Persistent=true`, so a missed start runs
  once the host is back. The twice-daily schedule provides another backup opportunity
  within 12 hours. The 24-hour RPO depends on a verified backup completing within that
  window.
- Scheduled runs keep the `daily` tag. Retention keeps the newest snapshot per day.
- Keep 7 daily, 4 weekly and 6 monthly snapshots; older ones are pruned.
- A run that restic ends with exit 3 is tagged `incomplete` and never selected by a
  restore. Only the five newest incomplete snapshots are kept, for diagnosis.
- A run that stalls for more than two hours is stopped and counts as a failure. A
  failed run retries up to three more times, 30 minutes apart, then stops until a
  person resets the unit.
- The 24-hour RPO holds only while a verified backup completes within the window. If
  retries are exhausted, the newest complete snapshot ages past 24 hours until a run
  succeeds.
- Check the last run with `systemctl status restic-backup.service` and
  `journalctl -u restic-backup.service`. A `failed` state means retries are exhausted.
- Check the newest daily snapshot's age with the repository credentials in a subshell,
  as in step 3. If it is more than 24 hours old, the backup is stale:

  ```bash
  (
    set -a; . ./restic.env; set +a
    restic snapshots --tag daily --latest 1 --compact
  )
  ```

- To resume a stopped backup on the host, clear the failed state and start the
  service: `systemctl reset-failed restic-backup.service && systemctl start restic-backup.service`.
  Then confirm the new snapshot appears.
