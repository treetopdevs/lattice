#!/bin/sh
# Installs the daily restic backup on treehouse-relay. Run once as root on the host,
# after copying this directory and restic.env to /root/treehouse-backup/.
set -eu

src=/root/treehouse-backup

install -d -m 700 /etc/restic
install -m 600 "$src/restic.env" /etc/restic/env
shred -u "$src/restic.env" 2>/dev/null || rm -f "$src/restic.env"

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -y upgrade
apt-get install -y restic unattended-upgrades

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

install -m 0755 "$src/backup.sh" /usr/local/sbin/treehouse-backup
install -m 0644 "$src/restic-backup.service" /etc/systemd/system/restic-backup.service
install -m 0644 "$src/restic-backup.timer" /etc/systemd/system/restic-backup.timer
systemctl daemon-reload
systemctl enable --now restic-backup.timer

# Create the repository once. Later runs find it already initialised.
set -a
# shellcheck source=/dev/null
. /etc/restic/env
set +a
restic cat config >/dev/null 2>&1 || restic init

# First backup now, so the result is visible without waiting for the timer.
systemctl start restic-backup.service
systemctl is-active caddy
restic snapshots --compact
