# R12: Empty offline native Treehouse preview

## Preparation status and boundary

Prepared on 2026-09-06 in `codex/treehouse-r12-offline-native-preview`, based on the frozen
R10 commit `f3fb93d3c818e92b44c933a8e963e6617c6d2510`. This document is the proposed implementation
and evidence contract, not implementation or packaged evidence. The integrator supplies the
accepted R01a/R05/R06/R10 merge results before enablement and the final integrated gate.

The controlling requirements are unified R12, Plan 158's execution amendment and Product
Isolation and Migrations / Treehouse TS Realm and Isolated Shell tickets, and Plan 178's explicit
R10/R12 root-only preview exception. The frozen R10 domain is the semantic implementation.
Plan 178's original documentation-only scope does not prohibit this separately adopted build.
No protected sentence, original assertion, README row or execution-ledger status changes here.

The delivered result is one real, separately packaged Treehouse app. Its fresh state has no
group, Thread, fixture, imported identity, peer, route or member grant. An explicit Create local
group action creates a device-held root identity and local Space; the user can create Threads,
post, edit, tombstone and archive, then reopen the same history and drafts after process restart.
Every screen identifies this as a local preview and shows `recovery_not_ready`. A saved operation
is local retained evidence, never a relay acknowledgement.

The first packaged gate is macOS using the installed Wry app and platform key store. Android
generated projects, pilot signing, phone reboot/upgrade, physical two-phone proof, QR/deep-link
enrollment and witness presence remain their named downstream packets. The manifest's Android
and iOS identifiers stay reserved and unchanged; a desktop result makes no mobile custody claim.

## Inspected substrate and dependency disposition

| Existing file | Reuse and practical limit |
| --- | --- |
| `clients/lattice-client/src/treehouse.ts` | R10 authoring, explicit product decoders, verified Space preparation and post identity-preserving observation. No second app reducer or invented command vocabulary. |
| `clients/lattice-client/src/codec.ts` | Existing canonical frame/delegation signing and verification. Preserve wire bytes and one signed op for each command. |
| `clients/lattice-mobile-core/products.json` | Already reserves `dev.treetop.lattice.treehouse`, `treehouse`, `dev.treetop.lattice.treehouse.carrier`, `treehouse-v1.sqlite3`, and `treehouse-pilot-v1`. No identifier amendment is needed. |
| `clients/lattice-mobile-core/native/src/storage.rs` | Product/schema marker validation, transactional migrations, N-1 upgrade and fail-closed unknown/future/interrupted/corrupt storage. Existing `kv_set_batch` has no expected-value check. |
| `clients/lattice-mobile-core/native/src/signer.rs` | Native Ed25519 signer and seed-store boundary. `ensure_key` can generate a missing key, so the new app must distinguish explicit first creation from reopening retained history before calling it. |
| `clients/lattice-mobile-core/src/native_workflow.ts` | Existing storage/outbox vocabulary and serialization pattern. Its several independent writes are insufficient for one atomic profile/history/draft/outbox commit. |
| `clients/township-tauri-shell/src-tauri/src/lib.rs` | Reference for manifest-bound platform keyring setup and real Wry command registration. Do not import the Township app state, seeded development constructor, witness ceremony or discovery services. |
| `clients/township-tauri-shell/test/tauri_launch_smoke.ts` | Demonstrates packaged launch infrastructure; its seeded vector, dev trace and auto-sync are not acceptable R12 product evidence. |

R05's redaction and R06's retained-input verification are prerequisites, not changes to reimplement
in this packet. The preparation base does not claim either accepted dependency closure. The new
TS consumer verifies the exact captured frames before projection; it does not trust a persisted
projection cache, saved quarantine assertion or a successful JSON parse. The BEAM reciprocal gate
uses the accepted R06 recovery policy when the final dependency integration is supplied.

## Proposed ownership and files

All paths below are repository-relative. New files may be split only when required by the existing
build tools; a scope change affecting behavior or another writer is reported before mutation.

| Files | Responsibility |
| --- | --- |
| `clients/treehouse-tauri-shell/package.json`, `package-lock.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `.gitignore` | New Vue 3.5/Tauri product package using the already adopted library versions and local packages. Own lockfile; no Township lockfile rewrite. |
| `clients/treehouse-tauri-shell/src/main.ts`, `App.vue`, `style.css`, `env.d.ts` | Empty boot, local group/Thread interface, accessible text controls, explicit durable/pending/refused states and honest preview copy. |
| `clients/treehouse-tauri-shell/src/treehouse_state.ts` | Closed versioned public storage record, strict structural validation and N-1 app-record migration. |
| `clients/treehouse-tauri-shell/src/treehouse_workflow.ts` | Serialized creation/draft/authoring workflows, authenticated replay, per-replica frontier and root capability selection, expected-revision persistence. |
| `clients/treehouse-tauri-shell/src/native_adapter.ts` | Narrow native invoke adapter implementing the existing carrier signer interface and aggregate storage commands. |
| `clients/treehouse-tauri-shell/src-tauri/Cargo.toml`, `Cargo.lock`, `build.rs`, `tauri.conf.json`, `capabilities/default.json`, `src/main.rs`, `src/lib.rs`, `src/key_store.rs` | Real manifest-bound Treehouse Wry package, native DB and key-store composition, fixed private alias, bounded signing and storage IPC. No development seed/import/peer environment variables or generic path/service selection. |
| `clients/lattice-mobile-core/native/src/storage.rs` | Small shared `kv_compare_and_set` API described below; no schema or existing method behavior change. Requires shared-writer reservation from the integrator. |
| `clients/lattice-mobile-core/native/tests/storage_compare_and_set.rs` | Two independent SQLite handles prove stale writers cannot lose retained state; error/rollback and product-key controls. |
| `clients/treehouse-tauri-shell/test/workflow.ts`, `storage.ts`, `product_contract.mjs` | Public adapter regressions for empty boot, durable commands, missing keys, hostile retained frames, migrations, concurrent writes and product isolation. Test-only signers stay outside the production import graph. |
| `clients/treehouse-tauri-shell/test/packaged_preview.ts`, `test/support/packaged_accessibility.swift` | External driver of the actual packaged UI through macOS Accessibility. No app-owned automation path or hidden mutation command. |
| `clients/treehouse-tauri-shell/src-tauri/tests/native_commands.rs`, `storage_lifecycle.rs` | Public native command/migration/key failure tests with injected stores only in test construction. |
| `apps/lattice_core/test/treehouse/native_preview_reciprocal_test.exs`, `scripts/treehouse_verify_preview.exs` | Independently verify public packaged frames, reduce with R10 modules, and compare state, original IDs, quarantine, canonical order, references and post lineage. No new domain semantics. |
| `.github/workflows/flagship.yml` | Proposed isolated TS/native/packaged gate steps; integrator reserves and integrates this shared file. |
| This document; `docs/treehouse_offline_preview.md` | Exact scope, local use and evidence instructions. No README, unified ledger, one-pager or protected Plan 178 edit. |

No production changes are proposed in `authority.ex`, `authority.ts`, `codec.ts`, `carrier.ts`,
R10 schemas/reducers, the original vector exporter, Township app code or the product manifest.
The app calls R10's complete effects path; it never expands effects into additional DAG nodes.

## Native API and persistence contract

The product state is one versioned public aggregate stored under a fixed Treehouse key. It holds
the bound public identity, one Space profile, up to twelve total local Thread profiles, original
signed frames per replica, per-replica outbox IDs, user drafts, active selection and durable
creation intents. Archived Threads retain their profiles, references, frames and slots.
Private seeds and signer objects cannot be serialized into this record.

The aggregate has a monotonic storage revision independent of signed operation IDs and logical
epochs. Draft changes, selection changes and signed-history changes use the same atomic commit.
Each operation is stored once; outbox entries reference those retained IDs. No remote transport
exists in R12, so nothing drains or fabricates acknowledgement of this queue.

Proposed shared API:

```rust
pub fn kv_compare_and_set(
    &mut self,
    key: &str,
    expected: Option<&str>,
    next: &str,
) -> Result<bool, ProductDatabaseError>
```

Validate the storage key with the existing product/secret-key guard, open an immediate SQLite
transaction, compare the existing value exactly (including absent versus present), write once
only on equality, and commit. Return `false` without changing data for a stale writer. This adds
no migration, wire format or new authority. Two app processes cannot overwrite one another's
history merely because each has its own JS/native mutex. An ambiguous native response is resolved
by re-reading the record and comparing the attempted revision and exact operation IDs.

The new shell exposes only these command families:

- `treehouse_open`: open the fixed product database and return the captured public record plus
  native key availability. Validate storage before attempting key creation. An existing key with
  missing history, or retained history with a missing/mismatched key, is explicit incomplete or
  unavailable state; neither silently becomes an empty group or replacement identity.
- `treehouse_initialize_identity`: explicit first-creation path after a durable local creation
  intent exists. Use the fixed Treehouse service/alias. Reuse the same existing key on an
  interrupted initialization; never accept seed material or a caller-selected service/alias.
- `treehouse_sign_carrier`: sign bounded ordinary carrier/delegation bytes through the existing
  native signer after matching the retained expected public key. Reopening does not mint keys.
  This is ordinary root-key custody, not a protected witness or native authority-projector claim.
- `treehouse_commit`: validate the closed envelope, expected revision and fixed Treehouse key,
  then use native compare-and-set. Return committed versus stale explicitly. Persistence errors
  keep the current UI draft and old durable record intact.

Before any view is considered ready, capture one record, check product/version, verify every raw
frame's canonical ID and outer signature, enforce matching replica/root and complete dependency
closure, then decode with the exact Space or Thread product and run the R10 observer. A malformed
record or forged frame refuses the captured snapshot; there is no reread between verification and
use. Schema/authentication refusal preserves the file and exposes no repair/reset shortcut.
An authentic but semantically quarantined operation remains retained and visible in audit.
No global completeness claim is inferred from a local frontier.

## Local workflows and UI

Use a small forest-green and warm neutral text interface with a group/Thread rail and one reading
column. Controls have visible labels, keyboard focus, sufficient contrast and usable narrow-window
layout. Empty boot displays Create local group, the local-only explanation and recovery status;
it does not render an example group. A raw operation count, storage state and local queue count are
available without exposing private data or making transport acceptance claims.

1. **Create group.** Save the user's name and fresh random replica nonce in a durable creation
   intent. Initialize/reuse the native key explicitly, then call R10's existing Space preparation.
   Verify and atomically retain its fixed genesis and immediately dependent name command with
   their outbox IDs and profile. A failure reports incomplete initialization and retries with the
   same intent, root and deterministic frames. Never report a name/policy as created when only
   genesis is durable. The profile is explicitly `legacy_root_only`, without a witnessed policy.
2. **Create Thread.** Persist a title/nonce intent, prepare the existing root genesis and authorized
   title command for the new Thread, and the authorized Space reference command. Verify both
   replica histories before one local aggregate commit publishes them. This is local atomic
   persistence of three existing operations, not a new cross-replica command. The reference is
   labelled Local; no route or catalog readiness is invented. Archive does not release a slot.
3. **Draft and post.** Draft text is saved independently of signing. Post reviews the current
   Thread, signs one command at that verified frontier, verifies/projects it, then atomically
   persists the original frame, local queue ID and cleared draft before showing Saved locally.
   Failed or stale commits retain the draft and expose a retry; no acknowledged local frame is lost.
4. **Edit and tombstone.** Read original post ID/author from R10 observation. Build author-edit,
   author-tombstone or distinct moderator-tombstone commands using the real target lineage.
   Project the entire candidate verdict; an application or holder refusal applies no effect.
   Tombstoned content cannot return through an edit. The audit retains original signed evidence.
5. **Archive.** The moderator archive command remains one signed op. A causally archived Thread
   disables new post/author edit/author tombstone actions and explains why. Moderator tombstone
   remains available. Repeated authorized archive behavior, concurrent-post semantics and retained
   slots remain exactly R10's rules. No unarchive or deletion shortcut is introduced.
6. **Restart and audit.** Reopen verifies the same captured frames and identity, restores selection
   and drafts, and shows queue/history counts without optimistic success. Audit exposes public
   operation IDs, reasons, frontier and readable local status. Public export contains retained
   signed evidence, not signing material or inferred relay acceptance.

Members and roles are read-only facts from the authority projection; the app exposes no invitation,
member grant, transfer, renewal, witness ceremony, join, Sync or live catalog control in R12.
There is one local Space with twelve total Thread slots. Reuse the stated 4,000-op / 8 MiB stop
as a conservative local authoring guard while retaining reads and evidence. Full volume warning,
rollover, cold-open cohort measurements and lifecycle claims belong to R15/R35.

## Public RED, GREEN and packaged evidence sequence

Author tests in vertical slices, preserve each meaningful failing assertion before implementation,
and keep tests at public adapter/native/UI seams. Missing imports alone do not prove a behavioral
RED: the first empty bootstrap can exist with disabled behavior before the persistence regression.

| Slice | Deterministic RED and GREEN evidence |
| --- | --- |
| Atomic persistence | Open the same disposable DB through two ProductDatabase handles, let both read one version, commit a real retained-frame value through one, then try the stale value through the other. RED loses the first retained frame; GREEN returns stale and preserves exact bytes. Also cover failed transaction, absent/current comparison and cross-product/secret-shaped keys. |
| Empty boot and identity | Public open returns zero profiles and does not call key creation. Explicit creation creates one key. Reopen loads the same public key; missing/malformed/inaccessible key, missing expected history and foreign/future/interrupted DB never mint a replacement or return a ready empty state. |
| Creation recovery | Crash/fail after each durable intent, key creation and aggregate commit boundary. Reopen/retry yields the same Space/Thread roots and frame IDs, no duplicate references, and honest incomplete state where required. |
| Commands and drafts | Create, post, edit, author tombstone, moderator tombstone and archive through the app workflow; persist and reopen the real storage adapter. Inject write rejection/uncertain acknowledgement and simultaneous writers. Preserve drafts, exact signed history, counts and all-or-none effects. |
| Retained input | Public open refuses canonical-but-forged signatures, wrong root/replica/product, missing dependencies, duplicate conflicting IDs, malformed/future record schema and altered stored projections. Authentic quarantined evidence remains retained with unchanged reasons. |
| Migration and isolation | Run the existing native matrix on the Treehouse manifest, plus app aggregate N-1 to current, current reopen, interrupted migration, unknown schema and wrong-product file. No Township seed/data import exists. |
| Packaged UI | Launch the actual built Treehouse app from a clean disposable macOS CI account. Through visible UI create a local group and Thread, save a draft, post, edit and archive; quit and relaunch; assert same public identity, names, post IDs/content, archive state, draft and queue counts. Record app hash, git SHA, screenshots and public frame digest. |
| Independent oracle | Read only the test-owned product DB or a UI-exported public artifact after the packaged run. Feed the exact raw frames into TS verification and independent BEAM Wire/Log/Reduce. Match state, original node count, IDs, quarantine, canonical order and references across restart. |

The packaged driver is external Accessibility automation of normal labelled controls. It cannot
call a hidden product test command, install a deterministic key, seed a group, preload frames,
inject a peer or replace native IPC with browser mocks. The exact package contains no automation
mutation endpoint. On a workstation with existing Treehouse data, the harness refuses destructive
cleanup; the clean-account CI gate is the reproducible empty-install environment. Accessibility
availability is an environment precondition, not evidence of a passing packaged gate.

The public packaged script records assertion RED against the minimal empty shell before workflow
implementation, then the full restart workflow GREEN on the final package. If native UI automation
cannot execute in the supplied account, retain its concrete failure and keep packaged closure open;
browser or injected-signer tests cannot substitute for it.

Final checks include the new TS workflow/storage contracts and production build, R10 Treehouse and
legacy client conformance, Rust format/test with the shared migration matrix, real native command
tests, protected prose-pin suites and one serialized integrated `mix check`. Relevant existing
Township native regressions exercise any shared storage API change. No full Mix gate overlaps R04.
The integrator wires the new scripts into actual CI, freezes exact source, obtains Claude Fable
review, and owns hosted PR/merge-result verification. Evidence distinguishes local adapter,
packaged desktop, hosted and later physical phone results.

## Scope disposition before implementation

No unadopted product-vocabulary or authority change was found. The local creation exception and
root-only recovery limitation are already explicit in Plan 178 and the Plan 158 amendment. The
required narrow implementation addition is the shared native compare-and-set method: existing
atomic writes cannot prevent a stale independently opened app from replacing retained history.
Reserve that exact storage hunk and its new test before implementation; leave other shared native,
workflow and lockfile ownership with the integrator. The ordinary carrier key binding in the new
shell must be reviewed independently of R17/R36's protected witness work.

Preparation can proceed while dependencies receive hosted closure, but R12 enablement and final
gates wait for the integrator's accepted merge base. A verification mismatch, lost retained frame,
replacement identity after failure, product-isolation breach, required protected-pin edit or
unavailable packaged proof stops only the dependent action and preserves concrete evidence.

## Implementation refinements (2026-09-06)

The accepted R10 follow-up is integrated as `fe0240b2` after the approved R06 prerequisite merge
`8325043b`. R10's frozen source remains untouched. The final combined engine/dependency gate and
hosted enablement still belong to the integrator; these are local preparation bases.

The preview uses a conservative **1 MiB total serialized public-history record** ceiling, in
addition to the per-Thread 4,000-op / 8 MiB stop. The aggregate ceiling can stop authoring first.
It is an explicit preview envelope, not a 13 × 8 MiB native IPC or pilot latency claim. Draft text
is limited to 16 KiB and is saved after a short idle debounce through a separate small native CAS
record. Typing does not reverify signed history or rewrite the history aggregate. Selecting a
Thread changes metadata without re-verifying signatures; new signed commands verify the changed
replica and open verifies all captured replicas. Partitioned append-only history storage and
full-volume cold-open measurements remain R15.

Posting atomically commits the signed frame, retained outbox ID and the exact saved draft revision
as a `clearedDrafts` watermark in the history record. The draft record has its own monotonic
revision. A draft at or below the committed watermark is hidden; a later concurrently saved draft
survives. Failed history writes keep the old watermark and draft. The native guard checks retained
frames and queue IDs are never removed or altered, public identity is immutable, and watermark
advancement accompanies an appended frame and cannot exceed the durable draft revision. This
refines the original single-aggregate draft wording without changing signed or DB schema formats.

User-facing status is **Recovery is not set up** and **Saved on this device**. The internal/export
readiness name is `recovery_not_ready`; the interface does not display protocol implementation
labels. Local outbox counts describe retained operations, never transport acknowledgement.

Native composition is split into `src-tauri/src/preview.rs` for the public persistence/signing
service and the small Tauri registration in `lib.rs`. The fixed key-store service is manifest-bound
and uses `device-carrier-v1`. An interprocess file lock serializes explicit initial key creation.
Reopen and sign only load existing seed-store material; they do not call an API that generates a
missing key. Signing derives the ordinary Ed25519 signer from that one captured key and checks its
public identity against retained storage. There is no development seed/import command, caller-
selected key service, or claim of protected witness authority. New generated icon assets belong
only to the separate Treehouse package.

The app record's N-1 fixture is an explicitly pre-release version `0` envelope with the same
seven public fields and no draft watermark map. It is not a claim about a previously shipped
Treehouse version. Both readers accept only that exact predecessor shape; TS authenticates its
captured history before a CAS migration adds `clearedDrafts`, increments the storage revision and
writes current version `1`. Original frames, roots and queues remain identical. Missing-key
history stays available for reading without trying to perform a migration write. Unknown/future
versions or extra predecessor fields refuse; native writes accept current version only.

The external Accessibility driver scopes inspection to the Treehouse window, excluding system
menus. WKWebView does not turn `AXValue` assignment into a normal text-input event, so the driver
focuses the visible field and sends ordinary Unicode keyboard events to that app process. It does
not execute JavaScript or invoke product commands. The initial scaffold's disabled create control
produced the required real packaged assertion RED. An empty DB left by that RED (zero KV/frames)
can be reopened without cleanup; the harness refuses any existing retained records.

## Local implementation evidence and open closure gates

The isolated implementation is ready for exact review, **not R12 DONE or enablement**. It adds the
separate empty Vue/Wry app, six narrow native commands, shared CAS, native retention/key/draft
guards, authenticated TS workflows and the independent BEAM preview oracle. It changes no Core
semantics, carrier bytes, R10 vectors, protected assertion blocks, README or unified ledger.

Meaningful behavioral RED evidence is retained locally:

- `/tmp/treehouse-r12-cas-red.log`: a stale second SQLite handle replaced acknowledged history.
- `/tmp/treehouse-r12-workflow-red.log`: explicit group creation remained unavailable in the
  working bootstrap; imports and empty boot already worked.
- `/tmp/treehouse-r12-native-retention-red.log`: a current-revision native write erased a saved
  profile. The native boundary now rejects deletion/mutation and mismatched-key signing.
- `/tmp/treehouse-r12-migration-red.log`: the closed predecessor envelope refused before migration.
- `/tmp/treehouse-r12-incomplete-profile-red.log`: a valid genesis alone was accepted as a complete
  group. The consumer now requires its honored directly dependent initialization command.
- `/tmp/treehouse-r12-packaged-red.log`: the actual macOS package exposed an empty UI, but its
  disabled creation control did not produce the group/Thread composer. The package hash is in
  `/tmp/treehouse-r12-packaged-red-binary.sha256`.

GREEN preparation evidence:

| Gate | Result and exact local evidence |
| --- | --- |
| Shared native matrix | 32 tests / 0 failures, including two independent CAS-handle cases; `/tmp/treehouse-r12-shared-native.log`. |
| New native service | 6 tests / 0 failures; identity/history refusal, interrupted creation, stale drafts/watermarks, failed transaction, closed N-1 input and product/future/interrupted/corrupt DB refusal; `/tmp/treehouse-r12-native-tests.log`. |
| New TS workflow/storage/product | Empty creation, exact key retry, commands, draft watermark, stale writers, uncertain acknowledgement, hostile snapshots, missing/mismatched key, N-1 metadata migration, authentic quarantine retention and initialization refusal; `/tmp/treehouse-r12-client-tests.log`. |
| TS/Vue production build | Typecheck and Vite build pass; `/tmp/treehouse-r12-ui-build.log`. |
| Real macOS creation and restart | `/tmp/treehouse-r12-packaged-green/result.json` records the original package hash and source-state scope. External visible UI creates one Space and one Thread, posts and edits, saves a later draft, archives, quits and relaunches. The exact identity, eight retained signed frames and all draft/aggregate rows survive. No injected seed, peer, frame or hidden app test command is involved. |
| Independent packaged-frame oracle | `/tmp/treehouse-r12-packaged-oracle.log` contains `TREEHOUSE_NATIVE_PREVIEW_ORACLE_OK`. Exact public packaged frames match BEAM Wire/Sync/Treehouse state, real holders, original post IDs, order, quarantine and dump/restore. An initial oracle-format mismatch was corrected by comparing BEAM's separately stored holders with TS's role fields; no engine semantic change. |
| Independent workflow oracle | One test / 0 failures on the current source; `/tmp/treehouse-r12-oracle-check.log`. |
| Visual inspection | Actual archived reading window and saved draft inspected at `/tmp/treehouse-r12-packaged-green/restarted-window.png`. |
| Full preparation suite | 770 tests + 27 properties, **one known dependency failure**, three existing exclusions. R02 P05 still expects the pre-R03 ignored beacon verdict; R03 returns the separately adopted `:unauthorized_beacon`. `/tmp/treehouse-r12-mix-check-preparation.log` records this; no expectation is weakened in R12. The integrator's reviewed engine merge supplies the approved migration test. |
| Source lint/format | Elixir format and final strict Credo pass with existing baseline suggestions; `/tmp/treehouse-r12-elixir-format.log`, `/tmp/treehouse-r12-credo.log`. Rust formatting passes in both crates. |

The final rebuilt app is packaged successfully (`/tmp/treehouse-r12-frozen-package-build.log`),
but its retained-identity replay is **blocked by macOS Keychain authorization**: changing the
unsigned executable makes the platform request the login Keychain password for the existing
Treehouse key. `/tmp/treehouse-r12-packaged-current.log` records the unavailable UI state. No
password or seed is requested through chat/tools, exported, replaced or bypassed. The original
visible-test identity/history are preserved. User-side OS authorization and a replay of the
rebuilt package remain open; the earlier successful same-binary restart is not an upgrade claim.
The later source changes add closed metadata migration/validation, reuse the already verified
changed-profile observation, and make failed draft saves explicit. Their focused gates pass;
this does not turn the blocked rebuilt-binary replay into packaged GREEN.

Final closure still requires the root-supplied reviewed engine/dependency merge, a full integrated
`mix check`, rebuilt retained-identity replay after platform authorization, exact Claude Fable
review, and hosted CI/merge verification. The root owns actual workflow wiring. Its unit job must
install `clients/treehouse-tauri-shell` dependencies **before** Mix runs the new reciprocal test.
The macOS job must build the ordinary package, run the external Accessibility gate on a clean
account and replay its exact public artifact through BEAM; no browser or seeded fallback counts.

Final bounded read-only review by the R05 agent found no concrete P1/P2 in the native storage,
fixed key binding, stale-writer CAS, interrupted initialization or draft-watermark boundaries.
That review ran no tests and did not access Keychain material; exact Claude review remains open.
The three protected prose/contract suites pass 18 tests / 0 failures at the preparation base
(`/tmp/treehouse-r12-protected.log`), and legacy client conformance plus the full Treehouse client
suite pass (`/tmp/treehouse-r12-client-conformance.log`, `/tmp/treehouse-r12-client-treehouse.log`).

The independent oracle also rejects a relabelled artifact identity: its top-level public key must
match an honored signed genesis in every profile. The public wrong-identity assertion first
failed (`/tmp/treehouse-r12-oracle-identity-red.log`), then passed after this verifier-only binding
was added. The same real packaged artifact continues to pass. No production wire, authority or
app path changed for this evidence correction.


## Reviewed native follow-ups (2026-09-06)

The integrator authorized the two concrete P2 repairs from the actual Claude Fable review of
`6439daa3`. Public seams are `TreehouseWorkflow.select` with missing signing material and native
`PreviewStore.save_draft` / `load_draft` / commit-watermark behavior for a valid replica nonce
containing `Seed`. These repairs change no authority, frame, identity or shared KV guard contract.
Missing-key selection is an in-memory reading preference; it must not commit, create a key,
increment storage revision or enable authoring. Unknown profiles still refuse. Draft key encoding
will use a stable lowercase hexadecimal SHA-256 identifier for new rows, with explicit retained
legacy-row compatibility. The final evidence below will record that compatibility before code
changes. Owned paths are the two workflow/native source files, their existing public tests,
this document, a direct native hash dependency plus its normal lockfile update, and the external
packaged reader's matching public draft-row lookup. The latter is an oracle-format amendment,
not a product IPC or hidden test interface. Packaged replay remains a separate gate.


Before the draft repair, the reviewed compatibility rule is: a legacy-only row remains at its
unchanged key and revision; a new draft uses the deterministic lowercase SHA-256 hex key. Reads
and writes reject `draft_storage_conflict` when both rows exist, even if their values match, and
retain both byte-identically. Corrupt legacy data refuses instead of falling through to an empty
or new row. Old and new binaries can concurrently create separate rows for a previously absent
draft; per-key CAS does not prevent that cross-key race. The resulting retained conflict needs
an explicit later resolution and is never silently assigned a winner. Existing watermark checks
must refuse advancement on that conflict. The packaged reader mirrors this public storage format,
and the UI maps the explicit conflict to readable preservation guidance.


The bounded follow-ups are implemented with public RED/GREEN evidence. Missing-key selection
first wrote revision metadata (11 writes instead of the expected 10), then passed without any
commit, key creation or changed retained revision. Reopen restores the saved selection; switching
still exposes the other Thread's actual posts, and authoring/unknown-profile refusals remain.
The native `Seed` nonce regression first returned `local_store_unavailable`; the repaired public
save/load and post-watermark sequence passes for the fragment in either nonce or root token.
A legacy revision-7 row remains at the same key through revision 9, with no digest copy. A dual-row
regression against the preceding native source first silently returned the legacy draft; it now
refuses load, save/clear and watermark advancement, keeping both rows and history byte-identical.
Corrupt legacy storage also refuses without creating a replacement.

Final focused evidence is under `/tmp/lattice-treehouse-execution-20260906/`:
`r12-missing-key-selection-red.log` / `r12-missing-key-selection-green.log`,
`r12-draft-key-red.log`, `r12-dual-draft-red.log`, `r12-followup-native-final.log`
(**10 native tests, zero failures**), `r12-followup-ui-tests.log` (workflow/storage/product pass),
and `r12-followup-ui-build.log` (Vue typecheck and normal production build pass). Rust formatting
and `git diff --check` pass. The first native filter matched zero tests; that log is retained as
`r12-draft-key-red-first.log` and is not RED evidence. The corrected exact test name produced the
recorded behavioral failure. No shared KV guard, schema, signing or engine source changed. The
new direct `sha2` dependency uses the already locked 0.10.9 version; no dependency versions moved.
The packaged reader now understands both draft row formats and refuses dual rows. This source
repair does not rerun or replace packaged/Keychain evidence; the integrator still owns the later
engine merge, full suite and hosted gates. Actual same-session Fable follow-up passed for both P2 repairs at `a5df72c0`; final dependency integration is recorded below.

### Final preview integration — 2026-09-06

Actual Fable's original implementation review at `6439daa3` and exact follow-up
through `a5df72c0` now both stand at PASS: missing-key Thread selection remains
readable, new draft keys use a lowercase SHA256 digest, legacy rows retain their
original CAS key, and simultaneous legacy/new rows explicitly refuse writes as
a retained conflict. Neither draft history nor signing identity is deleted.

Automatic dependency merges through `e21d009d6f2e264cdc67ca8b4228f2b046072e1e`
include final R10/R04/R03 engine source, including exact high legacy epochs and
the reviewed claim-constructor dependency normalization. CI explicitly runs the
new preview tests/build/native tests and packaged fresh/restart/oracle path; all
existing gates and timeouts remain. AGENTS now documents preview npm dependencies
required by the actual reciprocal Mix test in a fresh checkout.

Full `mix check` at e21d009d passes **808 tests and 27 properties, zero failures**,
three existing exclusions, clean formatting and strict Credo exit 0. Latest
client build, preview tests and Vue production build pass. Logs are
`/tmp/lattice-treehouse-execution-20260906/r12-final-high-epoch-full-check.log`,
`r12-final-preview-tests.log`, and `r12-final-preview-build.log`. An initial
client-build invocation used an incorrect relative npm prefix and failed before
executing any build; correcting the working-directory-relative prefix passed.

The original packaged fresh/restart and independent BEAM replay evidence remains
valid for that recorded binary. Rebuilt retained-identity replay still awaits
user-side macOS Keychain authorization; no new package/OS/device proof is inferred
from these software gates. Final integrated review uses Sol under the user's
instruction while Claude is unavailable. Exact hosted tip/merge checks and
accepted parent closure remain required before R12 is complete.
