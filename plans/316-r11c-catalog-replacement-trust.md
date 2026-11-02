# 316 — R11c catalog replacement trust and recovery

Status: PR 0 GO (API-sufficiency probe, test only, 2026-11-02); design merged in #211 (`7bdace22e`). PRs 1–2, PR 3's generation keying and PR 6's
exporter test can start on fixtures now. PR 4 waits on OD-16 (D-275/D-278), OD-17, plans 267/269
and row 320; PR 3's closed-binding refusal and PR 6's C15 run wait on PR 4. PR 5 native track; PR 7 rule 8. C10–C15 OPEN.

- **Row, priority, effort**: 316 (roadmap R11c, `plans/roadmaps/treehouse-unified-2026-09-06.md`); P1 / L
- **Depends on**: plan 224 PRs 1–3 (DONE), plan 263 (DONE, custodian ledger), R03 and R04 (DONE,
  beacons and bounded continuation); PR 4 also on 267/269. **Planned at** `cb7ffa3bc`, 2026-11-01
- **Drift check (run before each PR)**:
  ```sh
  L=apps/lattice_core/lib; C=clients/lattice-client/src
  git diff --stat cb7ffa3bc..HEAD -- $L/treehouse/{space,transport_catalog,catalog_trust,catalog_cutoff}.ex \
    $L/lattice/authority.ex $C/treehouse{,_catalog_codec,_catalog_trust}.ts docs/research/treehouse_catalog_lifecycle.md \
    apps/lattice_carrier_server/lib/lattice_carrier_server/operator/catalog_ceremony/
  ```
  If an in-scope file changed, recheck the "current state" notes; a cited-line mismatch is a STOP.

## 0. Status and normative source

Normative: [`docs/research/treehouse_catalog_lifecycle.md`](../docs/research/treehouse_catalog_lifecycle.md)
§2–§4 and §7 (**adopted contract**, integrator PASS at `789ab235`: command, claim fields, domains,
both stages, closed refusal order, C10–C15) and
[`docs/research/treehouse_founder_lifecycle.md`](../docs/research/treehouse_founder_lifecycle.md)
§6 (R11 amendment, A09 combined-loss fixture). This plan pins only what the contract leaves to
"R11c review", maps checks to code and splits PRs. Two pins read as contract interpretations,
D-275 (closing rule) and D-278 (which "known causal conflict" §4 puts in a resolution's deps);
both are OD-16 and need integrator sign-off. There is no catalog quorum (D-267): authority is the
living root's bootstrap delegation to an honored bounded Space admin (contract §1); R04 witnesses
govern admin acquisition and renewal; the custodian holds a key.

### Current state on `cb7ffa3bc`

| Fact | Where |
|---|---|
| `replace_catalog_v1` is a closed wire atom. It is in the bounded genesis ops ceiling but has no Space command. | `space.ex:26-29`; `wire_vocabulary.ex:178`; `wire_vocabulary.ts:163`; `treehouse_bounded.ts:33` |
| Every claim field atom is already in the closed vocabulary and the cutoff atom list. | `wire_vocabulary.ex`; `catalog_cutoff.ex:20-33` |
| The cutoff, inventory and rotation-possession byte functions exist. | BEAM `TransportCatalog.inventory_bytes/1`, `inventory_id/1`, `rotation_possession_bytes/1`, `service_realm/1`, `Treehouse.CatalogCutoff`; TS `canonicalBytesForCatalogInventory`, `catalogInventoryId`, `canonicalBytesForCatalogRotationPossession`, `catalogServiceRealm`, `treehouse_catalog_cutoff.ts`; native `catalog_eval/cutoff.rs`, `rotation.rs` |
| Old-key rotation is resolved in `resolve_binding!/3`. | `catalog_trust.ex:660-705` (TS twin around `treehouse_catalog_trust.ts:234`) |
| A binding node carries only `key` and one `parent`. Entry service checks and rotation key-distinctness read `context.bootstrap.service_*`. Routes build `origin`/`url` from `context.bootstrap.origin`. | `catalog_trust.ex:566-567`, `:672`, `:1349`, `:1351`; `treehouse_catalog_trust.ts:234`, `:261`, `:794-797` |
| Heads, forks and ancestry assume one parent per binding. Persisted-state restore checks one `parent`. | `catalog_trust.ex:1288-1309` (`rotation_forks/3`, `binding_heads/1`), `:2129` (`catalog_ancestor?/3`); TS `:290-310`, `:479` (restore), `:515`, `:523` |
| Evidence pages have exactly `[:catalogs, :rotations, :histories, :cutoff_proofs]`. | `catalog_trust.ex:25` |
| The closed `CatalogTrust.reason` set already contains every outcome R11c needs. | `catalog_trust.ex:91-110` |
| Authority observation APIs: `holder_epoch/3`, `acquisitions/3`, `analyze_with_beacon_evidence/2`, `analyze_with_records/2`, `continuation_profile/1`. | `authority.ex:135-180`, `:554-590` |
| Epoch/basis derivation and sign-last pattern for a Space command that carries a claim. | `member_continuity_authoring.ex` (`epoch/1`, `placeholder/1`, `intent/4`); `member_continuity.ex` `epoch/2` |
| The custodian ledger is keyed on `binding.bootstrap_id` and `binding.record.catalog_key`. | `catalog_ceremony/signing_ledger.ex:23-48`; `catalog_ceremony/binding.ex` |
| Seed and backup both lost: "Replacement is the R11c procedure, which is not built." | `docs/treehouse_catalog_signer_custody.md:417-420` |

**Grounding corrections** (D-273): native rotation exists (`catalog_eval/chains.rs`, plan 267)
but has no replacement node, so a replacement binding fails closed with `trust_pending` at
`Work::Binding` (`chains.rs:290-297`). PR 1 adds no wire atoms.

**Scope.** One Space command, a claim codec, authoring preflight, resolver integration, ledger
generation and parity vectors, on disposable-key fixtures. Out of scope: code in this design slice;
native `catalog_eval` source; `codex/treehouse-*` branches; the real Space; the ceremony;
Township and Toolshed.

## 1. Threat model

A "retained client" keeps its original bootstrap review and accepted watermark (contract §4).

| # | Attacker or loss | What the retained client checks | Outcome |
|---|---|---|---|
| a | Catalog signer seed and backup both lost (custody `:417`) | — | Recovery is a bounded-admin replacement. The old key is not an input. |
| b | Catalog signer compromised, admin intact. It can sign catalogs and old-key rotations under bindings it holds; it cannot change keys through a catalog or service identity through rotation. | Entry/inventory checks; route-reuse refusal; fork detection; the closing rule (D-275) | Bad catalogs refused; two signed revisions fork and pause transport. An admin replacement cites the attacker's heads in `parents` and **closes** every cited binding and its ancestry: later old-key rotations or catalogs under it are retained evidence and refused, so one resolution ends the attacker's ability to force `catalog_fork`. Suspected exposure is loss (`:420`). |
| c | Service key lost | Possession under `:service` | A partial-loss replacement keeps the catalog key (fresh `:catalog` possession) and sets a new service ID, key and, if needed, origin. |
| d | Founder, old catalog key and old service key all lost (C10/A09) | Full stage B | Only an R04 bounded successor acts, and only if its pre-loss ceiling includes `replace_catalog_v1`. Its rootless continuation delegation (`parent_id: nil`) is Core-honored and accepted (step 4). No old key, injected trust or root change. |
| e | Malicious current admin | Ordinary revoke, transfer and lease rules | Accepted residual (contract §1). A concurrent revoke, transfer or lapse reclassifies it (row g). |
| f | Two authorized sibling replacements, or one nonce reused with different claims (C12) | Declared-graph validation, then sibling and nonce-reuse detection | `catalog_fork` in either delivery order. Both heads retained, no route switch. A resolution covers both, and its deps include both ops. |
| g | Concurrent revoke, holder change or lapse beacon after union (C13) | Stage B step 3 on the full union | `authority_changed`: freeze routes, keep watermark and the refused node as evidence. A fresh current-admin resolution citing it unfreezes; the client never falls back to the old signer. |
| h | No honored ancestor beacon | Preflight; stage B epoch derivation | Authoring stops with `catalog_epoch_missing`; the resolver refuses `catalog_authority_refused`. |
| i | Living root's unleased genesis cap, or a leased grant without an honored acquisition | Strict-prefix acquisition match; finite lease (not attenuation, which Core owns) | `catalog_authority_refused`. The root must take a finite acquisition or rotate instead. |
| j | Wrong root, product, Space, version or profile; cross-product replay | Pinned bootstrap scope | `wrong_catalog_scope` |
| k | Rollback to an older generation, a wrong predecessor, or a child of a closed binding | Generation, predecessor and closing checks | `catalog_rollback` / `invalid_catalog_transition` |
| l | Incomplete or wrong cutoff for the new service | `log_digest` against the restored raw log | `recovery_incomplete`; never an invented empty replica. |
| m | Missing control or history page | Closure | `trust_pending`; bounded fetch, no switch. |
| n | Head or budget overflow (rotation and replacement heads count together; closed children and raw refusal evidence are not heads but count against parser bounds) | `overflow/2` | `control_history_limit`; no partial promotion or eviction. |
| o | Trust injected into a fresh client, a new operator key, a URL or a test object | Not a resolver input | Never proof |
| p | Withheld unknown ops; whole-store rollback; compromised-webview re-observation (OD-10, row 260) | — | **Non-claims** (§10) |

## 2. Exact artifacts and canonical bytes

Contract §3 restated with code names. **Claim** (closed map; extra or missing field is
`malformed_catalog`):

| Field | Rule |
|---|---|
| `version`, `product`, `space`, `bootstrap` | `1`, `:treehouse`, pinned Space, pinned bootstrap ID |
| `profile_genesis`, `profile_id` | Equal the retained bootstrap and `Authority.continuation_profile/1` at the strict prefix |
| `parents` | Binding-head IDs (bootstrap, rotation or replacement, D-276 refused nodes included): sorted, distinct, nonempty. First replacement: the current heads (the bootstrap unless a rotation advanced it, e.g. `[T]` after B→T). |
| `prior_catalogs` | **Pinned (D-271):** sorted, distinct `%{binding, catalog}`; at least one per parent; every retained catalog head under that parent (more than one when that binding's catalog chain forked); `catalog: nil` only as the sole entry for a parent with no known catalog. Coverage is an authoring obligation (PR 2), judged by the verifier only at step 7. |
| `generation` | `max(parent generation) + 1`, within the safe-integer horizon |
| `nonce` | Fresh 32-byte `Nonce`; also the local journal attempt ID |
| `new_catalog_key`, `new_service_id`, `new_service_key`, `new_origin` | 32-byte keys, `new_catalog_key != new_service_key`; for each parent a changed service key means a changed service ID; canonical origin grammar |
| `inventory_digest` | `TransportCatalog.inventory_id(entries)` of the first catalog under the new binding |
| `cutoffs` | Sorted, distinct `%{replica, frontier, log_digest}` covering every entry incl. archives; `Treehouse.CatalogCutoff` |
| `author`, `cap`, `holder_epoch`, `deps` | The final op's `author`, `cap`, the honored acquisition op ID, the op's sorted `deps` |
| `epoch`, `epoch_basis` | Maximum honored ancestor beacon epoch and the sorted nonempty beacon IDs at it |

**Possession bytes**: `Canonical.term(["lattice-treehouse-transport-possession-v1", purpose, claim])`,
`purpose ∈ {:catalog, :service}`, verified under `new_catalog_key` / `new_service_key`. Both are
required even when a key is kept.

**New pins** (decisions in the log, see the end):

- **Binding ID (D-268).** The final `replace_catalog_v1` op ID. The first catalog under it is
  `revision: 0, previous: nil`, `inventory_id(entries) == claim.inventory_digest`, every entry
  carries the new service ID/key, realm `"treehouse-service:" <> new_service_id`.
- **Namespace (D-272); no page field.** Replacement IDs are `lattice-op-v2` digests, rotation IDs
  use the rotation domain, so one `bindings` map is sound. Nodes come from `histories`, which
  already carries quarantined ops.
- **Binding node (D-270).** Every node carries `{key, service_id, service_key, origin, parents,
  refused?}`. The bootstrap seeds it; a rotation inherits service and origin from its parent and
  has a one-element `parents`; a replacement sets them from the claim. Entry service and realm
  checks, the rotation `new_catalog_key` distinctness check, and route `origin`/`url`
  construction (`routes/1`, TS `catalogRoutes`) read the **current binding**, not
  `context.bootstrap`. Heads, forks and ancestry (`binding_heads/1`, `rotation_forks/3`,
  `catalog_ancestor?/3`, TS `:290-310`, `:515`, `:523`) become multi-parent. Persisted
  single-`parent` trust stores (TS `:479`, BEAM restore) restore unchanged; `chains.rs` in PR 5.
- **Refused nodes are evidence (D-276).** A `replace_catalog_v1` op that passes every intrinsic
  check (OD-17 default: steps 1, 2, 4, 5 and 6, all read from its own bytes and ancestry) but is not honored on
  the full union (step 3) is a node with `refused?: true`, in every delivery order. It may be cited in
  `parents` and `prior_catalogs`; catalogs under it are retained conflict evidence. It authorizes
  nothing: a rotation, catalog or route under it is refused. Any other authenticated refused op
  (a non-admin's, or one failing scope, prefix or declared-graph checks) is **raw refusal
  evidence**: kept and exported (plan 266), never a node, head or citable parent. It counts
  against parser/history bounds but not the head budget: non-admin proposals cannot add a head or
  reach the head limit, though enough raw bytes still hit the parser bound (`control_history_limit`,
  fail closed, row n).
- **Closing rule (D-275, OD-16).** Every binding that is an ancestor-or-self of a `parents` entry
  of any D-276-eligible replacement node (honored or refused) is closed to old-key children. A
  rotation from it, or a catalog under it past the cited `prior_catalogs`, is retained evidence
  and refused (`catalog_rollback`); if it had been accepted, the result is `authority_changed`,
  never a silent switch, cleared by a fresh admin resolution citing the current heads. The node
  set only grows, so closure is monotone: it survives reclassification and is delivery-order
  independent. Two **admin** siblings still fork (C12). Rationale: the contract's sibling-fork
  rule covers controls of equal standing; without the rule an old-key holder forces
  `catalog_fork` forever.
- **Possession domain reuse (D-269).** Rotation and replacement share the domain and `:catalog`
  purpose; `Canonical.term` encodes map keys, the closed key sets differ (`parent` vs `parents`,
  …), each normalizer refuses the other's, and a negative cross-use test pins both ways (OD-12).
- **Retention (D-271, OD-15).** A claim may keep both keys and the service ID (no-op refusal is
  rotation-only, plan 274).

**Proposed names** (PR 1 fixes them): BEAM `TransportCatalog.{normalize_replacement_claim/1,
replacement_claim_bytes/1, replacement_possession_bytes/2, verify_replacement_possession/3}`; TS
twins in codec convention (`normalizeCatalogReplacementClaim`, `canonicalBytesForCatalogReplacement*`).

## 3. Verification stages, mapped to code

**Stage A — Space application callback.** A new `command_op_status/3` clause for
`{:replace_catalog_v1, [claim, catalog_possession, service_possession]}` in `space.ex`, with the
matching branch in `treehouse.ts` (registry `:283`, decoder near `:316`, status near `:401`),
after the existing cap and admin-holder gates. It checks the closed shape; that the bootstrap ID
names a causally visible honored `catalog_bootstrap_v1` (as the clause at `space.ex:568`);
`claim.author == op.author`, `claim.cap == op.cap`, `claim.deps == Enum.sort(op.deps)`, and
`claim.holder_epoch` is a visible ancestor; and both possession signatures. Failure is
`application_invalid_catalog`. Stage A does not call the resolver. A Core-honored action is not
a route switch.

**Stage B — the resolver.** `resolve_binding!/3` in `catalog_trust.ex` and its TS twin gain a
third node source: an authenticated `replace_catalog_v1` op in Space history. For each:

1. **Shape and scope.** Closed claim shape (`malformed_catalog`); `version`, `product`, `space`,
   `bootstrap` and `profile_genesis` against the retained bootstrap: `wrong_catalog_scope`.
2. **Closure, bindings, possession.** Every frame authenticated, dependency closure exact (else
   `trust_pending`). Then the resolver itself re-checks Stage A's literal bindings
   (`claim.author`/`cap`/`deps`/`holder_epoch` against the op, and the pinned bootstrap ancestral
   and honored at the strict prefix; else `invalid_catalog_transition`)
   and both possession signatures (`invalid_possession`): Core refuses a revoked or lapsed command
   at its authority gate before `command_op_status/3` runs, so a union-refused op was never
   Stage-A validated.
3. **Full union.** `Authority.analyze(Treehouse.Space, full_union)`. Not honored: a refused node
   if steps 1, 2 and 4–6 pass (OD-17), else raw refusal evidence (D-276); the candidate is
   `catalog_authority_refused` (Core reason attached), or `authority_changed` if accepted earlier.
4. **Strict prefix**, one `Authority.analyze_with_records(Treehouse.Space, strict_ancestor_log)`:
   `holder_epoch(:admin) == %{holder: op.author, op_id: claim.holder_epoch}`; the acquisition
   record `{claim.holder_epoch, author, delegation_id}` is the **Core-honored** current `:admin`
   record at that prefix and has `delegation_id == op.cap`. The resolver does not re-check the
   delegation chain: signature, issuer, audience, parent attenuation and activation are Core's
   (contract §3 step 3). The record may be a root-attenuated grant **or** an R04 continuation,
   whose delegation is self-issued with `parent_id: nil` (`continuation.ex` `scope?/4`); both are
   accepted (D-280). Resolver-specific predicates only: the ceiling contains
   `replace_catalog_v1` with **inherited provenance** (the permission is in every honored
   `:admin` ceiling from the latest root-attenuated record to this one; Core's `scope?/4` subset
   rule already implies it, and PR 0 decides whether the check is redundant), `live: false`, a
   finite lease unexpired at the prefix epoch, and `epoch`/`epoch_basis` equal to that pass's
   beacons (reuse `member_continuity.ex` `epoch/2`). Each failure is `catalog_authority_refused`
   (D-274), with a resolver-supplied detail when Core honored the op. A `profile_genesis` or
   `profile_id` mismatch with `continuation_profile/1` on the prefix is `wrong_catalog_scope`; it is evaluated here only
   because it needs the prefix. Step order is evaluation order; the reported reason is the
   highest-precedence failure among steps 1–6 (§4), so a profile mismatch outranks step 3. The
   epoch rule matches the private `member_continuity.ex` `epoch/2` but is recomputed from
   `analyze_with_beacon_evidence/2` on the prefix (that helper reads callback context).
5. **Declared graph, intrinsic (D-277).** Structural only, without installed heads or
   later-arriving catalogs: every parent is a known binding node (refused nodes included); each
   `prior_catalogs` entry names a catalog under its binding (unheld is `trust_pending`), and `nil`
   is its parent's sole entry; generation is `max + 1`; against each parent binding, a changed
   service key comes with a changed service ID; inventory and entries match the first
   catalog, whose entries extend every cited non-nil prior catalog (`inventory_extends?/2`: no
   replica dropped, `root`/`genesis`/`creation`/`reference`/`kind`/`schema` unchanged; only
   route and service fields change; lifecycle §2 no slot recycling). Failure is `invalid_catalog_transition`; an accepted candidate is never re-judged here.
6. **Conflict deps (D-278), intrinsic.** The candidate's op deps' causal closure includes every
   cited replacement op. Rotation heads are not Space ops and are covered by `parents` alone.
   Else `invalid_catalog_transition`. A cited node's refusal on the union is a D-276 property of
   that node (it authorizes nothing), never a validity condition of the citing candidate; the
   candidate covers the conflict by citing the node (contract §4). The resolver does not require
   the refusing Core controls in the deps: that set is unbounded (every later beacon past a lapsed
   lease refuses the node again) and depends on delivery order.
7. **Against retained evidence.** Omitting another D-276-eligible replacement head makes the
   candidate a **sibling**, retained as `catalog_fork` (never `invalid_catalog_transition`); nonce
   reuse with a different claim is `catalog_fork`; omitting a retained catalog head of a cited
   parent is likewise `catalog_fork` (no switch, no Thread dropped); an uncovered old-key child (rotation or
   catalog, whenever it arrived) of a closed binding falls under D-275; lower generation is
   `catalog_rollback`.
8. **Cutoffs** against `cutoff_proofs`, only after conflicts are classified:
   `recovery_incomplete` gates promotion of an otherwise sole valid head, never a fork record.
9. Store the atomic watermark with every observed head. Restore readiness against the new
   identity is still required (`carrier_pending`). Steps 3–4 needing more than these public APIs
   is a STOP for interface review (contract §3, PR 0).

**Intrinsic-check invariant (D-279).** Steps 1, 2, 4, 5 and 6 read only the candidate's bytes and
its own causal closure, so their verdict is fixed when the candidate is first evaluated and is
never re-judged for an accepted candidate. Only steps 3, 7 and 8 consult the retained union, and
they only reclassify (`authority_changed`, `catalog_fork`, `recovery_incomplete`). An accepted
candidate can therefore never later yield `invalid_catalog_transition`, `wrong_catalog_scope` or
an intrinsic `catalog_authority_refused`. PR 4 pins this with a monotonicity property test.

## 4. Refusal reasons

The closed `CatalogTrust.reason` set is unchanged; only `Space.author_replace_catalog/4` adds
`catalog_command_too_large` and `catalog_epoch_missing`. Precedence (contract §4): 1 `malformed_catalog` /
`control_history_limit`; 2 `wrong_catalog_scope` (incl. profile); 3 `trust_pending`; 4
`invalid_catalog_signature` / `invalid_possession`; 5 `catalog_authority_refused` (Core reason
attached); 6 `invalid_catalog_transition`; 7 `catalog_rollback` / `catalog_fork`; 8
`recovery_incomplete`; 9 `carrier_pending`.
`authority_changed` is the separate reclassification event; Stage A uses `application_invalid_catalog`.

## 5. Parity obligations

BEAM and TS share reciprocal vectors in `clients/lattice-client/test/vectors/catalog/replacement_v1.json`
(claim, both possession, inventory and cutoff pre-hash bytes including bad-signature `rejected`
evidence; the binding ID; every refusal reason), BEAM writing and TS reading, then the reverse.
Native `catalog_eval` is the third twin (OD-6/D-44, PR 5); until then packaged clients fail closed.

## 6. Buildable now vs parked

**Now, on disposable-key fixtures** (Sim bounded Space with `ops:`, root bootstrap, R04 leased
admin, R03 beacons): see Status. **Parked (rule 8):** real Space (row 224), custodian re-init,
new-signer ceremony, field and packaged runs. **Native:** after plan 267.

## 7. PR breakdown

Each PR is small, follows D-38 (freeze after two bot rounds), and gets rule 3 review by subject.
**PR 0 — API-sufficiency spike.** Test only:
`apps/lattice_core/test/treehouse/catalog_replacement_authority_probe_test.exs`. Tests: "leased
admin acquisition with replace_catalog_v1 in ceiling is observable at strict prefix via
holder_epoch/acquisitions"; "ancestor beacon basis derivable via analyze_with_beacon_evidence"
(`analyze_with_records/2` on the prefix); "unleased root genesis cap yields no finite
acquisition"; "an R04 continuation acquisition (`parent_id: nil`) is observable via
`acquisitions/3` and its delegation ceiling is readable from the prefix log" (`acquisition()`
carries only `delegation_id`, so reaching the delegation struct without a new API is part of the
probe); "a refused replacement op stays in the authenticated history with its Core reason". STOP if any check needs a new Core primitive: file a row and return for interface
review (contract §3). Do not approximate. *Outcome (2026-11-02): GO*, no Core primitive needed (evidence in PR #213); the PR 4 resolver must check ceiling monotonicity over the whole acquisition sequence (row 335).

**PR 1 — claim codec and the Space command.** Files: `transport_catalog.ex`; `space.ex` (the
`command(:replace_catalog_v1, [:_claim, :_catalog_possession, :_service_possession], ...)`
writing the `admin_actions` marker, plus the stage A clause); `treehouse_catalog_codec.ts` and
`treehouse.ts`; `replacement_v1.json`; the plan 178 copy-contract amendment with the lifecycle §7
vocabulary text, keeping its exact-command assertion. Codec tests
(`catalog_replacement_claim_test.exs` and TS twin): closed field set; parents sorted and distinct;
`prior_catalogs` sorted and distinct, at least one per parent, two entries for one forked binding
accepted, `nil` only as a sole entry; generation a safe positive integer (the max + 1 relation
is PR 4's); possession under the new keys; swapped
purpose fails; rotation and replacement possession bytes refuse each other; reciprocal byte
vectors match, including cutoff bytes with bad-signature evidence. Space command tests: non-admin
refused by cap; root-only preview ceiling bytes unchanged; bad possession, or author/cap/deps that
differ from the op, is `application_invalid_catalog`; historical Space vectors byte-identical;
`wire_vocabulary_test.exs` unchanged.

**PR 2 — authoring preflight.** BEAM `Space.author_replace_catalog/4` and its TS twin: freeze the
frontier; derive inventory, cutoffs and epoch basis; accept the two possession signatures;
re-verify the frozen state; sign last. Use the `member_continuity_authoring.ex` placeholder/intent
pattern for the size check. The attempt journal is keyed by the claim nonce. Tests:
`catalog_command_too_large` before any signature; `catalog_epoch_missing` with zero beacons; a
changed dep, key or cutoff requires new possession bytes; the cutoff excludes the action; an
authority reclassification of the frozen state cancels the pending attempt before and after the
signing call (C13 "cancel pending signing"). Follow-up observation: `author_catalog_bootstrap/3`
has no `catalog_command_too_large` preflight either; that is a separate row.

**PR 3 — custodian and ledger generation** (fixture only; the closed-binding refusal waits on
PR 4). Files: `catalog_ceremony/signing_ledger.ex`, `binding.ex`, `space_export.ex`,
`release_catalog.ex`. Key the ledger by `{binding_id, catalog_key}`; it takes the closed set from
the PR 4 resolver over Space history plus retained rotations and catalogs, never from raw Space
frames. Tests: accepts revision 0 under the new binding; refuses under a closed binding (incl.
ancestor B of cited rotation T) with a named reason; replay and crash refusals kept.

**PR 4 — resolver integration** (`catalog_trust.ex` / `.ts`, D-270, D-275–D-278). **GATED on
plans 267 and 269 merging** (seven `codex/treehouse-*` branches rewrite both files), **OD-16
sign-off, OD-17 and row 320** (the resolution shape that clears a closed-out accepted catalog). Row 335 (ceiling monotonicity over the acquisition sequence) is a PR 4 acceptance requirement, not a gate. Scope includes the multi-parent graph functions, current-binding route
origin/URL, refused nodes, and restoring pre-upgrade single-`parent` trust stores. Tests in
`catalog_replacement_trust_test.exs` and the TS twin. Every multi-delivery test persists the
accepted state between resolver calls and runs both delivery orders.

- **C10:** the combined-loss case is accepted; routes dial `new_origin` with the new realm. The
  author is an R04 continuation successor whose delegation is self-issued with `parent_id: nil`
  and an inherited ceiling containing `replace_catalog_v1` (a resolver that demands a linked root
  parent fails this case).
- **C11 negatives:** missing pre-loss permission (no `replace_catalog_v1` in the ceiling); restored permission (a later transfer from an older, broader continuation cap regains `replace_catalog_v1` after a narrower continuation dropped it; Core honors every hop, so a current-record check accepts it; row 335 acceptance); wrong
  profile, incl. a same-`profile_id` repin with another genesis (`wrong_catalog_scope`); a kept
  parent service ID with a new service key; wrong generation; no beacon; root genesis cap; unleased cap; wrong acquisition
  cap; stale holder; bad parent; a parent-linked delegation not attenuated from the root (Core
  refuses it, so the resolver sees no honored record); revoked or lapsed authority; wrong nonce,
  deps, epoch, basis or cutoff; each bad possession signature; a first catalog that drops a prior
  Thread or changes its root, genesis, creation or reference; an R04
  certificate alone grants no catalog trust; unsupported raw cutoff evidence refuses and is kept
  for export.
- **C12:** sibling replacements A and B from P, sequential with persisted acceptance, both orders,
  give `catalog_fork` (never `invalid_catalog_transition`); nonce reuse; a resolution covering
  both heads with both ops in its deps is accepted; one whose parents cover both but whose deps
  omit the sibling is refused; one omitting a head stays a fork; an old-key-only resolution is
  refused; a catalog fork within one binding resolved by a replacement citing both catalogs, and
  one citing only one side stays `catalog_fork`;
  valid sibling B without its cutoff proof is still `catalog_fork`, both orders, and after the proof.
- **Closing rule (D-275):** an old-key rotation of a binding cited by an accepted replacement is
  refused in both delivery orders; a later catalog under it is refused; a previously accepted
  such child yields `authority_changed`; after one resolution, a further attacker rotation cannot
  produce `catalog_fork`. Ancestry: with B, B→T, T→R accepted, B→Z is `catalog_rollback`, not a
  fork, both orders, and B→Z and T→Z′ stay refused after R is reclassified. R citing `{P, nil}`
  stays accepted when a C0 under P arrives later (C0 refused); C0 first gives `authority_changed`. A
  union-refused but D-276-eligible R′ citing P also closes P: an old-key rotation of P is refused, both orders.
- **C13:** a concurrent revoke after accepting R1 gives `authority_changed`, freezes routes and
  keeps the watermark; a client that saw the revoke first still holds R1 as a refused node; a
  fresh admin resolution citing refused R1, with the revoke in its deps, is accepted and unfreezes
  (a permanently frozen implementation fails); a rotation or catalog under refused R1 is refused;
  a causally later revoke keeps the history. **Redundant late beacon:** R1's lease expires at
  epoch 6 and concurrent beacon E7 refuses it; resolution R2 (lease to 13) cites R1 with R1 and E7
  in its deps and is accepted; beacon E8, a descendant of E7 concurrent with R1/R2, then arrives
  and R2 stays accepted (never `invalid_catalog_transition`), with persisted state, in both
  delivery orders (E8 before R2 and after). R2 citing R1 without E7 in its deps is also accepted.
- **Monotonicity property (D-279, plan-local):** StreamData over interleavings of valid revokes,
  transfers, beacons, rotations and replacements, state persisted between calls: an accepted
  candidate never later yields `invalid_catalog_transition`, `wrong_catalog_scope` or an intrinsic
  `catalog_authority_refused`; only `authority_changed`, `catalog_fork`, `recovery_incomplete` or
  (a third head, C14) `control_history_limit` may follow.
- **C14:** a third head is `control_history_limit`; a rotation head plus a replacement head count
  as two; each C11 negative that is union-refused adds no head or closure (OD-17); three non-admin proposals with `parents: [bootstrap]` are raw evidence, add no head and
  leave the bootstrap catalog resolving; a missing page is `trust_pending` with no partial
  promotion. Same bytes are idempotent; a rollback is refused.

**PR 5** — native parity (`catalog_eval` replacement node, D-270 nodes in `chains.rs`, row 319).
**PR 6** — a plan 266 exporter test now; after PR 4, the C15 two-cycle BEAM/TS reconstruction
(Space plus 12 Threads, one new child, a combined replacement). **PR 7** — the operator run, rule 8.

## 8. Gate commands

Per PR, on a fresh checkout first (`AGENTS.md`, Node 22 via `source ~/.nvm/nvm.sh && nvm use 22`):
`npm --prefix clients/lattice-client ci`, `npm --prefix clients/lattice-client run build`,
`npm --prefix clients/treehouse-tauri-shell ci`. Then `~/.asdf/shims/mix format --check-formatted`;
`MIX_ENV=test ~/.asdf/shims/mix compile`; `~/.asdf/shims/mix test apps/lattice_core/test/treehouse/`; for PR 3
`(cd apps/lattice_carrier_server && MIX_ENV=test ~/.asdf/shims/mix test)`;
`clients/lattice-client/node_modules/.bin/tsc -p clients/lattice-client` and the client test
runner there; `cargo test` in `clients/treehouse-tauri-shell/src-tauri` for any TS codec change;
regenerate dist. Before merge, lifecycle §6 gates: `ERL_FLAGS='+S 4:4' ~/.asdf/shims/mix check`
(`AGENTS.md` PATH prefix), every named TS gate, reciprocal exporters, protected legacy vectors.

For this design slice:
```sh
~/.asdf/shims/mix test apps/lattice_core/test/treehouse/r13_lite_contract_test.exs   # pins R13/R16/R21a "requires R11c"
~/.asdf/shims/mix test apps/lattice_core/test/treehouse/contract_test.exs
grep -o '](\.\./[^)]*)' plans/316-r11c-catalog-replacement-trust.md   # every target exists
```
## 9. Operator decisions

| ID | Question | Recommended default |
|---|---|---|
| OD-11 | Optional custodian or witness co-signature on replacement? | No. Contract §1 rejects a catalog quorum. |
| OD-12 | A possession-domain discriminator for replacement? | No. Disjoint closed field sets plus a negative cross-use test (D-269). |
| OD-13 | Does custodian re-initialization after a replacement need a new ceremony report? | Yes, under rule 8. |
| OD-14 | What does Treehouse show for `catalog_fork` / `authority_changed`? | "Transport paused, ask your admin", no automatic retry. |
| OD-15 | May a replacement keep both keys and the service ID? | Yes; the no-op refusal stays rotation-only (plan 274). |
| OD-16 | Adopt the closing rule (D-275), and D-278's reading that a resolution's deps need the cited replacement ops but not the refusing controls, as contract §4 amendments? | Yes. Sign-off gates PR 4 and PR 3's closed-binding refusal; without D-275 an old-key holder can pause transport indefinitely. |
| OD-17 | Which checks make a union-refused replacement a citable D-276 node? (Rule 3: third round on node eligibility.) | Every intrinsic check: steps 1, 2 (incl. causal honored bootstrap) and 4–6; any failure is raw evidence with no head or closure effect. |

## 10. Explicit non-claims

No completeness against withheld ops, whole-store rollback resistance or compromised-webview
re-observation (OD-10, row 260); no native or packaged acceptance until PR 5; no real-Space
replacement or ceremony; no R13/R16/R18 completion; no catalog quorum, Core primitive, quarantine
reason or wire atom; no production, Phase G or receipt-free W4. C10–C15 stay OPEN.

## Done criteria and STOP conditions

- **Design done:** roadmap R11c links this file and stays PLANNED; index row and decisions exist;
  design-slice gates pass. **Implementation done:** every PR's tests pass; vectors agree in BEAM,
  TS and, after PR 5, native.
- **STOP:** PR 0 needs a Core primitive or context field; a historical Space vector or wire byte
  changes; PR 4 starts before 267/269, OD-16, OD-17 and row 320; C10 needs an old key, new root or injected trust.

**Decisions:** D-265–D-280 (design), D-281+ (process): `plans/decisions-2026-10-17-backlog-run.html`.
