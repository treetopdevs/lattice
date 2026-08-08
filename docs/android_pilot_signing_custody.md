# Android Pilot Signing-Key Custody Runbook

This runbook satisfies Plan 158's "Android distribution" external prerequisite: named custodian,
pilot aliases, pinned certificate fingerprints, keystore/password CI secrets, a separately
encrypted signing-key backup, and a rehearsed backup/restore/rotation record. It covers internal
pilot distribution only — no Play Store, no Play App Signing, no production claim.

Custody model is **split-backup single custodian**: one operational custodian holds the working
keystore; the encrypted backup lives on separate media whose passphrase is held by a second
person. Neither party alone can lose the key silently, and no vendor account is a single point of
failure.

## 1. Roles

| Role | Holder | Holds |
|---|---|---|
| Custodian | Nicholas Zographos | Working keystore + passwords (1Password), CI secret administration, rotation authority |
| Backup passphrase holder | _TBD — name before first distribution_ | The backup passphrase only (never the backup media, never the keystore) |

Rules:

- The custodian never gives the working keystore or its passwords to anyone, including AI agents
  and CI logs. CI receives them only as GitHub Actions secrets.
- The passphrase holder never stores their passphrase alongside any copy of the backup.
- Naming the passphrase holder is a **blocking prerequisite** for the first distributed artifact,
  not for development.

## 2. Inventory

One keystore container per product, one alias each (Plan 158 allows a shared container; separate
files keep CI mounting exactly one product's key and make cross-product signing structurally
impossible):

| Product | Keystore file | Alias | Pinned SHA-256 cert fingerprint |
|---|---|---|---|
| Township | `township-pilot-v1.jks` | `township-pilot-v1` | _record after generation_ |
| Toolshed | `toolshed-pilot-v1.jks` | `toolshed-pilot-v1` | _generate before Toolshed candidate_ |
| Treehouse | `treehouse-pilot-v1.jks` | `treehouse-pilot-v1` | _generate before Treehouse candidate_ |

Only Township is needed for Wave A1. Generating the other two later uses this same ceremony.

## 3. Generation ceremony (custodian, offline, never on CI)

On the custodian's machine, in a directory that is not a git checkout and not cloud-synced:

```bash
keytool -genkeypair -v \
  -keystore township-pilot-v1.jks \
  -alias township-pilot-v1 \
  -keyalg RSA -keysize 4096 \
  -validity 10950 \
  -dname "CN=Township Pilot, O=Treetop Devs, C=US"
```

- Generate the store and key passwords in 1Password first (distinct, ≥24 random chars each);
  enter them at the prompts. Never pass passwords as command-line flags (shell history).
- Record the fingerprint and update the inventory table above (the pinned value is public and is
  committed; the keystore never is):

```bash
keytool -list -v -keystore township-pilot-v1.jks -alias township-pilot-v1 | grep 'SHA256:'
```

## 4. Working copy (1Password)

One 1Password item per product: the `.jks` as a document attachment, store password, key
password, alias, and the SHA-256 fingerprint in the notes. Delete the plaintext `.jks` from disk
after the backup in §5 is verified — the working copy lives in 1Password, the durable copy on
backup media.

## 5. Separately held encrypted backup

1Password must never be the only copy. Create the split backup:

```bash
# Fresh passphrase — generated, spoken/handed to the passphrase holder out of band,
# and NOT stored in 1Password or on the backup media.
age -p -o township-pilot-v1.backup.age township-pilot-v1.jks   # prompts for the passphrase
shasum -a 256 township-pilot-v1.backup.age                     # record this digest below
```

(GPG symmetric — `gpg -c` — is an acceptable substitute for `age`.)

- Include a small manifest inside the encrypted bundle if desired (alias, fingerprint, date), but
  **not** the store/key passwords: those live in 1Password; the backup protects against keystore
  loss, 1Password loss is mitigated by 1Password's own recovery. If custodian wants the backup to
  survive total 1Password loss too, put the passwords in the encrypted bundle — accepted
  trade-off, note it in the record table.
- Copy `*.backup.age` to at least one offline medium (USB drive) stored physically separate from
  the custodian's daily machine. A second copy in an unrelated cloud account is optional.
- Hand the passphrase to the backup passphrase holder via a separate channel from any channel
  carrying the backup file.

| Record | Value |
|---|---|
| Backup file SHA-256 | _record_ |
| Media locations | _record_ |
| Passphrase holder confirmed receipt | _date_ |

## 6. Restore drill (required BEFORE first distribution)

On a machine other than the one that generated the key:

1. Obtain the backup file from its media and the passphrase from its holder.
2. `age -d township-pilot-v1.backup.age > restored.jks`
3. `keytool -list -v -keystore restored.jks -alias township-pilot-v1` — the SHA-256 fingerprint
   must equal the pinned value in §2.
4. Securely delete `restored.jks` (`rm -P` / disk-level).
5. Record the drill:

| Drill date | Performed by | Fingerprint match | Notes |
|---|---|---|---|
| _date_ | | ☐ | |

## 7. CI secrets (GitHub Actions)

Use a protected **environment** (suggested name `android-pilot`) so only the release job on
approved branches can read the secrets; plain repo secrets are the fallback if environment
protection is not configured.

| Secret / variable | Kind | Content |
|---|---|---|
| `TOWNSHIP_PILOT_KEYSTORE_B64` | secret | `base64 < township-pilot-v1.jks` |
| `TOWNSHIP_PILOT_KEYSTORE_PASSWORD` | secret | store password |
| `TOWNSHIP_PILOT_KEY_PASSWORD` | secret | key password |
| `TOWNSHIP_PILOT_KEY_ALIAS` | variable | `township-pilot-v1` |
| `TOWNSHIP_PILOT_CERT_SHA256` | variable | pinned fingerprint (public; CI verifies the built APK against it) |

Upload without touching shell history or chat:

```bash
base64 -i township-pilot-v1.jks | gh secret set TOWNSHIP_PILOT_KEYSTORE_B64 --env android-pilot
gh secret set TOWNSHIP_PILOT_KEYSTORE_PASSWORD --env android-pilot   # paste at hidden prompt
gh secret set TOWNSHIP_PILOT_KEY_PASSWORD --env android-pilot        # paste at hidden prompt
gh variable set TOWNSHIP_PILOT_KEY_ALIAS --env android-pilot --body "township-pilot-v1"
gh variable set TOWNSHIP_PILOT_CERT_SHA256 --env android-pilot --body "<pinned fingerprint>"
```

The signing path must fail closed when these are absent — absence of secrets can never produce a
debug-signed artifact labeled release-pilot (see Plan 158 stop conditions).

## 8. Rotation and loss

Android in-place upgrades require the same signer. With internal distribution there is no
Play-style key upgrade, so **any certificate change forces pilot users to uninstall/reinstall**
(losing local app data unless exported first). Plan rotation accordingly:

- **Planned rotation:** generate `township-pilot-v2` via §3–§7, pin the new fingerprint by PR,
  announce a reinstall window to pilot users, retire the old secrets after the last v1 build.
- **Keystore lost, backup intact:** restore per §6, re-upload secrets. No user impact.
- **Keystore and backup both lost:** treat as rotation — new key, reinstall ceremony. Record the
  incident.
- **Suspected compromise:** stop distribution immediately (disable the CI environment), rotate,
  reinstall ceremony, record the incident. The pinned-fingerprint check in CI is the tripwire for
  artifacts signed by an unexpected key.

## 9. Prohibitions (Plan 158)

- Debug keys never enter the pilot lineage; `CN=Android Debug` on a distributed artifact is a
  program stop condition.
- The keystore is never committed, never generated on CI, never printed to logs, and never
  handled in plaintext by AI agents or chat.
- Cross-product signing (a Township artifact signed by a Toolshed/Treehouse alias or vice versa)
  is refused in CI.
