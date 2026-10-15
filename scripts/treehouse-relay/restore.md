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
   are not selected by this runbook:

   ```bash
   set -a; . ./restic.env; set +a
   restic snapshots --tag daily --compact
   ```

4. Restore the latest daily snapshot into a new temporary directory. `mktemp -d`
   makes a fresh directory on every run, so files from an earlier attempt cannot mix in:

   ```bash
   RESTORE_DIR=$(mktemp -d)
   restic restore latest --tag daily --target "$RESTORE_DIR"
   ```

5. Check the restored Caddy config against the config the host was built with:

   ```bash
   diff "$RESTORE_DIR/etc/caddy/Caddyfile" <(printf '%s\n' \
     'treehouse-relay.rootaccess.to {' \
     '  respond "Treehouse relay host: no service is deployed yet" 503' \
     '}')
   ```

   The diff is empty if the Caddyfile is intact. The `printf` text is the
   cloud-init content, so the check also flags any later hand edit.

6. Remove the restored copy and the local env file once the check passes:

   ```bash
   rm -rf "$RESTORE_DIR" ./restic.env
   ```

## Restore on the host

Stop Caddy first if the restore replaces `/etc/caddy` or `/var/lib/caddy`:
`systemctl stop caddy`. Restore into a staging directory, check it, then move the
files into place and start Caddy again. Do not restore `/etc/restic` over the live
copy unless the env file is lost.

## Schedule and retention

- Daily at a randomized time within 30 minutes of midnight UTC, `Persistent=true`.
- Keep 7 daily, 4 weekly and 6 monthly snapshots; older ones are pruned.
- Check the last run with `systemctl status restic-backup.service` and
  `journalctl -u restic-backup.service`.
