# 316 — R11c catalog replacement trust and recovery

Status: DESIGNED (design only, 2026-11-01). PRs 0–3 and 6 can start on fixtures now. PR 4 waits
on plans 267 and 269. PR 5 belongs to the native track. PR 7 is an operator run under rule 8.
C10–C15 stay OPEN.

- **Row**: 316 (roadmap R11c, `plans/roadmaps/treehouse-unified-2026-09-06.md`)
- **Priority / effort**: P1 / L
- **Depends on**: plan 224 PRs 1–3 (DONE), plan 263 (DONE, custodian ledger), R03 and R04 (DONE,
  beacons and bounded continuation). PR 4 also depends on plans 267 and 269.
- **Planned at**: commit `cb7ffa3bc`, 2026-11-01
- **Drift check (run before each PR)**:
  ```sh
  git diff --stat cb7ffa3bc..HEAD -- apps/lattice_core/lib/treehouse/space.ex \
    apps/lattice_core/lib/treehouse/transport_catalog.ex apps/lattice_core/lib/treehouse/catalog_trust.ex \
    apps/lattice_core/lib/treehouse/catalog_cutoff.ex apps/lattice_core/lib/lattice/authority.ex \
    clients/lattice-client/src/treehouse.ts clients/lattice-client/src/treehouse_catalog_codec.ts \
    clients/lattice-client/src/treehouse_catalog_trust.ts \
    apps/lattice_carrier_server/lib/lattice_carrier_server/operator/catalog_ceremony/ \
    docs/research/treehouse_catalog_lifecycle.md
  ```
  If an in-scope file changed, compare the "current state" notes below with the live code before
  you start. A mismatch in a cited line or function is a STOP condition.

## 0. Status and normative source

R11c has a design already. [`docs/research/treehouse_catalog_lifecycle.md`](../docs/research/treehouse_catalog_lifecycle.md)
§2–§4 and §7 are an **adopted contract** (integrator PASS at `789ab235`). Section 6 of
[`docs/research/treehouse_founder_lifecycle.md`](../docs/research/treehouse_founder_lifecycle.md)
(its R11 amendment, and acceptance row A09) adds the combined-loss fixture. Those two documents
are normative. This plan cites them and does not restate them as new decisions. It pins only what
the contract leaves to "R11c review", maps each check to the code that exists today, and splits
the work into PRs.

The contract fixes the following:

- the `replace_catalog_v1(claim, catalog_possession, service_possession)` Space command and its
  closed claim fields;
- the possession domain `lattice-treehouse-transport-possession-v1`, with purpose `:catalog` or
  `:service`;
- the inventory digest `lattice-treehouse-route-inventory-v1` and the cutoff digest
  `lattice-treehouse-recovery-cutoff-v1`;
- two verification stages: the app callback, then the pure resolver;
- the closed refusal order;
- acceptance cases C10–C15.

The task asked for a "root/custodian quorum". D-267 answers it. Replacement authority is the
living root's bootstrap delegation to an honored bounded Space admin (contract §1). There is no
catalog quorum. R04's witness quorum applies when a party acquires or renews the admin role. The
custodian holds a key. It is not an authority.

### Current state on `cb7ffa3bc`

| Fact | Where |
|---|---|
| `replace_catalog_v1` is a closed wire atom. It is in the bounded genesis ops ceiling but has no Space command. | `space.ex:26-29`; `wire_vocabulary.ex:178`; `wire_vocabulary.ts:163`; `treehouse_bounded.ts:33` |
| Every claim field atom is already in the closed vocabulary (`prior_catalogs`, `new_service_id`, `new_service_key`, `new_origin`, `holder_epoch`, `epoch_basis`, `inventory_digest`, `parents`, `author`, `cap`, `deps`, `epoch`, `catalog`, `service`). The cutoff atom list has them too. | `wire_vocabulary.ex`; `catalog_cutoff.ex:20-33` |
| The cutoff, inventory and rotation-possession byte functions exist. | BEAM `TransportCatalog.inventory_bytes/1`, `inventory_id/1`, `rotation_possession_bytes/1`, `service_realm/1`, `Treehouse.CatalogCutoff`; TS `canonicalBytesForCatalogInventory`, `catalogInventoryId`, `canonicalBytesForCatalogRotationPossession`, `catalogServiceRealm`, `treehouse_catalog_cutoff.ts`; native `catalog_eval/cutoff.rs`, `rotation.rs` |
| Old-key rotation is resolved in `resolve_binding!/3`. | `catalog_trust.ex:660-705` (TS twin around `treehouse_catalog_trust.ts:234`) |
| A binding node carries only `key`. Entry service checks and the rotation key-distinctness check read `context.bootstrap.service_*`. | `catalog_trust.ex:566-567`, `:672`; `treehouse_catalog_trust.ts:234`, `:261` |
| Evidence pages have exactly `[:catalogs, :rotations, :histories, :cutoff_proofs]`. | `catalog_trust.ex:25` |
| The closed `CatalogTrust.reason` set already contains every outcome R11c needs, including `authority_changed`, `catalog_fork` and `recovery_incomplete`. | `catalog_trust.ex:91-110` |
| Authority observation APIs: `holder_epoch/3`, `acquisitions/3`, `analyze_with_beacon_evidence/2`, `analyze_with_records/2` (one pass returns analysis, beacons and `{op_id, holder, delegation_id}` acquisitions), `continuation_profile/1`. | `authority.ex:135-180`, `:554-590` |
| Existing epoch/basis derivation and sign-last pattern for a Space command that carries a claim. | `member_continuity_authoring.ex` (`epoch/1`, `placeholder/1`, `intent/4`); `member_continuity.ex` `epoch/2` over `context.valid_beacons` |
| The custodian ledger is keyed on `binding.bootstrap_id` and `binding.record.catalog_key`. | `catalog_ceremony/signing_ledger.ex:23-48`; `catalog_ceremony/binding.ex` |
| Seed and backup both lost: "Replacement is the R11c procedure, which is not built." Suspected exposure is treated as loss. | `docs/treehouse_catalog_signer_custody.md:417-420` |

**Corrections to the task's grounding** (also D-273):

- The custody reference is `docs/treehouse_catalog_signer_custody.md:417`, not `signer_custody.md`.
- Native no longer refuses rotation with `catalog_rotation_unsupported`. That reason is from plan
  245. Plan 267 has since added rotation chains (`catalog_eval/chains.rs`). Native has no
  replacement node, so a catalog whose binding is a replacement op ID fails closed with
  `trust_pending` at the `Work::Binding` lookup (`chains.rs:290-297`). PR 5 adds a replacement
  node. It does not lift a rotation refusal.
- TS names follow the codec's existing convention (`canonicalBytesForCatalogRotationPossession`).
  The task's bare names are not used (§2).
- PR 1 adds no wire atoms, and `wire_vocabulary_test.exs` stays unchanged.

## Scope

In scope: one Space command, a claim codec, authoring preflight, resolver integration, ledger
generation, and parity vectors for the contract's replacement path, all on disposable-key
fixtures. Out of scope: any code in this design slice; the native `catalog_eval` source and
the `codex/treehouse-*` branches; replacing the real Space; the ceremony; Township and Toolshed.

## 1. Threat model

"Retained client" means an installed client that keeps its original bootstrap review and
accepted watermark (contract §4).

| # | Attacker or loss | What they can do | What the retained client checks | Outcome |
|---|---|---|---|---|
| a | Catalog signer seed and backup both lost (`treehouse_catalog_signer_custody.md:417`) | Nothing new. Nobody can publish under the current binding. | — | Recovery is a replacement authored by a bounded admin. The old key is not an input. |
| b | Catalog signer compromised, admin intact | The attacker can sign catalogs under the current binding. It can also author an old-key rotation to a key it holds, because rotation needs only the old catalog key. It cannot change service or catalog keys through a catalog update (contract §2). It cannot change the service identity through rotation. | Entry and inventory checks; route-reuse refusal; known-fork detection (`catalog_fork`); the rotation transition rules | Bad catalogs are refused. Two signed revisions form a fork that pauses transport. An honest admin replacement cites the attacker's rotation or catalog head in `parents`, needs no old key, and moves the binding off the compromised key. Custody treats suspected exposure as loss (`:420`). |
| c | Service key lost | The routes cannot authenticate. | Possession under `:service` | A partial-loss replacement keeps the catalog key, with a fresh `:catalog` possession signature, and sets a new service ID and key. |
| d | Founder, old catalog key and old service key all lost (C10/A09) | — | Full stage B | Only an R04 bounded successor can act, and only if its pre-loss acquisition ceiling includes `replace_catalog_v1`. No old private key, injected trust or root change is used. |
| e | Malicious current admin | It can replace transport inside its valid lease. The delegation permits this (contract §1). | Ordinary revoke, transfer and lease rules | Accepted residual. This plan does not soften it. A later revoke, transfer or lapse that is concurrent with the action reclassifies it (row g). |
| f | Two authorized sibling replacements, or one nonce reused with different claims (C12) | Split clients | Sibling and nonce-reuse detection over the retained graph | `catalog_fork`. Both heads are retained and no route switches automatically. A resolution must cover both heads. |
| g | Concurrent revoke, holder change or lapse beacon arrives after union (C13) | Invalidates an accepted action | Stage B step 2 on the full union | `authority_changed`. Route use freezes and the watermark and evidence are kept. The client never falls back to the old signer. |
| h | No honored ancestor beacon | — | Preflight; stage B epoch derivation | Authoring stops with `catalog_epoch_missing`. The resolver refuses with `catalog_authority_refused` (D-274). |
| i | The living root's unleased genesis cap, or a leased grant without an honored acquisition | The root signs a replacement directly | Strict-prefix acquisition match; finite-lease check | Refused (`catalog_authority_refused`). The root must first take an honored finite acquisition, or use old-key rotation instead. |
| j | Wrong root, product or Space; replay across products | Cross-scope replay | Pinned bootstrap scope | `wrong_catalog_scope` |
| k | Rollback to an older generation, or a wrong predecessor digest | Lower the watermark | Generation and predecessor checks against retained heads | `catalog_rollback` / `invalid_catalog_transition` |
| l | Incomplete or wrong cutoff for the new service | Hide history from the new service | Cutoff `log_digest` against the independently restored raw log | `recovery_incomplete`. The client never invents an empty replica. |
| m | Missing control or history page | Stall | Closure check | `trust_pending`. The client fetches a bounded page and does not switch. |
| n | Head or budget overflow. Rotation heads and replacement heads count together against the two-head bound. | Force eviction | Existing `overflow/2` budget | `control_history_limit`. There is no partial promotion and no head is evicted. |
| o | Trust injected into a fresh client, a new operator key, a URL or a test trust object | — | Nothing here is an input to the resolver. | Never proof |
| p | Withheld unknown ops; whole-store rollback; compromised-webview re-observation (OD-10, row 260) | — | — | **Non-claims** (§10) |

## 2. Exact artifacts and canonical bytes

The contract (§3) is restated here with code names. **Claim** (closed map; an extra or missing
field is `malformed_catalog`):

| Field | Rule |
|---|---|
| `version`, `product`, `space`, `bootstrap` | `1`, `:treehouse`, the pinned Space, the pinned bootstrap ID |
| `profile_genesis`, `profile_id` | Equal the retained bootstrap and `Authority.continuation_profile/1` at the action's strict prefix |
| `parents` | Binding-head IDs: sorted, distinct, nonempty. For the first replacement the sole parent is the bootstrap ID. Later replacements name the current binding heads (rotation or replacement IDs). |
| `prior_catalogs` | **Pinned (D-271):** exactly one `%{binding: parent, catalog: id \| nil}` per parent, in the same sort order as `parents`. `nil` only when no catalog under that parent is known locally. |
| `generation` | `max(parent generation) + 1`, within the safe-integer horizon |
| `nonce` | A fresh 32-byte `Nonce`. It is also the local journal attempt ID. |
| `new_catalog_key`, `new_service_id`, `new_service_key`, `new_origin` | 32-byte keys; `new_catalog_key != new_service_key`. For each parent, if the service key changes then the service ID changes (D-271). `new_origin` uses the canonical origin grammar (contract §2). |
| `inventory_digest` | `TransportCatalog.inventory_id(entries)` over the exact entry list of the first catalog under the new binding |
| `cutoffs` | Sorted, distinct `%{replica, frontier, log_digest}`. They cover every entry, archives included. `log_digest` comes from `Treehouse.CatalogCutoff` (`lattice-treehouse-recovery-cutoff-v1`). |
| `author`, `cap`, `holder_epoch`, `deps` | Equal the final op's `author`, `cap`, the honored acquisition op ID, and the op's sorted `deps` |
| `epoch`, `epoch_basis` | The maximum honored ancestor beacon epoch and the sorted, nonempty set of beacon IDs at that epoch |

**Possession bytes**: `Canonical.term(["lattice-treehouse-transport-possession-v1", purpose, claim])`
with `purpose ∈ {:catalog, :service}`. The `:catalog` signature verifies under
`new_catalog_key` and the `:service` signature under `new_service_key`. Both are required even
when a key is kept.

**New pins** (each is a decision in the appendix):

- **Binding ID (D-268).** The binding ID is the op ID of the final `replace_catalog_v1` op, as
  contract §3 says. The first catalog under a new binding is `revision: 0, previous: nil`.
  `inventory_id(entries) == claim.inventory_digest`. Every entry's `service_id`/`service_key`
  equals the new binding's. The service realm is `"treehouse-service:" <> new_service_id`.
- **Binding ID namespace (D-272).** A replacement binding ID is a `lattice-op-v2` payload digest.
  A rotation binding ID is a digest of the envelope under the rotation domain. The pre-image
  domains differ, so one `bindings` map stays sound.
- **No new page field.** Replacement nodes are extracted from honored Space history in
  `histories`, the same way as the bootstrap. Page fields stay `[:catalogs, :rotations, :histories,
  :cutoff_proofs]`.
- **Binding service identity (D-270).** Every binding node carries `{key, service_id,
  service_key, origin}`. The bootstrap seeds it. A rotation inherits it from its parent. A
  replacement sets it from the claim. Entry service and realm checks, and the rotation's
  `new_catalog_key` distinctness check, compare against the **current binding**, not
  `context.bootstrap`. The same change applies in the TS twin, and in `chains.rs` in PR 5.
- **Possession domain reuse (D-269).** Replacement possession and rotation possession share the
  domain and the `:catalog` purpose. Their signed pre-images cannot be confused. `Canonical.term`
  encodes map keys, and the two closed key sets differ: a rotation has `parent` and
  `prior_catalog`, while a claim has `parents`, `prior_catalogs`, `author`, `cap`, `deps`, `epoch`
  and others. Each normalizer refuses the other's field set. A negative cross-use test pins this
  in both directions (OD-12).
- **Retention (D-271, OD-15).** A claim may keep both keys and the service ID. A fork resolution
  needs this. The plan 274 no-op refusal applies to rotation only.

**Proposed function names** (PR 1 fixes the exact names):

- BEAM, in `Treehouse.TransportCatalog`: `normalize_replacement_claim/1`,
  `replacement_claim_bytes/1` (the pre-hash bytes for vectors), `replacement_possession_bytes/2`
  (`purpose, claim`), `verify_replacement_possession/3`.
- TS, in `treehouse_catalog_codec.ts`: `normalizeCatalogReplacementClaim`,
  `catalogReplacementClaimToCarrierTerm` / `FromCarrierTerm`,
  `canonicalBytesForCatalogReplacementClaim`,
  `canonicalBytesForCatalogReplacementPossession(purpose, claim)`.

## 3. Verification stages, mapped to code

**Stage A — the Space application callback.** A new `command_op_status/3` clause for
`{:replace_catalog_v1, [claim, catalog_possession, service_possession]}` goes in `space.ex`, with
the matching branch in `treehouse.ts` (registry at `:283`, decoder near `:316`, status near
`:401`). It runs after the existing cap and admin-holder gates. It checks:

- the closed shape;
- that the bootstrap ID names a causally visible, honored `catalog_bootstrap_v1` (the same
  observation the bootstrap clause at `space.ex:568` uses);
- `claim.author == op.author`, `claim.cap == op.cap`, `claim.deps == Enum.sort(op.deps)`, and
  that `claim.holder_epoch` is a visible ancestor;
- both possession signatures.

A failure is `application_invalid_catalog`. Stage A does not call the resolver and does not judge
its own command recursively. A Core-honored action is still not a route switch.

**Stage B — the resolver.** `resolve_binding!/3` in `catalog_trust.ex`, and its TS twin, gains a
third node source. A binding ID is now the bootstrap op, a rotation artifact, or an honored
`replace_catalog_v1` op in the Space history. For a replacement it runs:

1. Closure. Every supplied frame is authenticated and the dependency closure is exact.
   Otherwise `trust_pending`.
2. `Authority.analyze(Treehouse.Space, full_union)`: the op must be honored. If it is not, the
   result is `catalog_authority_refused` with the unchanged Core reason. If the op was accepted
   earlier, it is `authority_changed`.
3. Strict prefix: one `Authority.analyze_with_records(Treehouse.Space, strict_ancestor_log)`.
   - `holder_epoch(:admin) == %{holder: op.author, op_id: claim.holder_epoch}`.
   - The acquisition record `{claim.holder_epoch, author, delegation_id}` has
     `delegation_id == op.cap`.
   - That delegation's ops ceiling contains `replace_catalog_v1`, `live: false`, and its lease
     is finite and unexpired at the prefix epoch.
   - `epoch`/`epoch_basis` equal the beacons that same pass returns. Those beacons are already
     strict ancestors, so no global filter is needed. Reuse the derivation in
     `member_continuity.ex` `epoch/2`.
   - The profile matches `continuation_profile/1` on the prefix.

   Every step-3 failure is `catalog_authority_refused` (D-274). When Core has honored the op
   (for example zero beacons before any lease expiry, contract §2), the attached detail is a
   resolver-supplied reason, not a Core quarantine reason.
4. Predecessor checks:
   - every parent is a known binding;
   - each `prior_catalogs` entry matches the latest retained catalog under its parent;
   - no omitted retained head or catalog (`invalid_catalog_transition`);
   - generation.
   Then inventory and cutoff against `cutoff_proofs` (`recovery_incomplete`), then fork and nonce
   reuse across sibling bindings (`catalog_fork`).
5. Store the atomic watermark with every observed head. Restore readiness against the new
   identity is still required before any route is used (`carrier_pending`).

Contract §3 says: if steps 2–3 need anything beyond these bounded public APIs, stop and return
for interface review. PR 0 checks this before any resolver code is written.

## 4. Refusal reasons

Use the closed `CatalogTrust.reason` set unchanged. The only additions are the authoring-preflight
reasons `catalog_command_too_large` and `catalog_epoch_missing`. These are returned by
`Space.author_replace_catalog/4`. The resolver never returns them.

The precedence is contract §4:

1. `malformed_catalog` / `control_history_limit`
2. `wrong_catalog_scope`
3. `trust_pending`
4. `invalid_catalog_signature` / `invalid_possession`
5. `catalog_authority_refused` (Core reason attached)
6. `invalid_catalog_transition`
7. `catalog_rollback` / `catalog_fork`
8. `recovery_incomplete`
9. `carrier_pending`

`authority_changed` is the separate reclassification event. No Core quarantine reason is added.
Stage A uses the existing `application_invalid_catalog`.

## 5. Parity obligations

- **BEAM and TS twins.** They share reciprocal vectors in a new
  `clients/lattice-client/test/vectors/catalog/replacement_v1.json`. The vectors compare:
  - the claim pre-hash bytes;
  - both possession pre-hash bytes;
  - the inventory bytes and the cutoff pre-hash bytes;
  - the binding ID;
  - the expected reason for every refusal case.
  BEAM writes the vectors and TS reads them, then the reverse.
- **Native is the third twin** (`catalog_eval`, OD-6/D-44). It consumes the same vectors. The
  native track owns it after plan 267 closes. Until then a packaged client fails closed with
  `trust_pending` on a replacement binding (§0). That is a non-claim, not an acceptance.
- **Plan 266 exporter.** It must carry replacement-op histories. No page field changes; one
  test covers it (PR 6).
- **Plan 263 custodian ledger.** It must accept revision 0 of a new binding generation and refuse
  to sign under a superseded binding (PR 3).

## 6. Buildable now vs parked

- **Now, on fixtures with disposable keys.** A Sim bounded Space (`Sim.create_replica/3` with
  explicit `ops:`) with:
  - a root `catalog_bootstrap_v1`;
  - an R04 leased admin acquisition whose ceiling includes `replace_catalog_v1`;
  - R03 beacons (`Sim.beacon/3`).
  This covers PRs 0–3 and 6. PR 4 is fixture-buildable but gated on plans 267 and 269 (§7).
- **Parked under rule 8:**
  - replacing the real Space (row 224 `catalogued` is BLOCKED on the ceremony);
  - re-initializing the custodian and the new-signer ceremony;
  - field and packaged runs.
- **Parked on plan 267, not rule 8:** native enablement.

## 7. PR breakdown

Each PR is small and follows D-38 (freeze after two bot rounds). Rule 3 review is by subject.

**PR 0 — API-sufficiency spike.** Test only:
`apps/lattice_core/test/treehouse/catalog_replacement_authority_probe_test.exs`. Tests:

- "leased admin acquisition with replace_catalog_v1 in ceiling is observable at strict prefix via holder_epoch/acquisitions"
- "ancestor beacon basis derivable via analyze_with_beacon_evidence" (also checks
  `analyze_with_records/2` on the strict prefix)
- "unleased root genesis cap yields no finite acquisition"

STOP: if any check needs a new Core primitive, file a row and return for interface review
(contract §3). Do not approximate.

**PR 1 — claim codec and the Space command.** Files:

- `transport_catalog.ex`
- `space.ex`: the `command(:replace_catalog_v1, [:_claim, :_catalog_possession, :_service_possession], ...)`
  writing the `admin_actions` marker, plus the stage A clause
- `treehouse_catalog_codec.ts` and `treehouse.ts`
- `replacement_v1.json`
- the plan 178 copy-contract test amendment, with the vocabulary text from lifecycle §7. Do not
  loosen its exact-command assertion.

Tests go in `catalog_replacement_claim_test.exs` and its TS twin:

- the closed field set; an extra or missing field is malformed;
- parents sorted and distinct;
- `prior_catalogs` is one entry per parent;
- generation is max + 1;
- a nil `prior_catalog` is allowed only when no catalog is known;
- possession verifies under the new keys;
- a swapped purpose fails;
- rotation possession bytes are not accepted as replacement possession, and the reverse;
- the reciprocal byte vectors match.

Space command tests:

- a non-admin is refused by cap;
- the root-only preview ceiling is unchanged (the old command list bytes are identical);
- a bad possession is `application_invalid_catalog`;
- a claim whose author, cap or deps differ from the op is `application_invalid_catalog`;
- the historical Space vectors regenerate byte-identical;
- `wire_vocabulary_test.exs` passes unchanged.

**PR 2 — authoring preflight.** BEAM `Space.author_replace_catalog/4` and its TS twin. The steps:

1. Freeze the frontier.
2. Derive the inventory, cutoffs and epoch basis.
3. Accept the two possession signatures.
4. Re-verify the frozen state.
5. Sign last.

Use the `member_continuity_authoring.ex` placeholder/intent pattern for the size check before
signing. Tests:

- `catalog_command_too_large` is returned before any signature;
- `catalog_epoch_missing` is returned with zero beacons;
- a changed dep, key or cutoff requires new possession bytes;
- the cutoff excludes the action itself.

Observation: `author_catalog_bootstrap/3` has no `catalog_command_too_large` preflight either.
That is a follow-up row, not part of this plan.

**PR 3 — custodian and ledger generation** (fixture only). Files: `catalog_ceremony/signing_ledger.ex`,
`binding.ex`, `space_export.ex`, `release_catalog.ex`. Key the ledger by `{binding_id,
catalog_key}` instead of `bootstrap_id` plus `record.catalog_key`. The ledger learns which
bindings are superseded from the exported Space history. Tests:

- the ledger accepts revision 0 under the new binding;
- it refuses signing under the superseded binding with a named reason;
- the existing replay and crash refusals are kept.

**PR 4 — resolver integration** (`catalog_trust.ex` / `.ts`, including D-270). **GATED on plans
267 and 269 merging.** Seven `codex/treehouse-*` branches rewrite both files. Tests go in
`catalog_replacement_trust_test.exs` and the TS twin:

- **C10:** the combined-loss case is accepted.
- **C11 negatives:**
  - no beacon;
  - the root genesis cap;
  - an unleased cap;
  - a stale holder;
  - the wrong cap;
  - a wrong nonce, deps, epoch, basis, profile or cutoff;
  - each bad possession signature.
- **C12:**
  - a fork, delivered in both orders;
  - nonce reuse;
  - a resolution that covers both heads is accepted;
  - a resolution that omits a head is refused;
  - an old-key-only resolution is refused.
- **C13:** `authority_changed` after a concurrent revoke. A causally later revoke keeps the
  history.
- **C14:**
  - a third head is `control_history_limit`;
  - a rotation head plus a replacement head counts as two heads;
  - a missing page is `trust_pending`, with no partial promotion.
- Same bytes are idempotent.
- A rollback is refused.

**PR 5 — native parity** (a `catalog_eval` replacement node and the D-270 binding service
identity in `chains.rs`). The native track owns this after plan 267. It consumes the PR 1 and PR 4
vectors. This slice only files a row.

**PR 6** — the C15 two-cycle BEAM/TS reconstruction (Space plus 12 Threads, one new child, a
combined replacement) and a test that the plan 266 exporter carries replacement histories.

**PR 7** — the operator run. Parked under rule 8.

## 8. Gate commands

Per PR:

```sh
~/.asdf/shims/mix format --check-formatted
MIX_ENV=test ~/.asdf/shims/mix compile
~/.asdf/shims/mix test apps/lattice_core/test/treehouse/
(cd apps/lattice_carrier_server && MIX_ENV=test ~/.asdf/shims/mix test)   # PR 3
source ~/.nvm/nvm.sh && nvm use 22
(cd clients/lattice-client && node_modules/.bin/tsc -p . && <the lattice-client test runner>)
(cd clients/treehouse-tauri-shell/src-tauri && cargo test)                # any TS codec change
# then regenerate the dist files
```

For this design slice:

```sh
~/.asdf/shims/mix test apps/lattice_core/test/treehouse/r13_lite_contract_test.exs   # pins R13/R16/R21a "requires R11c"
~/.asdf/shims/mix test apps/lattice_core/test/treehouse/contract_test.exs
grep -o '](\.\./[^)]*)' plans/316-r11c-catalog-replacement-trust.md   # every target exists
```

## 9. Operator decisions

| ID | Question | Recommended default |
|---|---|---|
| OD-11 | Add an optional custodian or witness co-signature on replacement? | No. Contract §1 rejects a catalog quorum. |
| OD-12 | Give the possession domain a discriminator for replacement? | No. Reuse the domain and rely on the disjoint closed field sets plus a negative cross-use test (D-269). |
| OD-13 | Does re-initializing the custodian ledger after a replacement need a new ceremony report? | Yes, a new report, under rule 8. |
| OD-14 | What should Treehouse show for `catalog_fork` / `authority_changed`? | A plain "transport paused, ask your admin" message, with no automatic retry. |
| OD-15 | May a replacement keep both keys and the service ID? | Yes. A fork resolution needs it. The no-op refusal stays rotation-only (plan 274). |

## 10. Explicit non-claims

- No completeness against withheld ops, and no resistance to whole-store rollback.
- No re-observation from a compromised webview (OD-10, row 260).
- No native or packaged acceptance until PR 5. Packaged clients fail closed with `trust_pending`.
- No replacement of the real Space, and no ceremony.
- No R13, R16 or R18 completion.
- No catalog witness quorum, no new Core primitive, no new quarantine reason and no new wire atom.
- No production deployment, Phase G or receipt-free W4.
- C10–C15 stay OPEN until their PRs land.

## Done criteria

- **Design slice:** this file exists, the roadmap R11c row links it and stays PLANNED, the index
  row and decisions below are copied in, and the design-slice gates pass.
- **Implementation:** every PR's named tests pass, and the reciprocal vectors agree in BEAM, TS
  and, after PR 5, native.

## STOP conditions

- PR 0 needs a Core primitive or a new context field.
- Any historical Space vector or wire vocabulary byte changes.
- PR 4 starts before plans 267 and 269 merge.
- An implementation would need an old private key, a new root, or injected trust to pass C10.

## Appendix — proposed index row and decisions

These are copied into `plans/README.md` and `plans/decisions-2026-10-17-backlog-run.html` in the
index stage.

**README row:**

`| 316 | [R11c catalog replacement trust and recovery](316-r11c-catalog-replacement-trust.md) | P1 | L | 224 PRs 1–3; 263; 267/269 for PR 4; R03/R04 DONE | DESIGNED (plan 316, design only; PRs 0–3 and 6 startable on fixtures; PR 4 waits on 267/269; PR 5 is native-track owned; PR 7 is rule 8) |`

**Decisions:**

- **D-265.** Plan 316 is an implementation plan for the adopted lifecycle §2–§4/§7 contract and
  founder-lifecycle §6. It pins only the gaps left to R11c review.
- **D-266.** Order of work:
  - PRs 0–3 and 6 start now on fixtures.
  - PR 4 waits on plans 267 and 269, because seven `codex/treehouse-*` branches rewrite
    `catalog_trust.ex/.ts`.
  - PR 5 is owned by the native track.
  - PR 7 falls under rule 8.
- **D-267.** The "root/custodian quorum" has no quorum. Authority is the living root's bootstrap
  delegation to an honored bounded admin. R04's witness quorum governs acquisition and renewal
  only. The custodian is a key holder, not an authority. OD-11 keeps a co-signature optional and
  off.
- **D-268.**
  - The binding ID is the final `replace_catalog_v1` op ID.
  - The first catalog under it is revision 0 with `previous: nil`. Its inventory equals
    `claim.inventory_digest` and its entries carry the new service.
  - The realm is `"treehouse-service:" <> new_service_id`.
  - No page field is added.
- **D-269.** The possession domain is reused without a discriminator. The closed key sets of the
  rotation record and the claim are disjoint, so the pre-images cannot be confused. A negative
  test covers both directions.
- **D-270.** Every binding node carries `{key, service_id, service_key, origin}`. Entry, realm and
  distinctness checks read the current binding, not `context.bootstrap`. This applies in BEAM,
  TS and native.
- **D-271.**
  - `prior_catalogs` has exactly one entry per parent, in the same order.
  - `new_catalog_key != new_service_key`.
  - For each parent, a changed service key means a changed service ID.
  - A claim may keep both keys (OD-15).
- **D-272.** Op-ID bindings and rotation-ID bindings share one namespace safely, because their
  pre-image domains differ.
- **D-273.** Corrections to the grounding:
  - the custody doc path;
  - native fails closed with `trust_pending`, not `catalog_rotation_unsupported`;
  - the TS naming convention;
  - no new wire atoms.
- **D-274.** Every stage B step-3 failure (acquisition, cap, ceiling, lease, epoch/basis,
  profile) refuses as `catalog_authority_refused`. If Core honored the op, the attached detail is
  resolver-supplied rather than a Core reason. Each C11 vector therefore has exactly one reason.
