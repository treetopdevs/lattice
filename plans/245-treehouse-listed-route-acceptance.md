# Plan 245: Treehouse client acceptance of a `listed` route (plan 224 PR 6, design)

> **Executor instructions**: This is a design plan. It moves no code. Each build PR below is its own
> PR with one adversarial review; rule 3 PRs need a second independent review. Run every gate command.
> If anything in "STOP conditions" occurs, stop and report; do not improvise. Line numbers drift: grep
> the named function. Run mix as `~/.asdf/shims/mix`. Owner and carrier-server tests that skip on macOS
> run in Docker (`elixir:1.19.5-otp-28`, non-root, umask 022). Rust gates run from
> `clients/treehouse-tauri-shell/src-tauri`; TS gates from `clients/treehouse-tauri-shell` (Node 22 via nvm).
>
> **Drift check (run first)**: `git log --oneline bb40921f6..HEAD -- clients/treehouse-tauri-shell
> clients/lattice-shell-kit apps/lattice_core/lib/treehouse clients/lattice-client/src/treehouse_catalog_*.ts`.
> A new catalog trust reason, evidence-page field, route-grammar change or native trust command is a STOP.

## Status

Design written 2026-10-23 (slice 22) against main bb40921f6; revised the same day after two independent
reviews (dispositions in PR #162, rule 4). Parked under rule 8 for the final operator acceptance only. Part 1
(PRs 1-7, fixtures and disposable keys) starts when OD-6 to OD-10 are decided. Part 2 (the operator's own
run) needs the inputs under "Depends on" and is not a build PR.

## Header

- **Priority**: P2. **Effort**: XL (seven PRs; PR 3, a Rust evaluator, is the bulk). **Risk**: HIGH: a native
  commit that wrongly marks a route trusted lets a stale or forked catalog steer a member's traffic.
- **Depends on** (rule 8, exact inputs): (1) the operator ceremony report (`verification-report.json`,
  `mode: "real"`, `binding.status: "verified"`, runbook `docs/treehouse_catalog_signer_custody.md` §5.6);
  (2) plan 224 PRs 4 (`catalogued`) and 5 (`listed`), whose output the exporter reads; (3) OD-6 to OD-10;
  (4) R13 for member first install (not needed: this plan is root-only); (5) row 254, a bounded-family Thread
  to list (the app creates only legacy Threads; the pilot Thread comes from outside it).
- **Part 1 vs Part 2 (rule 8).** PRs 1-7 finish on fixtures: test support builds catalogs, exports and logs
  with disposable keys, so none needs (1) or (2). The operator acceptance (Done, Part 2) is parked on (1), (2), (5).
- **Rule 3 touches**: PRs 1, 2, 3, 5 and 7 (see the PR table). PRs 4 and 6 touch no rule 3 path.
- **Category**: Treehouse client trust (roadmap R11b client half; D1: activation stays local-only).
- **Planned at commit `bb40921f6`**.

## Sources

Plan 224 "Design 6" (six requirements, met by Designs A-G). Fixed D-39 decisions are not reopened: OD-4 (a)
evidence page file imported by the root's app, no wire change; OD-1 (A); OD-5 (a); D1 route activation local-only.
Contracts: `docs/research/treehouse_catalog_retained_trust.md` (adopted boundary; adapter `:376-396`),
`treehouse_catalog_lifecycle.md` §2 and §4, `treehouse_catalog_beam_trust.md`, plan 186 decision 6 (product
predicates stay shell-owned behind `RouteBook`/`SyncHost`).

## Current state (verified 2026-10-23, file:line checked)

Pure evaluators exist in Elixir and TS; nothing in the shell or native code calls them.

- Elixir `CatalogTrust.prepare_installation/1` (`catalog_trust.ex:116`), `evaluate/1` (`:145`), `resolve_route/1`
  (`:239`), 2,270 lines; TS twins at `treehouse_catalog_trust.ts:81,111,360` (743 lines) over `authority.ts`
  (2,071 lines; Elixir `authority.ex` 1,806). Zero hits for them under `clients/treehouse-tauri-shell`.
- `finish/6` (`catalog_trust.ex:264`): `accepted` advances only with no pending dependency (`:288-300`); else the
  earlier `accepted` stays, `reason` is `:recovery_incomplete`/`:trust_pending`, and routes are still emitted.
  A blocked state emits no routes (`:268-279`, `routes/1` `:1318-1319`). Review shape needs `version`, `product`,
  `space`, `spaceRoot`, `bootstrapId`, `observedBootstrapIds`, `disposition` (`:1940-1953`).
- A refused reference can surface as `invalid_catalog_transition` (`:936-939`) or `trust_pending`
  (`catalog_entries.ex:124-135`); the root-key commitment is verified in the authority fold
  (`authority.ex:364-372`), not by `Continuation.family/1` (`continuation.ex:16-37`), which only parses shape.
- TS decisions live in a module `WeakMap` (`treehouse_catalog_trust.ts:369,381`) and cannot cross IPC.
- Native: `catalog_store.rs` is candidate-only (`:1-4`) and refuses a first store beside an identity (`:99-100`).
  `lib.rs:4` declares it and registers no catalog command. `preview.rs:1-2` says retained signatures are
  verified by the TS consumer; native checks shape only. Only `ed25519-dalek` is available (`Cargo.toml:13`;
  `witness_reviewed.rs:9,160`); no Rust canonical encoder or authority fold exists (`lattice-mobile-core/native/src`).
- Locking: `identity_lock` (`preview.rs:608`) is taken only in `initialize` (`:724,743`). `commit` (`:765-770`)
  reads history and CASes `HISTORY_KEY` alone (`:913-915`); `kv_compare_and_set` compares one key
  (`storage.rs:484-490`). The history generation is `PreviewState.revision` (`preview.rs:32,769`).
- A saved relay set is never replaced and only gains routes (`preview.rs:836-847`). `PreviewStore` fields are
  private (`:605-608`). New commands must be listed in `build.rs:2-15`, `capabilities/default.json:7-15` and the
  exact-set contract `test/product_contract.mjs:101-125`.
- Ordinary CSP is `connect-src 'self' ipc: http://ipc.localhost` (`tauri.conf.json:26`); only the dev-trace overlay
  adds `ws:` loopback and `wss:` (`product_contract.mjs:12-27`).
- Grammar: TS `THREAD_REPLICA` is legacy-only (`treehouse_routes.ts:32`); Rust `replica_tail`/`route_replica` gate
  bounded on `space` (`preview.rs:133-140,257`). The case "bounded thread is not supported" has a
  non-canonical root tag ending `B` (`replica_grammar_cases.json:33-36`), so it is refused for two reasons.
- Routes: `RelayRoute` is `{replica, url, expectedPeerRealm, expectedPeerPubkey}` (`treehouse_state.ts:28-33`);
  `MAX_ROUTES = 4` (`:11`). The feed starts a worker for every route it is given (`feed.ts:524-535`) and each
  dials and subscribes (`:408-412`). Lifecycle v1 holds up to 13 entries but four foreground sockets
  (`lifecycle.md:52-58`). Ordinary sync appends received frames and persists them (`treehouse_workflow.ts:1092-1122`).
- Catalog origins are `wss://` DNS only (`transport_catalog.ex:248-262`). The carrier handshake has a server
  nonce only (`session.ex:5-7`): a pull cannot be cryptographically bound to a native challenge without a
  carrier change.
- The shell authors legacy Threads (`treehouse_workflow.ts:434,477`); `treehouse_bounded.ts:55` authors only a
  bounded Space; staging and entries need bounded Threads (`staging.ex:485`, `catalog_entries.ex:79`). Row 254.
- Operator side: `CatalogStore` is a read-only verifier (`operator/catalog_store.ex:1-12`); no module writes a
  client-facing evidence page, and plan 224 PRs 1-5 do not build one.

**Contradictions with Design 6:** G1 bounded Thread creation (row 254); G2 no exporter exists (PR 4); G3 the
root always has an identity first, so root first install is the case `catalog_store.rs:99` refuses (OD-7); G4
`MAX_ROUTES = 4` versus 13 retained entries (Design F); G5 a signed catalog cannot carry `ws://` (OD-8); G6
Design 6.4 omits that a verified native commit needs a native evaluator, which does not exist (OD-6).

## Design A: first install (root only) and its pin

1. **Pin source.** When the root signs the binding, a new native command writes the reviewed record
   (`bootstrapId`, `CatalogBootstrap` fields, `BindingReview.sha256`; `treehouse_bounded.ts:182-183`) write-once to
   `treehouse:catalog:binding:v1`. For a binding signed before this build, the migration review (Design D)
   writes it after the native evaluator confirms exactly one honored root-authored bootstrap in the persisted
   Space frames. The catalog key and service key come from that record, never from a caller.
2. **Review.** `catalog_trust_review` builds the closed review natively and shows bootstrap id, Space, root key,
   service id and origin. It refuses `not_space_root` (local key != `spaceRoot`), `already_pinned` (any non-sentinel
   record exists: the re-pin guard) and `catalog_fork` (more than one honored bootstrap).
3. **Token bound to bytes.** Native mints one token over `digest(review ‖ exact page bytes ‖ pulled frames ‖
   derived routes ‖ history generation)`. Commit recomputes it; one pending token under `identity_lock`; consumed
   on any attempt; dies with the process. A swapped page, reused, cross-process or superseded token is
   `review_token_invalid`. Pin and first catalog install in one CAS from the sentinel.
4. **Members** wait on R13: non-root gets `not_space_root` and a disabled explanation.

## Design B: the evidence page format, bounds and import

One file `lattice-catalog-evidence-page-v1`, a closed envelope `{format, space, bootstrapId, head, pages}` of
TS `TreehouseCatalogEvidencePage` values: the envelope chain from revision 0 as exact JSON strings plus signed raw
frames of the Space and each listed Thread. Bounds are existing: 32 artifacts per page, 128 KiB each
(`catalog_trust.ex:81,1933`), 16 MiB file (the `space_export.rs` cap). Duplicate or unknown keys, non-UTF-8 and
over-cap are `evidence_page_malformed`/`evidence_page_too_large`. A multi-page chain's completeness is caller-owned
(`retained_trust.md:372-374`); a gap leaves the head `trust_pending`. A page holding a rotation is refused
`catalog_rotation_unsupported` (R11c is a non-goal; native fails closed). The webview forwards bytes unchanged;
native re-parses. **Exporter (PR 4):** reads `<root>/catalog/` via `CatalogStore.verify/2` and the served logs,
writes with the never-overwrite no-follow rule of `space_export.rs`, and claims only "these bytes existed on the host".

## Design C: re-observation, probe authorization and the pull barrier

Routes come from the untrusted catalog, so acceptance is two steps.

1. `catalog_trust_probe(page)`: the native evaluator runs on the page and returns an **uncommitted** candidate
   plus a `ProbeGrant`, a type distinct from an activation receipt. It authorizes one pull-only attempt per
   required replica (Space and every listed Thread) against `route.url` with `route.realm`/`route.serviceKey` as
   expected peer, no operation sent, no route enabled in feed, sync or the saved list. It is bound to
   `digest(page head ‖ route set ‖ history generation)`, single use, in-process, and expires with the process.
2. Who pulls is OD-10. Under (b) the webview pulls and returns, per required replica, `{replica, frames,
   status}`; `catalog_trust_commit` refuses `probe_incomplete` when a replica is missing, `status` is not
   complete, the grant is spent or its digest differs. Under (a) native pulls and the status is native's own.
   Frames are self-authenticating and are unioned before the second native evaluation.
3. **Why a withheld revoke or beacon is caught.** A page lacking a concurrent revoke, lapse or lease beacon makes
   the reference look honored. It is caught when the pull returns the op: the union is folded whole, the
   reference is quarantined, and the result is a refusal, never nil.
4. **Nonclaim under OD-10 (b).** Native cannot attest webview network I/O (the carrier handshake has only a server
   nonce). A compromised webview can fabricate "complete" statuses and resubmit old frames, so re-observation is
   not enforced against it and a withheld revoke can be installed until the next native reclassification
   (Design D). The barrier is structural and generation-bound only: honest-shell tier. A server withholding the
   op from an honest pull is undetectable under (a) and (b).

## Design D: acceptance, the native owner and generation-scoped receipts

**Rule.** Installed only when the committed evaluation has `reason == nil`, `blocked == nil`, and
`accepted.catalog` equals the unique top head of the verified chain (more than one top head is `catalog_fork`; an
older page against a newer retained head is `catalog_rollback`).

**Outcomes.** Installed: routes exposed. Pending but unblocked (`trust_pending`, `recovery_incomplete`): earlier
accepted routes stay usable and the head is `not installed`. Blocked (`catalog_fork`, `authority_changed`,
`control_history_limit`): `routes: []`, watermark kept. Native persists only evidence it verified itself (Rust
evaluator output), never a webview-asserted refusal.

**Owner** `catalog_owner.rs` (+ `PreviewStore` integration for its private db, keys and lock). Commands:
`catalog_trust_status`, `_review`, `_probe`, `_commit`, `_routes`, `_migrate`, `catalog_binding_record_save`. None
accepts a snapshot, route list, review object or "verified" flag. Added to `build.rs`, `capabilities/default.json`
and the `product_contract.mjs` exact sets; a test denies each from a remote origin and the witness webview.

**Locking and counters.** Every writer of `HISTORY_KEY` (`commit`) and of the trust key takes `identity_lock`
exclusive. Under it: capture history revision `R`, evaluate, CAS trust with `R` stored in the record, and refuse
`stale_trust_snapshot` if `R` moved. `trust_revision` bumps on each trust commit; `history_generation` is
`PreviewState.revision`. Race gate: a history writer racing the installer never leaves a receipt for an unseen revoke.

**Receipts and reclassification.** A receipt is `{trust token, installedHead, routes, generation R}`. Routes are
served only by `catalog_trust_routes`, which compares `R` with the current revision and, if different, re-runs the
native evaluator over the current persisted histories plus retained evidence before answering; open does the same.
Blocked yields `[]`. The shell calls it before each dial and after each sync persist. Post-install revoke or
lapse is therefore caught at the next sync; the UI claims "listed as of last evaluation" (row 244 for lapsed refs).

**Saved routes.** Inside the commit, catalog routes are compared with the persisted `relay.routes` (rule at
`preview.rs:836-847`). A route differing in url, realm or key for a catalogued replica refuses the whole install
`route_conflicts_saved_route` until row 198's D3. An identical saved route is marked `shadowed_by_catalog` in the
record; the shell then ignores saved routes for catalogued replicas, even when the catalog is blocked.

**Ordering against an identity (OD-7 (a)).** `initialize()` writes, under `identity_lock`, an independent
`treehouse:catalog:initialised:v1` marker first, then the identity, then a sentinel trust record (token 0/0). A
missing or corrupt trust record beside the marker is `trust_recovery_required`; the sentinel is never recreated and
no CAS with expected `None` is allowed once the marker exists. Identities predating the build have neither marker
nor trust: `status` returns `migration_required`, and the user-confirmed `catalog_trust_migrate` writes marker and
sentinel under the lock. **Nonclaim:** a pre-build identity cannot be proven never-pinned, and deleting marker and
trust together is whole-store rollback (`lifecycle.md:452-455`). PR 5 test: delete row, reopen, still
`trust_recovery_required`, no new sentinel; install twice (re-pin) refused `already_pinned`.

## Design E: bounded Thread grammar with TS/Rust parity

TS `THREAD_REPLICA` (`treehouse_routes.ts:32`) becomes legacy-or-exact-bounded as `SPACE_REPLICA` is
(`replica:treehouse:thread:<43>#authority:bounded-continuation-v1#root:<43>`, both tails canonical); Rust
`replica_tail` drops its `space` gate for the bounded arm (`preview.rs:133-140`), `route_replica` follows (`:257`).
`productOf` is unchanged. The tag's commitment to the root key is judged by the authority fold, not here.
**Fixtures:** the existing case (root tag ending `B`) stays refused; add a canonical bounded-Thread positive and a
Thread counterpart of every bounded-Space near-miss (non-canonical nonce or tag, kind swap, trailing byte,
duplicate marker). `test/replica_grammar.ts` and `src-tauri/tests/route_alphabet.rs` replay one file. Older builds
refuse a state holding a bounded Thread profile ("newer builds only"). The kit is untouched.

## Design F: connect, refuse and the connection budget

All in shell-owned `src/treehouse_host.ts` (never the word "websocket") behind plan 186's ports.
- **Parameters** come only from `catalog_trust_routes`. `treehouse_host.ts` adapts each to the existing `RelayRoute`
  shape: `route.url` to `url`, `route.realm` to `expectedPeerRealm`, `route.serviceKey` to `expectedPeerPubkey`
  (`treehouse_state.ts:31`); the `RelayRoute` contract and its consumers are unchanged. Native supplies them; it does not enforce the dial (honest-shell claim).
- **Inventory vs selection.** `RouteBook` gains a read-only `catalogInventory` (up to 13, from the receipt) and a
  shell-owned `activeSelection` of at most four foreground routes (Space first, then open Threads by recency);
  the feed is given only the selection. `MAX_ROUTES` keeps governing hand-typed routes.
- **Identity of what was pulled:** replica, root and genesis must equal the route's, else the route is dropped
  (`route_replica_mismatch`, `route_root_mismatch`, `route_genesis_mismatch`).
- **No fallback:** a hand-typed route is never used for a catalogued replica (`catalog_route_unavailable`).
- **Scheme:** `wss://` only; the disposable-profile mapper is OD-8. **No freshness claim:** a withheld newer
  catalog is undetectable and an older one never displaces the retained head.

## Design G: ordinary-build network policy (OD-9)

The ordinary build connects to nothing (`tauri.conf.json:26`), so a real root's app cannot dial a catalog route.
The shared `tauri.conf.json` is also the Android bundle's config (`flagship.yml:1058` builds Android from it;
`AndroidManifest.xml:4` already holds `INTERNET`), so widening it would widen Android. Option (i): leave
`tauri.conf.json` local-only and add `wss:` to `connect-src` through a **desktop-only** platform override (Tauri
`tauri.<platform>.conf.json` merge files, confirmed in PR 7), with `product_contract.mjs` asserting the merged
desktop value and, separately, that the merged Android config's `connect-src` is still exactly the local-only
`table.csp.ordinaryConnectSrc`. Ordinary packaged evidence: the app attempts a `wss://` dial to a fixture host and
sees a network error with no `securitypolicyviolation`. Option (ii): ordinary stays local-only; acceptance ships in
the enrollment variant only. Option (iii): a native-proxied dial (new custody; joins OD-10 (a)). **Recommend (i)
desktop-only**: the ordinary route alphabet already admits `wss`, and Android stays local-only until its own plan.

## Refusals (atom: where enforced)

- Evaluator reasons (`malformed_catalog, control_history_limit, wrong_catalog_scope, trust_pending,
  invalid_catalog_signature, invalid_possession, catalog_authority_refused, invalid_catalog_transition,
  catalog_rollback, catalog_fork, recovery_incomplete, carrier_pending, authority_changed,
  invalid_verified_history, unsupported_cutoff`): the Rust evaluator (PR 3), vectors against Elixir/TS.
- `trust_recovery_required, stale_trust_snapshot, trust_persistence_failed, migration_required`: owner (PR 5).
- `not_space_root, already_pinned, review_token_invalid, probe_incomplete, head_not_accepted,
  route_conflicts_saved_route, evidence_page_malformed, evidence_page_too_large, catalog_rotation_unsupported`:
  owner (PR 5); the exporter refuses to write the last three (PR 4).
- `route_replica_mismatch, route_root_mismatch, route_genesis_mismatch, catalog_route_unavailable`:
  `treehouse_host.ts` (PR 6). `disposable_profile_only`: mapper guard (PR 6) and bundle check (PR 7).
- Grammar refusals: `treehouse_routes.ts`, `preview.rs` (PR 1). `catalog_envelope_invalid` (bad signature, bytes
  not canonical): Rust envelope verifier (PR 2).

## Operator decisions (raised, not decided)

- **OD-6 Where acceptance is verified (rule 3).** (a) A Rust evaluator in `src-tauri`: canonical encoder,
  envelope verifier, bounded-continuation authority fold, catalog trust, inventory and route-reservation rules,
  reciprocal vectors against Elixir and TS (the repo's existing twin discipline). (b) Native checks signature,
  chain and pin only and trusts a TS verdict: rejected by both reviews, because installing on a webview verdict
  is IPC promotion; allowed at most as a candidate-only path that never issues installed-route receipts.
  (c) Embed a sandboxed JS engine running a hash-pinned TS evaluator bundle. **Recommend (a)**: it keeps the
  evaluator inside the protected boundary with no new engine, no WebView-visible verdict, and mobile builds
  unchanged. (c) adds a JS engine and supply-chain surface to custody code and a bundle-pinning ceremony. Cost: a
  third twin of about 4,000 lines of authority plus trust logic; hence it is split into PR 2 and PR 3.
- **OD-7 First install beside an identity.** Recommend (a) as amended in Design D (independent marker written in
  `initialize()`, one-time user-confirmed migration, stated nonclaim). (b) let the reviewed bootstrap authorize a
  first store: rejected, deleting the row re-opens a fresh install. (c) separate profile: rejected, breaks onboarding.
- **OD-8 Test-profile origin.** A signed catalog cannot carry `ws://`. Recommend (iii): a dev-trace-only mapper
  rewriting the signed `wss://host` to `ws://127.0.0.1:<port>` only for a disposable catalog key, compiled out of
  release bundles (guard and unit test in PR 6, bundle check in PR 7). (i) codec arm: Wire-adjacent, a plan 224
  STOP. (ii) hosted wss loopback with a trusted cert: flaky. The claim says "realm, key, path, replica as signed".
- **OD-9 Ordinary-build CSP.** Recommend (i), desktop-only override, Android verified local-only (Design G).
- **OD-10 Who performs the mandatory re-observation pull (rule 3; second round on this class, so a decision).**
  (a) Native pulls itself with a Rust carrier client in the protected boundary: the barrier is attested and a
  compromised webview cannot skip it. It needs a WSS client (`tokio-tungstenite` plus rustls; neither is a
  dependency today, `src-tauri/Cargo.toml`), the carrier handshake, nonce signing, frontier/pull framing and the
  Wire decode: a port of the client half of `carrier.ts` (2,653 lines, `CarrierWebSocketClient` at `:862`) and
  `codec.ts` parts, estimated 1,500-2,500 lines of Rust plus an ordinary-CSP-free network path (native dials, so
  OD-9 shrinks) and a new network surface in custody code; carrier-adjacent, rule 3, its own PR 4b between PRs 3
  and 5. (b) The webview pulls; native enforces shape and generation binding only. Against a compromised webview
  re-observation is not enforced, and a withheld revoke can be installed until the next native reclassification.
  Written nonclaim, honest-shell tier. (c) Webview pulls but the first install is gated on a second signal sound
  without a Rust client: the evidence page itself is exported by the operator at a stated time and native refuses
  a page whose exporter timestamp is older than a root-confirmed bound; this bounds staleness of the page, not
  of the pulled frames, and does not stop frame resubmission, so it reduces but does not close the gap.
  **Recommend (b) for this plan, with (a) as a filed follow-up row**: the only attacker (a compromised webview)
  can already author and sign through the existing native signer on the user's behalf and dial anywhere its CSP
  allows, so (a) closes one gap in a surface that stays open; (a) costs a second protocol client in custody
  code. If you want the claim to hold against a compromised webview, choose (a) and accept PR 4b.

## Build PRs (ordered; file sets disjoint)

`src-tauri/` is `clients/treehouse-tauri-shell/src-tauri/`; other paths are under `clients/treehouse-tauri-shell/`
unless absolute from the repo root.

| PR | Scope | Files | Needs | Rule 3 |
|---|---|---|---|---|
| 1 | Bounded Thread grammar | `src/treehouse_routes.ts`, `src-tauri/src/preview.rs`, `test/replica_grammar.ts`, `test/replica_grammar_cases.json`, `src-tauri/tests/route_alphabet.rs` | — | Yes (`preview.rs` imports custody), second review |
| 2 | Rust canonical encoder and envelope verifier | new `src-tauri/src/catalog_eval/{mod,canonical,envelope}.rs`, `src-tauri/tests/catalog_eval_vectors.rs`, new vector files under `clients/lattice-client/test/vectors/catalog/` | OD-6 | Yes, second review |
| 3 | Rust catalog evaluator | new `src-tauri/src/catalog_eval/{authority,trust,entries}.rs`, extend `tests/catalog_eval_vectors.rs` | PR 2 | Yes, second review |
| 4 | Operator exporter | new `apps/lattice_carrier_server/lib/lattice_carrier_server/operator/catalog_evidence.ex`, new `apps/lattice_carrier_server/lib/mix/tasks/treehouse.catalog_evidence.ex`, tests, runbook section | fixtures; real input after 224 PRs 4-5 | No |
| 5 | Native owner | new `src-tauri/src/catalog_owner.rs`; `src-tauri/src/{lib,preview}.rs`, `src-tauri/build.rs`, `src-tauri/capabilities/default.json`, `test/product_contract.mjs`, `src-tauri/tests/catalog_owner.rs` | PRs 1-3; OD-7, OD-10 | Yes, second review |
| 6 | Shell import, probe, connect and refuse | `src/treehouse_host.ts`, new `src/catalog_install.ts`, `src/CatalogPanel.vue`, `src/treehouse_workflow.ts` (catalog actions), `src/App.vue`, tests, OD-8 mapper and its guard | PRs 4-5; OD-8, OD-10 | No (voluntary second review) |
| 7 | Ordinary CSP and hosted packaged gates | new desktop-only `src-tauri/tauri.macos.conf.json`, `product_contract.mjs`, `.github/workflows/flagship.yml`, new `test/packaged_catalog.ts`, `package.json`, `test/enrollment_ci_contract.mjs`, bundle-variant check | PR 6; OD-8, OD-9, OD-10 | Yes (`.github/workflows`), second review |

PR 5 edits `preview.rs` after PR 1 (disjoint hunks; PR 1 merges first).

### Gates

- PR 1: `npx tsx test/replica_grammar.ts`, `cargo test --test route_alphabet`, `npm run typecheck`; persisted
  bounded Thread profile reloads; the `B`-tail fixture still refused.
- PR 2: `cargo test --test catalog_eval_vectors`: Rust canonical bytes, frame ids and envelope signing bytes equal
  Elixir and TS vectors both ways; non-canonical, wrong-key, duplicate-key and over-cap inputs refused.
  **STOP if `Lattice.Canonical` must change.**
- PR 3: the same test replays every catalog fixture (fork in both orders, rollback, blocked, pending, rotation
  refusal, revoke/beacon lapse of a reference, route reservation, inventory growth) and the Rust decision, routes and
  reason equal Elixir and TS for each.
- PR 4: `mix test` for the exporter: round-trip through `CatalogTrust.evaluate/1` to `reason: nil`; refuses
  tampered, forked, gapped or over-cap chains and an existing output file or symlink; byte-identical on repeat.
- PR 5: `cargo test --test catalog_owner`: one test per owner refusal; reopen returns the same receipt; the Design D
  race gate; delete row then reopen is `trust_recovery_required` with no sentinel; re-pin refused; a swapped page
  or reused token refused; blocked routes `[]`; receipt reclassified after a history revoke and after restart;
  conflicting saved route refuses the install; contract exact sets and denial from remote origin and witness webview.
- PR 6: typecheck and shell tests: Accept unreachable before commit; failed or timed-out pull refuses; a pulled
  revoke turns the head into a refusal; replica/root/genesis mismatch drops the route; 13 retained entries open at
  most four sockets; no hand-typed fallback; mapper absent from the release variant. Tier: unit and contract.
- PR 7: hosted `treehouse_packaged_macos_enrollment` and the ordinary packaged job green on the exact tip: import,
  probe, commit, restart, routes persist, tampered page and pre-pull accept refused; ordinary desktop app shows no CSP
  violation for a `wss://` dial, and the merged Android config's `connect-src` equals the local-only ordinary
  value (Android gate unchanged and green). Tier: packaged macOS, disposable key, OD-8 mapping; no production, mobile or R21a claim.
- Each PR: hosted green on the exact tip (rule 2).

## Done criteria

Part 1 (finishable after OD-6 to OD-10):
- [ ] PRs 1-7 merged on green exact tips; each claims only its tier (rule 1).
- [ ] Every Refusals atom has a test in the PR that enforces it; every refusal leaves the retained record unchanged.
- [ ] Row 245 updated (one line); rows filed for OD-6 follow-ups and hand-off of lapsed-reference rechecks (row 244).

Part 2 (parked, rule 8): the root imports the real exported page and the app shows the listed Space and Thread
routes. Unchecked until the ceremony report, plan 224 PRs 4-5 and row 254 exist.

## STOP conditions

- An IPC command that accepts a snapshot, route list, review object or "verified" flag from the webview, or any
  receipt issued from a TS verdict.
- A change to `catalog_store.rs` that installs trust or exposes routes, or any catalog route written into
  `PreviewState.relay`.
- A change to `Lattice.Canonical`, the codec, Wire vocabulary, `carrier.ts` or the Elixir/TS evaluators.
- A probe grant used for anything but one pull-only attempt, or a route used for feed, sync or relay before a
  committed generation-valid receipt.
- A third review round on the same finding class (rule 3): operator design question.
- A loopback `ws://` reaching a release bundle, or a widened `connect-src` in the shared or Android config.
- Resolving OD-10 by adding caller-attested pull status that native treats as proof, or choosing (a) without PR 4b
  reviewed as carrier-adjacent.

**Non-goals:** member first install (R13); creating bounded Threads in the app (row 254); a catalog read message,
server push or origin file; key rotation or replacement (R11c); R21a origin mapping; mobile custody; freshness
claims; route replacement (row 198 D3); superseding a lapsed reference (row 244); native-performed dialing.
