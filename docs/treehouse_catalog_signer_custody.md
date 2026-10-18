# Treehouse Catalog Signer Custody Runbook

This runbook covers the operator inputs of backlog row 224: a named custodian, a generated
catalog signer key, a separately held encrypted backup, a rehearsed restore on a second machine,
and a binding of that key to a Treehouse Space. It uses `mix treehouse.catalog_ceremony`
(`apps/lattice_carrier_server`).

## 1. Purpose and claim boundary

The catalog signer is the Ed25519 key that will sign the Treehouse `TransportCatalog`. The
Space root authors the one-time binding record (`catalog_bootstrap_v1`) that names this key as the
Space's `catalog_key`. Row 224 needs the key, its backup and its binding to exist and be
verified before the later phases can start.

What this ceremony proves:

- A signer key exists, and its public key and fingerprint are recorded.
- An encrypted backup of the seed exists on separate media, and a second machine decrypted it
  and re-derived the same public key.
- Custody is split between two different people.
- The binding payload for the Space root is prepared and, once the root can sign it,
  verified against the Space log.

What it does not prove or do:

- It does not make anything **catalogued** or **listed**. It is an operator ceremony record,
  not a catalogue phase. The carrier realm `treehouse-service:<service_id>` does not exist in the
  carrier server yet.
- The tool signs nothing in real mode. It proves possession by re-deriving the public key from
  the seed.
- It does not change D1: activation stays local-only. Nothing here is a production claim.

## 2. Roles

| Role | Holder | Holds |
|---|---|---|
| Custodian | _TBD, name before the ceremony_ | The signer seed file, the password manager item, the working machine |
| Backup passphrase holder | _TBD, must differ from the custodian_ | The backup passphrase only. Never the backup medium, never the seed |
| Rotation owner | _TBD_ | Authority to schedule and approve a planned rotation |

Rules:

- The custodian and the passphrase holder must be two different people. `report` refuses
  otherwise (`custody_not_split`).
- Nobody gives the seed or the passphrase to an AI agent, chat, ticket or CI job.
- The passphrase holder never keeps the passphrase beside any copy of the backup.

## 3. Materials and time

- Two machines. The generating machine should be offline-capable. The second machine is used
  only for the restore drill and must be a different host.
- A password manager (for the passphrase record, not for the seed).
- Two removable media: one for the encrypted backup, one spare copy of it.
- About 45 minutes, including the rehearsal.

Run every command from the repository root. Choose the directories before you start:

| Name | Meaning | Rules |
|---|---|---|
| `SIGNER` | Path of the seed file, e.g. `/Users/you/signer/catalog.seed` | Absolute, outside any git checkout, outside cloud-synced folders, parent directory mode 0700 and owned by you |
| `CEREMONY` | Directory for public artifacts, e.g. `~/catalog-ceremony` | Holds only public files. Created 0700 if absent. Not inside the signer directory |
| `BACKUP` | Path of the encrypted backup, on the removable medium | Not in the signer's directory, not in a git checkout |

## 4. Rehearse first

Run the whole flow once with throwaway keys before touching real material:

```bash
~/.asdf/shims/mix treehouse.catalog_ceremony dry-run --ceremony /tmp/catalog-rehearsal
```

`dry-run` needs a new or empty directory. It writes the marker `DRY-RUN-NOT-REAL`, derives every
key from a published label, builds a disposable bounded Space, and runs generate, backup,
verify-backup, binding-payload, verify-binding and report. Its report says `"mode": "dry_run"`
and its binding is `verified`. It keeps its disposable seed, backup, restored seed and Space logs in `disposable-signer/`,
`disposable-backup/`, `disposable-restore/`, `disposable-space-pre.log` and `disposable-space.log`
inside that directory, and prints `ceremony`, `marker`, `binding_payload_sha256`, `bootstrap_id`,
`report` and `report_sha256`. A non-empty directory is refused (`ceremony_not_empty`). Read the
artifacts so the real run holds no surprises.

Real-mode commands refuse the dry-run keys (`disposable_test_key`) and any ceremony directory
holding the marker (`dry_run_ceremony_dir`), so a rehearsal cannot be mistaken for the real thing.
Delete the rehearsal directory afterwards.

## 5. Ceremony steps

Every command that touches a secret takes an explicit path. There are no defaults and no
environment variables. The passphrase is read from stdin only, never from argv or the environment,
and only when stdin is a pipe or a file. If stdin is a terminal the tool refuses
(`passphrase_stdin_is_terminal`) before reading anything, because echo cannot be turned off
reliably from inside the Erlang VM. Section 5.2 shows the silent shell recipe that pipes the
passphrase in.

Secret paths (the seed, a restored seed, the backup) are resolved once to a canonical path, which
every later check and write uses, and are checked along that whole ancestor chain: every directory up to `/` must be a real directory owned by you or root and must
not be group- or other-writable unless it has the sticky bit (like `/tmp`). Files are created with
`O_EXCL`, then bound to the created inode (chmod 0600, then the path must still be that same
regular file with mode 0600 and one link) before any byte is written; a failure removes only the
file the tool made.

### 5.1 Generate (custodian, generating machine)

```bash
mkdir -m 0700 -p "$(dirname "$SIGNER")"
~/.asdf/shims/mix treehouse.catalog_ceremony generate --signer "$SIGNER" --ceremony "$CEREMONY"
```

This creates a new random 32-byte seed with `O_EXCL` and mode 0600, refusing an existing file
(`signer_exists`). It also writes `CEREMONY/signer.json`
(`lattice-catalog-signer-public-v1`) and prints the public key and its SHA-256 fingerprint.
The seed file holds 64 lowercase hex characters followed by one newline, the format
`LatticeCarrierServer.Manifest.read_identity_file` accepts. It is never printed. Stdout carries
`fingerprint_sha256`, `public_key_base64`, `public_key_hex` and `signer_record` (the path of
`signer.json`). `CEREMONY` is created with mode 0700 if absent.

Refusals you may see: `signer_path_required`, `signer_symlink`, `unsafe_signer_directory` (parent
not a real directory owned by you with no group/other bits), `signer_in_git_checkout` (any ancestor
holds `.git`), `signer_ceremony_overlap` (the ceremony directory is inside the signer's parent, or
the signer is inside the ceremony directory; symlinks are resolved), `signer_record_exists`
(`CEREMONY/signer.json` already exists), `signer_exists` (the seed path exists),
`signer_unwritable`, `signer_unreadable` (an existing seed must be a regular file with a single link, owned by you, mode 0600), `ceremony_directory_invalid`, `disposable_test_key`,
`dry_run_ceremony_dir`. An existing `CEREMONY` must be owned by you with no group or other
permission bits (`ceremony_directory_invalid`), and its ancestors must pass the chain rule above.
Artifacts are written through an exclusively created, uniquely named temporary file and renamed, so
a planted link never redirects a write. If the seed is written but `signer.json` then fails to
write (`ceremony_write_failed`), the tool deletes the seed it just created (only that inode) and
refuses; run `generate` again. A catalog signer key that equals a dry-run key is refused wherever a
`signer.json` is loaded (`disposable_test_key`).

Record the fingerprint in the table in section 7.

### 5.2 Encrypted backup (custodian, then passphrase holder)

The passphrase holder chooses a passphrase of 20 to 1024 characters and keeps it out of the
password manager entry for the seed and off the backup medium. It must be **printable ASCII only**
(bytes 0x20 to 0x7E, so letters, digits, space and punctuation; no accents, emoji or control
characters; `passphrase_not_ascii` otherwise). The reason: the key is PBKDF2 over the exact
passphrase bytes, and an independent recovery (section 6) must derive the same bytes whatever the
keyboard, locale or Unicode normalization. The tool strips only the trailing line break (`\n` or
`\r\n`) and reads two lines from stdin, one per entry.

The tool will not read a passphrase from a terminal. Type it into your own shell with `read -s`
(no echo) and pipe it in. `printf` is a shell builtin, so the passphrase is not in any process
argument list, and `read -rs` does not echo or enter shell history. Run this yourself, in your own
terminal:

```bash
IFS= read -rs P1; echo; IFS= read -rs P2; echo
printf '%s\n%s\n' "$P1" "$P2" | ~/.asdf/shims/mix treehouse.catalog_ceremony backup \
  --signer "$SIGNER" --ceremony "$CEREMONY" --out "$BACKUP"; unset P1 P2
```

Type the passphrase at each silent `read`; the tool refuses `passphrase_mismatch` if the two
entries differ. The restore drill in 5.3 then proves the holder's own copy decrypts the backup.

`backup` needs `CEREMONY/signer.json` from step 5.1 and re-reads the seed from `SIGNER` (the
seed must derive the recorded public key, else `signer_key_mismatch`; an unreadable or
policy-violating seed file is `signer_unreadable`). The `BACKUP` file is created with `O_EXCL` and
mode 0600. Its directory and every ancestor must be owned by you or root and must not be group- or
other-writable without the sticky bit (`backup_directory_unavailable`), because nobody else may be
able to swap the file between its creation and its chmod. A removable volume mounted by macOS with
ownership ignored shows as yours; otherwise make a 0700 directory on the medium first.

Stdout carries `bytes`, `public_key_base64`, `sha256` and `backup_record` (the path of
`backup.json`). Refusals: `passphrase_mismatch`, `passphrase_too_short` (under 20 characters), `passphrase_too_long`
(over 1024), `passphrase_not_ascii`, `passphrase_stdin_is_terminal`, `passphrase_unreadable`, `backup_path_required`, `backup_symlink`, `backup_directory_unavailable`,
`backup_in_git_checkout`, `backup_beside_signer` (inside the signer's directory tree),
`backup_exists`, `backup_unwritable`, `signer_key_mismatch`, `signer_unreadable`. The tool decrypts
the new file in memory and checks the public key (`backup_self_check_failed` deletes the file). It
records `CEREMONY/backup.json` (`lattice-catalog-backup-record-v1`: `backup_format`,
`kdf_iterations`, `sha256` of the backup bytes, `bytes`, `created_at`, `public_key_base64`).

Copy the backup to both removable media and store them apart from the generating machine. Hand
the passphrase to its holder through a different channel from any channel that carried the file.
Never type the passphrase into a command line, a script or a chat; the `read -rs` recipe above
keeps it out of argv.

### 5.3 Verify the backup on a second machine

Copy `CEREMONY` (public artifacts) and the backup to a different host. The seed file is **not**
copied and is not read. The command does not need it.

The copied backup on the second machine follows the secret-path policy: it must be owned by the
verifying user with mode 0600 (`chmod 600 BACKUP`), a single link, in a directory that is mode 0700
and whose ancestors nobody else can write, outside any git checkout. Otherwise `verify-backup`
refuses with `backup_unreadable`, `backup_directory_unavailable` or `backup_in_git_checkout`.
`signer.json`, `backup.json` and `restore.json` must be the complete records the tool wrote, with
exactly their keys and value shapes (a hand-edited `separate_host` that disagrees with the two host
names, or any extra or malformed field, is refused with `ceremony_artifact_malformed`).

```bash
IFS= read -rs P; printf '%s\n' "$P" | ~/.asdf/shims/mix treehouse.catalog_ceremony verify-backup \
  --backup "$BACKUP" --ceremony "$CEREMONY"; unset P
```

The passphrase holder types the passphrase once (same terminal rule and ASCII rule as 5.2). The tool checks the backup digest against
`backup.json` (`backup_digest_mismatch`), decrypts (`backup_decrypt_failed`), derives the public
key and compares it with `signer.json` (`backup_key_mismatch`). Other refusals:
`backup_unreadable`, `backup_path_required`, `malformed_backup`, `ceremony_artifact_missing`
(no `signer.json` or `backup.json` in `CEREMONY`). It writes `CEREMONY/restore.json`
(`ok`, `backup_sha256`, `public_key_base64`, `verified_at`, `host`, `generation_host`,
`separate_host`, `seed_restored`). `separate_host` is true only when this host's name differs from
`generation_host`. That is a hostname comparison and nothing more: the tool cannot prove the second
machine is physically or administratively separate. The restore drill is attested by the named
people in the report, not proven by the tool. Stdout carries `ok`, `backup_sha256`, `public_key_base64`, `separate_host`,
`seed_restored` and `restore_record`. Copy `restore.json` back to the generating machine's
ceremony directory.

If the drill should also restore a working signer, add `--restore-to NEWSIGNER` (same path rules
as `SIGNER`, `O_EXCL`, mode 0600; the written seed is read back and its public key re-derived,
`restore_check_failed` otherwise, and the file just made is removed, as it is if `restore.json` cannot be written, `ceremony_write_failed`). `NEWSIGNER` must not be in the backup file's directory tree (`restore_beside_backup`, checked before the passphrase is read). Do that only in the loss procedure in section 8; a drill should
end by deleting any restored seed.

### 5.4 Binding payload (custodian)

The binding names the catalog key, a service key, and the carrier origin for one Space. The
Space log is the Space's signed op log exported to a file.

```bash
~/.asdf/shims/mix treehouse.catalog_ceremony binding-payload \
  --ceremony "$CEREMONY" --space-log "$SPACE_LOG" \
  --service-public-key "$SERVICE_PUBKEY_B64" --origin "wss://relay.example:443" \
  [--service-id "$SERVICE_ID"]
```

The tool restores the log with verification and requires a bounded Space profile. It derives the
Space id, root, profile genesis and profile id from the log, takes `catalog_key` from
`signer.json`, and makes a fresh nonce (and a fresh service id when you give none). `SERVICE_PUBKEY_B64`
is the base64 of 32 raw bytes. It refuses a log that does not verify (`invalid_space_log`,
`space_log_required`), a non-bounded Space (`space_not_bounded_profile`), any two of catalog key,
service key and Space root being equal (`binding_key_reuse`), and an invalid key, service id, record
or origin (`malformed_binding`). It writes `binding-payload.json`
(`lattice-catalog-bootstrap-payload-v1`: `record`, `record_encoding`, `canonical_base64`, `sha256`
of the canonical bytes) and `binding-review.txt`, a plain sheet with every field. If the review sheet cannot be written the payload just written is removed (`ceremony_write_failed`).
Stdout carries `binding_payload_sha256`, `payload` and `review_sheet` (paths).

`verify-binding` and `report` refuse a payload without its `binding-review.txt` beside it
(`ceremony_artifact_missing`). Two people read `binding-review.txt` field by field against the intended Space and relay before
anyone signs it.

**Honest status of the signing step.** The Space root must author this record as the Space command
`catalog_bootstrap_v1`. Today the Tauri app creates legacy-family Spaces and has no
`catalog_bootstrap_v1` command, so the real root cannot sign a valid binding yet (tracked as
row 232). `binding-payload` refuses such a Space with `space_not_bounded_profile`. Until row 232
lands, finish steps 5.1 to 5.3 and produce the report with the binding pending (section 5.6).
Do not hand-craft or sign the record outside the product.

### 5.5 Verify the binding (after the root has signed)

```bash
~/.asdf/shims/mix treehouse.catalog_ceremony verify-binding \
  --ceremony "$CEREMONY" --space-log "$SPACE_LOG"
```

The tool observes the Space log for honored bootstrap records. It requires exactly one whose
normalized record equals the payload and whose author is the Space root. No match is
`binding_not_found`; more than one distinct honored record is `binding_fork`. On success it writes
`CEREMONY/binding.json` (`lattice-catalog-binding-record-v1`: `bootstrap_id`, `record_sha256`,
`space`, `verified_at`). Stdout carries `bootstrap_id`, `record_sha256`, `space` and
`binding_record`. Other refusals: `space_log_required`, `invalid_space_log`,
`ceremony_artifact_missing`, `ceremony_artifact_malformed`, `ceremony_inconsistent`.

### 5.6 Report

```bash
~/.asdf/shims/mix treehouse.catalog_ceremony report --ceremony "$CEREMONY" \
  --custodian "NAME" --passphrase-holder "OTHER NAME" --rotation-owner "NAME"
```

Names are trimmed, must be non-empty, at most 80 characters and contain no control characters
(`malformed_custody_name`). The report requires `restore.json` with `ok: true`
(`restore_not_verified`), in a real ceremony a restore whose `separate_host` is true
(`restore_not_separate_host`; a dry-run report records the value as it is), and a custodian different from the passphrase holder, compared
case-insensitively (`custody_not_split`). It re-checks that signer, backup and restore agree on the
public key, backup digest, format and iteration count (`ceremony_inconsistent`) and writes
`CEREMONY/verification-report.json` (`lattice-catalog-ceremony-report-v1`: `mode`, `signer`,
`backup` {`sha256`, `format`, `kdf_iterations`}, `restore` {`verified_at`, `separate_host`},
`custody`, `binding`, `generated_at`, `claim`). Stdout carries `report` (path) and `report_sha256`.

While row 232 is open, the report carries
`"binding": {"status": "pending_root_signature", "payload_sha256": <hex or null>, "blocker": "row 232"}`
(`payload_sha256` is null when no `binding-payload.json` exists). After a successful
`verify-binding`, rerun `report`; it overwrites the file and the binding becomes
`{"status": "verified", "bootstrap_id", "record_sha256", "space"}`. A `binding.json` that does not
match the payload makes `report` refuse with `ceremony_inconsistent`. Never edit the report by hand.

## 6. Independent recovery recipe

The backup must be recoverable without this repository. The file is one JSON object:

```json
{
  "format": "lattice-catalog-signer-backup-v1",
  "public_key_base64": "...",
  "kdf": {"name": "pbkdf2-hmac-sha256", "iterations": 600000, "salt_base64": "..."},
  "cipher": {"name": "aes-256-gcm", "nonce_base64": "..."},
  "ciphertext_base64": "...",
  "tag_base64": "..."
}
```

- Key: PBKDF2-HMAC-SHA256 over the passphrase bytes (printable ASCII, so UTF-8 and ASCII agree) with the decoded salt (16 bytes),
  600000 iterations, 32-byte output.
- Cipher: AES-256-GCM, 12-byte nonce, 16-byte tag. The plaintext is the raw 32-byte seed.
- **AAD** is the exact UTF-8 bytes of the header: the object above **without** `ciphertext_base64`
  and `tag_base64`, serialized compactly (no whitespace) with keys sorted lexicographically at
  every level, as Jason encodes it. For the object above that is, in order:
  `cipher`{`name`,`nonce_base64`}, `format`, `kdf`{`iterations`,`name`,`salt_base64`},
  `public_key_base64`. Slashes are not escaped. The tool built the AAD with `Jason.OrderedObject`
  and its test rebuilds it by string concatenation; the Python below produces the same bytes.
- The reader accepts exactly these keys, this format, KDF name, iteration count (600000) and cipher
  name; anything else is `malformed_backup`.

```python
# pip install cryptography   (run with: python3 -I recover.py BACKUP)
import base64, getpass, hashlib, json, sys
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

b = json.load(open(sys.argv[1]))
assert b["format"] == "lattice-catalog-signer-backup-v1"
assert b["kdf"]["name"] == "pbkdf2-hmac-sha256" and b["kdf"]["iterations"] == 600000
assert b["cipher"]["name"] == "aes-256-gcm"

header = {k: v for k, v in b.items() if k not in ("ciphertext_base64", "tag_base64")}
aad = json.dumps(header, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()

pw = getpass.getpass("passphrase: ").encode()
key = hashlib.pbkdf2_hmac("sha256", pw, base64.b64decode(b["kdf"]["salt_base64"]), 600000, 32)
ct = base64.b64decode(b["ciphertext_base64"]) + base64.b64decode(b["tag_base64"])
seed = AESGCM(key).decrypt(base64.b64decode(b["cipher"]["nonce_base64"]), ct, aad)
assert len(seed) == 32
print("seed recovered; compare the public key out of band, do not print the seed")
# Derive the public key (cryptography): 
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization as s
pub = Ed25519PrivateKey.from_private_bytes(seed).public_key().public_bytes(
    s.Encoding.Raw, s.PublicFormat.Raw)
assert base64.b64encode(pub).decode() == b["public_key_base64"], "wrong key"
print("public key matches")
```

Write the recovered seed to a 0600 file in a 0700 directory only if you are restoring the signer.
Write the seed as 64 lowercase hex characters plus a newline. Prefer
`verify-backup --restore-to`, which applies the path checks.

## 7. Records and what is committed

Fill these in at the ceremony.

| Record | Value |
|---|---|
| Public key (base64) | _record_ |
| Fingerprint (SHA-256 of public key) | _record_ |
| Backup file SHA-256 | _record_ |
| Media locations | _record_ |
| Passphrase holder confirmed receipt | _date_ |

| Drill date | Performed by | Second host differs | Public key matches | Notes |
|---|---|---|---|---|
| _date_ | | ☐ | ☐ | |

Commit only:

- `verification-report.json`
- the public `signer.json`

Never commit the seed, the backup, the passphrase, or the rest of the ceremony directory unless
reviewed. The seed and backup never enter a git checkout; the tool refuses to write them in one.

## 8. Rotation and loss

- **Planned rotation:** a `TransportCatalog` rotation record signed over the old and new
  catalog keys. That record type lands in a later slice; until then, rotation is not available.
  Run this ceremony again for the new key and have the rotation owner approve the date.
- **Seed lost, backup intact:** run `verify-backup --backup BACKUP --ceremony CEREMONY
  --restore-to NEWSIGNER` on a trusted machine, then
  continue with `NEWSIGNER`; `signer.json` already holds the unchanged public key, so the binding
  stays valid. `import --signer NEWSIGNER --ceremony CEREMONY` is for a ceremony directory that has
  no `signer.json` (it writes one with `imported: true`); with an existing `signer.json` it refuses
  `signer_record_exists`.
- **Seed and backup both lost:** the key cannot be recovered. Replacement is the R11c procedure,
  which is not built. Record the incident and stop publishing under this catalog key.
- **Suspected exposure:** treat as loss. Stop use, tell the rotation owner, record it.

## 9. Prohibitions

- No AI agents, chat, tickets or CI jobs ever see the seed or the passphrase. Nothing here runs
  in CI.
- The seed never lives in a git checkout, a cloud-synced folder, or beside its backup.
- Never pass a passphrase in argv or in the environment. Stdin only, from a pipe, never a terminal.
- Never use a dry-run key, directory or output as real material, and never the reverse.
- Never hand-sign the binding outside the product to get past row 232.
