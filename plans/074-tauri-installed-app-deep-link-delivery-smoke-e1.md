# Plan 074: Tauri installed-app deep-link delivery smoke (E1)

## Status

DONE.

## Objective

Prove that the packaged Township Tauri app can receive an OS-delivered
`township://pairing` URL and load it into the same draft-only pairing handoff path, without saving,
syncing, connecting, or claiming trust.

## Scope

- Activate Tauri bundle packaging for the Township app.
- Add the local Tauri CLI and a `tauri:build` package script that builds the macOS `.app` bundle
  without requiring the DMG bundler.
- Add `tauri:deep-link:smoke`, a macOS installed-app smoke that:
  - builds the `.app` bundle,
  - verifies `Info.plist` registers `dev.treetop.lattice.township` and the `township` URL scheme,
  - launches the packaged app through `open` with explicit dev trace and deterministic key env,
  - sends a `township://pairing` URL through LaunchServices, and
  - waits for trace evidence that the raw URL arrived and the pairing handoff loaded.
- Make native dev tracing and explicit seeded dev key overrides available in release builds only
  when the corresponding env vars are set.
- Add the installed-app deep-link smoke to the named `app:convergence` gate.

## STOP Conditions

- If the smoke only checks static config and does not launch the packaged app, stop.
- If the deep link bypasses `parseTownshipPairingDeepLink` or the existing draft-only handoff path,
  stop.
- If a delivered deep link saves pairing config, syncs the outbox, opens a carrier session, or marks
  the peer trusted, stop.
- If production code logs secrets by default, stop. Dev tracing must be inert unless
  `TOWNSHIP_DEV_TRACE_FILE` is explicitly set.
- If this slice claims phone-grade mobile convergence, production multi-device LAN discovery, or W4
  receipt-freeness, stop.

## TDD Evidence

- RED: `cargo test --test runtime_bootstrap` failed because `bundle.active` was still false.
- RED: `npm run frontend:contract` failed because `tauri:build`,
  `tauri:deep-link:smoke`, `@tauri-apps/cli`, and the installed-app smoke file did not exist.
- RED/GREEN refinement: the first installed-app smoke built `Township.app` but failed when the
  default DMG bundler failed; `tauri:build` was narrowed to `tauri build --bundles app`.
- RED/GREEN refinement: the packaged app initially produced no release trace because dev tracing
  was compiled out in release; tracing is now runtime-gated by `TOWNSHIP_DEV_TRACE_FILE`.
- RED/GREEN refinement: the packaged app then hung in platform keyring setup; the smoke now supplies
  explicit deterministic dev key env and the release app honors those vars when present.
- GREEN: `tauri:deep-link:smoke` proves the packaged `.app` contains the `township` scheme, launches
  through `open`, receives a `township://pairing` URL through LaunchServices, and records
  `pairing-link-loaded:<fingerprint>` without save/sync/connect claims.

## Second Opinion

Claude Code was asked for a pre-review and post-review of this slice, but both CLI review prompts
produced no output after roughly 60 seconds and were interrupted. This is recorded as reviewer
unavailability, not as a GO.

## Verification

- `cd clients/township-tauri-shell/src-tauri && cargo test --test runtime_bootstrap`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npm run deeplink:contract`
- `cd clients/township-tauri-shell && npm run deeplink:source:contract`
- `cd clients/township-tauri-shell && npm run app:convergence`
- `cd clients/township-tauri-shell/src-tauri && cargo test --test native_commands`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell && npm run tauri:deep-link:smoke`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `cd clients/township-tauri-shell/src-tauri && cargo check --bin township-tauri-shell`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`
- `git diff --check`

## Remaining Work

- Phone-grade Tauri-mobile or Expo convergence smoke remains open.
- Plan 075 added the advertiser command; a physical multi-device LAN discovery smoke remains open.
- W4 receipt-freeness remains blocked on the M4 primitive.
