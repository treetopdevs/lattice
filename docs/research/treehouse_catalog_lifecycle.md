# Treehouse catalog, provisioning and replacement contract

Prepared 2026-09-06 for unified R11a/R11b/R11c. **Contract adopted by the
integrator on 2026-09-06 after Claude Fable's exact follow-up PASS on
`789ab235`. R11a local implementation is authorized; R11b/R11c and live profile
enablement remain separate gates.** The exact reviewed records, transitions,
section 8 defaults and source-contract amendments below are adopted. R04 was
frozen separately during design; the design worktree
starts at `8b7c9b53`. The exact review uses R04 `75e544d2` and R10 `3d6a4443`
source snapshots; neither sibling worktree was modified or merged here. R03
hosted-review remediation was open at that review. R11a preparation starts at
the combined, locally verified engine `90a07e2b`; implementation rechecks its
resolved-root policy/contextual codec/continuation collector and verified
quarantine seams. Hosted dependency closure still precedes any R11 enablement.

## 1. Decision and evidence

Keep a signed transport catalog separate from signed Space membership and Thread
references. The living root expressly delegates catalog/service replacement to
the bounded Space admin before loss. Installed clients verify that authority
from their retained bootstrap and complete signed history. Operator possession
of newly generated keys, a URL, a recovery backup or a fresh trust object cannot
grant that authority.

Use the current R04 role judge and existing Space command/authority-field seam.
Do not introduce a catalog witness quorum. R02 section 6 proposed that extra
quorum; it is an optional stronger consent policy, not an implemented requirement.
Under this proposal an authorized admin can replace transport during its valid
lease without obtaining fresh witness approval for each endpoint change. R04's
quorum applies when acquiring/renewing bounded authority. A compromised or
malicious current admin can exercise the expressly delegated replacement power;
ordinary revocation, transfer and lease rules still govern its operations.
Independent per-change consent would reduce that discretion but add another pin,
availability dependency and native ceremony. It is outside this minimal profile.

| Existing source | Available behavior and implementation consequence |
|---|---|
| `LatticeCarrierServer.Manifest`, `manifest.ex:48,52` | Maximum 64 instances; strict existing manifest/secret/log paths and trusted-peer maps. No product catalog. The symbolic reporter allowlist currently contains Township only. |
| `Runtime.prepare/1`, `runtime.ex`; `RouteOwner` | Startup manifest preparation and route restart. No live add/remove/reconcile contract. A manifest edit alone does not change running admission. |
| `Health`, `health.ex` | Content-free loopback readiness tests restore/listener and relay durability. It is not an authenticated proof of a public route's identity or replica. |
| `Holder`, `Durability` | Existing path-backed relay persists before acknowledgement using file sync, rename and directory sync. Reuse its guarantees; never rewrite an active log from a genesis-only snapshot. |
| `Treehouse.Space`, R10 `space.ex:32,65` | `create_thread` stores replica/title; `prepare_creation` is an authenticated, deterministic **root-only** draft helper. It does not install a catalog policy, create another replica's grants or support arbitrary later-genesis retry. |
| `Treehouse.ReadModel.thread/3`, R10 `read_model.ex:51` | Requires a semantic reference and matching log replica; it does not verify catalog metadata. |
| `Authority.holder_epoch/3`, `analyze/2`; TS `analyzeAuthority` | Actual honored acquisition and operation verdicts are public observations. R04 supplies finite continuation and ceiling verification. Reuse them rather than accepting signatures of a presented acquisition as proof it was honored. |

These are source observations, not new runtime test results. Existing R04 and
R10 evidence remains in their own packets. No WSS, native, physical or host-reboot
gate was run for this document.

## 2. Closed profile and encoding

Version 1 is Treehouse only: one Space, at most 12 total Threads including archived
Threads, one product service identity and one current catalog signer. All that
product's isolated replica listeners use the same product service public key;
the manifest already permits that arrangement. Different products must use
different catalog/service identities and storage. The host limit remains 64
routes across products. Four foreground sockets is the client scheduling limit,
not a catalog or operator connection count.

Use existing `Canonical.term` / `canonicalBytesForCarrierTerm` with closed atom
maps and the current CarrierTerm grammar. Do not invent another encoder, change
legacy certificate bytes or add arbitrary atom decoding. Tables enumerate every
field; missing/extra fields and unsupported versions refuse. Map order follows
the existing canonical encoder. List order is explicit below.

**R11a interface amendment adopted 2026-09-06:** standalone catalog and
rotation envelopes serialize through the existing CarrierTerm JSON grammar.
Expose `Lattice.Carrier.Wire.encode_value/1` and `decode_value/1` as narrow
wrappers around its existing term encoder/decoder and canonical-signable
checks. Preserve the existing depth, integer, duplicate-term and atom rules;
no new atom creation, fake operation envelope or increased limit is allowed.
The raw standalone parser applies the 128-KiB byte bound before JSON decoding.
This is a public interface for the existing grammar, not a new canonical format
or a repair to the separately owned R03 policy/certificate parsing.
The generic decoder retains its existing normalization of repeated map keys
and mapset members. The new catalog ingress separately rejects duplicate fields
in its closed raw atom maps before normalization or signature verification;
the wrapper alone is not a strict canonical-envelope verifier. This preserves
existing op decoding while refusing ambiguous signed catalog input.

`Id` is an existing canonical 43-character SHA-256 base64url identifier;
`Nonce` is 32 fresh random bytes represented canonically the same way. Raw keys
are 32 bytes and signatures 64 bytes, with strict canonical Base64 in JSON.
Integers are exact `0..9_007_199_254_740_991`; increment at the horizon refuses.
Text is nonempty, valid UTF-8 with lossless TS roundtrip. No display label selects
an identity, product, schema or role. Bytes and raw signed frames are retained.

The initial pilot uses one canonical origin `wss://<lowercase DNS host>[:port]`,
with default port 443 omitted and no credentials, path, query or fragment.
Routes are exactly `/r/<Nonce>`; clients concatenate the verified origin and
path. Arbitrary URLs, redirects and path traversal refuse. IPv6/IP-literal
production origins are outside this closed first profile. An explicit disposable
test profile may use loopback WS; its marker cannot load in a release profile.

Proposed parser bounds are 128 KiB per standalone signed catalog/control
artifact, 13 catalog entries, 32 control records per input page and at most two
unresolved binding heads for automatic resolution, including both rotations
and replacements. These are
conservative implementation limits to test, not
measurements. Causal histories are supplied separately through R06/R08 bounded
verified restore, not embedded unboundedly in these artifacts. More than two
valid unresolved heads yields `control_history_limit` and stops switching;
export/review is required, with no silent head eviction. The third authenticated
head remains retained as blocked evidence within the total history budget; the
two-head bound limits automatic resolution, not preservation of known history.
If the total history budget prevents accepting more evidence, freeze route use
and preserve existing trust rather than claiming a complete smaller view.
Installed trust retains
accepted chain and conflict evidence, subject to the existing profile history
stop limits; it does not compact away its security baseline.

The standalone-artifact bound does not enlarge the existing carrier transport.
Before signing either new Space command, encode its complete one-op push JSON
envelope with the actual Wire/TS carrier encoder, including all envelope fields,
op fields and fixed-size signature/ID slots. It must fit the existing 64,000-byte
frame cap and pass the adapter's existing batch budget, which includes envelope
overhead. Recheck the actual signed frame before persistence/submission. An
artifact that fits 128 KiB but cannot fit that carrier budget refuses as
`catalog_command_too_large`; do not split one signed op, increase transport
limits or claim canonical payload size proves JSON envelope fit. Larger control
chains/recovery histories travel as bounded pages, never one oversized command.
If mandatory frontier lists exceed that envelope, an actually authorized
ordinary operation may join heads with bounded dependency fan-in only when
existing permissions, dependency and frame limits permit. Then derive fresh
cutoffs, claim and possession signatures. Otherwise remain
`catalog_command_too_large` with retained evidence; no universal recovery,
splitting, pruning or increased cap is promised. This is an operational
limitation, not a new authority or compaction rule.

### Root bootstrap

Add the exact Space command `catalog_bootstrap_v1(record)`. It writes its ordinary
command-name marker to the existing `admin_actions` authority marker. The complete signed
record remains in its immutable command body. A pure query extracts catalog
controls only from authenticated operations actually honored by the authority
judge; there is no new materialized field or duplicated side log. The ordinary
cap/holder gate applies; application validation
additionally requires the raw author to equal the immutable Space root. It must
be signed while that root is available, before operator provisioning.

The record has exactly:

| Field | Required value |
|---|---|
| `version`, `product`, `space`, `space_root` | `1`, `:treehouse`, full bound Space replica ID, raw immutable root key. |
| `profile_genesis`, `profile_id` | Exact valid ancestral R04 pin op and digest, matching the Space family/admin profile. |
| `replacement_rule` | Exactly `:bounded_space_admin_v1`. This delegates only the transport changes described here. |
| `catalog_key`, `service_id`, `service_key`, `origin` | Reviewed initial raw keys, opaque service `Nonce` and canonical origin. The two keys must be distinct. |
| `nonce` | Fresh bootstrap attempt `Nonce`; retained across retries. |

For this v1 profile, the carrier service realm is exactly the UTF-8 ASCII bytes
`"treehouse-service:" <> service_id`, where `service_id` is its canonical
43-character nonce text. All that product's replica listeners use this realm
and the bound service key. No IPC, manifest or discovery label overrides it.
An otherwise valid handshake under a different realm refuses; after handshake,
the exact replica/root/genesis check still applies independently.

`bootstrap_id` is this signed op's ID, also the initial binding ID/generation 0.
The record contains no reference to its own ID. The installed client's initial
review pins the exact root, Space, bootstrap ID and product. Competing distinct
root bootstraps require an explicit bootstrap-fork disposition; never choose one
by arrival order. Later root genesis/policy changes do not silently replace this
pin. A different active continuation profile blocks this replacement rule until
an explicitly reviewed migration is available.

The initial root/admin acquisition and every relevant pre-loss transfer must
include `replace_catalog_v1` in their effective signed operation ceiling.
Continuation cannot recover a permission omitted from that ceiling. Root-only
R10 preview histories remain usable under their own preview contract, but cannot
be silently labeled as this catalog/recovery profile. R11a may use disposable
bounded-profile fixtures while hosted dependencies remain open.
At least one honored ancestral R03 beacon is required before any replacement.
Without it, stop with the explicit zero-beacon refusal even when Core has not
yet expired a finite lease. The bounded profile's pre-loss setup must make the
beacon policy usable by surviving configured witnesses; no root or wall-clock
fallback supplies a missing epoch. The living root's unleased genesis cap also
cannot satisfy replacement: it must first obtain an honored finite acquisition
through the existing role contract, or use old-key rotation for that narrower
operation. A mere leased grant without a new honored acquisition is insufficient.
Keep the existing R10 root-only helper/exporter command ceiling and its canonical
genesis bytes unchanged. Adding these commands to module registration must not
silently broaden its dynamic all-command grant. Use an explicit new bounded
creation profile and preserve the old preview command list in both runtimes.

### Signed catalog snapshot

The envelope is exactly `%{catalog: C, signature: sig}`. Sign
`Canonical.term(["lattice-treehouse-transport-catalog-v1", C])`; its SHA-256 ID
uses the same bytes. The signer is obtained from the verified binding, not an
untrusted envelope field. `C` has exactly:

| Field | Required value |
|---|---|
| `version`, `product`, `space`, `bootstrap` | `1`, `:treehouse`, pinned Space, pinned bootstrap ID. |
| `binding`, `revision`, `previous` | Verified binding ID; revision 0 with `previous: nil` for the first snapshot under a binding, then exactly prior revision + 1 and prior catalog ID. |
| `entries` | Distinct records sorted by full replica ID; exactly one Space entry and at most 12 Thread entries. No removal of an archived or previously listed Thread to recycle its slot. |

Each entry has exactly `product`, `replica`, `kind`, `schema`, `root`, `genesis`,
`creation`, `reference`, `route`, `service_id`, `service_key`. Product is
`:treehouse`; kind/schema pairs are `:space/:treehouse_space_v1` or
`:thread/:treehouse_thread_v1`. Full replica ID/root/genesis must match verified
signed history. `creation` is the exact honored `create_space` or child
`create_thread` op. A Thread's `reference` is the exact signed Space
`create_thread` op ID; a Space entry uses the bootstrap ID. Service ID/key must
equal the current binding. Route and replica IDs are unique; route reuse for a
different replica refuses across the entire retained control/catalog chain,
including earlier revisions and bindings. New route nonces are inexpensive;
moving A from `/r/X` to `/r/Y` never frees `/r/X` for B. A title is read from semantic history, not
from the catalog.

Known entry root/genesis/creation/reference bindings are immutable within a
listed attempt. A superseding attempt for the same unlisted child must explicitly
retain its signed genesis and publish a new reviewed reference/catalog revision;
it does not mint a second child or silently reinterpret an old reference.
Normal snapshots may append readied replicas and change an opaque route under
the same service identity. Catalog updates cannot change service/catalog keys,
bootstrap, root or product. A valid extra route grants no semantic visibility;
a referenced missing route is unavailable. Verify the exact reference bytes,
child history and metadata before resolving any route.

### Planned catalog-key rotation

This remains distinct from loss recovery. A rotation record has exactly
`version`, `product`, `space`, `bootstrap`, `parent`, `prior_catalog`, `generation`,
`new_catalog_key`, `nonce`, `inventory_digest`, `cutoffs`. The latter two use the
replacement definitions below and bind the current verified inventory/cutoff.
It preserves service identity/origin/inventory, has
one current parent and increments binding generation by one. The old catalog
key signs `Canonical.term(["lattice-treehouse-catalog-rotation-v1", record])`;
the new key proves possession over the same record under the catalog possession
domain below. The envelope has exactly `rotation`, `old_signature`,
`new_signature`; its binding ID hashes the complete canonical envelope under
the rotation domain. Old-key rotation cannot resolve a known fork or change a
service identity. Same-key encrypted restore does not create a rotation record.

## 3. Replacement authorized by bounded Space admin

Add the exact Space command
`replace_catalog_v1(claim, catalog_possession, service_possession)`. It writes its
ordinary command-name marker to `admin_actions`; its complete signed transition
is extracted from the honored raw command body by the same pure query.
It does not mutate another replica's root, a membership row or a semantic grant.
The old catalog and service private keys are not inputs.

The claim has exactly these fields:

| Fields | Meaning and checks |
|---|---|
| `version`, `product`, `space`, `bootstrap` | `1`, `:treehouse`, pinned Space and bootstrap ID. |
| `profile_genesis`, `profile_id` | Equal the retained bootstrap and the active valid R04 profile at the action's causal position. |
| `parents`, `prior_catalogs`, `generation` | Sorted distinct binding-head IDs; sorted distinct `{binding, catalog}` maps committing their reviewed last catalog IDs; `max(parent generation) + 1`. `catalog: nil` is permitted only when no catalog under that parent is locally known; it is never proof that none exists elsewhere. Initial parent is the bootstrap. No omission of a locally retained later/conflicting head or catalog. |
| `nonce` | Fresh attempt `Nonce`. Exact same bytes are idempotent; two authorized different claims reusing a nonce produce a retained fork in either delivery order, not a first-arrival winner. |
| `new_catalog_key`, `new_service_id`, `new_service_key`, `new_origin` | Reviewed replacement binding. Keys are distinct; service ID changes when its key changes. Either key may be intentionally retained in a partial-loss case, with a fresh possession signature. |
| `inventory_digest`, `cutoffs` | Hash of the exact next catalog entry list under `lattice-treehouse-route-inventory-v1`; sorted distinct `{replica, frontier, log_digest}` records covering every entry, including archives. Frontier IDs are sorted/distinct and verify against the independently restored raw log. `log_digest` is defined below and commits actual raw signed frames, not just displayed state or op IDs. |
| `author`, `cap`, `holder_epoch`, `deps` | Actual raw final-op author, exact current acquisition delegation ID, its honored acquisition op ID and exact sorted/distinct outer-op dependencies. No caller-supplied holder is accepted as authority. |
| `epoch`, `epoch_basis` | Maximum valid R03 ancestor epoch and exact nonempty sorted set of ancestor beacon IDs at that epoch; derived from the verified history. |

The two possession signatures cover
`Canonical.term(["lattice-treehouse-transport-possession-v1", purpose, claim])`,
with fixed purpose `:catalog` or `:service` and the corresponding new public key.
Both must verify even if a key is retained. They prove key control, not authority
or hardware custody. These are operator/service signatures, not a new witness
ceremony or arbitrary native member-signing endpoint.

There is no circular op ID: freeze the native/client store generation and actual
frontier; derive claim and exact inventory/cutoffs; obtain new-key possession
signatures; freshly verify the same state; sign the normal Space command last.
Its final op ID becomes the next binding ID. A changed dependency, authority
acquisition, inventory, key or cutoff requires new possession bytes and new
member review. Local journal attempt ID equals the claim nonce.
The Space cutoff is the frozen pre-action history/frontier; it cannot include
the action being signed. The inventory list likewise contains no new binding or
catalog ID. After signing, restore the action and its complete control/dependency
closure in addition to that committed cutoff. The first new catalog can then
name the final action ID. No claim, cutoff or possession signature depends on
its own future operation ID.

For each cutoff, `log_digest` hashes
`Canonical.term(["lattice-treehouse-recovery-cutoff-v1", replica, ops, rejected])`.
`ops` is the ID-sorted list of
`%{id: id, bytes: Canonical.op_payload(op), sig: op.sig}`
for the exact authenticated log, including all semantically quarantined ops.
`rejected` is the separately sorted list of preserved structural-quarantine
evidence
`%{id: id, bytes: Canonical.op_payload(op), sig: op.sig, reason: :bad_signature}`
validated by the existing R06 quarantine seam. This list cannot confer authority
or causal closure. Rejected evidence preserves its supplied ID/signature bytes;
they are not treated as valid digest/signature slots. Its raw op must roundtrip
through the current bounded carrier term/header grammar. A broader BEAM-only
quarantine record that cannot roundtrip is an explicit unsupported-cutoff refusal,
with original evidence preserved for export; it is not silently normalized.
Unencodable/malformed rejection evidence refuses the cutoff;
never invent canonical bytes for it or silently omit it. Exact replicated frame
bytes/signatures, sorted frontier and verified quarantine remain distinguishable
from equal projected state. The exact TS payload function is
`canonicalBytesForCarrierOp(frame)` from `src/codec.ts`; like
`Canonical.op_payload/1` (equivalently `Op.canonical_encoding/1`), it emits the
sig-free `lattice-op-v2` payload and normalizes dependencies with the existing
set ordering. Do not hash the JSON wire frame, `wire_version`, or a duplicated
signature as `bytes`. Reciprocal vectors must compare each payload byte string
and the complete domain-separated pre-hash cutoff bytes, as well as the digest.

### Two distinct verification stages, using the existing authority judge

The pure Space application callback validates closed record/possession shape,
causal honored bootstrap and the literal claim-to-op bindings after the existing
capability and admin-holder gates. It does not call the catalog resolver or
recursively judge its own command. A Core-honored proposed control is an
authorized signed action; route adoption still needs the following public pure
trust resolver. A marker or a callback success alone never switches a route.

Given all retained authenticated Space frames plus incoming frames, the resolver:

1. Verifies hash/signature/replica, exact dependency closure and canonical terms,
   retaining signed quarantined application/authority history. Missing closure
   requests bounded recovery; it does not evaluate a smaller convenient subset.
2. Calls the normal `Authority.analyze(Treehouse.Space, full_log)` / matching TS
   public analysis and requires the final replacement op to remain honored.
   Concurrent revoke, expiry beacon and holder-change semantics stay unchanged.
3. Calls the same existing authority judge on the action's strict ancestor log
   to obtain the actual admin acquisition at that causal position. It requires
   `holder_epoch` and `author` to match, and `op.cap` to equal that acquisition's
   embedded delegation ID, not a broader unrelated root grant. The delegation
   must include `replace_catalog_v1`, have `live: false`, finite unexpired lease,
   and the actual valid profile/beacon basis claimed above. Static signature,
   issuer, audience, parent attenuation and activation are ordinary Core checks.
4. Verifies the retained bootstrap, control graph, all possession signatures and
   exact route inventory/cutoff proofs. It obtains no replacement authority from
   a new operator, a service report, a role label or a standalone R04 certificate.
5. Atomically stores the accepted binding/catalog watermark with all observed
   heads before using a replacement route. Authentication and restore readiness
   must still pass against the new identity and exact promised cutoff.

Steps 2/3 reuse public analysis without adding a Core authority primitive or
context field. An implementation that cannot perform these steps with bounded
existing APIs must return for an exact interface review, not approximate the
authority timeline. The caller must serialize review, signing and promotion
against its current store; a pure function cannot prove snapshot completeness.

**R11a observation interface adopted 2026-09-06:**
`Authority.continuation_profile(log)` and async TS
`resolveContinuationProfileFromFrames({replica, frames})` independently verify
complete authenticated retained history and reuse the existing R04 delegation,
root, continuation-context and pin-selection helpers. Success returns the
actual `replica`, `root`, `profile_genesis`, normalized `profile`, `profile_id`
and `verified_frontier` (camelCase names in TS). BEAM wraps that record in
`{:ok, result}`; TS returns `{ok: true, ...result}`. Legacy family refuses as
`unauthorized_continuation`, unsupported reserved family as
`unsupported_authority_profile`, bounded missing/invalid pin as
`continuation_not_configured`, and malformed/incomplete/forged retained history
as `invalid_verified_history` (`{:error, reason}` / `{ok: false, reason}`).
These outcomes belong to this read-only observation, never replace existing
method returns, and create no policy, role or cache. A later malformed pin is
ignored under the existing selector; a later valid metadata-only pin supersedes
it. Caller-supplied trusted projections and fabricated continuation candidates
are not accepted inputs.

The integrator also adopted the narrow internal synchronous TS predicate
`continuationProfileBindingMatches(replica, causalOps, root, pin, profileId)` on
2026-09-06 for the existing synchronous application callback. It reuses those
same collectors and selector; its semantic-op input does not authenticate a
history. It is used only after the parent's existing authenticated-carrier,
capability and admin gates, and is not exported by the package index. Public
installation continues to use authenticated raw-frame observation. BEAM uses
`continuation_profile(Log.from_ops(...))` on that same authenticated causal
context. A new bootstrap shape/scope/root/pin mismatch returns the application
reason `application_invalid_catalog`, after existing malformed-command, cap and
admin refusal precedence. This adds no Core role or permission path.

**R11a package-boundary correction adopted 2026-09-06:** the existing
`export * from "./authority"` would expose the internal predicate despite the
contract above. The bootstrap lane may replace that wildcard in `src/index.ts`
with explicit value/type exports preserving every preexisting authority export
and omitting only `continuationProfileBindingMatches`. Public package-entry
tests must demonstrate the predicate is absent and existing symbols remain
available. The integrator must reconcile any additional authority exports from
concurrent packets before normal distribution regeneration; generated files
remain integrator-owned. This corrects the export boundary without changing
authentication or authority semantics.

The 2026-09-06 integrator-approved fixture amendment adds `ops:` to public
`Sim.create_replica/3` as an explicit genesis capability ceiling, with omitted
`ops:` preserving the current module-registry default exactly. It is not a
permission bypass: commands outside that signed ceiling still refuse. The four
historical Space vector scenarios explicitly pass their original six commands;
roles, policies, signatures and bytes stay unchanged. Root-only product creation
helpers likewise retain that literal old ceiling. New bounded fixtures choose
their larger pre-loss ceiling explicitly. The final gate regenerates all
historical vectors from freshly compiled current source and compares exact bytes.

## 4. Retained trust, concurrent controls and refusal behavior

Persist product/root/Space/bootstrap, accepted control chain, catalog watermark,
known competing heads and signed evidence separately from discardable discovery
cache. Never replace this with a downloaded smaller set. A fresh install has an
explicit bootstrap review; an existing member key plus missing/corrupt trust
store requires recovery and refuses automatic bootstrap replacement.

| Input/event | Required installed-client result |
|---|---|
| Same catalog/control bytes again | Idempotent; no second transition or lowered watermark. |
| Older generation/revision, wrong predecessor digest, unknown signer/product/root | Retain existing trust; refuse the candidate. |
| Missing control/history page | `trust_pending`; bounded fetch and no switch. |
| Two independently authorized sibling controls or catalog forks | Retain both heads; `catalog_fork`; no automatic winner or route switch. Stop new transport work until resolution. |
| Fresh valid admin resolution | Its parents cover every locally retained conflicting head and its op dependencies include the known causal conflict. Re-verify current authority and complete inventory; then advance generation. Parent records are evidence of observed bindings, not authority to sign this resolution. |
| Previously accepted action becomes quarantined after union with a concurrent revoke/holder change/beacon | `authority_changed`; preserve watermark/conflict evidence, cancel pending attempts and stop new use of the affected route. Do not fall back to the old signer. A fresh valid resolution must cover the observed heads/conflict; an old accepted-but-now-refused head cannot grant authority. |
| New service with incomplete/wrong cutoff | `recovery_incomplete`; transport stays pending, state never becomes an invented empty replica. |
| Above parser/history/head budget | Explicit `control_history_limit`; no partial promotion, truncation or silently discarded heads. |

These names are proposed **catalog/workflow** outcomes, not changes to Core's
quarantine vocabulary. Core reasons retain their existing precedence. Invalid
structure has no trust writes; authenticated conflicting evidence may be durably
retained while producing no route/signing effects. Byte-identical retry differs
from signing another attempt. Any authority reclassification must cancel a
pending signature/review before and after a blocking native presence call under
the existing R17 generation-token contract.

The proposed resolver refusal order is closed: malformed envelope/field/encoding
(`malformed_catalog`) or exceeded bounds (`control_history_limit`); wrong pinned
scope/version/profile (`wrong_catalog_scope`); missing authenticated closure
(`trust_pending`); failed signature/possession (`invalid_catalog_signature` or
`invalid_possession`); refused Core action (`catalog_authority_refused`, with its
unchanged Core reason attached); invalid predecessor/generation/inventory claim
(`invalid_catalog_transition`); retained rollback (`catalog_rollback`) or known
fork (`catalog_fork`, including nonce reuse); incomplete restored cutoff
(`recovery_incomplete`); unavailable authenticated route (`carrier_pending`).
An already accepted action's reclassification is the separate `authority_changed`
event above. These outcomes never replace the raw signed history's Core verdicts.
Authoring preflight additionally reports `catalog_command_too_large` before any
signature or persistence, and `catalog_epoch_missing` when no honored ancestor
beacon exists. These do not reinterpret an otherwise valid Core lease verdict.

Validate a candidate's declared predecessor graph before comparing it with the
installed head. A valid sibling is retained as a fork, not discarded as a bad
transition merely because another sibling arrived first. Recovery resolution
may cite an authenticated, previously observed head whose action is now refused;
that citation acknowledges evidence only. Its keys cannot authorize any child
control. The fresh resolution derives its authority independently from the root
bootstrap and the currently valid bounded admin action.

`context.visible_ops` restricts what application policy can inspect to strict
ancestors, but its verdicts reflect the current whole-log authority fold. They
are not permanent verdicts sealed at original receipt. Step 2 above therefore
uses the full retained union, while step 3 uses the strict prefix only to derive
the claimed acquisition. A later-arriving **concurrent** revoke/expiry beacon or
role acquisition, including a same-holder renewal, may reclassify an action.
An event causally after that action preserves it under the existing rules.
Elapsed wall time alone does neither. R11 does not modify those Core decisions.

A malicious current admin or catalog signer can create a fork or withhold
availability. The resolver prevents acceptance against known retained evidence;
it cannot prove that unknown operations were not withheld. Whole native-store
rollback is also not prevented by a private file, encryption or a MAC. Existing
native storage remains trusted outside the webview/cache mutation threat; no
new monotonic hardware anchor is asserted here. Physical/native R17 proof remains
separate from local installed-store process restart tests.

## 5. Operator journal and publication order

The named local operator owns `pilotctl add-replica`, `add-peer`, `remove-peer`,
`status` and `reconcile`. No public administration API or participant custody is
added. Inputs contain public signed frames, reviewed public identities, an
attempt nonce and secret-file **references**, never private keys in argv, JSON,
logs or QR. Existing filesystem ownership, no-symlink and manifest checks remain.

Use one durable per-host journal and exclusive operator lock across processes.
The lock mechanism must have a crash-released owner and a two-process exclusion
test; a PID file with guessed stale-owner deletion is insufficient. Each mutation
compares the intended manifest generation and catalog head with current durable
state. Stage immutable artifacts first, then atomically replace the active
manifest using the supported file/directory-sync discipline. Journal entries
record attempt/content IDs, expected generations, public inventories, exact
paths and phases; they contain no signing seeds.

| Durable phase | Work and restart/retry invariant |
|---|---|
| `local_draft` | Creator stores attempt nonce and reviewed request. Capacity check happens before rollover/archive. No catalog or semantic reference is published. |
| `genesis_created` | Persist exact child genesis, creation op, bounded profile and signed grants once. Child root is its actual independently generated creator key, not Space/operator authority. Freeze an actual signed Space reference frame but do not publish it yet. |
| `carrier_pending` / prepared | Authenticate/replay Space reference and child bundle; retain hashes and op IDs. Stage exact existing/new logs and next manifest, including required current-member peer admissions. Existing logs remain on their authoritative paths and are never overwritten by the staged bootstrap. |
| activated | Quiesce/stop the controlled release; wait for accepted operations' durable acknowledgement boundary. Activate next manifest generation and restart. Restarting closes old sessions so peer removals take effect. Failed activation stays pending; never reset a log or generate an identity. |
| ready | Check content-free health **and** authenticate each intended route with pinned realm/service key. Pull/verify exact replica/root/genesis/cutoff and required peer admission. The loopback health response alone cannot satisfy this phase. |
| catalogued | Sign and durably publish the next catalog after readiness. A crash here may leave an extra unused route/catalog entry; it grants no semantic visibility. |
| listed | Recheck current reviewed membership/authority/attempt, then publish the original staged signed Space reference. Require its exact ID/bytes to match the catalog. Persist local receipt; retry submits the same content-addressed op. |

Readiness is an observation at publication, not a future availability guarantee.
A later failed route is shown unavailable. If retained authority/roster changes
between staging and publication, stop for a new explicit review; do not quietly
re-sign. Reuse the same child/root/history/route as a superseding pending attempt
with an explicitly new reference/catalog revision. Never manufacture duplicate
genesis or discard acknowledged/history frames to simplify a retry.

A frozen reference is not guaranteed to remain honored until delayed publication.
Re-evaluate its actual signed frame with the complete current Space log. An
unseen beacon can be concurrent with that frame and lapse its cap even if the
beacon was signed later in wall time; a concurrent holder acquisition can also
make it stale. Refuse publication and create a newly reviewed superseding
reference/catalog revision in those cases. R10's ordinary `create_thread` does
not inspect membership removal, so a roster change may leave the frame honored
while its admission inventory is stale. The workflow must independently refresh
the current roster/grants and require fresh review; do not claim Core quarantines
that reference merely because a member was removed.

`reconcile` resumes from durable facts, not solely from the last phase string:
verify staged hashes, current manifest and exact log inventory, running identity,
route readiness, catalog head and original reference receipt. After a crash
between rename and journal update, inspect both generations and continue the
same intent. Ambiguous/corrupt/mismatched inventory refuses and preserves files.
Do not delete a pending route/log as an automatic compensation. A failed service
restart may interrupt unrelated routes on this single pilot host; status reports
that outage explicitly. R16 owns supported Linux reboot and public WSS evidence.

### Peer and removal reconciliation

In the first profile the admitted carrier public key is the same public identity
named by the signed membership/grant evidence; a realm label is only a mapped
transport name. A different carrier-key binding needs a separately defined signed
contract and is not inferred by this CLI. `add-peer` validates the exact reviewed
public recipient, current inventory and per-replica admission request; it never
issues a grant. Initial founder transport admission is covered by root bootstrap
evidence. Retrying an old add-peer against a newer removal/manifest generation
refuses rather than re-admitting the peer.

Removal records three independent facts: honored Space membership removal,
issuer-authorized per-replica revocation or valid lease lapse, and effective
transport denial. Enumerate Space plus all current/archived Threads; retain a
per-replica ledger of exact grant/issuer/peer outcomes. Reconcile new inventory
appearing during an attempt before claiming completion. `remove-peer` can update
transport immediately while semantic signatures remain pending; it must restart
or otherwise prove closed old sessions, then probe that the removed key cannot
authenticate any affected route. A manifest edit is not completion.

Only the actual issuer/root may author the existing revoke. If unavailable, show
the unresolved grants until a valid signed lapse/revocation is established.
The operator does not sign as a member; the Space admin does not acquire a child
root's powers; membership removal does not erase historical plaintext. R14 owns
the human review and signature flow, including fixed-nominee eligibility checks.

Capacity is a **catalog/provisioning** cap, as Plan178 already specifies. Operator
serialization prevents its 13th Thread route/listing and the host's 65th route.
R10 can still retain/honor independently authored excess semantic references;
R11 shows those as unavailable/over-limit and stops new provisioning, rather
than inventing a global Core cardinality rule. Archives retain slots, routes and
history. One group's 13 routes are not the whole host's 64-route inventory.

## 6. Executable acceptance contract and packet split

Every row is currently OPEN. Tests must use public raw-frame verification,
`Log.accept`/normal authority/materialization, actual Manifest/Runtime/Holder
boundaries and retained trust APIs. Mocks of an authority verdict or readiness
success cannot close these cases. BEAM and TS author reciprocal signed vectors;
wrong-input controls exercise the same public seams as successful cases.

| ID | Public acceptance and negative controls | Packet |
|---|---|---|
| C01 | Root bootstrap, profile pin, catalog bytes/hash/signature agree both directions; extra/missing fields, malformed Base64/IDs/text, wrong root/product/schema/family, forged/unknown signer refuse. Actual one-op push envelopes at the carrier budget boundary pass/refuse without changing the 64,000-byte cap; a 128-KiB-valid artifact can still be refused for command size. | R11a |
| C02 | Exact Space/Thread root/genesis/creation/reference bytes bind routes; extra entry stays invisible, missing route unavailable, altered reference/service key/derived realm refuses. Moving a route between different replicas across revisions or bindings refuses. | R11a |
| C03 | Same installed trust reopens after process stop; identical replay idempotent; older revision/wrong predecessor/cross-product artifact cannot lower trust. Missing/corrupt trust with existing identity refuses. | R11a |
| C04 | Planned old-key rotation with new-key possession passes; wrong old/new signature, mutated cutoff and attempted service change refuse. Same-key encrypted restore is a distinct path. | R11a/R11c |
| C05 | Exactly 12 Threads including archives and 64 host routes accepted; next route, duplicate path, replacement Space and archive slot reuse refuse. Concurrent two-process operator requests cannot bypass bounds or reset existing logs. Excess signed Space references remain auditable/unavailable. | R11b |
| C06 | Crash before/after every journal write, log stage, manifest rename/sync, restart, readiness, catalog publish and reference receipt; retry yields one genesis, route and exact reference, preserving acknowledged ops. | R11b |
| C07 | Real authenticated route with wrong service/realm/replica, missing root, smaller cutoff, read-only relay or missing member admission cannot become catalogued/listed; health-only success is insufficient. | R11b |
| C08 | New child after founder loss: actual bounded admin reference, independent living child creator/root, current roster grants, child pin, operator readiness, then exact reference publication. Space cap reused on child, forged child root and changed roster/ref attempt refuse. | R11b/R04/R14 |
| C09 | Removal across Space +12 current/archived Threads, one offline issuer, interruption and new pending Thread; transport denial proves all sessions closed, actual issuer-owned semantic grants remain explicitly pending. Stale add-peer cannot undo it. | R11b |
| C10 | Keep installed client's original trust; remove access to founder, old service and old catalog private keys/backups; obtain real R04 bounded successor/renewal from preauthorized witnesses, sign exact admin replacement with newly created operator keys, restore member frames and authenticate/replay the same cutoff. No injected trusted key/object, old private key or altered replica root is used. | R11c |
| C11 | Missing pre-loss permission/profile, no honored ancestor beacon, living-root genesis cap, unleased/wrong acquisition cap, stale holder, bad parent/attenuation, revoked/lapsed authority, wrong nonce/deps/epoch/basis/profile/cutoff and either bad possession signature refuse. R04 certificate alone grants no catalog trust. Reciprocal cutoff pre-hash bytes include bad-signature evidence; unsupported raw evidence refuses without being discarded. | R11c |
| C12 | Two partitioned authorized replacements from the same parent delivered in both orders cause retained fork and no automatic switch; repeat with reused nonce/different claims. Valid resolution covers both; omitted head and old-key-only resolution refuse. | R11c |
| C13 | Union adds a concurrent revoke/holder transfer/lapse beacon invalidating an already accepted action: cancel pending signing, freeze route use, preserve watermark. Current-authority resolution covers the conflict without trusting the refused parent as authority. Causally later revocation leaves prior valid historical action intact under normal Core rules. | R11c |
| C14 | Missing chain/causal page and budget overflow cannot promote partial trust; restore after interruption retains all observed heads. Third unresolved valid binding head hits the explicit limit without eviction; rotation and replacement heads count together. Unknown withheld ops/whole-store rollback remain nonclaims. | R11a/R11c |
| C15 | Two complete cycles across one Space +12 Threads, old and new member grants, one new child, and combined transport replacement reconstruct identical BEAM/TS state/quarantine/cutoff. Count ordinary ops, signatures and retained bytes from actual histories, with no physical prompt/timing claim. | R11b/R11c |

Proposed owned seams are `Treehouse.TransportCatalog` (pure codecs/trust),
`Treehouse.Space`'s two commands and callback, TS `treehouse_catalog.ts` plus its
explicit Treehouse decoder, and carrier-server `PilotCtl`/journal modules with
one local Mix task. Client/native persistent adapters integrate later through
R12/R14/R17. No HTTP administration route, general signing API or raw seed API.
R11a may build local pure seams before dependencies close, but no downstream
enrollment/profile enablement or hosted merge before required parents are green.

Required implementation gates: focused public C01-C15 suites; reciprocal
BEAM-to-TS and TS-to-BEAM signed exporters; every protected legacy vector
byte-identical; `mix check` with the AGENTS toolchain and `ERL_FLAGS='+S 4:4'`;
all existing named TS gates plus the catalog gate; carrier authentication,
frame-bound, durable acknowledgement and read-only refusal matrix. Add CI calls
only if existing entrypoints do not already invoke these tests. R16 supplies
Linux reboot/WSS; R17 supplies scoped native review/custody/presence; R18 supplies
physical retained-install recovery. Local green tests do not close those gates.

## 7. Exact source-contract amendments adopted before code

The dated R11 amendment to Plan158's catalog section preserves historical
text and identifying the clauses it supersedes:

> For the unified Treehouse profile only, replace the lost-catalog-key requirement
> for a new founder/product-root ceremony with a living-root-pinned delegation to
> an honored bounded Space-admin `replace_catalog_v1` action. The permission must
> exist in its pre-loss acquisition ceiling. Installed clients retain the original
> bootstrap and verify full current Core authority, exact control predecessor
> digests, new-key possession, route inventory and cutoff before adoption. No new
> root, operator authority, fresh-client trust injection or additional catalog
> witness quorum is implied. Planned old-key rotation and encrypted same-key
> restore remain separate. Known fork, rollback, reclassified authority and
> missing evidence stop automatic switching. Publication binds the exact prepared
> signed Space reference and child genesis/creation bytes, readies transport and
> signs the catalog before publishing that original reference. Treehouse's 12
> Thread limit includes archives and is a catalog/provisioning limit. Other
> products' catalog recovery policies are not changed by this amendment.

The dated Plan178 amendment immediately after its Space command vocabulary
explicitly extends the ordered list by these two entries before implementation:

> `catalog bootstrap v1` is the root-authored, admin-field-gated Space command
> `catalog_bootstrap_v1(record)`, which pins the closed transport-only binding and
> bounded-admin replacement rule before loss. `replace catalog v1` is
> `replace_catalog_v1(claim, catalog_possession, service_possession)`, which records
> a scoped admin-authorized transport replacement proposal. Actual route adoption
> additionally requires the retained-trust resolver's full authority, possession,
> inventory and readiness checks. Neither command changes membership, grants,
> immutable replica roots or child authority. Existing command mappings and
> protected claim text remain unchanged; these commands are not enabled in the
> existing root-only preview. The exact closed shapes and executable refusals are
> the reviewed R11 contract, not caller-selected signing payloads.

The Plan178 copy-contract test must receive this named vocabulary amendment; do
not silently loosen its exact-command assertion or change protected hosting,
founder-loss or legacy one-pager strings. Add a dated disposition to R02 section
6 and its capability table: the separate two-of-three catalog witness proposal
is superseded for this profile by the explicit bounded-admin delegation above.
Retain R02's installed-client, fork, cutoff, key-loss and rollback tests. R17
requires review of these actual Space commands before native enablement, but
gains no separate catalog-witness purpose by default.

## 8. Integration boundaries and remaining review decisions

R04 and R10 must be integrated only after the root checks the conflict inventory.
Their merge base is `7f984d44`; both include earlier prerequisite changes, so
cherry-picking overlapping R03/R09 commits again is incorrect. Shared hot seams
include authority BEAM/TS, carrier/codec/op/quarantine, Sim/log/compaction mirrors,
the legacy exporter, package/index and generated output. Union R04's bounded
family/continuation guards with R10's ordered effects/product decoding; retain
R10's duplicate-role canonical-set normalization. Regenerate outputs after the
source union. Shared README/unified ledger remain exclusively root-owned.
The non-mutating merge-tree probe of those two frozen commits found text
conflicts in `src/authority.ts`, `src/carrier.ts`, `src/op.ts`, plus generated
`dist/src/authority.js`, `dist/src/carrier.js`, `dist/src/op.d.ts` and
`dist/test/conformance.js`. `authority.ex` auto-merged textually; that is not
semantic approval. R04's later reviewed P2 fix `75e544d2` must also be preserved;
R10's active review fixes require its final frozen SHA before an actual merge.

On 2026-09-06 the integrator adopted the exact maps/domains,
single product service identity, explicit same member/carrier-key profile,
two-binding-head/128-KiB standalone input bounds with the unchanged carrier
envelope budget, strict current-acquisition cap and first-beacon requirements, and the
fork/reclassification resolution rules after Claude Fable PASS. These are the
concrete selected defaults, not measured field bounds. A needed Core semantic
change, different carrier-key binding or additional native signing purpose is a
new named review boundary. This document contains no adopted field measurement,
device attestation result or permission to enable an incomplete profile.

The original review and correction are preserved at `0666e726` and `789ab235`.
On 2026-09-06 the integrator adopted the narrower state-compatibility amendment:
catalog controls come from honored signed command history, preserving all existing
materialized field types and empty-state/vector shapes. This corrects the reviewed
draft's proposed `catalog_controls` field and two-effect wording. The final
implementation review must check this explicit correction; closed command bytes,
permissions and retained-history requirements are unchanged.
The final follow-up resolved all five original findings. Its one advisory
frontier-width point is addressed in section 2 with the integrator-adopted
bounded operational disposition. C01–C15 remain OPEN until their implementation
packets provide the stated evidence; design review alone closes none of them.


### Cutoff and bootstrap observation build paths, 2026-09-06

The integrator assigns pure `Treehouse.CatalogCutoff` to
`apps/lattice_core/lib/treehouse/catalog_cutoff.ex`, with public tests in
`apps/lattice_core/test/treehouse/catalog_cutoff_test.exs`. `derive(log)` first
uses the existing R06 accepted/quarantine authenticity checks, verifies exact
bounded carrier round trips and complete accepted dependency closure, then returns
`{:ok, %{cutoff: %{replica: replica, frontier: ids, log_digest: digest},
canonical_bytes: bytes, ops: accepted_records, rejected: rejected_records}}`.
The sorted raw records and pre-hash bytes follow section 3 exactly. Invalid
history returns `{:error, :invalid_verified_history}`; authenticated or validated
rejected evidence outside the shared bounded grammar returns
`{:error, :unsupported_cutoff}` without changing or omitting the source evidence.
No state projection, authority claim, file I/O or trust promotion occurs here.

The TS bootstrap query is `treehouseCatalogBootstrapsFromFrames({replica, frames})`,
returning `{ok: true, bootstraps: [{id, record}], verifiedFrontier}` after cloning,
authenticating complete raw history and normal product materialization, or
`{ok: false, reason: "invalid_verified_history"}`. Return every actually honored
bootstrap deterministically; the query never chooses trust or resolves a fork.
The corresponding BEAM query reuses normal `Authority.analyze(Treehouse.Space, log)`
after R06 verification. Existing authority marker state is never the audit source.
These are additive R11a public seams and tests, not catalog/profile enablement.

The BEAM observation is assigned to `Treehouse.CatalogBootstrap.observe(log)` in
`apps/lattice_core/lib/treehouse/catalog_bootstrap.ex`, with public tests in
`apps/lattice_core/test/treehouse/catalog_bootstrap_observation_test.exs`. It
returns `{:ok, %{bootstraps: [%{id: id, record: record}], verified_frontier: ids}}`
in normal canonical operation order after R06 authentication and the full
Space authority fold, or `{:error, :invalid_verified_history}`. It preserves
validated rejected evidence in its input and never uses it as honored history;
the separate cutoff binds that evidence. Multiple honored root bootstraps are
returned together. Selecting/persisting trust remains the retained-trust gate.

### Shared raw cutoff portability amendment — 2026-09-06

The integrator adopts a cutoff-only shared grammar for BEAM/TS observations.
This is stricter than the broad in-VM R06 log, preserves all source evidence,
and changes neither general Wire/TS ingress nor canonical encoding. A supported
cutoff uses exact raw CarrierTerm payload encoding rather than semantic decode.
Accepted history first passes R06 authentication and complete dependency closure;
rejected entries must be distinct per supplied ID, same replica, actually invalid
under hash/signature verification, and carry exactly `bad_signature`. The same ID
may occur once in each of the two separate lists. Rejected dependencies cannot
satisfy accepted closure. Where raw evidence is representable its authentication
failure takes `invalid_verified_history` precedence. Broader validated evidence
that cannot meet the shared portable grammar returns `unsupported_cutoff`.

Raw headers require a 32-byte author, lossless UTF-8 replica/ID/dependency text
and binary signatures. A rejected ID need not be a hash and its signature need
not have 64 bytes; both are preserved verbatim. Embedded delegations require
32-byte issuer/audience, 64-byte signature, the existing flat shape and a lease
that is absent or a safe JSON integer. Generic tagged integers remain exact
through uint64 maximum, using canonical decimal strings above the safe horizon.
The current depth64 and duplicate-canonical-map/set refusals remain. Unknown
atoms are retained as unsupported evidence: the cutoff-only fixed vocabulary
is the 130 sorted names frozen in
[`cutoff_atoms_v1.json`](../../clients/lattice-client/test/vectors/catalog/cutoff_atoms_v1.json), SHA256
`a66d085dd185091d745d933c3145101a97b3306406aba905af07ca051d09506c`, in the retained execution evidence. Both runtime constants and reciprocal fixtures must match
that exact set; no runtime atom creation or dynamic module-loading vocabulary.

Each operation must fit **64,000 UTF-8 bytes**, inclusive, in the actual complete
`{type: "push", ops: [frame]}` JSON envelope. There is no invented aggregate cutoff
cap; existing total-history limits still govern callers. Unsupported headers,
wide numeric delegation leases, unknown atoms, oversized frames or in-VM values
refuse without pruning history or claiming recovery. The read-only TS API is
`deriveTreehouseCatalogCutoff({replica, frames, rejected: [{frame, reason}]})`;
it clones input before awaiting authentication and returns the BEAM-equivalent
cutoff, canonical bytes and separate sorted records, or the two named refusals.
The implementation lives in `treehouse_catalog_cutoff.ts`; its public/reciprocal
tests and BEAM `CatalogCutoff` portability tests must include high exact epochs,
semantic quarantine, rejected-plus-genuine same IDs and unsupported raw evidence.

The BEAM vocabulary is compiled from those fixed literal atoms; loading the
cutoff module makes the entire closed grammar available to the existing-atom
Wire decoder in a fresh VM. It never interns a name from imported input.

### Continuous reciprocal cutoff gate — 2026-09-06

The integrator assigns `catalog_cutoff_reciprocal_test.exs` under the existing
Treehouse test directory to turn the reviewed manual reciprocal proof into a
required full-suite gate. It invokes the actual TS exporter/observer with fresh
temporary files and independently signs BEAM histories, then compares every raw
record, canonical pre-hash byte, digest and frontier in both directions. It uses
the committed fixed-atom fixture, not a machine-local vocabulary or copied result.
Existing Node/client preparation applies; missing dependencies fail this gate.
Temporary test-owned files are removed after the test. This changes test wiring
only; the reviewed cutoff grammar and C01–C15 status remain unchanged.
