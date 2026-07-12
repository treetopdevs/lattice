# Plan 131: Packaged macOS convergence CI gate (toward G1)

## Status

IN PROGRESS

## Objective

Make the already-passing packaged macOS stable-relay onboarding and LiveView-to-Tauri action
handoff proofs mandatory in GitHub Actions. The required job must build and launch the actual
`Township.app` bundle on a GitHub-hosted macOS runner, exercise native key/KV custody and
LaunchServices routing, converge through the production stable relay, and compare the result with
the existing `Lattice.Sim` oracle.

This is CI enforcement for existing Plans 129 and 130 behavior. It adds no new Township capability,
but closes the gap between a locally required packaged proof and the repository rule that a claim is
trusted only when its gate runs in CI.

## Why this increment

- Plan 129 proved packaged native-custody onboarding through the stable relay, and Plan 130 proved
  packaged LaunchServices action handoff through the same path. Both smokes currently pass only
  when a developer runs `app:convergence` on macOS.
- The Ubuntu flagship action-handoff gate uses the built web surface with a native IPC test seam. It
  cannot prove an app bundle, WKWebView process, native command registration, native KV/key custody,
  or LaunchServices delivery.
- Server push and broader participant controls both build on this packaged foundation. Guarding it
  first prevents later feature work from expanding an unprotected native surface.
- Production deployment remains downstream of a usable, CI-guarded participant loop. Receipt-free
  W4 remains blocked on the named M4 research verdict.

GitHub's current standard hosted-runner inventory exposes `macos-15-intel`; use that pinned label
rather than the retiring `macos-14` image or a moving `macos-latest` alias. The Intel image also
keeps the setup-beam path on the established x64 build lane. Runner availability and real GUI app
launch are feasibility conditions, not assumptions.

## Required vertical gate

Add a non-optional `packaged_macos` job to `.github/workflows/flagship.yml` that:

1. runs on `macos-15-intel` with a bounded timeout and no `continue-on-error`;
2. checks out without persisted credentials and installs the pinned OTP 28.1, Elixir 1.19.5, and
   Node 22 toolchains;
3. caches Cargo registry/build state, installs root, TS-client, and Tauri-shell dependencies from
   their lockfiles, and rebuilds the client's exported `dist` before the shell packages its file dependency;
4. compiles the umbrella in `MIX_ENV=test` so the BEAM support processes have real ebin paths;
5. installs the pinned esbuild binary needed by the action smoke's cold `assets.build` step;
6. installs the shell's pinned Playwright Chromium build;
7. runs `tauri:stable-relay:onboarding:smoke`; and
8. runs `tauri:action-handoff:smoke` without `TOWNSHIP_SKIP_ACTION_APP_BUILD=1`.

Both commands must execute their existing Darwin-only assertions against a freshly built real app
bundle and exit successfully. The workflow itself must be protected by a repository test that
asserts the macOS runner, both smoke commands, the real-build path, and the absence of soft-failure
configuration. A text-only workflow check is not the feasibility proof: the hosted CI job must also
finish green before this plan can be marked done.

Use a 75-minute hard timeout for the two release-mode Tauri builds. The second build reuses Cargo
artifacts from the first, but a cold Intel runner remains the long pole; the timeout is a failure
bound, not a performance claim. The job caches Cargo registry and target state with the repository's
already-pinned `actions/cache` revision. Standard hosted runners are free for this public repository,
while the higher macOS billing multiplier would matter if the repository becomes private.

## Trust and oracle invariants

1. The stable-relay onboarding smoke remains the Plan 129 proof: pulled capability evidence,
   persisted pairing/cap state, native signing, acknowledged-only outbox drain, restart durability,
   and a fresh observer matching Sim.
2. The action-handoff smoke remains the Plan 130 proof: real LiveView-produced unsigned intent,
   inert LaunchServices ingress, native-gated explicit accept/post/sync, exact Sim operation and
   projection equality, redacted trace/KV evidence, and restart recovery.
3. CI may configure deterministic fixture identities and isolated temporary paths, but it may not
   replace native signing, native KV, the actual bundle, LaunchServices, the stable carrier server,
   the real projection, or the Sim oracle.
4. A platform skip, prebuilt stale bundle, mocked native IPC surface, or green text-contract alone
   is not a packaged convergence result.

## Public TDD seams

1. `LatticeCarrierServer.PlanContractTest`: fail while no required `packaged_macos` job exists;
   then pin its runner, commands, hard-failure posture, and honest non-claims.
2. `.github/workflows/flagship.yml`: the only production change, adding the real hosted macOS job.
3. The existing package scripts
   `tauri:stable-relay:onboarding:smoke` and `tauri:action-handoff:smoke`: executable acceptance
   boundaries whose assertions must not be weakened to satisfy CI.
4. Plan/build-map/status documentation: distinguish CI enforcement from new product behavior and
   keep server push, broader controls, deployment, mobile/device work, Phase G, and W4 open.

## Scope

- `.github/workflows/flagship.yml`
- `apps/lattice_carrier_server/test/plan_contract_test.exs`
- this Plan 131 file and the plan/build-map/status documentation needed to make the CI claim honest
- package or smoke support only if the first hosted run exposes a real setup-beam, runner, or GUI
  lifecycle incompatibility; any such change must preserve the existing local proof
- the existing Ubuntu native-core job's Tauri Linux system prerequisites if the hosted run proves
  its real-Wry tests cannot compile on the bare runner; this remains environment repair, not product scope

## Non-goals

- No new carrier message, subscription, notification, or server-push protocol.
- No broader post/summary/title/member/grant/revoke/vouch participant control.
- No participant key, capability, dependency, or semantic-authority movement into Phoenix or the
  carrier server.
- No secure-store implementation change, mobile claim, Android/iOS/device/camera/LAN/cross-device
  probe, or change to the mobile secure-store strategy.
- No TLS, DNS, public ingress, backup, database, multi-writer transaction, release signing,
  notarization, or production deployment claim.
- No G1/Phase G completion and no receipt-free W4 claim.

## STOP conditions

- Stop if the hosted runner cannot launch the real WKWebView app and receive LaunchServices input;
  do not replace that boundary with a browser or mocked IPC proof.
- Stop if green requires `continue-on-error`, a platform skip, `TOWNSHIP_SKIP_ACTION_APP_BUILD=1`,
  a stale/prebuilt app artifact, removal of native-custody assertions, or a weaker oracle comparison.
- Stop if the job cannot use a standard GitHub-hosted runner and would silently require an
  unavailable paid larger or self-hosted runner; record the feasibility result before reprioritizing
  server push.
- Stop if CI logs expose fixture seeds, action URLs, post text, private key material, or native KV
  values that the current smokes require to remain redacted.
- Stop if this enforcement-only increment is relabeled as server push, deployment, complete G1,
  complete Phase G, a mobile/device result, or receipt-free W4.

## TDD plan

1. **Workflow contract RED.** Add the Plan 131 test first. Observe it fail because
   `.github/workflows/flagship.yml` has no `packaged_macos` job.
2. **Static workflow GREEN.** Add the smallest complete macOS job and make the focused ExUnit
   contract pass. Validate YAML syntax and action pins without changing either packaged smoke.
3. **Hosted feasibility RED/GREEN.** Commit and push the workflow, observe the actual GitHub-hosted
   run, and treat its first native/toolchain/GUI failure as the next red. Fix only evidenced setup or
   lifecycle defects without weakening the gate, then rerun until both packaged smokes are green.
4. **Documentation contract RED/GREEN.** Advance Plan 131 and cumulative status claims only after
   the hosted job is green; retain every capability non-claim above.
5. **Full verification.** Re-run the two packaged smokes locally, focused plan contracts, format,
   full pinned-OTP `mix verify`/`mix check`, and an exact-diff Claude review. Confirm the pushed
   workflow run is green at the final commit.

## Second opinion

Claude Code Opus reviewed the clean Plan 130 frontier read-only and returned `PROCEED`. It ranked
macOS CI enforcement ahead of server push because the actual packaged binary, native custody, and
LaunchServices proof is the only claimed Plan 129/130 lane still outside CI. It required both
packaged smokes on a real macOS runner, no soft-failure or build-skip escape, and a static anti-decay
contract, with hosted GUI launch treated as a feasibility gate.

The live runner audit tightened Claude's suggested `macos-14` label to `macos-15-intel`: GitHub's
current image inventory has begun macOS 14 retirement, while the standard macOS 15 Intel image has
the required Xcode and Rust floor and retains the established x64 setup-beam lane.

Claude then reviewed this exact written plan, RED contract, both smoke bodies, the BEAM support
harness, Cargo manifest, and asset pipeline and returned `PROCEED`. It confirmed the RED fails only
on the missing workflow job and that the smokes may run sequentially, provided CI compiles
`MIX_ENV=test` before the stable-relay smoke. Its material finding was that a cold action-handoff run
would fail because `mix assets.build` does not install esbuild; the required job now installs the
pinned esbuild binary explicitly. Its initial claim that root `npm ci` was unnecessary was later
falsified by the first hosted run and is corrected below.

Claude's pre-push implementation review returned `REVISE` because it believed a clean checkout had
no built lattice-client export and would fail ESM loading before either smoke. Live `git ls-files`
inspection showed `dist/src/index.js` and the client distribution are tracked, so the predicted
missing-file crash was not literally present. The recommended explicit client build is still
load-bearing for source fidelity: it runs before the shell's file dependency is installed, ensuring
the packaged smoke consumes current TypeScript output rather than trusting a potentially stale
generated tree. The workflow also adopts Claude's non-blocking Cargo-cache hardening. The official
runner inventory confirms `macos-15-intel` is a standard hosted label, and the repository's main
branch currently has no required-check protection that could be stranded by the feasibility run.

Claude's focused follow-up returned `PROCEED` with no remaining blocker, high, or medium finding
before the hosted push. It verified the cache is scoped to `packaged_macos`, the client build precedes
the shell file-dependency install, the cold BEAM/esbuild prerequisites are present, both no-skip
protections remain contract-pinned, and this plan still withholds completion pending real hosted
WKWebView and LaunchServices execution.

The first hosted run exposed a separate existing RED in the Ubuntu unit job: `cargo test` failed in
`glib-sys` and `gobject-sys` because the bare runner lacked their pkg-config development libraries.
Claude inspected the native tests and returned `PROCEED` on installing Tauri's official Ubuntu
prerequisite set. The tests intentionally bootstrap the real Wry runtime, so removing Tauri default
features or rewriting them onto a mock would weaken the established native-core gate. Provisioning
the system libraries adds no Linux package, GUI launch, carrier convergence, mobile, Phase G, or W4
claim; it only lets the existing compile-and-logic test execute as written.

Hosted run `29180508051` then passed the entire macOS setup and the real packaged stable-relay
onboarding smoke. The action-handoff smoke failed before LaunchServices because its real Phoenix
`mix assets.build` could not resolve root-owned `vue` and `@dagrejs/dagre`; the packaged job had not
created root `node_modules`. Claude's focused correction returned `PROCEED`: root `npm ci` is the
smallest honest fix, the existing esbuild working directory resolves those dependencies by walking
up to the repository root, and no `NODE_PATH` or bundling change is needed. The root lockfile now
participates in setup-node's cache key, and root install precedes both smokes. The stable-relay pass
is evidence that hosted app launch and native-custody onboarding are feasible; action handoff
remains unproven in CI until the corrected run reaches and passes its full boundary.

An implementation review remains required before completion.

## Verification

Pending TDD and hosted CI execution.

## Completion claim

Not complete while the required packaged macOS job is absent or has not passed on the pushed
workflow revision.
