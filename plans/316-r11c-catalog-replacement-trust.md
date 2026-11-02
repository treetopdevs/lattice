# 316 — R11c catalog replacement trust and recovery

Status: DESIGNED (design only, 2026-11-01). PRs 0–3 and 6 can start on fixtures now. PR 4 waits
on plans 267 and 269 and on integrator sign-off for D-275 (OD-16). PR 5 belongs to the native
track. PR 7 is an operator run under rule 8. C10–C15 stay OPEN.

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
  If an in-scope file changed, recheck the "current state" notes; a cited-line mismatch is a STOP.

## 0. Status and normative source

R11c has a design already. [`docs/research/treehouse_catalog_lifecycle.md`](../docs/research/treehouse_catalog_lifecycle.md)
§2–§4 and §7 are an **adopted contract** (integrator PASS at `789ab235`). Section 6 of
[`docs/research/treehouse_founder_lifecycle.md`](../docs/research/treehouse_founder_lifecycle.md)
(its R11 amendment, and acceptance row A09) adds the combined-loss fixture. Those two documents
are normative. This plan cites them and does not restate them as new decisions. It pins only what
the contract leaves to "R11c review", maps each check to the code that exists today, and splits
the work into PRs. The one pin that reads as a contract interpretation (D-275) is flagged as
OD-16 and needs integrator sign-off before PR 4.

The contract fixes the `replace_catalog_v1(claim, catalog_possession, service_possession)`
command and claim fields, the possession, inventory and cutoff domains, the two verification
stages, the closed refusal order, and acceptance cases C10–C15.

The task asked for a "root/custodian quorum"; D-267 answers it. Replacement authority is the
living root's bootstrap delegation to an honored bounded Space admin (contract §1); there is no
catalog quorum. R04 witnesses govern admin acquisition and renewal; the custodian holds a key.

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

**Corrections to the task's grounding** (D-273): the custody reference is
`docs/treehouse_catalog_signer_custody.md:417`. Native no longer refuses rotation with
`catalog_rotation_unsupported` (plan 267 added `catalog_eval/chains.rs`); it has no replacement
node, so a replacement binding fails closed with `trust_pending` at `Work::Binding`
(`chains.rs:290-297`). TS names follow the codec convention
(`canonicalBytesForCatalogRotationPossession`). PR 1 adds no wire atoms.

**Scope.** One Space command, a claim codec, authoring preflight, resolver integration, ledger
generation and parity vectors, on disposable-key fixtures. Out of scope: code in this design slice;
native `catalog_eval` source; `codex/treehouse-*` branches; the real Space; the ceremony;
Township and Toolshed.

## 1. Threat model

A "retained client" keeps its original bootstrap review and accepted watermark (contract §4).

| # | Attacker or loss | What the retained client checks | Outcome |
|---|---|---|---|
| a | Catalog signer seed and backup both lost (custody `:417`) | — | Recovery is a bounded-admin replacement. The old key is not an input. |
| b | Catalog signer compromised, admin intact. It can sign catalogs and old-key rotations under bindings it holds; it cannot change keys through a catalog or service identity through rotation. | Entry/inventory checks; route-reuse refusal; fork detection; the closing rule (D-275) | Bad catalogs refused; two signed revisions fork and pause transport. An admin replacement cites the attacker's heads in `parents` and **closes** every cited binding: later old-key rotations or catalogs under it are retained evidence and refused, so one resolution ends the attacker's ability to force `catalog_fork`. Suspected exposure is loss (`:420`). |
| c | Service key lost | Possession under `:service` | A partial-loss replacement keeps the catalog key (fresh `:catalog` possession) and sets a new service ID, key and, if needed, origin. |
| d | Founder, old catalog key and old service key all lost (C10/A09) | Full stage B | Only an R04 bounded successor acts, and only if its pre-loss ceiling includes `replace_catalog_v1`. No old key, injected trust or root change. |
| e | Malicious current admin | Ordinary revoke, transfer and lease rules | Accepted residual (contract §1). A concurrent revoke, transfer or lapse reclassifies it (row g). |
| f | Two authorized sibling replacements, or one nonce reused with different claims (C12) | Declared-graph validation, then sibling and nonce-reuse detection | `catalog_fork` in either delivery order. Both heads retained, no route switch. A resolution covers both, and its deps include both ops. |
| g | Concurrent revoke, holder change or lapse beacon after union (C13) | Stage B step 2 on the full union | `authority_changed`: freeze routes, keep watermark and the refused node as evidence. A fresh current-admin resolution citing it unfreezes; the client never falls back to the old signer. |
| h | No honored ancestor beacon | Preflight; stage B epoch derivation | Authoring stops with `catalog_epoch_missing`; the resolver refuses `catalog_authority_refused`. |
| i | Living root's unleased genesis cap, or a leased grant without an honored acquisition | Strict-prefix acquisition match; finite lease | `catalog_authority_refused`. The root must take a finite acquisition or rotate instead. |
| j | Wrong root, product, Space, version or profile; cross-product replay | Pinned bootstrap scope | `wrong_catalog_scope` |
| k | Rollback to an older generation, a wrong predecessor, or a child of a closed binding | Generation, predecessor and closing checks | `catalog_rollback` / `invalid_catalog_transition` |
| l | Incomplete or wrong cutoff for the new service | `log_digest` against the restored raw log | `recovery_incomplete`; never an invented empty replica. |
| m | Missing control or history page | Closure | `trust_pending`; bounded fetch, no switch. |
| n | Head or budget overflow (rotation and replacement heads count together; closed children are not heads but count against parser bounds) | `overflow/2` | `control_history_limit`; no partial promotion or eviction. |
| o | Trust injected into a fresh client, a new operator key, a URL or a test object | Not a resolver input | Never proof |
| p | Withheld unknown ops; whole-store rollback; compromised-webview re-observation (OD-10, row 260) | — | **Non-claims** (§10) |

## 2. Exact artifacts and canonical bytes

Contract §3 restated with code names. **Claim** (closed map; extra or missing field is
`malformed_catalog`):

| Field | Rule |
|---|---|
| `version`, `product`, `space`, `bootstrap` | `1`, `:treehouse`, pinned Space, pinned bootstrap ID |
| `profile_genesis`, `profile_id` | Equal the retained bootstrap and `Authority.continuation_profile/1` at the strict prefix |
| `parents` | Binding-head IDs (bootstrap, rotation or replacement, refused-but-observed included): sorted, distinct, nonempty. First replacement: the bootstrap ID. |
| `prior_catalogs` | **Pinned (D-271):** sorted, distinct `%{binding, catalog}`; at least one per parent; every retained catalog head under that parent (more than one when that binding's catalog chain forked); `catalog: nil` only as the sole entry for a parent with no known catalog. |
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

**New pins** (decisions in the appendix):

- **Binding ID (D-268).** The final `replace_catalog_v1` op ID. The first catalog under it is
  `revision: 0, previous: nil`, `inventory_id(entries) == claim.inventory_digest`, every entry
  carries the new service ID/key, realm `"treehouse-service:" <> new_service_id`.
- **Namespace (D-272).** Replacement IDs are `lattice-op-v2` payload digests; rotation IDs digest
  under the rotation domain. One `bindings` map stays sound.
- **No new page field.** Replacement nodes come from the authenticated Space history in
  `histories`, which already carries quarantined ops (the cutoff requires them).
- **Binding node (D-270).** Every node carries `{key, service_id, service_key, origin, parents,
  refused?}`. The bootstrap seeds it; a rotation inherits service and origin from its parent and
  has a one-element `parents`; a replacement sets them from the claim. Entry service and realm
  checks, the rotation `new_catalog_key` distinctness check, and route `origin`/`url`
  construction (`routes/1`, TS `catalogRoutes`) read the **current binding**, not
  `context.bootstrap`. Heads, forks and ancestry (`binding_heads/1`, `rotation_forks/3`,
  `catalog_ancestor?/3`, TS `:290-310`, `:515`, `:523`) become multi-parent. Persisted
  single-`parent` trust stores (TS `:479`, BEAM restore) must restore unchanged on upgrade.
  Same change in TS, and in `chains.rs` in PR 5.
- **Refused nodes are evidence (D-276).** A `replace_catalog_v1` op that is authenticated but not
  honored on the full union becomes a node with `refused?: true`. It may be cited in `parents` and
  `prior_catalogs`; catalogs under it are retained conflict evidence, never `trust_pending`. It
  authorizes nothing: a rotation, catalog or route under it is refused. A resolution derives its
  authority independently (contract §4).
- **Closing rule (D-275, OD-16).** A binding cited in `parents` of any retained honored
  replacement is closed to old-key children. A rotation from it, or a catalog under it past the
  cited `prior_catalogs`, is retained evidence and refused (`catalog_rollback`); if it had been
  accepted, the result is `authority_changed`, never a silent switch. Evaluated over the retained
  graph on every re-resolution, so it is delivery-order independent. Two **admin** siblings from
  one parent still fork (C12). Rationale: the contract's sibling-fork rule covers controls of
  equal standing; without the rule an old-key holder forces `catalog_fork` forever.
- **Possession domain reuse (D-269).** Rotation and replacement share the domain and `:catalog`
  purpose. `Canonical.term` encodes map keys and the closed key sets differ (`parent`,
  `prior_catalog` vs `parents`, `prior_catalogs`, `author`, `cap`, `deps`, `epoch`, …); each
  normalizer refuses the other's set. A negative cross-use test pins both directions (OD-12).
- **Retention (D-271, OD-15).** A claim may keep both keys and the service ID; the plan 274 no-op
  refusal applies to rotation only.

**Proposed names** (PR 1 fixes them): BEAM `TransportCatalog.normalize_replacement_claim/1`,
`replacement_claim_bytes/1`, `replacement_possession_bytes/2`, `verify_replacement_possession/3`;
TS `normalizeCatalogReplacementClaim`, `catalogReplacementClaimToCarrierTerm` / `FromCarrierTerm`,
`canonicalBytesForCatalogReplacementClaim`, `canonicalBytesForCatalogReplacementPossession`.

## 3. Verification stages, mapped to code

**Stage A — the Space application callback.** A new `command_op_status/3` clause for
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

1. **Scope.** `version`, `product`, `space`, `bootstrap` and `profile_genesis` against the
   retained bootstrap: `wrong_catalog_scope` (precedence 2).
2. **Closure.** Every frame authenticated, dependency closure exact; else `trust_pending`.
3. **Full union.** `Authority.analyze(Treehouse.Space, full_union)`. Not honored: the node is
   kept with `refused?: true` (D-276); the candidate is `catalog_authority_refused` with the
   unchanged Core reason, or `authority_changed` if it was accepted earlier.
4. **Strict prefix**, one `Authority.analyze_with_records(Treehouse.Space, strict_ancestor_log)`:
   `holder_epoch(:admin) == %{holder: op.author, op_id: claim.holder_epoch}`; the acquisition
   record `{claim.holder_epoch, author, delegation_id}` has `delegation_id == op.cap`, attenuated
   from the root bootstrap delegation; its ceiling contains `replace_catalog_v1`, `live: false`,
   finite unexpired lease at the prefix epoch; `epoch`/`epoch_basis` equal that pass's beacons
   (reuse `member_continuity.ex` `epoch/2`). Each failure is `catalog_authority_refused`
   (D-274), with a resolver-supplied detail when Core honored the op. A `profile_id` mismatch
   with `continuation_profile/1` on the prefix is `wrong_catalog_scope`; it is evaluated here only
   because it needs the prefix.
5. **Declared graph, intrinsic (D-277).** Judged without the installed heads: every parent is a
   known binding node (refused nodes included); each `prior_catalogs` entry names an
   authenticated catalog under its binding, or is the sole `nil` for a parent with none known;
   generation is `max + 1`; inventory and entries match the first catalog. Failure is
   `invalid_catalog_transition`. Then cutoffs against `cutoff_proofs` (`recovery_incomplete`).
6. **Conflict deps (D-278).** If the candidate cites more than one head, a refused node, or a
   catalog-forked binding, its op deps' causal closure includes every cited replacement op and
   every Core control op (revoke, transfer, beacon) that refused a cited node. Rotation heads are
   not Space ops and are covered by `parents` alone. Else `invalid_catalog_transition`.
7. **Against installed heads.** Omitting a retained head or later catalog makes the candidate a
   **sibling**, retained as `catalog_fork` (never `invalid_catalog_transition`); nonce reuse with
   a different claim is `catalog_fork`; the closing rule (D-275) applies; lower generation is
   `catalog_rollback`.
8. Store the atomic watermark with every observed head. Restore readiness against the new
   identity is still required (`carrier_pending`).

If steps 3–4 need more than these bounded public APIs, stop for interface review
(contract §3, PR 0).

## 4. Refusal reasons

The closed `CatalogTrust.reason` set is unchanged; only `Space.author_replace_catalog/4` adds
`catalog_command_too_large` and `catalog_epoch_missing`. Precedence (contract §4):
1 `malformed_catalog` / `control_history_limit`; 2 `wrong_catalog_scope` (incl. profile);
3 `trust_pending`; 4 `invalid_catalog_signature` / `invalid_possession`;
5 `catalog_authority_refused` (Core reason attached); 6 `invalid_catalog_transition`;
7 `catalog_rollback` / `catalog_fork`; 8 `recovery_incomplete`; 9 `carrier_pending`.
`authority_changed` is the separate reclassification event; Stage A uses
`application_invalid_catalog`.

## 5. Parity obligations

BEAM and TS share reciprocal vectors in `clients/lattice-client/test/vectors/catalog/replacement_v1.json`
(claim, both possession, inventory and cutoff pre-hash bytes including bad-signature `rejected`
evidence; the binding ID; every refusal reason), BEAM writing and TS reading, then the reverse.
Native `catalog_eval` is the third twin (OD-6/D-44), native-track owned after plan 267; until then
packaged clients fail closed with `trust_pending` (§0), a non-claim. The plan 266 exporter must
carry replacement histories, refused ones included (PR 6). The plan 263 ledger must accept
revision 0 of a new binding and refuse to sign under a closed binding (PR 3).

## 6. Buildable now vs parked

**Now, on disposable-key fixtures:** a Sim bounded Space (`Sim.create_replica/3` with explicit
`ops:`), a root `catalog_bootstrap_v1`, an R04 leased admin acquisition whose ceiling includes
`replace_catalog_v1`, and R03 beacons (`Sim.beacon/3`): PRs 0–3 and 6; PR 4 too, but gated (§7).
**Parked under rule 8:** the real Space (row 224 `catalogued` BLOCKED on the ceremony), custodian
re-initialization, the new-signer ceremony, field and packaged runs. **On plan 267:** native.

## 7. PR breakdown

Each PR is small, follows D-38 (freeze after two bot rounds), and gets rule 3 review by subject.
**PR 0 — API-sufficiency spike.** Test only:
`apps/lattice_core/test/treehouse/catalog_replacement_authority_probe_test.exs`. Tests: "leased
admin acquisition with replace_catalog_v1 in ceiling is observable at strict prefix via
holder_epoch/acquisitions"; "ancestor beacon basis derivable via analyze_with_beacon_evidence"
(also `analyze_with_records/2` on the prefix); "unleased root genesis cap yields no finite
acquisition"; "a refused replacement op stays in the authenticated history with its Core
reason". STOP if any check needs a new Core primitive: file a row and return for interface
review (contract §3). Do not approximate.

**PR 1 — claim codec and the Space command.** Files: `transport_catalog.ex`; `space.ex` (the
`command(:replace_catalog_v1, [:_claim, :_catalog_possession, :_service_possession], ...)`
writing the `admin_actions` marker, plus the stage A clause); `treehouse_catalog_codec.ts` and
`treehouse.ts`; `replacement_v1.json`; the plan 178 copy-contract amendment with the lifecycle §7
vocabulary text, keeping its exact-command assertion. Codec tests
(`catalog_replacement_claim_test.exs` and TS twin): closed field set; parents sorted and distinct;
`prior_catalogs` sorted and distinct, at least one per parent, two entries for one forked binding
accepted, `nil` only as a sole entry; generation max + 1; possession under the new keys; swapped
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

**PR 3 — custodian and ledger generation** (fixture only). Files:
`catalog_ceremony/signing_ledger.ex`, `binding.ex`, `space_export.ex`, `release_catalog.ex`. Key
the ledger by `{binding_id, catalog_key}`; it learns closed bindings from the exported Space
history. Tests: accepts revision 0 under the new binding; refuses signing under a closed binding
with a named reason; existing replay and crash refusals kept.

**PR 4 — resolver integration** (`catalog_trust.ex` / `.ts`, D-270, D-275–D-278). **GATED on
plans 267 and 269 merging** (seven `codex/treehouse-*` branches rewrite both files) **and on
OD-16 sign-off.** Scope includes the multi-parent graph functions, current-binding route
origin/URL, refused nodes, and restoring pre-upgrade single-`parent` trust stores. Tests in
`catalog_replacement_trust_test.exs` and the TS twin. Every multi-delivery test persists the
accepted state between resolver calls and runs both delivery orders.

- **C10:** the combined-loss case is accepted; routes dial `new_origin` with the new realm.
- **C11 negatives:** missing pre-loss permission (no `replace_catalog_v1` in the ceiling); wrong
  profile (`wrong_catalog_scope`); no beacon; root genesis cap; unleased cap; wrong acquisition
  cap; stale holder; bad parent; delegation not attenuated from the root; revoked or lapsed
  authority; wrong nonce, deps, epoch, basis or cutoff; each bad possession signature; an R04
  certificate alone grants no catalog trust; unsupported raw cutoff evidence refuses and is kept
  for export.
- **C12:** sibling replacements A and B from P, sequential with persisted acceptance, both orders,
  give `catalog_fork` (never `invalid_catalog_transition`); nonce reuse; a resolution covering
  both heads with both ops in its deps is accepted; one whose parents cover both but whose deps
  omit the sibling is refused; one omitting a head stays a fork; an old-key-only resolution is
  refused; a catalog fork within one binding resolved by a replacement citing both catalogs.
- **Closing rule (D-275):** an old-key rotation of a binding cited by an accepted replacement is
  refused in both delivery orders; a later catalog under it is refused; a previously accepted
  such child yields `authority_changed`; after one resolution, a further attacker rotation cannot
  produce `catalog_fork`.
- **C13:** a concurrent revoke after accepting R1 gives `authority_changed`, freezes routes and
  keeps the watermark; a fresh current-admin resolution citing refused R1, with the revoke in its
  deps, is accepted and unfreezes (a permanently frozen implementation fails); a rotation or
  catalog under refused R1 is refused; a causally later revoke keeps the history.
- **C14:** a third head is `control_history_limit`; a rotation head plus a replacement head count
  as two; a missing page is `trust_pending` with no partial promotion.
- Same bytes are idempotent; a rollback is refused.

**PR 5** — native parity (a `catalog_eval` replacement node, D-270 nodes in `chains.rs`), owned by
the native track after plan 267, consuming the PR 1 and PR 4 vectors; this slice only files a row.
**PR 6** — the C15 two-cycle BEAM/TS reconstruction (Space plus 12 Threads, one new child, a
combined replacement) and a plan 266 exporter test. **PR 7** — the operator run, rule 8.

## 8. Gate commands

Per PR: `~/.asdf/shims/mix format --check-formatted`; `MIX_ENV=test ~/.asdf/shims/mix compile`;
`~/.asdf/shims/mix test apps/lattice_core/test/treehouse/`; for PR 3
`(cd apps/lattice_carrier_server && MIX_ENV=test ~/.asdf/shims/mix test)`; then under Node 22
(`source ~/.nvm/nvm.sh && nvm use 22`) `tsc -p .` and the lattice-client test runner from
`clients/lattice-client/node_modules/.bin`; `cargo test` in
`clients/treehouse-tauri-shell/src-tauri` for any TS codec change; regenerate the dist files.

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
| OD-16 | Adopt the closing rule (D-275) as a contract §4 amendment? | Yes. Integrator sign-off is a PR 4 precondition; without it an old-key holder can pause transport indefinitely. |

## 10. Explicit non-claims

No completeness against withheld ops; no whole-store rollback resistance; no re-observation from a
compromised webview (OD-10, row 260); no native or packaged acceptance until PR 5 (packaged
clients fail closed with `trust_pending`); no real-Space replacement or ceremony; no R13, R16 or
R18 completion; no catalog witness quorum, new Core primitive, quarantine reason or wire atom; no
production deployment, Phase G or receipt-free W4. C10–C15 stay OPEN until their PRs land.

## Done criteria and STOP conditions

- **Design slice done:** this file exists, the roadmap R11c row links it and stays PLANNED, the
  index row and decisions below are copied in, and the design-slice gates pass.
- **Implementation done:** every PR's named tests pass; reciprocal vectors agree in BEAM, TS and,
  after PR 5, native.
- **STOP:** PR 0 needs a Core primitive or a new context field; any historical Space vector or
  wire vocabulary byte changes; PR 4 starts before plans 267/269 merge or OD-16 is answered; C10
  would need an old private key, a new root, or injected trust.

## Appendix — proposed index row and decisions

Copied into `plans/README.md` and `plans/decisions-2026-10-17-backlog-run.html` in the index stage.

`| 316 | [R11c catalog replacement trust and recovery](316-r11c-catalog-replacement-trust.md) | P1 | L | 224 PRs 1–3; 263; 267/269 for PR 4; R03/R04 DONE | DESIGNED (plan 316, design only; PRs 0–3 and 6 startable on fixtures; PR 4 waits on 267/269 and OD-16; PR 5 native-track; PR 7 rule 8) |`

- **D-265.** Plan 316 implements lifecycle §2–§4/§7 and founder §6; it pins only R11c-review gaps.
- **D-266.** PRs 0–3 and 6 start now on fixtures; PR 4 waits on 267/269 (seven
  `codex/treehouse-*` branches rewrite `catalog_trust.ex/.ts`) and OD-16; PR 5 native track; PR 7
  rule 8.
- **D-267.** No catalog quorum: authority is the root's delegation to an honored bounded admin;
  R04 witnesses govern acquisition and renewal only; the custodian is a key holder (OD-11).
- **D-268.** Binding ID is the final `replace_catalog_v1` op ID; first catalog revision 0,
  `previous: nil`, inventory equals `claim.inventory_digest`, entries carry the new service; realm
  `"treehouse-service:" <> new_service_id`; no page field (§2).
- **D-269.** Possession domain reused; disjoint closed key sets; negative test both ways (§2).
- **D-270.** Binding nodes carry `{key, service_id, service_key, origin, parents, refused?}`;
  entry, realm, distinctness and route origin/URL read the current binding; heads, forks and
  ancestry are multi-parent; old single-`parent` stores restore on upgrade; BEAM, TS, native (§2).
- **D-271.** `prior_catalogs`: sorted distinct `{binding, catalog}`, at least one per parent,
  every retained catalog head under it, `nil` only as a sole entry; distinct new keys; changed
  service key means changed service ID; both keys may be kept (OD-15) (§2).
- **D-272.** Op-ID and rotation-ID bindings share one namespace; pre-image domains differ (§2).
- **D-273.** Grounding corrections: custody doc path; native fails closed with `trust_pending`;
  TS naming; no new wire atoms (§0).
- **D-274.** Stage B acquisition, cap, attenuation, ceiling, lease and epoch/basis failures are
  `catalog_authority_refused` (resolver detail when Core honored the op). Scope, version and both
  profile fields are `wrong_catalog_scope` per contract §4 (§3 steps 1, 4).
- **D-275.** Closing rule: a binding cited by a retained honored replacement admits no old-key
  rotation or later catalog; such children are refused evidence, or `authority_changed` if
  accepted; order-independent; admin siblings still fork (OD-16) (§2).
- **D-276.** Authenticated but refused replacement ops are evidence nodes: citable as parents,
  authorize nothing (§2).
- **D-277.** The resolver validates a candidate's declared graph before comparing it with
  installed heads; an omitting sibling is `catalog_fork`, not `invalid_catalog_transition` (§3
  steps 5, 7).
- **D-278.** A resolution's deps causally include every cited replacement op and every Core
  control op that refused a cited node; rotation heads are covered by `parents` (§3 step 6).
