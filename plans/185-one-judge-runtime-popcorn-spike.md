# Plan 185 (spike): One judge runtime — run the real `lattice_core` judge inside the Treehouse Tauri webview via Popcorn, measure it, and decide

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat c57c826ad..HEAD -- apps/lattice_popcorn_spike clients/treehouse-tauri-shell/src-tauri/tauri.conf.json clients/treehouse-tauri-shell/package.json clients/lattice-client/test/conformance.ts .github/workflows/popcorn-spike.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M (spike; the build it may unlock is L and is a separate plan)
- **Risk**: MED for the spike (the Android WebView header question can end it), HIGH for any later build
- **Depends on**: plans/183-product-scoped-ci-and-legacy-fence.md; plan 182 (policy)
- **Category**: direction (design/spike)
- **Planned at**: commit `c57c826ad`, 2026-10-08

## Why this matters

The authority judge exists three times: `apps/lattice_core/lib/lattice/authority.ex` (1,689 lines,
plus 1,079 in `authority/`), `clients/lattice-client/src/authority.ts` (1,943, plus `capability.ts`,
`policy.ts`, `quarantine.ts`, `materialize.ts`, `continuation.ts`), and the test-only mirror
`apps/lattice_core/test/support/compaction_spike.ex` (1,973). They are held equal by 91 Sim-exported
vector files (8.1 MB) produced by a 5,276-line exporter. Rounds 3, 4 and 5 each found a parity hole
(plans 140, 147, 148, 162, 163, 172, 176); Round 4's headline was both runtimes agreeing on the wrong
answer. The roadmap now serializes all work on `authority.ex`, `authority.ts`, `codec.ts`,
`carrier.ts` and the exporter to one writer, and every semantic packet is an atomic three-way merge.
`docs/lattice2_design.md:160-164` warns against exactly this parallel stack.

The Popcorn spike already runs the real core in a browser: `apps/lattice_popcorn_spike/scripts/shared.mjs`
copies twenty core files byte-for-byte (hash-recorded) into an OTP 29 browser project, and
`browser/lib/durable.ex` calls `Authority.analyze/2`, `Reduce.reduce/3`, `Sync.deliver/2` and
`Wire.encode_ops/1` inside a Chromium Web Worker. Its Chromium gate (two browser replicas converge and
reject revoked writes against the native server) passed three times on 2026-10-08
(`.github/workflows/popcorn-spike.yml`, job `browser-proof`). What is unknown is whether that runtime can
live inside the Treehouse Tauri webview on desktop and Android at an acceptable size and speed, and
whether it reproduces every vector verdict. This spike answers that with numbers and ends in a dated
GO / NO-GO. It ships nothing to the ordinary app.

## Current state

- `apps/lattice_popcorn_spike/` is not an umbrella app (its `browser/mix.exs` is a standalone Mix
  project depending only on `{:popcorn, "0.4.0-next.0"}`, `extra_applications: [:logger, :crypto]`).
  Browser toolchain: OTP 29.0.6 / Elixir 1.20.4 (`.tool-versions` in the spike); server toolchain stays
  OTP 28.3.1 / Elixir 1.19.5. `scripts/compile.mjs` runs `prepareShared()` then `mix compile --warnings-as-errors`
  in `browser/` and writes `browser/_build/source-hashes.json`. `vite.config.mjs` uses
  `popcorn({ rootDir: "browser", app: "lattice_browser", runtimeVariant: "crypto" })`, inputs
  `index.html` and `replica.html`, and sets headers:
  `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`,
  CSP `default-src 'self'; script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; …`.
- `scripts/shared.mjs` `sources` (20 files): `identity.ex`, `canonical.ex`, `op.ex`,
  `authority/delegation.ex`, `authority/succession_certificate.ex`, `authority/continuation.ex`,
  `authority/continuation_certificate.ex`, `authority/beacon_certificate.ex`, `authority.ex`,
  `replica.ex`, `log.ex`, `dag.ex`, `sync.ex`, `sync/shape.ex`, `reduce.ex`, `crdt/{causal_list,lww,or_set}.ex`,
  `carrier/wire.ex`, `browser_log_store.ex`. The README's "exactly four modules" sentence is stale.
- `browser/lib/realm.ex` is a GenServer registered as `LatticeBrowser.Bridge`; the page calls it with
  `vm.genserver.call("Elixir.LatticeBrowser.Bridge", command, { timeoutMs })` from
  `src/replica-session.mjs` (`INGRESS` constant, `call` helper, 64 KiB frame cap). Commands are maps
  with a `"command"` key (`replica_restore`, `replica_receive`, …). `browser/lib/durable.ex` defines the
  demo replica `LatticeBrowser.Notes` (`use Lattice.Replica`) and does
  `analysis = Authority.analyze(Notes, log); Reduce.reduce(Notes, log, quarantine: analysis.quarantine)`.
- `verification.md` records: crypto Wasm 3,834,784 bytes (about 1.6 MB gzip), 8,094,720 bytes of OTP/app
  tarballs; boot latency and memory unmeasured; one unreachable clause had to be removed from core
  `Authority` to compile under Elixir 1.20 with warnings as errors; `wire.ex` decoding needs the atom
  vocabulary modules preloaded (`String.to_existing_atom`).
- Treehouse shell: `clients/treehouse-tauri-shell/src-tauri/tauri.conf.json` CSP is
  `script-src 'self'`, `connect-src 'self' ipc: http://ipc.localhost`, no `worker-src`, no headers
  block. The installed Tauri CLI is 2.11.4 (`tauri` crate 2.11.5); its `config.schema.json` documents
  `app.security.headers` with exactly the COOP/COEP example needed for `SharedArrayBuffer`. Build
  variants are selected by a separate config file plus `VITE_*` flags (precedent:
  `npm run tauri:build:dev-trace` → `tauri build --features treehouse-dev-trace --bundles app --config src-tauri/tauri.dev-trace.conf.json`
  with `VITE_TREEHOUSE_ENROLLMENT=1`); `test/packaged_bundle_variant.ts` classifies bundles and the
  enrollment work added a binary string scan proving the ordinary bundle contains no relay strings.
- Semantic calls in the Treehouse shell today are synchronous TypeScript:
  `treehouse_sync.ts:209` `await syncCarrierOnce(client, localOps, candidates, {}, { verifier, submission: "relay", expectedReplica, commandDecoders })`
  after `carrierOpsToSemanticOps(...)`; `treehouse_workflow.ts` imports `authorTreehouseCommand`,
  `treehouseCommandDecoders`, `verifyCarrierOp` and friends from `@treetopdevs/lattice-client`.
- Vector corpus: `clients/lattice-client/test/vectors/*.json` (91 files). `test/conformance.ts`
  iterates `readdirSync(vecDir)`, decodes `oracleCarrierOps` with `decodeCarrierOpFrame`
  (`carrierOpsToSemanticOps` with `treehouseCommandDecoders` for Treehouse schemas), runs
  `materialize(vec.schema, ops)` and compares `quarantineReasons`, state and order. Vector fields:
  `scenario`, `schema.name`, `ops` or `oracleCarrierOps`, `realmByPubkey`, `authorityQuarantine`
  (sorted `[id, reason]` pairs), `perspectives`, `capabilityCase`.
- Domain modules the vectors reference are **not** in the shared set: `Township.Matter`,
  `Township.ElectionBoard`, `Toolshed.Shed/Tool` (+ `Lattice.Authority.Consent`), `Treehouse.Space/Thread`
  (+ `Treehouse.Invitation`, `MemberContinuity*`, `TransportCatalog`, `CatalogEntries`), `Lattice.Demo.Thread`.
  `treehouse/catalog_trust.ex` and others call `Jason`; the browser project has no `jason` dependency.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Browser toolchain | `cd apps/lattice_popcorn_spike && cat .tool-versions` then `asdf install` for those versions | OTP 29.0.6, Elixir 1.20.4 |
| Spike baseline | `cd apps/lattice_popcorn_spike && export PATH="$HOME/.asdf/shims:$PATH" && npm ci && npm run prepare:shared && (cd browser && mix deps.get && mix test) && npm test && npm run build` (the shim resolves the spike's `.tool-versions`; `scripts/compile.mjs` spawns `mix` from `PATH`, so the export covers it too; bare `mix` is a broken mise shim) | all pass; `dist/build.json` written |
| Browser proof (needs Chromium) | `npm run e2e:replicas` with the proof servers from `README.md` running | `evidence/replicas.json` written, pass |
| Hosted proof | `gh workflow run popcorn-spike.yml --ref <branch>` | `browser-proof` green |
| Treehouse shell | `cd clients/treehouse-tauri-shell && npm ci && npm test && npm run build` | pass |
| Bundle classifier | `cd clients/treehouse-tauri-shell && tsx test/packaged_bundle_variant.ts` | pass |
| Core suite (server toolchain) | `PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix test apps/lattice_core` | 0 failures |

## Scope

**In scope**:
- `apps/lattice_popcorn_spike/**` (new Worker command, vector harness, shared-set extension, README fix)
- `clients/treehouse-tauri-shell/`: a new build-flag-gated page and config variant only
  (`src-tauri/tauri.judge-spike.conf.json`, one `VITE_TREEHOUSE_JUDGE_SPIKE` gate, one npm script)
- `docs/research/one_judge_runtime_spike.md` (new decision record)
- `plans/README.md` row 185
- Optionally `.github/workflows/popcorn-spike.yml`: one `workflow_dispatch`-only step for the vector harness

**Out of scope** (do NOT touch):
- `apps/lattice_core/lib/**` — if a core module will not compile under Elixir 1.20 / Popcorn, record it;
  do not patch core in this plan (that is a finding for the build plan)
- `clients/lattice-client/src/**` — nothing is retired here
- The ordinary and dev-trace Treehouse builds and their CSP; `tauri.conf.json` is read, not edited
- Any Township code

## Git workflow

- Branch: `advisor/185-one-judge-spike` from `origin/main`.
- Commits per step. Do NOT push or open a PR unless the operator instructed it; the deliverable is the
  decision record plus the prototype branch.

## Steps

### Step 1: Baseline the spike and fix its stale status text

Run the spike baseline. Then correct `apps/lattice_popcorn_spike/README.md` lines 7–12 and the "exactly
four Lattice value modules" sentence to state what `shared.mjs` ships (twenty modules) and that the
Chromium gate passes (cite the latest green `popcorn-spike.yml` run id). Do not touch the root README.

**Verify**: baseline commands pass; `grep -c "exactly four" apps/lattice_popcorn_spike/README.md` → `0`.

### Step 2: Extend the shared set to the domain modules the vectors need

Add to `scripts/shared.mjs` `sources` the domain files required by every schema name that appears in
`clients/lattice-client/test/vectors/*.json` (`jq -r .schema.name clients/lattice-client/test/vectors/*.json | sort -u`
lists them). Start with `demo/thread.ex`, `township/matter.ex`, `township/election_board.ex`,
`toolshed/shed.ex`, `toolshed/tool.ex`, `authority/consent.ex`, `treehouse/space.ex`,
`treehouse/thread.ex`, `treehouse/invitation.ex`, and add whatever those `alias`/`import` transitively
(`grep -n "alias\|import" <file>`). If a pulled-in module calls `Jason`, add `{:jason, "~> 1.4"}` to
`browser/mix.exs` deps (pure Elixir). Compile with `npm run build`, which runs
`mix compile --warnings-as-errors` for the whole browser project and has no module-scoped bypass. A
module that fails only on a warning under Elixir 1.20 is therefore a STOP like a hard error: record
the module and the warning text in the decision doc and stop (do not patch core; see STOP conditions).

**Verify**: `npm run build` succeeds; `dist/build.json` lists the added source hashes.

### Step 3: Add a `vector_verdict` Worker command

In `browser/lib/realm.ex` add a command `%{"command" => "vector_verdict", "schema" => name, "frames" => frames}`
that: resolves `name` to the module (an explicit allowlist map, never `String.to_atom`); preloads the
vocabulary modules as the existing decoder does; decodes `frames` with `Lattice.Carrier.Wire.decode_ops/1`;
builds a `Lattice.Log` (`Log.from_ops/2` or the path `durable.ex` uses); runs `Authority.analyze(mod, log)`
and `Reduce.reduce(mod, log, quarantine: analysis.quarantine)`; and replies
`%{"ok" => true, "quarantine" => sorted [[id, reason_string]], "holders" => map, "state" => canonical JSON, "elapsed_us" => integer}`.
For `state`, use the same JSON shape `Lattice.state/2` is compared with in `conformance.ts`; if that is
not reproducible directly, compare `quarantine` and `holders` exactly and record `state` comparison as
"not attempted" in the decision doc.

Add `test/vector-browser.mjs` modeled on `test/replica-browser.mjs`: launch Chromium against the
built preview, load each vector that has `oracleCarrierOps` (skip and list the others), send
`vector_verdict`, and assert per vector that `quarantine` equals the vector's `authorityQuarantine`
(sorted), that every role in `holders` equals the oracle state's holder for that role, and that `state`
equals the oracle state; a vector passes only when all three hold. Write `evidence/vectors.json` with
per-vector pass/fail, the three comparison results, elapsed, and the list of skipped scenarios. Add
`"e2e:vectors": "node test/vector-browser.mjs"` to the spike's `package.json`.

**Verify**: `npm run e2e:vectors` reports N passed, 0 failed, with the skipped list; attach
`evidence/vectors.json` to the decision doc.

### Step 4: Host the bundle inside the Treehouse Tauri webview (desktop)

- Add `src-tauri/tauri.judge-spike.conf.json` (merged over `tauri.conf.json` by `--config`) that sets
  `app.security.headers` to `{"Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp"}`
  and a CSP equal to the ordinary one plus `worker-src 'self' blob:` and `script-src 'self' 'wasm-unsafe-eval'`.
  Try `'wasm-unsafe-eval'` first; only if Popcorn fails to boot, retry with `'unsafe-eval'` and record
  which one was required.
- Add an npm script `tauri:build:judge-spike` mirroring `tauri:build:dev-trace` with
  `VITE_TREEHOUSE_JUDGE_SPIKE=1`, and a page `src/judge_spike.html` (or a route in `App.vue` behind the
  flag, loaded by dynamic `import()` so the ordinary bundle has no Popcorn code) that loads the spike's
  built `dist/` assets copied into the shell's `dist/judge/` at build time and runs the Step 3 vector
  loop in-app, printing results to the page and to a trace file under the app data dir.
- Prove the ordinary build is unchanged: `npm run build` then `tsx test/packaged_bundle_variant.ts`, and
  `grep -c -i popcorn dist/assets/*.js` → `0` for the ordinary build.

**Verify**: the judge-spike build launches on macOS, the Worker boots, and the in-app vector loop
reports the same pass count as Step 3.

### Step 5: Measure on macOS

Record, in a table in the decision doc, from three cold launches: time from window open to first
verdict (ms); Worker and app memory (BEAM `:erlang.memory(:total)` reported by the Worker, plus the
process RSS from `ps -o rss= -p <pid>` of the webview helper); bundle sizes (`dist/judge/` bytes raw
and gzip, from `build.json`); and per-op reduce time on a synthetic Thread log of 4,000 `post` ops
generated with `Lattice.Sim` (the roadmap's pilot stop threshold), measured as the `elapsed_us` of one
`vector_verdict` call. Record the host machine model and OS version.

**Verify**: the table is filled with numbers, not placeholders.

### Step 6: Android attempt

Using the `treehouse_android_preview` job's toolchain (NDK and Rust target as in
`.github/workflows/flagship.yml:632-651`), build the judge-spike variant as a debug APK and run it in
an emulator (or a device if one is attached). Record: whether Tauri's custom protocol delivers the
COOP/COEP headers on Android System WebView (check `crossOriginIsolated` in the page), whether the
Worker boots, time to first verdict, and memory. If no emulator or device is available, record
"not attempted" with the reason. This step informs the decision; it is not a gate.

**Verify**: the decision doc has an Android section with a result or "not attempted".

### Step 7: Write the decision record

Create `docs/research/one_judge_runtime_spike.md` with: what was run (commit, run ids, commands), the
measurement tables, the vector results (`evidence/vectors.json` summary, skipped scenarios and why),
the compile findings (modules that needed Jason, warnings under 1.20, anything that did not compile),
the CSP finding (`wasm-unsafe-eval` vs `unsafe-eval`), the Android result, and the verdict against the
thresholds below. Date it and name the operator decision needed.

Thresholds (adjustable by the operator; record any adjustment):

| Criterion | GO requires |
|---|---|
| Vector equality | every loaded vector's quarantine (and holders) equal; skipped scenarios listed with a reason that is not "mismatch" |
| macOS cold start to first verdict | ≤ 3,000 ms (median of three) |
| Memory with the 4,000-op log | ≤ 300 MB process RSS |
| Bundle | ≤ 16 MB raw, ≤ 6 MB compressed |
| CSP | boots with `'wasm-unsafe-eval'`, or the operator explicitly accepts `'unsafe-eval'` |
| Android | recorded (pass, fail or not attempted); a fail makes the verdict CONDITIONAL (desktop GO, mobile open), not NO-GO |

Verdicts: **GO** (all desktop rows met) → the follow-on build plan routes Treehouse semantic calls to
the Worker and retires `authority.ts`, `capability.ts`, `policy.ts`, `quarantine.ts`, `materialize.ts`
and the per-domain TS mirrors from the Treehouse path, shrinks the vector corpus to a smoke, and
deletes or re-derives `compaction_spike.ex`. **CONDITIONAL** as above. **NO-GO** → the index records a
freeze: no new TypeScript semantic module without an operator decision, and plan 188 carries
`authority.ts` in lockstep.

**Verify**: the doc exists, every threshold row has a measured value, and the verdict line is one of
GO / CONDITIONAL / NO-GO with a date.

### Step 8: Index

Update `plans/README.md` row 185 in one line with the verdict and the decision doc path.

## Test plan

- `apps/lattice_popcorn_spike`: existing `browser/test`, `npm test`, `e2e:replicas` stay green; new
  `e2e:vectors` harness.
- Treehouse shell: `npm test` and the bundle classifier prove the ordinary build is untouched.
- No change to the core suite is expected; run it once to confirm the shared-set extension did not
  require a core edit (it must not; see STOP).

## Done criteria

- [ ] `docs/research/one_judge_runtime_spike.md` exists with filled tables and a dated verdict
- [ ] `apps/lattice_popcorn_spike/evidence/vectors.json` exists and matches the doc's summary
- [ ] `grep -c -i popcorn clients/treehouse-tauri-shell/dist/assets/*.js` → `0` for the ordinary build
- [ ] `tsx test/packaged_bundle_variant.ts` passes; `npm test` in the Treehouse shell passes
- [ ] `git diff --stat` touches only in-scope paths
- [ ] `plans/README.md` row 185 is one line with the verdict

## STOP conditions

- A core module needed by the vectors fails to compile under the browser toolchain with a hard error.
  Record the module and error; do not patch core.
- Ed25519 `:crypto.verify/5` is unavailable or returns different results in the Worker for any vector
  signature (the canonical run would show it): record and stop; that is a runtime-equivalence finding.
- Any vector mismatch: do not "fix" either implementation. Record the scenario and both verdicts; the
  mismatch is itself the decision input.
- Tauri cannot deliver COOP/COEP on macOS and Popcorn requires `SharedArrayBuffer`: record and stop
  (NO-GO on the header criterion).
- You are tempted to change `tauri.conf.json`, `authority.ts` or anything in `apps/lattice_core/lib`.

## Maintenance notes

- The follow-on build plan (not written here) must also decide the async seam: the shell's
  `syncCarrierOnce` and `authorTreehouseCommand` call sites become Worker round-trips.
- The compiler split (OTP 29 / Elixir 1.20 for the browser vs 28 / 1.19 for the server) is a standing
  cost; if GO, align the server toolchain or pin the browser one in `.tool-versions` at the root.
- `popcorn-spike.yml` is path-filtered on `apps/lattice_core/**`; it will run on the shared-set change.

## Execution record (2026-10-08)

- Executed by an Opus executor in an isolated worktree; the reviewer overrode the step 3 STOP so steps
  4–6 could still be measured, then integrated eight commits onto `claude/round6-plans-182-185`.
- Decision record: `docs/research/one_judge_runtime_spike.md`. Verdict **NO-GO (2026-10-08)**, on two
  independent blockers: (1) vector equality 63/68, the five refusals being the pre-existing
  `Lattice.Carrier.Wire` atom-vocabulary defect that also fails natively (now plan 190); (2) macOS
  WKWebView under Tauri 2.11.5 reports `crossOriginIsolated: true` but exposes no `SharedArrayBuffer`,
  which Popcorn 0.4.0-next.0 needs, so the runtime never boots in the Treehouse webview (the plan's
  header STOP in substance). Android: the debug APK, judge-spike and ordinary alike, panics in `wry`
  about 11 s after launch on the API 34 emulator (row 192); nothing measured there.
- Numbers that did land: Chromium cold start to first verdict median 999 ms; 4,004-op synthetic log
  judged in 7.9 s in-BEAM (about 1,974 µs per op, `Authority.analyze/2` dominating natively too);
  bundle 12,950,737 bytes raw / 5,591,179 compressed (under both thresholds); `'wasm-unsafe-eval'`
  suffices in isolated Chromium; Popcorn's JS-to-VM bridge drops single messages above about 64 KiB,
  so the spike sends chunks.
- The ordinary Treehouse build is byte-identical to the base build (no Popcorn, judge or collector
  strings; bundle classifier and shell `npm test` pass). Evidence files are committed under
  `apps/lattice_popcorn_spike/evidence/`.
- Operator decisions: approve plan 190; decide whether a `SharedArrayBuffer`-dependent judge runtime
  remains a desktop candidate (options in the record: a threadless Popcorn build, a WKWebView setting
  that exposes it, or a different desktop host).

