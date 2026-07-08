# Plan 052: Tauri outbox ack compaction (E1)

## Status

DONE.

## Objective

Make the Tauri shell's carrier-frame outbox a pending-only queue by compacting frames that a
carrier peer already knows or accepts, without deleting the carrier-frame delegation evidence used
for local cap selection.

Planned at commit `ee6f56c`.

## Scope

- Split the shell workflow's frame storage responsibilities:
  - delegation evidence frames are retained for `carrierDelegationsFromFrames` and action
    availability,
  - carrier outbox frames are the pending frames to push.
- Update the authoring path so newly authored command frames append to the pending outbox while
  delegation lookup reads the evidence store.
- Update sync so accepted or already-peer-known outbox frames are removed after a successful sync.
- Preserve outbox frames that the carrier reports as `pending`, `quarantined`, or `rejected`.
- Keep production onboarding/cap issuance, mobile secure-store changes, and Tauri/Expo app
  convergence out of scope.

## TDD Plan

1. RED: update shell action tests to seed delegation evidence separately from the pending outbox and
   expect only newly authored local command frames in the outbox.
2. RED: update sync tests to prove accepted and already-peer-known outbox frames are compacted, while
   pending/quarantined/rejected frames remain.
3. GREEN: add the explicit delegation-evidence store to the native workflow and route cap selection
   through it.
4. GREEN: expose carrier-sync acknowledgement metadata and use it to save the compacted outbox.
5. VERIFY: run the focused shell/client contracts first, then Rust checks, umbrella Mix checks with
   `PATH="$HOME/.asdf/shims:$PATH"`, Sobelow, and `git diff --check`.

## TDD Evidence

- RED: `npm run action:contract` failed because `TOWNSHIP_DELEGATION_FRAMES_KEY` did not exist
  after the test split delegation evidence from the pending outbox.
- RED: `npm run sync:contract` failed on the same missing delegation-frame store before the sync
  compaction implementation existed.
- GREEN: `TownshipNativeWorkflow` now exposes `delegationFrames`; action availability and command
  submission use delegation evidence for cap selection while newly authored command frames append
  only to the pending outbox.
- GREEN: `syncCarrierOnce` reports `acknowledgedFrameIds`, and `syncTownshipOutbox` saves merged
  delegation evidence while removing accepted or already-peer-known frames from the pending outbox.
- COVERAGE: sync tests prove accepted and peer-known frames compact to an empty outbox in the W1
  fixture, and a partial-ack client proves pending/quarantined/rejected frames remain.
- RED: after Claude Code review, `npm run action:contract` failed on the legacy-upgrade case where
  `delegation_frames` is empty but pre-052 `carrier_frames` still contains local delegation
  evidence.
- GREEN: action availability and shared command authoring now fall back to legacy
  `carrier_frames` only when `delegation_frames` is empty.
- COVERAGE: sync tests now include a single mixed report with peer-known, accepted, quarantined,
  rejected, and pending frame ids to prove only acknowledged frames compact.

## Second Opinion

- Claude Code requested before implementation: blocked locally with `Not logged in · Please run /login`.
- After interactive `/login` OAuth, Claude Code reviewed the implemented diff in the PTY and judged
  "DONE is justified."
- Claude's actionable caveats were a legacy `carrier_frames` fallback for pre-052 local stores and a
  combined peer-known/accepted/quarantined/rejected/pending sync test; both were implemented before
  this plan remained DONE.
- Claude's remaining caveats are non-blocking for this slice: total persisted delegation-evidence
  bytes still grow, and the local-log/delegation/outbox saves are separate idempotent writes.

## Verification

All BEAM commands below were run with `PATH="$HOME/.asdf/shims:$PATH"` and explicit
`~/.asdf/shims/mix` where applicable, to avoid the local Homebrew/mise Erlang collision.

- `~/.asdf/shims/mix --version` -> Mix 1.19.5 on Erlang/OTP 28.
- `cd clients/lattice-client && npm run typecheck`
- `cd clients/lattice-client && npm run build`
- `cd clients/lattice-client && npm run township:authoring`
- `cd clients/lattice-client && npm run carrier:township:live`
- `cd clients/lattice-client && npm run tauri:bridge`
- `cd clients/lattice-client && npm run conformance`
- `cd clients/lattice-client && npm run canonical`
- `cd clients/lattice-client && npm run carrier:township`
- `cd clients/township-tauri-shell && npm run action:contract`
- `cd clients/township-tauri-shell && npm run sync:contract`
- `cd clients/township-tauri-shell && npm run live:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run build`
- `cd clients/township-tauri-shell && npm run native:contract`
- `cd clients/township-tauri-shell && npm run peer:contract`
- `cd clients/township-tauri-shell && npm run tauri:launch:smoke`
- `cd clients/township-tauri-shell/src-tauri && cargo fmt --check`
- `cd clients/township-tauri-shell/src-tauri && cargo check`
- `cd clients/township-tauri-shell/src-tauri && cargo test`
- `~/.asdf/shims/mix format --check-formatted`
- `~/.asdf/shims/mix check`
- `cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit`

## Remaining Work

- Add production onboarding/cap issuance so newly generated device keys can receive delegations.
- Decide the mobile secure-store strategy before claiming phone-grade persistence.
- Converge the real Tauri/Expo app surfaces against the same BEAM realm.
