# Plan 186: Shared shell kit `clients/lattice-shell-kit` (Round 6, S3)

> **Executor instructions**: This is a design plan. It decides what moves, in what order, and what proves
> behaviour unchanged; it moves no code. Each PR below is executed as its own slice, with its own
> adversarial review. Run every verification command. If anything in "STOP conditions" occurs, stop and
> report; do not improvise. Line numbers drift: grep the named symbol, not the number. Run mix as
> `~/.asdf/shims/mix`; run npm tools from `node_modules/.bin` (the npm shell wrapper recurses).
>
> **Drift check (run first)**: `git log --oneline -- clients/treehouse-tauri-shell/src clients/treehouse-tauri-shell/test/support clients/treehouse-tauri-shell/package.json .github/workflows/flagship.yml clients/township-tauri-shell`
> then re-read the "Current state" inventory against the live files. Any module in the inventory that
> gained a second import of a shell-local type, or a Township file that changed (rule 10 forbids it), is
> a STOP condition until the inventory is refreshed.

## Status

Design written 2026-10-17. PR 1 (skeleton, wiring, test support, classifier arm) in review 2026-10-17.
PR 1 deviations: lattice-client is a kit peer only (a kit-local copy splits `instanceof` under
`--preserve-symlinks`), and the kit typechecks it through a `paths` entry; `--preserve-symlinks` goes on the
tsx calls that load the fake relay, while the BEAM helpers sit in a node-only `./testing/beam` subpath so the
pinned enrollment scripts are unchanged; Vite `preserveSymlinks` is deferred to PR 2; the bundle guard
lives in `vite.config.ts` under `build`. CI coverage of the kit's own checks is row 220, needed before PR 2.

PR 2a (2026-10-17) landed row 220 (unit installs the kit and runs typecheck and the boundary check; the enrollment
cargo cache key hashes kit source), the route validator factory (design decision 7) and Vite `preserveSymlinks`.
It then hit a STOP condition: `test/enrollment_ci_contract.mjs` pins the `packaged:enrollment` script to
`tsx test/packaged_enrollment.ts` with no switches, and that harness imports the relay client and sync. A kit
module importing `@treetopdevs/lattice-client` at runtime cannot resolve without `--preserve-symlinks`; unflagged
tsx fails with "ERR_MODULE_NOT_FOUND: Cannot find package '@treetopdevs/lattice-client' imported from
.../clients/lattice-shell-kit/src/...", and the contract documents no refresh procedure for that pin. PR 2 therefore
halts after commit 1 instead of using the sync/feed split allowance, so this is not a further split under rule 9:
the remainder (relay client, sync, feed, panel sync) lands as one PR once the operator answers the pin question in
row 221 (re-pin with a documented procedure, inject lattice-client values into the kit per decision 4c, or set
`NODE_PRESERVE_SYMLINKS=1` in the job env, unverified and possibly pinned itself). PR 2a deviations from decision 7:
the factory takes `isSpace(replica)` instead of `classify`, since the kit needs only the Space test, and reads
`maxRoutes` lazily through a getter because `treehouse_state` and `treehouse_routes` import each other. When the
relay client and sync move, `product_contract.mjs`'s `carrierClientFiles` must name their kit paths.

PR 2 remainder (2026-10-17, row 221 decided as D-15 option (a)): the relay client, sync, feed and panel sync wiring
moved into `clients/lattice-shell-kit/src/sync/` behind `RouteBook` and `SyncHost` (`src/sync/host.ts`), implemented
by the shell's new `src/treehouse_host.ts`, which also holds the Treehouse-named adapters with the old signatures, so
tests changed import lines only. `packaged:enrollment` is re-pinned to exactly `tsx --preserve-symlinks
test/packaged_enrollment.ts` with a dated note in `enrollment_ci_contract.mjs`; no workflow line changed. Deviations:
the carrier modules sit behind a `./sync` subpath and the `.` barrel stays inert (routes only), so the unflagged tsx
tests keep resolving; `gate:enrollment` also gains `--preserve-symlinks` (it imports the moved modules; unpinned);
the signer and the two route validators are members of the port rather than a third interface; Space-first ordering
is an `isAnchor` predicate, plus `holdsAnchorProfile` for the feed's Space pre-sync; the status copy
(`describeSyncStatus`, connection labels) and `treehouseFeedEnv` stay in the shell as product copy and product flags,
and the kit's `createPanelSync` takes `describe`, `pollMs` and `autosyncOnMount`; the unobservable internal string
"Treehouse feed worker stopped" became "feed worker stopped"; the move is two commits, not five; and
`r13_lite_contract_test.exs`'s claim-surface list now names `treehouse_host.ts`, where the status copy moved. The
`test/feed.ts:233` timing flake predates the move and is row 222.
PR 3 (packaged harness) remains.

## Header

- **Priority**: P2
- **Effort**: M (three PRs; the second is the large one)
- **Risk**: MEDIUM. The moved code is the Treehouse sync path, so a regression is a user-visible sync
  failure. It is mitigated by moving test support first, by the existing suites being the proof, and by
  parameterizing instead of rewriting.
- **Depends on**: plan 183 (done: product-scoped CI and the `changes` classifier this plan edits)
- **Category**: architecture (Round 6, loop A5, slice S3)
- **Planned at**: 2026-10-17, against the tree named by the drift-check paths above

## Why this matters

Round 6 loop A5 says the shells copy instead of share. Plan 181 decided, correctly for its slice, to
"copy and parameterize" the Township feed controller and outbox sync and to "not import across shells"
for the BEAM test helpers. The result is that every sync or relay-client fix has to be made in two places
by hand, and the next shell (Toolshed at R26, a mobile shell, or a Township revival at R34) would copy a
third time. Treehouse's `src/` is 4,693 lines, of which about 1,300 (relay client, sync, feed, panel
sync, routes) are carrier-client plumbing with no product meaning, and about 1,700 lines of test support
and harness are shell-neutral.

**The central tension, stated plainly.** Rule 10 freezes Township, so today the kit would have exactly
one consumer. It is not DRY across two live shells, and this plan does not pretend it is. Two reasons
still justify it:

1. **Break the copy loop before the next shell exists.** The cheapest moment to put a boundary around
   the plumbing is while one shell owns it and nobody else has forked it. After a second shell copies it,
   extraction needs a three-way reconciliation.
2. **The boundary is testable today.** Treehouse's own suite (`npm test`, `gate:enrollment`, the hosted
   packaged jobs) is the kit's conformance. No parallel kit suite is needed, so this does not add to loop
   A4 (evidence outweighing product).

**Fold-back condition.** If no second shell consumes the kit when Township unfreezes (plan 183 and the
index defer it to R34) or when a new shell plan is filed, whichever comes first, the kit is folded back
into the Treehouse shell by a mechanical move. That is the price of being wrong, and it is small because
the shell keeps its own tests and thin adapters throughout.

**Rule 8 check.** Every gate below runs on hosted runners and local tools that exist today (shell tests,
the BEAM relay fixture, the `macos-15-intel` packaged jobs). No device, signing identity, host or
operator approval is needed, so this is a buildable plan, not a parked one.

## Current state

Inventory of `clients/treehouse-tauri-shell`, measured 2026-10-17. "Product" means it names a Treehouse
type or concept.

| Module | Lines | Couples to | Verdict |
|---|---|---|---|
| `test/support/fake_relay.ts` (`FakeRelay`, `FakeClock`) | 182 | `@treetopdevs/lattice-client`, `@noble/curves` only | moves as is |
| `test/support/relay_peer.ts` BEAM helpers (`freeTcpPort`, `runBeamSupport`, `makeGateRoot`, `assertPrivateChain`, `fileSha256`) | ~90 | node only | moves as is |
| `test/support/relay_peer.ts` manifest relay (`writePilotManifest`, `spawnPilotManifestServer`, `createRelayObserver`) | ~200 | `RelayRoute` type, `fromBase64`, repo-root path to `pilot_node.exs` | moves, route type becomes structural |
| `src/treehouse_routes.ts` | 228 | `route_alphabet.json`, `MAX_ROUTES`, `productOf`, replica regexes | validators move as a factory; alphabet, regexes and `productOf` stay |
| `src/treehouse_relay_client.ts` | 92 | `TreehouseWorkflow` (identity, signer), `RelayRoute` | moves behind a signer/identity port |
| `src/treehouse_sync.ts` | 367 | `TreehouseWorkflow`, `treehouseCommandDecoders`, `productOf` ordering of routes | moves behind a host port; ordering stays a shell callback |
| `src/treehouse_feed.ts` | 674 | `workflow.state.relay`, `workflow.state.profiles`, `MAX_ROUTES`, `syncTreehouseRoute`, `productOf` | moves behind the same host port |
| `src/treehouse_panel_sync.ts` | 135 | feed controller, relay connector, `RelayRoute` | moves with the feed |
| `test/support/packaged_ax.ts` + `packaged_accessibility.swift` | 163 + 78 | none (injected exec) | moves as is |
| `test/support/packaged_bundle_variant.ts`, `secret_scan.ts`, `store_read.ts` | 99, ~60, ~40 | product bundle identifiers, KV record names | move with identifiers as parameters |
| `test/support/seeded_native.ts`, `route_alphabet_cases.ts` | ~140, 264 | `parseState`, `treehouse_routes` | stay |
| `src/App.vue` (619), `EnrollmentPanel.vue` (460), `WitnessSetup.vue`, `treehouse_workflow.ts` (900), `treehouse_state.ts` (259), `native_adapter.ts`, `witness_*.ts` | | product UI, workflow, state shape, native bridge | stay in the shell |

Facts that constrain the design:

- **Package wiring precedent.** Both shells depend on `"@treetopdevs/lattice-client": "file:../lattice-client"`.
  That package ships a built `dist/` behind an `exports` map, which is why every CI job runs
  `npm --prefix clients/lattice-client run build` before `npm ci` in a shell. There is no root npm
  workspace; the repository root `package.json` is a legacy demo package.
- **Hosted CI classifier** (`.github/workflows/flagship.yml`, job `changes`): a path outside the listed
  product prefixes is classified `core=true`, which turns every product job on, Township included. A new
  `clients/lattice-shell-kit/` directory with no arm would therefore run the whole matrix.
- **Pinned workflow text.** `test/enrollment_ci_contract.mjs` pins step bodies of
  `treehouse_packaged_macos` and the enrollment job by digest. Any edit to those step bodies requires
  the refresh procedure in that file's header.
- **A source scan that the move would silently escape.** `test/product_contract.mjs` walks `src/` and
  `src-tauri/src/` and forbids `websocket` outside three named carrier-client files, and forbids a list
  of seed and discovery markers everywhere. Code moved to the kit leaves that walk unless the walk is
  extended.
- **Shared alphabet.** `route_alphabet.json` is read by both `treehouse_routes.ts` and
  `src-tauri/src/preview.rs` (plan 198); `test/route_alphabet.ts` plus the committed cases keep the two
  ends equal. A src-tauri path is a rule 3 path.
- **What Township holds.** `township_feed.ts` (403), `township_sync.ts` (548), `township_carrier_peer.ts`
  (327), `test/support/beam_peer.ts` (424) and its own `packaged_bundle_variant.ts` are the historical
  source the Treehouse copies were made from. They are not edited by this plan.
- **What is already shared.** `clients/lattice-client` carries transport, codec, canonical bytes,
  `CarrierPeerError`, bounded dial and request deadlines, and `syncCarrierOnce`. The kit is the layer
  above it (scheduling, routing, persistence ordering, harness), not a second client.

## Design decisions

1. **A package, not a directory of copies.** New package `@treetopdevs/lattice-shell-kit` at
   `clients/lattice-shell-kit`, TypeScript source only, `"private": true`. Subpath exports: `.` (runtime
   modules) and `./testing` (fake relay, BEAM helpers, packaged harness). The shell's production import
   graph never reaches `./testing`. The existing bundle classification checks native marker strings, not
   frontend imports, so PR 1 adds a `vite build` step to the shell's `check` script that reads Rollup's
   resolved module list (`build.manifest` or a `generateBundle` hook) and fails if any module path is under
   `lattice-shell-kit/src/testing/`.
2. **Consume by `file:` dependency, as lattice-client is consumed; no root workspace.** A root workspace
   would change `npm ci` behaviour and the `cache-dependency-path` lines for every shell and for the
   Township jobs this plan must not touch, and it would drag the root legacy package into the graph.
   Rejected.
3. **No build step and no committed `dist/`.** Round 6 already lists the 130 tracked `lattice-client/dist`
   files as a defect. The kit's `exports` points at `.ts` source; the shell's Vite, `tsx` and `vue-tsc`
   compile it. This also avoids adding a build line at the five CI sites that build lattice-client.
4. **One copy of lattice-client and noble, proven not assumed.** The kit declares
   `@treetopdevs/lattice-client` and `@noble/curves` as `peerDependencies` (and as `devDependencies` for
   its own typecheck). If npm resolved a second copy, `CarrierPeerError instanceof` would split and
   `Verifier` types would diverge. The kit has no runtime dependency of its own. PR 1 begins with a wiring
   spike whose only acceptance is a script that asserts the kit's `CarrierPeerError` is the same object
   the shell imports. Candidate wirings, tried in this order: (a) symlinked `file:` dependency with
   `preserveSymlinks` in TypeScript and Vite and `--preserve-symlinks` for `tsx` runs; (b) npm
   `install-links` for the shell, which copies instead of linking (changes how lattice-client is
   installed, so only if (a) fails); (c) the kit takes lattice-client values by parameter and imports only
   types. If none of the three yields one copy, that is a STOP condition.
5. **Test support moves first, product code second, harness third.** Ordered by coupling, lowest first,
   so the wiring is proved on code with no product edges before any sync path moves.
6. **Parameterize by a small host port; do not rewrite.** The product code reaches the kit through two
   narrow interfaces the shell implements in a new `src/treehouse_host.ts` adapter over
   `TreehouseWorkflow`:
   - `RouteBook`: configured routes, local realm, pinned-profile lookup, route limit.
   - `SyncHost`: command decoders for a route, the verifier, load and persist of the local frame store,
     the route ordering callback (`productOf` ordering stays in the shell).
   The moved bodies keep their control flow, their constants and their comments. A diff that changes
   behaviour is a rejected diff; the PR description lists any deliberate difference by name.
7. **Routes: validators move as a factory; the alphabet stays.** `createRouteValidators(alphabet,
   { maxRoutes, isReplica, classify })` returns `validateLocalRealm`, `validRouteUrl`, `validateRoute`,
   `validateRoutes`, `parseRouteList`, `mergeRelay`. `isReplica` carries the replica regexes and
   `classify` carries `productOf`, so `validateRoute` and the exactly-one-Space rule in `validateRoutes`
   run unchanged inside the kit while the product knowledge stays in the shell. The shell calls it with
   `route_alphabet.json` and those callbacks and re-exports the results, so `treehouse_routes.ts` shrinks to the factory call plus `productOf`, the replica regexes,
   `routesForOffer` and `offerRoute`. The JSON file does not move, so `preview.rs` is not touched and no
   src-tauri path enters this plan. `test/route_alphabet.ts` and its cases remain the TypeScript/Rust
   agreement check.
8. **Boundary enforcement by configuration, not by a source-reading test.** Policy rule 6 forbids a new
   test that asserts on another file's source text. `include` and absent aliases alone do not stop a
   relative import into a shell (TypeScript follows imported files outside `include`), so the kit's
   `check` script runs `tsc --noEmit --listFiles` and fails if any listed file is outside
   `clients/lattice-shell-kit/` or a `node_modules/` directory. That checks the compiler's resolved
   graph, not source text. The PR description records one `grep` of the kit for
   `treehouse|township` as a human review line. No new test file is added for this.
9. **Tests stay in the shell for this cut.** The shell is the only consumer, and its suite (`feed.ts`,
   `sync.ts`, `sync_panel.ts`, `storage.ts`, `route_alphabet.ts`, `enrollment_sync_gate.ts`) is the proof.
   A kit-local suite would duplicate it (loop A4). A second consumer is what moves tests into the kit.
10. **Township is left as a frozen copy.** It is not migrated, not edited, not annotated. Its duplicated
    modules stay duplicated; they are listed in the Non-goals so no one reads the duplication as an
    oversight. The classifier gets a kit arm that sets `treehouse=true` only, so a kit PR does not run
    Township jobs, which is correct because Township does not import the kit.
11. **Existing source pins are retargeted, never loosened or added.** `product_contract.mjs` is edited in
    the same PR that moves a file: its source walk gains `../lattice-shell-kit/src` so the forbidden-marker
    scan still covers moved code, and its carrier-client allowlist names the kit files that now hold the
    `websocket` references. Policy rule 6 allows retargeting an existing pin to a moved file; it forbids
    new pins.
12. **Evidence tiers (rule 1).** Every PR claims the shell-suite tier plus one hosted packaged job, in
    one sentence, and nothing higher. No core claim, no vectors, no device claim, and no change to the
    receipt-free W4 or Phase G status.

## PR plan

### PR 1: Skeleton, wiring, and the zero-coupling test support

**Moves**: `fake_relay.ts` (`FakeRelay`, `FakeClock`) and the BEAM helpers from `relay_peer.ts`
(`freeTcpPort`, `runBeamSupport`, `makeGateRoot`, `assertPrivateChain`, `fileSha256`) into
`clients/lattice-shell-kit/src/testing/`. The shell tests that import them (`feed.ts`, `sync.ts`,
`sync_panel.ts`, `enrollment_sync_gate.ts`, `packaged_enrollment.ts`) change their import path and
nothing else.

**Also contains**:
- The package skeleton (`package.json`, `tsconfig.json`, `src/index.ts`, `src/testing/index.ts`) and the
  shell's `package.json` dependency line plus lockfile update.
- The wiring spike's acceptance script (decision 4), kept as a shell script in `package.json`, not as a
  new source-reading test.
- The classifier arm in `.github/workflows/flagship.yml`: `clients/lattice-shell-kit/*` sets
  `treehouse=true`. No other workflow line changes, and no new build step is added because the kit has no
  build. If the wiring candidate chosen by the spike needs an install flag at the Treehouse `npm ci`
  sites, those lines change too and the digests in `enrollment_ci_contract.mjs` are refreshed by the
  procedure in its header.

**Gates**: shell `npm test`; `typecheck` in the shell and the kit; `gate:enrollment` (real BEAM relay and
`Lattice.Sim` oracle); the workflow-parsing tests named in plan 183 (`enrollment_ci_contract.mjs` and the
Township ones); hosted `treehouse_packaged_macos` and `treehouse_packaged_macos_enrollment`; a throwaway
check that a kit-only diff leaves every Township job skipped.

**Tier**: shell suite plus one hosted packaged job. **Rule 3**: yes, `.github/workflows` is touched, so
this PR gets the second independent review, once.

### PR 2: Relay client, routes engine, sync, feed, panel sync

**Moves**, as separate commits in this order so each is green on its own: (1) the route validator
factory; (2) `treehouse_relay_client.ts` behind a signer/identity port; (3) `treehouse_sync.ts` behind
`SyncHost`; (4) `treehouse_feed.ts` behind `RouteBook` and `SyncHost`; (5) `treehouse_panel_sync.ts`.
The shell gains `src/treehouse_host.ts`, and its old module paths become one-line re-exports for the
duration of the PR only, removed in the last commit so no shim survives the merge.

**Behaviour that must not change**, checked by the existing tests and named in the PR description: the
persist-after-acknowledgement ordering, the Space-before-Thread route order, the coalesced trailing
refresh, reconnect backoff and epoch cancellation, the bounded dial and request deadlines, the
`CarrierPeerError` stop mode (rows 195 and 197), the "relay link, never peer convergence" labelling, and
`MAX_ROUTES`.

**Gates**: shell `npm test` (`feed.ts` is 1,023 lines and carries most of the feed contract);
`gate:enrollment`; `route_alphabet.ts` with committed cases; `product_contract.mjs` retargeted per
decision 11; `vue-tsc` typecheck and `vite build`; hosted `treehouse_packaged_macos_enrollment`, which is
the real-app run of invitation, join, post and sync against the fixture relay compared with `Lattice.Sim`.

**Tier**: shell suite plus one hosted packaged job. **Rule 3**: no. If extraction appears to need an edit
to `clients/lattice-client/src/{authority,codec,carrier}.ts` or any `src-tauri/src` file, that is a STOP
condition, not a scope extension.

**Split allowance**: if review finds the PR too large, it may split once at the sync/feed seam (commits
1 to 3, then 4 and 5). It may not split further; this is a bounded move, not a ladder (rule 9).

### PR 3: Packaged harness

**Moves**: `packaged_ax.ts` and `packaged_accessibility.swift`; `packaged_bundle_variant.ts`
(the kit takes product bundle identifiers and the dev-trace marker as parameters; the Treehouse values
stay in the shell); `secret_scan.ts` and `store_read.ts` (KV record names as parameters); the manifest
relay spawner (`writePilotManifest`, `spawnPilotManifestServer`, `createRelayObserver`, with the route
type made structural and the repo-root path to `pilot_node.exs` passed in). `packaged_enrollment.ts`,
`packaged_preview.ts` and `test/packaged_*.ts` change imports and the `swiftc` source path only.

**Gates**: shell `npm test` (including `packaged_ax_driver.ts` and `packaged_bundle_variant.ts`, which run
without an app); hosted `treehouse_packaged_macos` and `treehouse_packaged_macos_enrollment`, which are the
only runs that exercise the Swift helper and the real bundle classification. A local green run does not
substitute for these.

**Tier**: shell suite plus hosted packaged. **Rule 3**: no, provided no workflow line references a moved
path. Today none does (the Swift helper and `test/support/` files are reached by relative path from the
shell, not from YAML). If that has changed by execution time, the PR keeps those files in place and exports
nothing for them, rather than editing the workflow.

## Non-goals

- Migrating, editing, annotating or deleting anything under `clients/township-tauri-shell`. Its duplicates
  of the feed, sync, carrier peer and `beam_peer.ts` stay (rule 10). The done criteria check the diff is
  empty.
- Any change under `clients/lattice-client/src/{authority,codec,carrier}.ts` or `src-tauri/src` custody
  code. The kit is a consumer of those, not an editor.
- Moving `App.vue`, `EnrollmentPanel.vue`, `WitnessSetup.vue`, `treehouse_workflow.ts`,
  `treehouse_state.ts`, `native_adapter.ts` or `witness_*.ts`. Product UI, workflow and state stay.
- Moving `route_alphabet.json` or editing `preview.rs` (plan 198 owns that pair).
- A kit-local test suite, a kit `dist/`, a root npm workspace, or placing kit modules under
  `lattice-client/src` (which would put shell code inside rule 3's fence permanently).
- Behaviour changes of any kind, including fixing sync or feed defects found during the move. A defect
  found gets its own index row (rule 7) and is fixed after the move, not inside it.
- Server push, relay replacement, catalog, sealing, Keychain custody, mobile or device results,
  production deployment, Phase G completion or receipt-free W4. This is a source-organization change and
  claims none of them.
- Splitting `treehouse_workflow.ts` (900 lines). It is product code; a separate plan if wanted.
- Lazy-loading Township probe modules from `App.vue` (deferred behind plan 187 by the Round 6 notes).

## Done criteria

- [ ] `clients/lattice-shell-kit` exists with the modules in the three PRs, no `dist/`, no tests of its own,
      and its `tsc --noEmit` passes with no path alias into either shell.
- [ ] The wiring acceptance script shows one copy of lattice-client in the shell's resolved graph.
- [ ] Treehouse `npm test` and `gate:enrollment` pass unchanged in assertions; the only test-file edits
      are import paths, the retargeted `product_contract.mjs` walk, and any digest refresh that PR 1's
      workflow edit requires.
- [ ] Hosted `treehouse_packaged_macos` and `treehouse_packaged_macos_enrollment` are green on each PR's
      exact tip (rule 2).
- [ ] `git diff --stat <base>..HEAD -- clients/township-tauri-shell clients/lattice-client/src
      clients/treehouse-tauri-shell/src-tauri` is empty for PR 2 and PR 3, and for PR 1 shows only the workflow, shell and kit paths.
- [ ] A kit-only throwaway diff skips every Township job (PR 1 check).
- [ ] No shim re-export of an old shell module path survives the merge of PR 2.
- [ ] `plans/README.md` row 186 updated in one line, with the fold-back condition named.
- [ ] Each PR states its claimed tier in one sentence.

## STOP conditions

- The wiring spike cannot produce a single copy of lattice-client under any of the three candidates.
- A moved test starts failing and the cause is behaviour in the moved body, not an import path. Revert the
  commit; do not adjust the assertion.
- Extraction needs an edit to a rule 3 path other than PR 1's classifier arm.
- `product_contract.mjs` would have to be loosened (not retargeted) for a moved file to pass.
- A kit module needs to import a shell type to compile. Widen the port by one named method instead; if the
  port grows past two interfaces, report it as a design question for the operator.
- `enrollment_ci_contract.mjs` fails on an edit and its header gives no refresh procedure for it.
- Any change appears in `clients/township-tauri-shell`.

## Maintenance notes

- A new product directory needs a classifier arm; an unlisted prefix is treated as core (safe, slower).
  The kit's arm sets `treehouse=true`. If a second live shell ever consumes the kit, its product flag is
  added to the same arm in the PR that adds the dependency.
- Moving a shell test into the kit is the signal that the kit has a second consumer. Until then, tests
  stay with the shell.
- When Township unfreezes (R34), the first question is whether to migrate it onto the kit or leave the
  historical copy; this plan does not decide that, and that migration is the evidence for or against the
  fold-back condition.
