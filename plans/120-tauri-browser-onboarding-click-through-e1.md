# Plan 120: Tauri browser onboarding click-through (E1)

## Status

DONE

## Objective

Drive the ordinary production Vue bundle through the resident onboarding
controls and prove that a successful carrier pull refreshes the displayed cap
availability before the resident authors and syncs a post.

Pair this control-surface proof with Plan 119's packaged-runtime proof without
claiming that Chromium plus mocked IPC is a packaged WKWebView click-through.

## Scope

- Add `onboarding:click-through` as a headless Playwright test of the built
  `dist` bundle.
- Inject Tauri's public JavaScript transport seam: set `globalThis.isTauri`
  and implement `window.__TAURI_INTERNALS__.invoke`.
- Back every native invocation with one shared in-memory KV store and one
  deterministic Ed25519 signer.
- Start `LatticeNodeSpike.TownshipOnboardingScenario` as the real BEAM carrier
  peer and import its public pairing handoff through the rendered controls.
- Require the resident to fill the local realm omitted from the public
  handoff, explicitly confirm the imported pairing, and prove an unchecked
  save does not persist it.
- Pin the mount-hydration ordering by observing `Post / No local cap` before
  the first sync.
- Prove a successful pull refreshes the Post action to `Available`.
- Author and push a post through the rendered controls, require an empty
  default-namespaced outbox, and query the live peer for the post and empty
  authority quarantine.
- Assert the native signer seam was invoked and private seed material never
  entered the shared KV store.

## Non-Goals

This does not prove packaged WKWebView rendering or controls.
It does not use the real Rust signer or native KV implementation.
It does not prove human click-through, mobile or physical-device behavior,
cross-device exchange, iOS/Expo, QR camera onboarding, LAN discovery, or
production remote TLS.
It does not refresh availability immediately after a local unsynced revoke.

## STOP Conditions

- Stop if the test enables dev-trace onboarding or autosync-on-mount.
- Stop if native workflows receive separate mock KV stores.
- Stop if the pre-sync hydrated `Post / No local cap` checkpoint is omitted;
  without it, the one-second mount timer makes the RED racy.
- Stop if a BEAM startup, transport, or scenario-authority failure is reported
  as the stale-cap RED.
- Stop if docs call this a packaged-GUI, real-native-signer, human, or mobile
  click-through proof.

## TDD Evidence

- RED: after the rendered controls import, confirm, and save the pairing, the
  first successful sync persists the resident delegation but the Post action
  remains `No local cap` because `App.vue` retains its mount-time availability
  snapshot.
- GREEN: on successful sync only, reload action availability from the shared
  native store, mirroring the existing post-grant refresh. The same rendered
  control path then authors and pushes the post, drains the outbox, and observes
  the post with empty authority quarantine on the live BEAM peer.

## Second Opinion

Claude Code selected a rendered-DOM click-through as the next honest slice
after macOS accessibility inspection showed that packaged WKWebView controls
are absent from the accessibility tree. On refinement, Claude required the
pre-sync hydration checkpoint, one shared mock KV store, live-BEAM failure
separation, and explicit native/package non-claims. With those corrections it
returned `PROCEED` and agreed that the minimum GREEN is a successful-sync-only
availability reload.

## Verification

- `npm --prefix clients/township-tauri-shell run onboarding:click-through`
- `npm --prefix clients/township-tauri-shell run frontend:contract`
- `npm --prefix clients/township-tauri-shell run mobile:strategy`
- `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness`
- `npm --prefix clients/township-tauri-shell run app:convergence`
- `npm --prefix clients/township-tauri-shell run typecheck`
- `~/.asdf/shims/mix verify`
