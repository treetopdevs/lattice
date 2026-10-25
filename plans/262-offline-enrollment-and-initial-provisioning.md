# Plan 262: offline enrollment and guarded initial provisioning

## Status, dependencies and execution boundary

IN PROGRESS. Initial provisioning and offline enrollment PRs are merged after their
required exact-tip checks passed, with merge trees matching the tested heads.
Ordinary OS Keychain identities, native file picker,
fingerprint refusal, offline acceptance/admission/grants and operator-bundle export
passed in the hosted packaged gate. These are software/packaged results; native catalog
trust, guarded listing and a real two-Mac relay session remain separate requirements.

The design was prepared from main e8f5c285ed3508f93efaea8279819012d72b41cb. PR #165
merged bounded creation and native custody. PR B started from fresh main a297e1ddf,
built privately on the explicit PR A dependency, and now refreshes from merged main.
A stacked draft collected software evidence while the parent finished; no dependent
work is merged or called complete before its parent and its own required gates pass.

Plan stamp: design base `e8f5c285ed3508f93efaea8279819012d72b41cb`, reviewed PR A base
`a297e1ddfe72076f337ef2fd0ce03c2fe07696a6`. Review drift before applying the plan:

```sh
git diff a297e1ddfe72076f337ef2fd0ce03c2fe07696a6 -- apps/lattice_carrier_server/lib/lattice_carrier_server/operator scripts/treehouse_operator_mutation.py
```

Priority P1; effort XL across three bounded PRs below; risk HIGH. This amends an
operator publication contract, changes the Python/BEAM journal twins and introduces
untrusted public evidence import. It changes no authority rule or carrier Wire message.
Read AGENTS.md and plans/README.md first. The unified roadmap remains the execution
ledger; this is its self-contained design. Decision D-46 is recorded in the existing HTML decision log on the dependency-based
implementation branch; retain D-45 unchanged when refreshing from merged main.

Software build/acceptance uses disposable fixture identities, ceremony directories,
local path-backed logs and loopback carriers. No real credentials, host, human witness
or operator ceremony report is required for those PRs. A real WSS field run separately
needs the real verified ceremony, service identity/host mapping, two Macs and operator
access. Missing field inputs must not stop fixture implementation or be called proof.

## Deliverable and full product target

Deliver a supported initial path from two ordinary app identities through offline
invitation/acceptance, founder admission and grants, a verified provisioning bundle,
and public operator staging of the resulting bounded Thread. Finish listing integration
without writing the already-honored reference a second time once plan 224 PRs 4-5 exist.

This advances, but does not replace, the complete two-app goal: ordinary native trust
installation on both apps, signed catalog routes, real pinned WSS, both people posting,
offline heal, app/relay restart persistence and clean restore evidence. Plan 245 and
plan 261's remaining trust/network slices still own that work. No realm helper, pure
codec, candidate review or fixture service alone closes this plan's behavioral gates.

Scope: first publication of one new bounded Space and one bounded Thread, founder plus
one other participant, local operator provisioning, no live roster change or migration.
Later Thread creation in an already-catalogued group still needs the pending-reference
saga; initial adoption must not silently become a general already-published exception.

## Why the current contracts cannot compose

PR #165's ordinary creation atomically retains the child genesis/title/profile,
Space reference, founder invitation/admission and exact-audience posting grant. Later
invitation/admission history causally depends on that reference.

`Staging.verify_reference/2` in
`apps/lattice_carrier_server/lib/lattice_carrier_server/operator/staging.ex` currently
requires the reference absent from the served Space log, then hypothetically accepts
it. `inspect_staged/4` also requires the child unserved and verifies its profile/grants.
Thus importing the final app Space log fails staging; removing just the reference
breaks causal closure. `space_export.ts` exports frames, not a `Log.dump` file, and the
native Space writer accepts only that specific format. Current `issueInvitation`
requires configured routes; `acceptInvitation` requires held histories and confirmed
routes. None is the required pre-access offline exchange.

Chosen design: guarded initial-only adoption of the same already-honored signed
reference. Rejected alternative: pre-enroll an empty Thread scope, split a closed
pre-reference frontier, then reorder creation and grant all roster members before
listing. That alternative undoes PR #165's atomic creation, changes what recipients
accept, and still needs a new app/operator saga. Do not remove the reference or forge
its ancestors to make existing staging tests pass.

## Ceremony and bootstrap order

Before offline invitations, use the existing ordinary path in
`docs/treehouse_catalog_signer_custody.md` §5.4: create and continuation-pin the bounded
Space, export its public frames, then operator `binding-payload` prepares
`binding-payload.json` and `binding-review.txt` using the catalog/service custody inputs.
The founder uses existing Catalog binding Review/Sign controls, confirming every
public field. Export again; operator `verify-binding` and `report` establish the
verified ceremony against the honored bootstrap. Create the bounded Thread with
its explicit continuity setup, then issue/review/accept the offline invitation,
admit/grant, export final histories, and import against that same
ceremony. A fabricated bootstrap id is forbidden; no relay route is installed here.
PR B composes these existing controls rather than introducing another bootstrap path.
Fixture ceremonies supply every input in tests; real ceremony adoption stays a field gate.

## Contract amendment A: explicit initial reference mode

Amend `docs/research/treehouse_catalog_lifecycle.md` §5 and plan 224 Designs 2/4/5 in
the implementation PR, before enabling the new path. Preserve all normal publication
and recovery semantics. These are proposed contract changes, not statements that the
current implementation already accepts them.

Reference artifact review becomes exactly one of:

- `null`: existing pending reference; it MUST remain absent from the active Space.
- `{"mode":"initial_existing"}`: exact closed initial-adoption variant below.

No inferred mode, extra fields, fallback after a refusal, caller-supplied authority
verdict, new phase or new carrier message. Existing version-1 records with null review
retain byte-identical canonical serialization. Older readers safely refuse the new
variant; never silently strip it. Extend kind-aware review validation/serialization
in both Journal and `scripts/treehouse_operator_mutation.py`, with parity vectors.
The mode is reviewed journal metadata, not covered by the raw reference digest. Treat
it as an assertion of observed presence: present iff `initial_existing`; otherwise
refuse. Every activation/readiness/catalog/listing recheck repeats that observation.
The immutable artifact digest, attempt and journal CAS bind the surrounding evidence.

`initial_existing` requires ALL of the following at public staging:

1. Verified CatalogStore has no committed head, pending envelope or prior committed
   catalog/receipt history. Verify against the ceremony catalog public key inside the
   stage lock; request `catalog_head: null` is not proof. Corrupt or missing receipted
   state refuses. A complete deletion of store, journal and history is indistinguishable
   from first use: operator preservation of this private state is a trust assumption,
   not an anti-rollback guarantee. Never reset these files to obtain initial mode.
2. Exactly one active bound Space history and one previously unserved candidate child.
   Initial Space references identify exactly this one Thread. No second initial child,
   route alias, already-served child or replacement of any previous entry is admitted.
3. The exact reference op, including signature and canonical signed payload, is present
   and honored in the served Space and equals the reviewed artifact/id. It references
   the candidate child's exact verified replica and creation. A similar command, changed
   title/id/ancestor set, unhonored reference or alternate signature artifact refuses.
4. Existing genesis/root commitments, independent child root, continuation and matching
   beacon profile, unique honored root bootstrap, ceremony binding, service key/realm,
   route and manifest checks remain mandatory. Do not weaken them for app-produced logs.
5. Both actual participants are admitted in the current Space roster; child grants are
   the exact current usable roster inventory, including the founder. No transport
   allowlisting substitutes for semantic admission or per-Thread capability authority.
6. Existing owner locking, captured active-log digests, manifest checks, immutable
   artifacts, crash recovery and stale-attempt guards bind the observation. Recheck
   membership/profile/binding at activation/readiness rather than trusting importer text.

PR A must make Journal and the Python twin explicitly refuse `initial_existing` in
`catalogued`/`listed` until C implements their guards. New downstream readers cannot
advance the new mode accidentally; C removes that refusal with the behavioral gate.

`catalogued` keeps the existing first-catalog chain, signature, carried-entry and
actual route-probe rules. Its hypothetical reference check must distinguish the two
modes: append the absent pending op, or re-observe the exact existing op. It must not
create a duplicate or treat an existing reference as proof of an available route.

`listed` retains the guarded holder/courier boundary. The initial branch re-observes
the exact honored reference, current roster/grants, bootstrap, attempt and catalog
entry from the holder's current log; it performs NO new Space op write. Only then may
the owner record the existing listed observation/receipt. Retrying uses the same
reference/catalog id, returns the same receipt and adds zero ops. Normal pending mode
still writes its original signed reference once. A caller boolean or cached journal
observation cannot authorize the no-write branch. Listing guards run for every entry,
including carried entries, before any irreversible action.

## Contract amendment B: offline evidence, not installed trust

Introduce closed canonical JSON format `treehouse-offline-invitation-v1` with exactly:
`format, product, space, spaceRoot, bootstrapId, invitationId, recipient, profiles`.
Product is `treehouse`. Each profile contains only `product, replica, frames`. The invitation carries exactly the Space profile;
the final provisioning format below carries Space plus Thread. Thread posts need not
be disclosed before admission. Derive Thread scope from honored Space references and
the invitation; do not accept duplicated scope, roles, routes, readiness, trust verdicts,
private keys, app state, drafts, outbox or acknowledgement fields.

Input is bounded before allocation: maximum 2 MiB encoded bytes and 4,000 total frames;
fatal UTF-8 decoding; duplicate/unknown keys and non-canonical JSON refused. Export
rebuilds canonical wire terms using the existing signing encoder, not hand-written
JSON reconstruction. Re-encoding after closed decode must equal the canonical input;
this must reject duplicate keys rather than preserving a parser's last value.

Before issuing, the founder explicitly verifies the recipient public-key fingerprint
through an independent channel; a swapped self-consistent join request cannot be
detected cryptographically. Capture confirmed key/state generation and invalidate
review on change/reopen. The joiner fingerprint review below is separate.

Every frame independently verifies signature/id, replica and complete dependencies.
Repeated frame ids, identical or conflicting, are refused instead of silently collapsed. Check the committed root, canonical bounded family and creation
for both histories, then use the existing Authority/materialization judgments for
honored invitation, recipient, current scope and unique root bootstrap. Keep authentic
quarantined frames; never drop them to manufacture a valid history. Required claims
must be honored; final child provisioning requires zero quarantined frames under
staging's existing clean-authority rule. Retaining an authentic quarantined child
frame therefore preserves a refusal, not a promise that the bundle can stage.

The review displays group/Thread, recipient and roots. The founder displays a grouped
SHA-256 fingerprint of a domain-separated canonical tuple `(space, spaceRoot, bootstrapId)`.
The joiner does not get a candidate-fed code to copy back into confirmation. The joiner
must explicitly compare it through an independent channel; a fingerprint carried only
inside the same file is not confirmation. The founder displays the same group code;
the joiner enters the independently received value (case/spacing normalized), rather
than feeding the candidate's own value back through a checkbox. The invitation must
be root-issued. The group code remains the stable identity tuple above; the one-Thread
scope is independently derived and displayed from the current signed Space.
Cancel signs nothing. Review binds captured
exact bytes, identity and state generation; changes/reopen require a fresh review.

The joiner signs the existing recipient-bound acceptance only after this review.
Candidate histories remain outside installed PreviewState profiles/routes. Reimport
and repeated acceptance reuse the native identity and signed invitation; no new key or
implicit member/trust state. A crash may require reimport/review of public evidence,
not regeneration. Retain the existing identity/trust-missing recovery semantics:
no `verified_fresh` assertion, trust sentinel, installation receipt or catalog pin is
created by this flow. Native first-member trust owner and migration remain plan 245/
plan 261 work; this honest-shell review is not a native semantic-verification claim.

Initial founder issuance requires the bounded Space root, exactly one referenced
Thread, and a root-only roster or an exact replay for its sole second member. Refuse
other states before signing rather than create an enrollment the initial exporter
cannot publish. Preparing a join identity explicitly warns that this profile will
join an existing group and cannot subsequently create its own group.
Founder issuance must work without a relay configuration. Supply the verified held
replica inventory to the pure invitation helper as scope availability, never fabricated
endpoint routes. Reuse an existing honored current-scope invitation. The existing
admit-and-grant helper uses the founder participant signer for Space admission and
PR #165's `threadSigners` map for direct child-root grants, never subdelegations of
the founder posting grant. Persist all profile histories/outboxes in the single
PreviewState revision/CAS transaction implemented by PR #165; operator dump files
are later exports, not independent live writes. It must
atomically persist member admission plus exact-audience child grants. Replay is a no-op;
revoked/expired grants and removed-member replay retain their existing refusals.

## Contract amendment C: verified provisioning bundle and import

After admission, export `treehouse-initial-provisioning-v1`: exactly
`format, product, space, spaceRoot, bootstrapId, referenceId, profiles`. The profiles
are the final signed Space and Thread histories; all other facts are derived, not
trusted booleans. Apply the same byte/frame/UTF-8/closed-shape/canonical rules. Compute
projected initial app profile size including metadata before accepting its capacity;
the existing 1 MiB workflow limit is not expanded by this file format. An eventual
native trust install must recalculate its own actual merged size before committing.

Add a supported operator importer, separate from live-log mutation. Inputs are the
public bundle, local verified ceremony directory, and explicit operator-controlled
manifest/service-identity paths. The service seed never enters a bundle or app export.
Authenticate full histories and ceremony binding; derive reference, profile ids,
grant introductions/recipients, roots, expected service realm/key and peer maps.

Create fresh output before the operator root's first controlled boot; a prior boot
marker refuses new imports rather than being erased. An exact completed retry only
rechecks and syncs existing files. Write a new private output directory with verified Log dumps, canonical
reference artifact and derived review inventory. Never overwrite a served log,
manifest, existing artifact or user file; refuse symlinks/aliases, conflicting outputs
and ambiguous partial attempts. Seal a completion index after data and a nonbootable manifest blueprint are
durable and re-read/verified; only then exclusively publish/sync the bootable initial
manifest. Before sealing there is no bootable initial-manifest entry point. An interrupted partial directory is not ready input;
retry verifies exact existing material or refuses, never silently replaces it.

Produce Space and child artifacts that the real `Staging.prepare/5` consumes. The
importer also emits a new Space-only initial manifest referencing its immutable
Space dump. The existing carrier startup/boot validation starts this new deployment;
only then does public staging use it as `active_manifest`. Refuse an already-running
conflicting deployment, never copy over a live file. The candidate manifest adds the
unserved child. PR A owns and tests this initial boot through the production boundary. References already visible in the Space confer no
catalog route availability.
No test-only fixture bypass, renamed JSON-as-Log.dump file or direct live-holder edit.

Derive `treehouse-client:<canonical unpadded base64url native public key>` consistently
in app and operator peer generation. It is an authenticated-key label, not authority.
Peer sets retain staging's `{instance root} ∪ current roster` rule, including the
independent child root. Deduplicate the founder who is both Space root and member;
root allowlisting does not require another app to use that root for transport.
Keep service realm distinct. Preserve existing saved legacy realm/routes and refuse
conflicting attempted installation; no silent migration or Wire change. The realm
helper is part of this behavioral path, not a standalone completion milestone.

## Owning files and bounded implementation order

Publish each PR from refreshed main after its prerequisites merge; isolated build
work may use the exact reviewed dependency tip as described above.
A single PR must not claim work still assigned to another PR below.

Operator modules live under `apps/lattice_carrier_server/lib/lattice_carrier_server/operator/`;
the import task lives under `apps/lattice_carrier_server/lib/mix/tasks/`. Client codec:
`clients/lattice-client/src/treehouse_offline_enrollment.ts`. Ordinary UI/workflow:
`clients/treehouse-tauri-shell/src/{OfflineEnrollmentPanel.vue,App.vue,treehouse_workflow.ts,native_adapter.ts}`.
Native public exporters live under that shell's `src-tauri/src/`; update its lib/build/
capability command allowlists explicitly. Keep `space_export`'s current format closed.

| PR | Coherent outcome | Owning files / prerequisite |
| --- | --- | --- |
| A | Verified initial app bundle reaches real guarded operator staging | New `operator/initial_provisioning.ex` and Mix import task; `operator/{staging,journal}.ex`, Python owner twin, operator tests; lifecycle §5 and plan 224 amendments. Requires merged PR #165; starts on ordinary workflow fixture exports. |
| B | Two ordinary identities complete supported offline invite/accept/admit/export and feed A | New client `treehouse_offline_enrollment.ts`; shell workflow, offline panel, App/native adapter/public export writer and command ACLs; deterministic realm and bundle tests. Requires A and PR #165; no saved-route or network prerequisite. |
| C | Actual catalog/listing uses initial mode without a second reference write | Plan 224 `ReleaseCatalog`/`ReleaseListing`, holder guard, operator integration tests and catalog evidence exporter integration. Requires actual plan 224 PRs 4-5 implementation; no fake owner/courier may substitute. |

A's smallest proof unit is an exported ordinary bounded artifact plus second-participant
acceptance/grants, strict import, and successful public non-root Linux staging. B then
replaces test-only exchange orchestration with the supported ordinary app controls.
Do not stop A at a parser or B at a realm helper. C is NOT DONE until the real listing
entry point passes the no-second-write gate; file it explicitly if those modules are
not yet implemented. Fixtures need no absent external credentials in any build PR.

Future paths under `clients/treehouse-tauri-shell/src-tauri/src` or authority/carrier/
workflow boundaries require the second independent review mandated by README rule 3.
Use the user-requested agy Argon 4 High review, with Sonnet 5.5 High only if unavailable.
Record dispositions in the PR, one line each. Do not pin prose or source text in tests.

## Required proof and commands

Prepare Node clients per AGENTS.md; use Node 22. On this Mac invoke Mix through asdf,
with the OTP 28/Elixir 1.19 bin PATH prefix for child processes. On Linux use the
`elixir:1.19.5-otp-28` toolchain. Native builds need Cargo on PATH.

Each code PR: `mix verify`, focused client/shell typecheck and tests, ordinary frontend
build, focused/full relevant Cargo tests, and exact-tip hosted workflow gate. Run both
per-app Sobelow boundaries for affected HTTP surfaces; do not substitute umbrella
Sobelow. Keep local, packaged, Linux, physical and field claims separate.

PR A owns BEAM decoding plus actual ordinary-workflow export parity vectors; PR B
adds reciprocal parity against its supported TS offline codec. Neither substitutes
hand-authored signing terms for the ordinary workflow source.

Behavioral gates (no fixtures that bypass the named production boundary):

1. Canonical round-trip and TS/Elixir parity: same signed ids/payloads/signatures,
   fingerprint and realm mapping; one-byte-over limits, duplicate keys/frames,
   bad signatures, missing deps, wrong roots/bootstrap/recipient/profile and extra
   secret/route/state fields refuse without mutation.
2. Two distinct ordinary native identities: begin join, issue offline invitation with
   no relay saved, review/cancel/confirm, sign acceptance, founder admit/grant, export.
   Restart/reimport preserves identities and ops; swapped recipient/evidence or stale
   review refuses; failed final persistence publishes neither partial admission nor grant.
3. Non-root Linux, umask 022, from `apps/lattice_carrier_server`: import actual app-
   authored artifacts and call public `Staging.prepare/5`, not only a pure verifier.
   Both peers must match the exact roster/grants; no service/root key reuse. Retain
   existing pending-mode refusal for a present reference and canonical journal bytes.
4. Initial mode negatives: prior committed/pending/receipted catalog, served child,
   extra initial reference, different valid reference, unhonored reference, roster or
   bootstrap drift, changed service/manifest and stale attempt all refuse atomically.
   Python/BEAM journal variants must agree through restore and a two-process race,
   including activation/readiness rechecks at their existing public entry points,
   duplicate-recipient and noncanonical-public-key refusals at their owning
   validation boundary; do not assume Journal alone performs staging review.
5. Real `catalogued` then public `ReleaseListing.publish`: crash/retry before/after
   receipt commit leaves the same op set and one catalog/reference id. Count holder
   ops and compare exact canonical frames before/after initial listing: zero new Space
   writes. A changed current reference/roster/bootstrap refuses even if a prior probe
   or journal record was valid. Normal pending listing still writes once.
6. Hosted ordinary packaged macOS controls exercise the file exchange and actual native
   identity path. Test keys/loopback mapping cannot stand in for this claim. No network
   dial or native trust-install receipt is caused by reviewing/importing a candidate.

## Rollout, stops and completion

Land/rebase PR #165 first. Keep old pending mode default and byte-compatible. New
reference mode is explicit and first-publication only; deploy matching Python and
BEAM readers together. Once new-mode records reach append-only history, older binaries
cannot verify it: rollback requires a compatible forward fix, not journal/history
editing. No automatic conversion of old journals, catalog deletion,
trust reset, key regeneration or recreation of an already-listed reference.

STOP and revise the design if initial admission requires weakening authority, accepting
an unverified bootstrap/service, trusting a webview installation verdict, opening relay
access to an unadmitted identity, dropping causal dependencies, or bypassing the actual
Linux owner/staging boundary. Also stop if a new mode requires undeclared Wire/schema
changes or if initial adoption is being generalized to an existing catalog/roster.

Software completion requires A/B behavioral proofs and C's real listing gate; report
any still-missing prerequisite as unfinished, not a passing fixture substitute. The
full two-app WSS target additionally needs native member/catalog trust installation,
ordinary networking and actual host/Keychain/restore evidence. This plan does not mark
R13, G2, R21b, permission renewal, founder-loss recovery or the community pilot DONE.

Review refinements: initial/unserved child verification remains strict; live checks
retain quarantined evidence while enforcing the exact effective grants, profile and
reference. The sealed public bundle supports read-only staging-input reload after
append-only Space growth or activation; import retry itself still compares every
byte. CLI listener ports are explicit and nonzero. Parent/child titles agree; service
keys cannot be members and a tombstoned Space cannot be imported. Postwrite rereads
and preservation/refusal of incomplete output are intentional safety boundaries.

Offline import cannot discover another OS process's deployment under a different
operator root. The runtime comparison is same-VM only; the boot marker scopes only
the supplied operator root. Operators must preserve the actual root and independently
ensure the selected service identity is not reused by another deployment. Import
creates offline files; it does not grant exclusive deployment ownership or readiness.
