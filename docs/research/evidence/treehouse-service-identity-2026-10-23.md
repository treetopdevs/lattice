# Treehouse relay service identity key: creation log (2026-10-23)

This records how the carrier service identity key for row 224 was created on the relay host. It
is an operator input to the catalog signer ceremony (`docs/treehouse_catalog_signer_custody.md`
§5.4, `--service-public-key`) under operator decision OD-1 (A), D-39: the existing carrier
instance identity file, shared by all Treehouse instances.

Claim tier: operations record only. The carrier is not deployed (R21b), so no running carrier has
used this key yet. Nothing here is catalogued, listed, or a production claim.

## Decisions settled in this session

| Item | Value | Why |
|---|---|---|
| Carrier host | `treehouse-relay-nyc3-1` (DigitalOcean nyc3, 159.65.180.40, Ubuntu 24.04.5) | Existing I1 host (PR #124). The binding names a DNS name and a key, not a machine, so the host is replaceable by restoring the key and repointing DNS. |
| Origin | `wss://treehouse-relay.rootaccess.to` | Existing DNS and Let's Encrypt certificate. Operator confirmed 2026-10-23 that this is the origin to keep. Changing it later needs R11c (`replace_catalog_v1`), which is not built. |
| Service key | New Ed25519 seed generated on the host | No carrier identity file existed yet. The seed never leaves the host except inside the encrypted restic backup. |

## Result

| Record | Value |
|---|---|
| Seed path | `/var/lib/treehouse-relay/service-identity.seed` |
| Owner, mode | `treehouse-relay:treehouse-relay` (uid 995, gid 986), `-rw-------`, 65 bytes, 1 link |
| Format | 64 lowercase hex characters plus a trailing newline (the `Manifest.read_identity_file` format) |
| **Service public key (base64)** | `qJ7tfzm+Gvc1O1lgfj/ZwdPgSAC/jcuxXMHoA2qVbB4=` |
| Fingerprint (SHA-256 of the 32 raw public-key bytes) | `e8b7dae1343e84cf66322387b585ba35d7dad3e3433258a18c16ba25540db07d` |
| Backup snapshot holding the seed | restic `03c546e0`, 2026-10-23 14:51:06 UTC, tag `daily` |
| Restore check | Seed restored from `03c546e0` into a temp directory on the host: bytes identical, same public key; temp removed |

The seed itself was never printed, copied off the host by hand, or seen by the agent. Every check
below inspects metadata, a character count, or the derived public key.

## Procedure and output

Commands were run by Claude over SSH as `root`, at the operator's request in this session. Times are UTC.

### 0. Pre-check: the derivation recipe (local, 14:4x)

The host has no Elixir, so the public key is derived with OpenSSL by wrapping the raw seed in the
fixed PKCS#8 Ed25519 prefix `302e020100300506032b657004220420`. Before touching the host, a
throwaway seed was checked locally: OpenSSL's result equalled
`LatticeCarrierServer.Manifest.identity_public_key/1` (`MATCH`). The throwaway seed was deleted.

### 1. Connect and read state (14:50:41)

`ssh treehouse-relay.rootaccess.to` failed with `Host key verification failed`: known_hosts has
no entry under the DNS name. It does have one under the IP (`ssh-ed25519 AAAAC3...ClUD`), and the
DNS name resolves to that IP, so every later command connected to `root@159.65.180.40` and was
checked against that stored key. No new host key was accepted.

```
treehouse-relay-nyc3-1
Ubuntu 24.04.5 LTS
OpenSSL 3.0.13 30 Jan 2024
/usr/bin/xxd
id: 'treehouse-relay': no such user
ls: cannot access '/var/lib/treehouse-relay': No such file or directory
restic-backup.timer   next Sat 2026-10-24 00:05:28 UTC, last Fri 2026-10-23 00:20:43 UTC
caddy: active
```

### 2. Create user, directory and seed (14:50:48)

```sh
useradd --system --home-dir /var/lib/treehouse-relay --shell /usr/sbin/nologin treehouse-relay
install -d -m 0700 -o treehouse-relay -g treehouse-relay /var/lib/treehouse-relay
sudo -u treehouse-relay sh -c "umask 077; set -C; openssl rand -hex 32 > /var/lib/treehouse-relay/service-identity.seed"
```

```
uid=995(treehouse-relay) gid=986(treehouse-relay) groups=986(treehouse-relay)
drwx------ 2 treehouse-relay treehouse-relay 4096 Oct 23 14:50 /var/lib/treehouse-relay
seed-created
```

### 3. Verify the file and derive the public key (14:50:57)

```sh
stat -c "%A %U:%G %s bytes %h link(s)" $F
head -c 64 $F | tr -d 0-9a-f | wc -c          # non-hex characters in the first 64
tail -c 1 $F | od -An -c                      # last byte
sh -c "umask 077; set -C; openssl rand -hex 32 > $F"   # must refuse
{ printf 302e020100300506032b657004220420; cat $F; } | xxd -r -p \
  | openssl pkey -inform DER -pubout -outform DER | tail -c 32 | base64
```

```
-rw------- treehouse-relay:treehouse-relay 65 bytes 1 link(s)
non_hex_chars_in_first_64: 0
last_byte: n        (od printed "\n"; xargs dropped the backslash. With 65 bytes and 64 hex, this is the newline.)
sh: 1: cannot create /var/lib/treehouse-relay/service-identity.seed: File exists
overwrite_refused_as_intended
public_key_base64: qJ7tfzm+Gvc1O1lgfj/ZwdPgSAC/jcuxXMHoA2qVbB4=
public_key_bytes: 32
fingerprint_sha256: e8b7dae1343e84cf66322387b585ba35d7dad3e3433258a18c16ba25540db07d
```

### 4. Back up (14:51:06)

`systemctl start restic-backup.service` ran `Result=success`, `ExecMainStatus=0`. The new snapshot
covers `/etc/caddy /var/lib/caddy /etc/restic /var/lib/treehouse-relay` (`backup.sh` adds the last
path when it exists).

```
03c546e0  2026-10-23 14:51:06  treehouse-relay-nyc3-1  daily
/var/lib/treehouse-relay
/var/lib/treehouse-relay/service-identity.seed
```

### 5. Restore check (14:51:19)

```sh
restic restore 03c546e0 --target $T --include /var/lib/treehouse-relay/service-identity.seed -q
cmp -s $T/var/lib/treehouse-relay/service-identity.seed /var/lib/treehouse-relay/service-identity.seed
```

```
Restored 4 / 1 files/dirs (65 B / 65 B)
restored_bytes_identical
restored_public_key: qJ7tfzm+Gvc1O1lgfj/ZwdPgSAC/jcuxXMHoA2qVbB4=
temp_removed
```

This restore ran on the host itself. It proves the snapshot copy is intact, not that a clean
machine can restore it; the PR #124 clean-machine drill covered the repository, not this file.

## Observations

- **Backup timer is still once a day.** `list-timers` shows the next run at 2026-10-24 00:17 UTC,
  24 hours after the last one. The twice-daily unit from PR #124 is not installed on the host, so
  that R21b item stays open. This session did not change it.
- **known_hosts lacks the DNS name.** SSH by name fails host-key verification; SSH by IP works.
  Adding the name to known_hosts after checking the key in the DigitalOcean console would fix that.

## Custody from here

- The seed is now binding-critical (OD-1): once the root signs the binding, a lost seed means a
  new Space until R11c exists. Its only off-host copy is the restic repository, so the restic
  password and Spaces key in 1Password are binding-critical too.
- If the droplet is rebuilt, restore this file from restic. Never generate a new one.
- When the carrier is deployed (R21b), the manifest instance's `identity_file` points at this path,
  and the carrier runs as `treehouse-relay`. Check then that its `carrier_hello` key equals the
  public key above.
- Ceremony use: `binding-payload --service-public-key qJ7tfzm+Gvc1O1lgfj/ZwdPgSAC/jcuxXMHoA2qVbB4=
  --origin wss://treehouse-relay.rootaccess.to`, with no `--service-id`.
