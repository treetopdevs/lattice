# Plan 263: catalog publication with an off-host custodian

## Status and scope

Implementation packet prepared 2026-10-24 from main
`ba7f23f49bff3257f57747ae6a0766e4786eb2c6`, after merged PRs #165 and #166.
Execution rebased onto `187cc3d8a77242cbca0fa1d6916af10fc1d6ef0c` after #167;
all 29 implementation files were byte-identical across rebase.
Implements plan 224 PR 4 in full: prepare, independent custodian verification/signing,
commit, and crash-safe `catalogued` publication. Shared read-only release review is
implemented, together with authenticated public histories and the signing package
verifier. Custodian ledger/signing APIs now have replay, refusal and kill-boundary
tests and CLI controls. Relay prepare/commit now have live pending/initial-reference
rehearsals. Carried-entry and 13/14 capacity rehearsals pass; the relay command
adapter and restaging status guard are implemented. Final crash tests pass locally
and on Linux. Independent reviews and Sonnet fallback confirmation have no remaining
P1/P2; final frozen-tip verification and hosted checks remain.
Custody P1 fixes are confirmed; this is not yet a completed publication slice.
The unified roadmap is the execution ledger. D-47 records the delegated decisions.

Software acceptance uses disposable keys and real-mode ceremony fixtures, the production
operator owner, and real authenticated route probes. No absent operator secret, physical
host or public relay is needed for these tests. The operator's actual ceremony report,
second-host backup and public relay remain operational prerequisites in plan 224.
`listed`, native catalog trust and two ordinary apps over public WSS remain later work.

## Rebaseline and invariants

Read plans/README.md, plan 224 Designs 3–5, plan 262 and lifecycle §5 first.
Run `git log --oneline 187cc3d8a..HEAD -- scripts/treehouse_operator_mutation.py
apps/lattice_carrier_server/lib apps/lattice_core/lib/treehouse` before implementation.
Plan 224's older baseline predates its merged realm, store and initial-reference work;
those changes, plus merged ordinary offline enrollment #167, are accepted prerequisites here. Unexplained subsequent journal, manifest,
owner, catalog or authority changes require reconciling this packet before implementation.
Do not change Authority, Wire, signed catalog bytes, trust rules or client networking.

- Relay host never reads the catalog seed. It prepares public evidence and verifies the
  returned signature against the root-bound catalog key before invoking the owner.
- Existing `TransportCatalog`, `CatalogEntries`, `CatalogBinding` and `CatalogStore`
  judgments remain authoritative. No caller-supplied ready/verified flag substitutes.
- `CatalogBinding` already separates Space root, catalog key and service key. Reuse it.
- Python owns operator filesystem mutations under its lifetime lock. BEAM reviews and
  requests a derived transition; no alternate journal or catalog writer is introduced.
- Every committed revision carries all prior entries unchanged. Maximum 13 total entries;
  no replica or route reassignment across the verified store, even after retirement.
- Initial-existing references are observed exactly and never appended again. Ordinary
  staged references are authenticated as hypothetical pending operations until listing.
- `catalogued` is a checked observation, not client trust, delivery, live readiness or
  publication of a pending reference into the Space. Keep that distinction in output.

## Ownership and public API

Existing files are below `apps/lattice_carrier_server/lib/lattice_carrier_server/operator/`.

1. Extract a shared read-only publication review from `release_readiness.ex` so confirm
   and publication use one guarded-deployment, manifest, roster, binding and route-probe
   implementation. Keep `confirm/4` behavior and refusal compatibility. Publication
   requires exact raw `expected` journal bytes at `ready`, matching loaded manifest and
   incarnation, health, reviewed relay realms and current roster. Reload binding after
   probes. Re-read and revalidate served logs after probes, returning that later snapshot
   and its frontiers. Use phase-specific roster drift atoms. Probe keys must differ
   from catalog/service/Space/Thread roots. Read logs through durability locks.
2. Add `ReleaseCatalog.prepare(root, expected, ceremony_dir, probe_file, custodian_status)`: construct C
   deterministically and return a closed public signing package plus a review sheet.
   Prepare also requires the public custodian ledger status, including any pending C;
   only that same pending C may be prepared. Export status under the custodian lock.
   Restaging an existing ready/catalogued/listed attempt requires Staging.prepare/6
   with that status, checked inside the owner-held inspection.
   No journal/store mutation or private signing occurs. CLI writes a new exclusive
   output file; same bytes may replay, conflicting output refuses.
3. Add `CatalogCeremony.SignCatalog.review/2` and `.sign/4`, exposed by ceremony CLI
   commands `review-catalog` and `sign-catalog`. Review never reads the seed. Signing
   requires the exact reviewed catalog digest as explicit confirmation and independently
   validates the package and custodian's own verified ceremony binding/report.
4. Add `ReleaseCatalog.commit(root, expected, ceremony_dir, probe_file, package_file, envelope_file)`:
   rebuild all observations and C, verify exact C and signature, then call existing
   `Lock.catalogued/6`. Never accept a catalog solely because prepare once succeeded.
5. CLI and runbook show prepare → transfer public package → review → confirm/sign →
   transfer envelope → commit. Refusals are atom-only; no key material, seed path or
   secret-bearing exception inspection enters logs or review sheets.

## Signing package and independent evidence

Use a closed versioned format, `treehouse-catalog-signing-v1`. It contains C, its
SHA-256 over `TransportCatalog.catalog_bytes/1`, reference mode and exact signed
reference, plus authenticated public histories for every entry. It carries no seed,
secret path, route authorization assertion or installed-trust receipt.

Define one canonical JSON encoder/decoder with sorted keys and exact re-encode equality;
reject duplicate/unknown keys, alternate encodings, trailing data, invalid UTF-8 and
noncanonical frame leaves. Decode through existing Wire and Log verification, including
content ids, signatures, complete dependencies and unique sorted frame ids. Extract the
shared verified public-history codec from SpaceExport/InitialBundle instead of copying
crypto or weakening their current closed formats. Existing formats remain byte compatible.

Resource contract: at most 13 histories, one per catalog entry; at most 4,000 frames and
16 MiB canonical JSON per history (existing export limits), at most 64 MiB aggregate
package bytes, at most 128 KiB metadata excluding history payloads, and existing 64,000
byte per-frame push bound. Bound total bytes before JSON parsing; count histories/frames and history bytes after
the bounded parse, before Wire/crypto replay. Fail before output/signature.
The aggregate cap is a deliberate software resource limit, independent of the ordinary
app's 1 MiB store limit; it supports carried entries and does not claim every possible
13-entry maximal history fits. Explain capacity refusal without truncating evidence.

Both operator and custodian recompute entries and call `CatalogEntries.observe/2` over
all supplied logs. Exactly one Space and all carried/new Thread histories are required;
reject missing, duplicate or unrelated profiles. Observe the signed staged reference in
the hypothetical Space for normal mode; for `initial_existing`, require its exact bytes
already honored in the actual Space, an empty committed catalog head and the initial
journal provenance. The custodian verifies the root-bound bootstrap against its own
ceremony binding/report, not merely a matching key supplied inside the package.
Complete histories expose chat plaintext to the custodian and its backup readers.
Do not advertise this transfer as metadata-only. Keep complete evidence: pruning
ancestry can omit revocations/beacons and change Authority judgments. Busy histories
can exhaust these explicit limits and block further catalogs until a separately
designed scalable evidence format exists; never silently drop chat or authority ops.
The package digest is not independent authorization: the review sheet names binding,
revision/previous, complete inventory and, for new entries, replica/root/route/reference.
Print each history frontier digest and frame count. Commit requires current histories
to extend the reviewed snapshot and independently evaluates their current authority.

## Catalog construction and store checks

Verify the entire store with the root-bound key. Committed head must equal the journal
head. For first publication C has revision 0, previous nil, the exact bootstrap binding,
Space entry and new Thread entry. Later C extends the head by exactly one Thread entry,
retaining all prior entries exactly; verify every carried route and history too.
Previously carried references must already be actual and honored: listing (PR 5) or
genuine client delivery precedes later publication. Only the new staged reference is
hypothetical. A missing old reference refuses; capacity fixtures publish exact client
frames between revisions and do not prove a listed receipt.
Root, genesis, creation, reference and route come from reviewed actual logs/instances,
never caller summaries. Route/replica reuse checks inspect all stored revisions.
A single pending envelope must describe this exact rebuilt C; another fork refuses.
Use existing catalog canonical/signature format and id semantics unchanged.

## Custodian crash safety and replay

A new private, per-binding signing ledger lives beside public ceremony artifacts, never
on the relay. Seed storage and backup rules remain those of Signer/Paths. Managed seed
identity must match the custodian's verified binding. No seed auto-generation or reset.

Serialize cross-process signing with an OS lifetime file lock, not a BEAM-only mutex or
create/delete lock sentinel. A small Python filesystem owner may hold flock on macOS
and Linux and persist only public envelope/head bytes; it never receives a seed. Keep
this separate from the Linux-only operator mutation owner. BEAM checks ledger state,
reads the seed and signs while ownership is live; output requires durable owner ACK.
Owner EOF/death means no output and no late persistence after lock release. Bound
the callback wait with a deadline; expiry refuses without releasing a signature.
Disarm that alarm before the bounded local write phase, avoiding an alarm after ACK.

An explicit one-time init-ledger takes the custodian’s verified signed Space log,
not a signing package: its exported genesis status must precede the first prepare.
After binding verification it durably creates a genesis
head naming binding, catalog key and no signed revision, under the same lock. Only an
empty ledger may initialize; missing head thereafter is corruption. Initialization
crashes before head publication may retry only while no envelope exists.
Under the lock verify the entire contiguous immutable envelope ledger and head record.
Accept only the next revision with previous equal to the last signed id. Exact same C
returns stored envelope bytes without another signature. A competing C at that revision
refuses. Publish the envelope exclusively, sync file and directory, then atomically
advance/sync head; ACK only afterwards. On macOS require F_FULLFSYNC as well as
fsync, including replayed files and directory entries; unsupported storage refuses.
Never recreate a missing lock over existing ledger state. Recheck held/path inode
identity after flock and before writes/ACK; compare the head before replacement. If a crash leaves one envelope beyond head,
only replay of that exact C may finish head advancement. Missing head with nonempty
ledger, missing committed envelope, multiple pending envelopes, chain gap, substituted
file, fork or corrupt state refuses. Never repair by deleting evidence or advancing to
whatever file happens to be latest. Preserve inode/ancestor/symlink/private-mode checks.

Backups must preserve signer ledger and head together with existing seed backup practice.
Deleting/restoring the entire ledger to a consistent old snapshot cannot be detected
without an external monotonic witness: document the preservation assumption, do not
claim hardware anti-rollback. Initializing another ledger for the same key is an operator
custody error; bind normal commands to the managed ceremony path and never offer reset.

## Owner and initial-existing integration

The existing Python `catalogued` plan derives ready→catalogued and stores the immutable
signed envelope before the receipt. Keep its exact expected bytes, attempt, incarnation,
manifest, digest/path and chain checks. Extend both BEAM and Python record validators
only to admit `initial_existing` in `catalogued` once the guarded ReleaseCatalog consumer
exists. Keep `initial_existing` in `listed` refused until ReleaseListing is implemented.

Crash after envelope publication but before receipt leaves one pending catalog; retry
rebuilds the same C and commits it. Lost journal reply is resolved by exact existing
receipt/envelope comparison; return idempotent success without another artifact or
revision. A catalogued retry still rechecks current binding, roster, routes and histories;
reject drift rather than silently preparing a new revision or restaging live logs.
A signed but now-unusable C permanently consumes that revision: no fork-safe abandon
exists. This is an operator custody/recovery event, never a reset. Before restaging,
require current public custodian status and refuse a pending signed revision with
:catalog_signature_pending. The custodian remains authoritative if status is withheld;
its next sign refuses a conflicting C. Document this cross-host preservation boundary.
Do not weaken generic owner callers into accepting arbitrary record transitions.

## Implementation order

1. Shared read-only review and verified public-history codec, preserving current gates.
2. Signing package, deterministic catalog construction and independent review fixtures.
3. Custodian locked signing ledger, CLI review/sign and crash/concurrency refusals.
4. Commit/owner integration, both reference modes and exact receipt/reply-loss recovery.
5. Full end-to-end software rehearsal, runbook, adversarial and independent reviews,
   required local and exact-tip hosted gates, PR. These steps form one meaningful PR 4;
   helper-only partial work is not publication completion.

## Required behavioral evidence

- Real disposable ceremony, stage/seal/activate/restart/ready → prepare → off-host
  sign → commit → controlled restart and CatalogStore verification. Exercise both
  ordinary pending and initial-existing; the latter has zero Space writes.
- Second catalog carries all old entries, authenticates their histories and routes,
  adds exactly one Thread and extends the chain. Boundary 13 succeeds; 14 refuses.
- Wrong signer/binding, changed roster/relay realms, unavailable authenticated route,
  stale manifest/incarnation/expected bytes and revoked/bootstrap drift refuse writes.
- Custodian independently refuses signed-but-unhonored creation/reference, wrong root,
  carried entry mutation, duplicate routes, missing histories, tampered/oversize or
  noncanonical packages and well-formed wrong confirmation digest before seed access.
- Concurrent identical signing replays exact envelope; different catalogs at the same
  revision yield one winner. Kill at each envelope/head/ACK boundary, reopen and retry.
  Assert no signature output before ACK and no publication after losing lock ownership.
  Include initialization kills, first-envelope/head kills and expired hold deadlines.
  Spy on fsync/fullfsync/link/replace ordering; check Darwin full-flush dispatch.
  Include genesis kills, callback expiry, output loss while the write completes,
  cleanup of temporary hard links, and concurrent identical/competing signing.
  Signing followed by roster drift/restaging must surface the pending signature and
  refuse a conflicting revision without resetting either ledger.
- Owner kill before/after artifact link, receipt write and reply produces one catalog,
  one receipt, or a bounded refusal. Missing receipt, deleted tail, corrupted envelope,
  forged chain and mismatched pending C cannot silently recover or fork.
- Existing readiness/store/ceremony/initial-provisioning tests remain green. No new
  source/prose pins; use compiled behavior and observed filesystem/route outcomes.

Prepare Node dependencies per AGENTS.md; run asdf Mix with OTP 28 PATH. Run focused
operator/ceremony tests, formatting, full `mix check`, both boundary Sobelow scans and
non-root Linux owner tests under `elixir:1.19.5-otp-28`, umask 022. Do not count macOS
skips as owner evidence. One exact-tip hosted run gates the PR. Get the requested
Argon 4 High adversarial review, falling back to Sonnet 5.5 High on actual unavailability;
review the custody/owner boundary independently. Fix or reject findings explicitly.

## Exit and next work

Complete only when the end-to-end transitions and crash matrix above pass, CLI/runbook
are usable without repository-state edits, and reviews plus required exact-tip gates
are green. Record evidence in PR/index, not an ever-growing plan. No operational or
physical ceremony claim follows. Next: plan 224 PR 5 guarded listing courier, then
plan 245 native catalog acceptance and plan 261 real-relay app integration.
