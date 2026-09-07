# Adopted retained catalog trust implementation boundary

Adopted by the integrator on 2026-09-06 within the user-authorized unified
program. The detailed source proposal follows below as design provenance; its
requests for integrator adoption are satisfied by this section. No field,
installed-client, native, route readiness or C01–C15 completion is asserted.

The integrator adopts the proposed closed public interfaces, file ownership,
raw-history authentication, explicit reviewed bootstrap pin, catalog revisions,
actual signed entry/reference validation, route-history preservation, known-fork
freeze, old-key rotation and immutable historical cutoff proof rules. TS owns
the three named new trust source/test/exporter paths; root owns BEAM equivalents,
package/CI wiring and the separate native durability adapter. API refinements
needed to make a refusal closed and executable must be recorded before coding.
Existing Core/codec/authority and preview contracts stay in force.

The six concrete choices are resolved as follows:

1. Retain at most 1,024 distinct signed catalog/rotation artifacts and 16 MiB of
   their original standalone UTF-8 JSON, inclusive. These are new software
   defaults, not measured field limits. Per-page32/per-artifact128-KiB and two
   automatic binding-head limits remain. Raw operation history and immutable
   cutoff proof history use their separate existing preservation/healing rules;
   their bytes are not mislabeled as catalog artifacts. If accepting more
   authenticated in-scope evidence would exceed this budget, return a durable
   `control_history_limit` freeze proposal preserving all previously retained
   trust/evidence and the accepted watermark. Do not evict an artifact or claim
   the smaller retained view is complete. The freeze marker identifies the
   triggering authenticated artifact and its digest; no routes are usable.
   Incoming evidence that did not fit is explicitly unaccepted and must remain
   available to the operator for export/review. A failed or uncertain freeze
   commit also leaves route use disabled in the active process. No automatic
   unfreeze/reset/compaction API exists in this slice. C14 remains open until
   real persistence and boundary tests verify this disposition.
2. Authenticated catalog publication before its actual signed reference/child
   evidence remains pending. Never synthesize a reference. Existing durable
   routes may continue only absent known fork or authority reclassification.
3. Rotation consumes its exact prior catalog tip. A valid old-binding catalog
   descendant competing with that transition is retained as a control fork in
   either delivery order; rotation never resolves a known fork.
4. A current continuation-profile mismatch blocks the bounded replacement rule;
   it does not alone invalidate an otherwise valid pinned old-key rotation.
   A bootstrap/reference actually refused by the complete current authority fold
   freezes affected route use as `authority_changed`, preserving pin/watermark.
5. Verify historical cutoff proofs against immutable exact proof snapshots and
   their inclusion in the complete retained current union. Later ordinary posts
   must not invalidate the old cutoff merely by extending the history.
6. Previously listed root/genesis/creation/reference tuples stay immutable.
   Supersession of an unlisted staged attempt needs R11b's concrete receipt flow;
   no ad hoc unlock flag or completed supersession claim is added here.

TS has no existing bounded JSON wrapper. This module may privately check
standalone UTF-8 byte size before JSON.parse and call the existing closed raw
CarrierTerm adapters. This is additive ingress for the new API and does not
change shared decoders. Pure route outputs remain installation-required
candidates; only the real adapter can turn an exact durable generation receipt
into usable transport state. Missing/corrupt trust with an existing identity
requires recovery and is never a fresh installation.

# R11a retained catalog trust — concrete implementation proposal

Prepared 2026-09-06 against immutable `5210ed2ac5044f749ac3445f73a5a055ee6eb4c3`.
Design worktree: `/Users/nicholas/develop/lattice-treehouse-r11a-trust-20260906`,
branch `codex/treehouse-r11a-trust`. The complete adopted catalog lifecycle
contract was read. This proposal changes no source, contract, protected fixture,
installation, key, route or readiness state. It requires integrator adoption
before implementation. No test or independent review result is asserted here.

## 1. Smallest useful slice and its remaining obligations

Implement a pure, authenticated retained-trust decision module for initial
reviewed bootstrap, catalog revision chains, actual product entry verification,
planned old-key rotations, deterministic known-fork freeze, and route lookup.
It returns an exact proposed durable snapshot and candidate routes. A separate
trusted adapter must atomically persist that snapshot and the history generation
before any caller may use a candidate route. Pure success is neither installation
nor authenticated carrier readiness.

This is required R11a work for C01/C02/C03 and the rotation/C14 portions of C04/C14.
C03 remains OPEN until the real durable adapter passes process-stop/reopen,
missing/corrupt trust and stale-writer tests. R11b still owns operator locking,
manifest generations, capacity across the host, staging, authenticated readiness,
original reference publication and peer admission/removal. R11c still owns
bounded-admin replacement activation, lost-key/combined-loss scenarios, conflict
resolution by that command and authority reclassification of accepted replacement
actions. We must not call the whole R11a packet complete after only this module.

No replacement command, authority primitive, arbitrary callback verdict or
bootstrap reset is added in this slice. Existing signed replacement-shaped Space
ops stay in the complete raw history and receive their current Core/application
verdict; this version cannot treat their marker or codec shape as a binding.

## 2. Proposed public TS boundary

One new module: `clients/lattice-client/src/treehouse_catalog_trust.ts`.
Names below describe the final proposed API, not APIs already present.

```ts
type RawHistory = {
  replica: string;
  frames: readonly unknown[];
  rejected: readonly {frame: unknown; reason: "bad_signature"}[];
};
type BootstrapReview = {
  version: 1;
  product: "treehouse";
  space: string;
  spaceRoot: string;                 // canonical Base64 raw key
  bootstrapId: string;               // exact selected signed command ID
  observedBootstrapIds: string[];    // every currently honored bootstrap, sorted
  disposition: "pin_exact_observed_bootstrap";
};
type CutoffProof = {cutoff: CatalogCutoff; history: RawHistory};
type EvidencePage = {
  catalogs: readonly string[];       // exact standalone CarrierTerm JSON artifacts
  rotations: readonly string[];      // exact standalone CarrierTerm JSON artifacts
  histories: readonly RawHistory[];  // additions, never a replacement smaller set
  cutoffProofs: readonly CutoffProof[];
};
type StoreToken = {trustRevision: number; historyGeneration: number};
type CatalogTrustInput = {
  installed: InstalledCatalogTrustV1;
  expected: StoreToken;
  incoming: EvidencePage;
};

prepareTreehouseCatalogInstallation({
  review: BootstrapReview,
  history: RawHistory,
  store: {kind: "verified_fresh"; expected: StoreToken}
}): Promise<CatalogTrustDecision>;

evaluateTreehouseCatalogTrust(input: CatalogTrustInput):
  Promise<CatalogTrustDecision>;

resolveTreehouseCatalogRoute({
  decision: CatalogTrustDecision,
  replica: string
}): CatalogRouteDecision;
```

`verified_fresh` is an assertion provided only by the trusted installation
adapter after atomically checking identity and trust namespaces. It is not a
webview permission, a recovery import flag, or evidence supplied by a catalog
server. A pure library cannot prove freshness or that a human reviewed an input.
The review is an explicit local artifact from the named user review surface;
no ambient remembered root, existing member key or discovery cache selects it.
If identity already exists while trust is absent/corrupt, this API must not be
called as fresh: the adapter returns `trust_recovery_required`.

All objects are closed, cloned before the first await, and verified independently.
Public input never accepts semantic `Op[]`, a holder, an acquisition verdict,
precomputed materialized state, an injected trusted signer or a route-readiness
boolean. `installed` originates only from the protected adapter; nevertheless
its closed shape, signatures, predecessor graph and index consistency are checked.
An arbitrary caller-constructed installed object is not an installed-client proof.

The initial prepared state contains the reviewed pin and complete Space evidence
but no catalog watermark or usable route. All current bootstrap records remain
retained, including explicitly reviewed alternatives. A review missing any
currently observed honored bootstrap refuses `catalog_fork`; sorted query order
does not choose. Later newly observed distinct bootstraps freeze automatic work
without replacing the pin. A future explicit bootstrap-fork disposition flow may
acknowledge them while keeping the same pin; it is not an implicit reset API here.

## 3. Durable snapshot and decision schemas

```ts
type InstalledCatalogTrustV1 = {
  version: 1;
  review: BootstrapReview;
  histories: RawHistory[];            // full retained union, including quarantines
  catalogs: {id: string; json: string}[];
  rotations: {id: string; json: string}[];
  cutoffProofs: CutoffProof[];         // immutable exact historical proof snapshots
  accepted: null | {
    binding: string; generation: number;
    catalog: string; revision: number;
  };
  // Authentication/proof-complete competing nodes, pending signed nodes, and
  // historical accepted nodes are retained; no largest-generation selection.
  blocked: null | {
    reason: "catalog_fork" | "authority_changed" | "control_history_limit";
    bindings: string[]; catalogs: string[]; bootstrapIds: string[];
    opIds: string[];
  };
};
type CatalogTrustDecision =
  | {kind: "reject"; reason: CatalogTrustReason; detail?: RefusalDetail}
  | {
      kind: "unchanged" | "propose" | "retain_blocked";
      expected: StoreToken;
      next: InstalledCatalogTrustV1;
      reason: CatalogTrustReason | null;
      observed: {
        bootstrapIds: string[];
        bindingHeads: string[];
        catalogHeads: {binding: string; catalogs: string[]}[];
      };
      routes: VerifiedCatalogRoute[]; // candidates only, never installation receipt
    };
type VerifiedCatalogRoute = {
  replica: string; kind: "space" | "thread";
  schema: "treehouse_space_v1" | "treehouse_thread_v1";
  root: string; genesis: string; creation: string; reference: string;
  binding: string; catalog: string; revision: number;
  origin: string; path: string; url: string;
  serviceId: string; serviceKey: string; realm: string;
};
type CatalogRouteDecision =
  | {ok: true; candidate: VerifiedCatalogRoute; installationRequired: true}
  | {ok: false; reason: CatalogTrustReason | "thread_not_authorized" |
      "thread_unavailable"};
```

Indexes such as route reservations, entry identity locks and head sets are derived
from the retained evidence on every evaluation/reopen; they are not independent
authority. `accepted` is a durable watermark, never recomputed by taking a maximum
over arbitrary input. Its exact signed supporting graph must exist. Reclassified
accepted history preserves the watermark and evidence while blocking use; it is
not “corrupt storage” merely because today's authority fold differs. Bad/missing
supporting bytes or contradictory saved indexes instead require recovery.

Same artifact bytes are idempotent, and semantically identical map ordering can
have the same signed ID. Retain the original bytes received for audit; compare
content using the existing canonical bytes and signatures. Conflicting raw frames
under one accepted op ID refuse rather than keeping the first. Rejected and genuine
frames with the same supplied ID remain in their separate existing R06 lists.
Arrays have deterministic unsigned UTF-8 ID order for output; this never implies
arrival order, a fork winner or causal order where canonical topo order is needed.

The adapter owns `StoreToken`, not signed catalog protocol. Either counter at the
safe integer horizon refuses advancement. It compares both counters in one
transaction with immutable history references/bytes; checking only trust revision
would permit authority/history to change between verification and promotion.

## 4. Authentication and actual entry verification

1. Parse every standalone artifact with the adopted 128-KiB boundary and existing
   closed codec before signature verification. BEAM already has bounded JSON
   ingress; TS has only the raw/typed closed codec at this base. Add a private
   UTF-8-byte check → JSON.parse → existing FromCarrierTerm adapter in the new
   trust module, without changing codec.ts or a global decoder. At most 32 total catalog+rotation records in
   one incoming page. Replaying more retained records is not another input page.
   Histories use existing 64,000-byte op envelope/depth/grammar boundaries.
2. Union each incoming history into its retained same-replica snapshot; retain
   complete signed quarantined history and validated rejection evidence. Use
   the public cutoff observer for raw authenticity and exact evidence identity,
   then strict frame/product decode, verify no semantic decoder dropped a frame,
   canonical complete closure, and normal product materialization/analysis.
   Missing accepted closure is `trust_pending`; representable forgery is
   `invalid_verified_history`. Rejected deps never supply accepted closure.
   Unsupported portable/raw or semantic evidence explicitly refuses; it is not
   dropped to make a smaller history pass. No change to either global decoder.
3. Obtain all honored Space bootstraps with the existing public raw query and
   compare the reviewed one byte-for-byte against the pinned scope/root/profile.
   `resolveContinuationProfileFromFrames` checks the actual current pin. A changed
   valid active profile never silently changes the installation. It blocks the
   replacement rule; recommendation in §9 separates that from old-key rotation.
4. For each catalog, get its signer from its validated binding graph, then call
   `verifyCatalogEnvelope`. Never trust a caller-supplied catalog key. Require
   exact pinned product/Space/bootstrap, fixed service ID/key and canonical
   derived realm/origin. No discovery label overrides these fields.
5. For each of its 1–13 entries, authenticate the full retained history under
   its actual product decoder and matching schema. The exact named genesis must
   be a valid, nonquarantined authority genesis with a parentless, valid delegation
   whose raw issuer/audience and op author equal `analysis.security.root.pubkey`
   and the entry root. Require root commitment/full replica family match. Its
   genesis must be in the strict causal past of the named, currently honored
   `create_space` or Thread `create_thread` command; do not select the last genesis
   because later metadata-only pins are intentionally retained. No extra direct
   dependency/deps-empty restriction is proposed; those are not universal Core
   creation rules. The catalog pins this exact valid creation attempt.
6. The Space entry must be the reviewed Space, with reference equal to bootstrap.
   For each Thread, the exact reference ID must be a currently honored Space
   `create_thread` with two arguments whose replica is this exact child. Use the
   full Space fold, not a presented signature or a marker/title match. Its own
   Thread root is verified independently; Space/operator catalog authority does
   not become child authority. A schema swap, fake reference, cross-replica cap,
   impostor genesis or wrong root cannot produce a route candidate.
7. Derive semantic visibility from current actual Space references. A signed
   extra route does not create a reference or grant. Missing child/reference
   evidence leaves the candidate catalog pending and invisible; it does not
   insert a staged ref into the accepted Space frontier. The current accepted
   catalog stays unchanged while bounded fetch seeks that evidence. This permits
   R11b to publish a catalog before publishing its exact staged reference without
   claiming clients have already adopted/listed it.

Normal invalid-candidate failures preserve existing trust and don't add arbitrary
malformed bytes to the trust store. Authenticated in-scope pending/conflicting
evidence may produce `retain_blocked`/`propose` with the unchanged watermark, so
known evidence survives restart. A missing dependency must be distinguished from
a forged input by raw signature checking; never label verifiable forgery as a
mere fetch need. Do not invent a new R06 error or broaden its grammar to do this.

## 5. Revision, inventory, route history and fork rules

Build/validate the declared predecessor graph before comparing a candidate to
the installed watermark. For each binding, revision0 has `previous:null`;
each later revision points to an existing same-binding catalog at exactly n−1.
Missing predecessor is pending; wrong binding/revision/digest is invalid.
Byte-identical replay does not increment revision. A valid earlier prefix cannot
lower the watermark. A structurally valid, authenticated alternate branch is
retained as a fork, even if its revision/generation is below the accepted tip.
Never discard a sibling as rollback solely because another arrived first.

For every validated predecessor edge, the next inventory may append but never
remove a listed Space/Thread, archived or otherwise. Exactly one Space and at
most12 Threads are enforced by the existing codec and inventory transition check.
The full root/genesis/creation/reference tuple for a previously listed replica
cannot change. Superseding still-unlisted attempts need an explicit reviewed
workflow extension; they cannot silently unlock an accepted reference here.

Route reservation is the union over every authenticated, proof-validated catalog
in the retained pin's graph, including valid competing branches and prior
bindings. A route once assigned to A never becomes available to B after A moves
or archives. Different routes for the same immutable replica are allowed.
Per-artifact unique routes alone are insufficient. Invalid unrelated artifacts
cannot reserve routes or poison another product's installation.

Catalog forks and binding forks both freeze all new transport work. Two valid
rotation children of one parent are retained regardless of arrival order; a
third unresolved binding head returns `control_history_limit` and is retained
as blocked evidence, never evicted. A rotation cannot resolve a catalog or
binding fork. R11c will add the only adopted fresh bounded-admin resolution
path; R11a can observe/freeze these conflicts without claiming to resolve them.

## 6. Planned old-key rotation and historical cutoff proofs

Reuse the existing closed rotation codec, canonical bytes, old signature and
new possession verifier. Require the exact parent binding, known `priorCatalog`
under it, generation=parent+1, new key different from old key/service key,
same pinned product/Space/bootstrap and no known competing head. New key is a
catalog signer only. Service identity/key/origin and inventory remain unchanged.
The record cannot mutate those facts by selecting another cutoff or catalog.
Its inventory digest equals the exact prior catalog entries; its cutoff replica
set equals all entry replicas, including archives. The first catalog under the
new binding is revision0/previous-null and keeps that exact inventory; later
ordinary revisions can append or move routes under the same identity rules.

For each committed cutoff, derive the existing public cutoff from its exact
`CutoffProof.history`; compare every raw payload/signature/rejection record,
frontier and digest. Its frames/evidence must be retained in the current union;
the proof never replaces the union. Rejected evidence cannot be reconstructed
from a frontier, so retain it explicitly. Current full-fold authority uses all
current history, including later posts and quarantine. Ordinary new history must
not invalidate an old cutoff by recomputing its digest over today's larger log.
Insufficient proof bytes are `recovery_incomplete`; unsupported retained bytes
stay `unsupported_cutoff`. This proves a local committed cutoff, not restored
service readiness or the absence of operations withheld elsewhere.

## 7. Refusal and installation boundary

`CatalogTrustReason` includes the adopted catalog vocabulary:
`malformed_catalog`, `control_history_limit`, `wrong_catalog_scope`,
`trust_pending`, `invalid_catalog_signature`, `invalid_possession`,
`catalog_authority_refused` (unchanged attached Core reason),
`invalid_catalog_transition`, `catalog_rollback`, `catalog_fork`,
`recovery_incomplete`, `carrier_pending`, `authority_changed`.
Observation errors `invalid_verified_history` and `unsupported_cutoff` remain
distinct. Adapter-only `trust_recovery_required`, `stale_trust_snapshot` and
`trust_persistence_failed` never become Core quarantine reasons. Closed detail
objects contain only relevant public IDs and actual Core reason, not arbitrary
objects or secret material.

Within one candidate use the adopted order: malformed/bounds; pinned scope;
closure; signatures/possession; current Core verdict; transition; rollback/fork;
cutoff; carrier. Before that candidate's result permits use, independently fold
new authenticated retained history over accepted evidence: newly established
fork/reclassification blocks old-route use even if another candidate is malformed.
A rejected candidate cannot mask a security event already established from the
current independently verified union. At page boundaries there is no assertion
that a remote peer supplied all pages; its cursor/completeness evidence is caller
owned, and exhausted/missing pages cannot promote a convenient subset.

Required trusted adapter, separately owned by root:

```ts
loadCatalogTrust(namespace):
  Promise<{kind:"fresh";token:StoreToken} |
    {kind:"installed";token:StoreToken;state:InstalledCatalogTrustV1} |
    {kind:"recovery_required";reason:"missing"|"corrupt"}>;
commitCatalogTrust({namespace,expected,next}):
  Promise<{ok:true;token:StoreToken} |
    {ok:false;reason:"stale_trust_snapshot"|"trust_persistence_failed"}>;
```

The API is a trusted/native service, not an IPC endpoint accepting arbitrary
reviewed booleans/state objects. It serializes verification and commit against
identity+trust+history generations and exact pending review tokens. R17 checks
again around any blocking presence/signature operation. Stage immutable evidence
first, sync it, atomically CAS the active metadata, and acknowledge only after
the existing platform durability boundary; never expose a route on pure success
or after failed/uncertain commit. Reopen validates retained content hashes and
supporting signed graph. Missing/corrupt state is not a new blank installation.
Whole native-store rollback and hidden remote history remain explicit nonclaims.

Current `LocalKeyValueStore`/`createJsonCarrierFrameStore` is insufficient: it has
only get/set, treats missing storage as empty, and no cross-history CAS. Do not
silently repurpose it as this adapter. Root's native persistence integration can
reuse its real transaction/durability primitives after exact scope adoption.

## 8. Owned files and meaningful RED→GREEN order

After adoption, this TS lane owns only the new trust module, new
`test/treehouse_catalog_trust.ts`, a self-contained signed exporter
`test/support/export_treehouse_catalog_trust.ts` and its explicit reciprocal
fixture directory. No `authority.ts`, `treehouse.ts`, codec, index, package,
distribution, native source or shared plan edits without a named new need.
Root owns matching BEAM module, durable adapter, catalog contract amendment,
explicit public exports and normal generated build/CI integration.

1. Public signed bootstrap preparation: explicit pin accepted; all alternatives
   exposed; missing/forged Space history, wrong root/profile/family, incomplete
   observed set refuse. Fresh/existing-identity distinction tested at adapter.
2. Real independently rooted Space+Thread fixture: catalog resolves exact
   genesis/creation/ref/service tuple; wrong signed reference, fake genesis,
   bad signature, schema/root/realm mismatch and missing history refuse through
   the same API. Catalog-only extra route adds no semantic visibility.
3. Catalog0→1/retry/reopen pure state; malformed predecessor, revision skip,
   rollback, changed listed binding, deletion/archive reuse and A→B route reuse
   after A changes route. Thirteen entries including12 archived/current Threads
   positive; fourteenth and replacement Space negative.
4. Real catalog siblings in both orders produce equivalent retained fork/no
   route; existing accepted branch plus later sibling freezes without lowering
   watermark. Missing predecessor page remains pending, then completes exactly.
5. Old-key rotation with both real signatures and exact reciprocal cutoffs;
   wrong old/new sig, mutation, service change, bad generation/inventory and
   wrong first new catalog refuse. Later ordinary signed history does not erase
   the accepted historical cutoff. Same-key restore is idempotent, no rotation.
6. Two/three rotation heads in both orders; no head eviction or partial route
   promotion. Known catalog fork prevents old-key rotation from resolving it.
7. Pure current full-fold controls for accepted bootstrap/reference authority
   reclassification, maintaining evidence/watermark; future replacement-specific
   C13 controls remain R11c and do not get a false checkmark here.
8. Adapter process-stop/reopen, identical retry, stale two-writer/history token,
   crash before/after durable transition, missing/corrupt with retained identity,
   failure to persist new fork evidence, and no route use before receipt. This
   requires real storage, not a mocked successful commit.
9. BEAM→TS and TS→BEAM complete signed histories + exact catalog/rotation bytes,
   IDs, cutoff records/digests, derived routes/refusals and reversed-order state.
   All protected legacy bytes unchanged; client typecheck/build, named catalog
   and existing conformance gates, root-serialized Mix/security suites. No local
   test is a device, WSS, reboot, provisioning or loss-recovery claim.

## 9. Decisions that need explicit adoption

1. **Total retained control budget is not numeric in the adopted contract.**
   The roadmap's4000-op/8-MiB threshold is a posting stop with healing ingestion,
   not an exact hard control journal budget. Do not mislabel it an existing
   resolver cap. Proposed initial aggregate limit: 1,024 retained catalog/rotation
   artifacts and 16 MiB of their UTF-8 artifact bytes per installed pin, with
   duplicate delivery not charged twice. These are proposed operating defaults,
   not measurements or existing limits. Retained Space/Thread history and cutoff
   proof bytes have separate caller/storage budgets and cannot be omitted from
   those budgets. Recommend an append-only overflow/freeze record, separately from
   per-page32/per-artifact128-KiB. Until that choice, implement per-page/head
   limits and expose caller-budget exhaustion as fail-closed; do not claim C14
   aggregate-bound closure. A third head within storage budget must persist.
2. **Publication-before-reference.** Recommend keep an authenticated catalog
   pending until real signed reference/child evidence exists in the complete
   retained histories. Do not synthesize listing or inject privately staged refs
   into the accepted frontend Space log. Existing accepted routes may continue
   under their old durable catalog absent a known fork/reclassification; no new
   candidate route is exposed. This is client observation, not R11b readiness.
3. **Old-binding catalog growth after a rotation's declared prior catalog.**
   Recommend model the rotation as consuming that exact catalog tip. A valid
   old-binding catalog descendant diverging from it is a retained catalog/control
   fork in either delivery order; otherwise arrival order hides signed conflict.
   A genuinely earlier catalog prefix remains rollback/idempotent. This concrete
   cross-type graph rule needs adoption before production/tests assert it.
4. **Profile changes and bootstrap reclassification.** Recommend current profile
   mismatch explicitly blocks the bounded replacement rule, as the contract says;
   it does not automatically invalidate an otherwise pinned old-key rotation.
   But if the installed bootstrap/reference itself becomes refused in the full
   fold, freeze the affected route as `authority_changed`, preserve the original
   pin/watermark, and never silently choose a newly honored bootstrap. Distinguish
   these cases in public tests, without changing Core semantics.
5. **Historical cutoff proof availability.** Recommend require immutable exact
   proof snapshots plus inclusion in full retained current evidence, not equality
   with the ever-growing current log. This preserves the exact domain commitment
   and prevents normal posts from making a verified rotation unreopenable.
6. **Unlisted attempt supersession.** This slice locks accepted listed bindings.
   Recommend explicit later reviewed workflow evidence for supersession rather
   than an ad hoc boolean unlocking the tuple. R11b owns its staged reference
   receipt; the implementation must not claim that path already works.

The proposal deliberately leaves these concrete choices visible. Root can adopt
the defaults and assign the TS implementation while building BEAM/durability in
parallel; no production work in this lane starts before that adoption.

## 2026-09-06 origin-aware retained-state validation amendment

Before incoming union, candidate parsing, overflow handling or a durable-freeze
return, validate the original installed snapshot's complete authenticated graph,
exact cutoff proofs, raw-history closure, watermark and index coherence. Original
corruption returns `trust_recovery_required`; incoming evidence never repairs it
and an existing freeze never masks it. This resolves the P1 found by the actual
configured gpt-5.6-sol review of unpublished TS source d912f5b7.

The integrator adopts the following additive field in the unpublished v1 block:

```ts
authorityWitnesses: {
  replica: string;
  frontier: string[];
  opIds: string[];
}[];
```

BEAM uses the corresponding predeclared `authority_witnesses` / `op_ids` keys.
Witnesses are unique and sorted by replica. Frontier and operation IDs are
canonical, sorted and distinct. An authority freeze has at least one witness;
the exact union of witness operation IDs equals the block's operation IDs.
Each listed operation is a selected bootstrap or accepted-entry genesis,
creation or reference in its actual replica. Reconstruct the witness frontier's
complete dependency closure only from original retained accepted raw frames,
authenticate and fold it, require that frontier to be the closure's exact
frontier, and reproduce each named refusal. Reject unknown, missing, redundant
or inconsistent references. Counts are bounded by the corresponding retained
history's frame count; this field adds references, not duplicate raw history or
an independent frame allowance. Rejected evidence cannot supply accepted closure.

Capture these frontiers on the first observed authority freeze and preserve them
when later history re-honors an operation. The original complete current graph,
watermark and proofs still require validation separately. The witness proves a
refusal in an authenticated causal subset, not when it was observed or provenance
of an arbitrary caller-created map. Installed native storage remains the trusted
boundary; no whole-store rollback protection or automatic unfreeze is added.
Missing/invalid historical witnesses require recovery. No deployed state migration
is claimed: this version is not yet integrated or published.

Overflow uses the existing closed `triggers` array, retaining metadata for all
distinct unadmitted authenticated page artifacts needed to establish exhaustion
against the original retained set. At most 32 trigger records are retained, in
canonical kind/ID order. For example, an original count of 1,023 plus two incoming
records needs both triggers when the entire page remains unadmitted. Count/bytes
including those triggers must establish the adopted aggregate overflow. Reopen
checks canonical metadata and budget coherence; it cannot reauthenticate omitted
JSON bytes. Those bytes remain explicitly unaccepted and operator-retained outside
this state, as already adopted. Existing exhaustion witnesses are preserved;
subsequent unadmitted pages do not append an unbounded trigger journal or imply
admission/completeness.

Authority witnesses and prior overflow triggers survive either order of those
events. Once authority witnesses exist, retain `authority_changed` as the block
reason, preserving overflow metadata alongside it. Other block reasons have an
empty authority witness array. Every such state remains frozen with no routes.
These are pure-state validation rules, not C03/C14 persistence closure. Actual
process stop/reopen, durable CAS and field recovery evidence remain outstanding.

## 2026-09-06 frozen pending-entry evidence refinement

Actual Fable review of TS source `050ed8c7` found that newly authenticated Thread
history could reveal a refusal in a nonaccepted catalog already retained during
a fork. The fallback saved that history, but reopening mislabeled the resulting
authentic frozen evidence as corrupt storage. Public signed-history reproduction
also demonstrated the same problem when complete child history reveals that a
previously pending retained sibling names another Thread's real reference.

For a validated existing block, an originally retained, nonaccepted catalog's
entry proof may therefore become refused or demonstrably invalid as authentic
history arrives. Preserve its exact signed artifact and raw history as diagnostic
evidence, keep the node pending and unable to reserve routes, and return a frozen
state that passes the same original-state validation on reopen. This does not
promote the entry or certify the catalog's semantic validity. Retain the existing
block and expose the affected entry's diagnostic operation IDs where applicable.

This exception is limited to entry proofs of originally retained nonaccepted
catalogs under an already validated block. It never softens artifact signatures,
closed grammar, binding/transition graph validation, cutoff proofs, watermark or
index coherence, raw-history authenticity/closure, or an accepted catalog's entry
requirements. New candidate artifacts and unblocked candidates retain their
ordinary invalid-transition refusal. Accepted-entry authority changes still need
the historical authority witnesses above. Origin-first validation continues to
reject corrupted installed evidence before considering incoming data.

Both runtimes must reproduce the authentic authority-refusal and wrong-reference
cases, reopen every resulting frozen state, and keep negative controls for
unblocked/new candidates and saved corruption. This is a pure resolver correction;
native persistence, recovery export and C01–C15 acceptance remain open.

## Overflow freeze precedence clarification — 2026-09-07 UTC

Root adopts the following narrow BEAM/TS parity rule for the existing closed
state shape. A validated trigger-bearing overflow freeze retains its original
block and trigger metadata when later graph forks, additional binding heads or
an unseen authentic bootstrap are observed. Those later unadmitted artifacts
must not replace the block with indexes into artifacts absent from the retained
catalog/rotation set. Retained raw histories and observed bootstrap IDs still
advance through their existing verified path; no routes are enabled.

An actual authority refusal remains stronger: preserve an existing
`authority_changed` block, or upgrade to a newly verified authority block while
retaining prior overflow triggers. In BEAM this authorizes one trigger-preserving
clause in each of `merge_graph_block` and `merge_security_block`, after their
existing authority-priority clauses and before non-authority replacement.
It matches the TS overflow branch's existing normalized journal shape. No
validator, schema, budget, watermark, raw authentication or historical-witness
predicate is weakened; no new unfreeze path is introduced.

Require public RED/GREEN for overflow followed by two new rotations and for
overflow followed by an unseen bootstrap, including empty-page reopen, original
trigger equality, retained-history/observed-ID advancement and empty routes.
Retain authority-before/after-overflow controls. Independent Fable review remains
required on the exact implementation. C03/C14 and durable native gates stay OPEN.


## Integrated pure trust evidence — 2026-09-07 UTC

Integrated source `00396f79d62b05d0606c7c50a993587e87b72572` combines TS
`40263ce98ad00314628b6ca4e3c9cc264e601a93` and BEAM
`8b9edda748527abeba7e2f6302ef39a6ff61cdb7`. Actual Fable approved the historical
bootstrap repair, TS recovery behavior and live reciprocal gate. After Claude's
session limit interrupted the follow-up, independent Sol approved the final
three-line BEAM overflow repair and exact root API/CI integration, with no P0–P2.
The user's requested Sol fallback was used; interrupted reviews were not counted
as approvals. Initial failures and findings remain in the execution evidence.

Root full `mix check` at that source passed 877 tests and 27 properties, zero
failures, three configured exclusions, formatting and strict Credo exit0. The
integrated TS trust suite passed34 tests with no skips (64.377 seconds), typecheck
and build. The final BEAM leaf's public/reciprocal subset passed21 tests. Root's
full run executes fresh BEAM output through the actual TS trust verifier and
fresh TS output through BEAM, with exact comparison against the pinned TS fixture.
All published-foundation vector files remained byte-identical. Public index
exports three trust functions and14 types; every usable route is still explicitly
an installation-required candidate, not a native receipt.

Relevant artifacts under `/tmp/lattice-treehouse-execution-20260906/` are
`r11a-final-integrated-full-check.log`, `r11a-integrated-ts-trust-402.log`,
`r11a-final-trust-vector-preservation.json`,
`sol-r11a-overflow-final-review.md`, and
`sol-r11a-final-integration-review.md`.
Exact publication-tip and merge-result hosted gates remain separate. No native
SQLite transaction, freshness observation, provisioning, actual transport lease,
process restart or C03/C14 completion is claimed by these pure-state checks.
