# Plan 134: Reactive packaged Tauri availability feed (toward G1)

## Status

DONE

## Objective

Turn the direct TypeScript availability substrate from Plan 133 into a verified, reactive feed in
the actual Vue/Tauri application. A saved carrier pairing must establish one authenticated
subscription, perform an initial verified read-only refresh, coalesce later hints into one active
refresh plus one latest trailing refresh, recover across same-path server restart, and update the
rendered Township matter from the verified local projection.

Reactive refresh never submits or compacts the authored outbox. Post and Sync remain separate,
explicit participant controls. Every pulled frame is verified before conversion or persistence.

The increment must be proved in the packaged macOS app against the real stable
`LatticeCarrierServer`, with `Lattice.Sim` as the independent oracle. A headless controller test is
necessary but insufficient.

## Why this increment

- Plan 133 added typed direct-TypeScript availability subscriptions and a real stable-server gate,
  but explicitly deferred a persistent Vue/Tauri consumer and packaged lifecycle proof.
- `syncTownshipOutbox/1` is the wrong hint callback. It advertises, pulls, pushes or relays authored
  frames, acknowledges accepted frames, and compacts the carrier outbox. Calling it automatically
  would erase Plan 130's explicit Post then Sync ceremony.
- The current shared `syncCarrierOnce/5` converts pulled frames to semantic operations before any
  app-side canonical hash or Ed25519 signature verification. The existing headless Plan 133 gate
  verifies out of band, but the production app path does not. Reactive materialization cannot ship
  on that seam.
- `App.vue` renders `townshipPreview()` over a fixed fixture. Persisting a refreshed local log alone
  would not make app convergence observable and would produce a tautological packaged proof.
- The stable relay, Sim fixture, native key/KV seams, dev-trace packaged harness, and mandatory
  macOS job already provide the prerequisites for one real vertical increment.

## Scope

### Included

1. Required pulled-frame verification in `syncCarrierOnce/5`: canonical hash and Ed25519 signature
   verification must complete for every pulled frame before semantic conversion, integration,
   submission, or caller persistence.
2. A verified read-only Township refresh that pulls missing frames, verifies all of them, integrates
   and persists the local read log/cap evidence, and returns a materialized preview without reading,
   submitting, acknowledging, compacting, or writing the authored carrier outbox.
3. A `TownshipFeedController` with one preallocated worker epoch, one active client/subscription,
   one refresh in flight, one latest trailing availability, bounded reconnect/backoff, pairing
   replacement, and explicit stop.
4. An initial refresh from the subscription baseline. A client that starts after the durable change
   must converge without waiting for another hint.
5. Vue wiring that renders the verified local projection and exposes connecting, refreshing, fresh,
   reconnecting, unavailable, and unconfigured feed states while retaining the last verified
   projection during reconnect.
6. A deterministic controller/read-refresh contract covering verification failure, no-write
   invariants, coalescing, reconnect, pairing replacement, and teardown.
7. A real packaged macOS smoke proving initial convergence, first pushed generation, rendered
   Sim-equal state, no automatic outbox submission, same-path restart replacement, and a second
   pushed generation.
8. Hard hosted CI wiring plus cumulative Plan 134 documentation contracts.

The manual Sync path is deliberately co-scoped for verification hardening. Reactive refresh does
not call `syncCarrierOnce/5`, but leaving the adjacent explicit Sync control able to materialize an
unverified pull would preserve the same prime-directive violation in the real app. Requiring its
operation verifier is an intentional security boundary change, not incidental cleanup.

### Explicitly deferred

- Any automatic push, relay, outbox acknowledgement, or outbox compaction. The user still invokes
  the existing Sync control to publish locally authored frames.
- Any participant-key, capability-authoring, pairing-import, onboarding, or native-storage custody
  redesign. Existing saved public pairing state and native signing commands are reused unchanged.
- No mobile secure-store implementation change and no new Android, iOS, emulator, or physical-device
  probe. The parked-area rule in `TOWNSHIP_BUILD_MAP.md` remains in force.
- No server protocol or holder behavior change, pushed operation/state materialization, diagnostic
  frontier reconciliation, broader participant controls, production ingress/TLS/deployment or
  notarization.
- No complete G1/Phase G claim and no receipt-free W4 claim.

## Public seams

### Verified shared sync

`clients/lattice-client/src/carrier.ts` changes `SyncCarrierOptions` so a `Verifier` is required:

```ts
export interface SyncCarrierOptions {
  verifier: Verifier;
  submission?: CarrierSubmission;
}
```

`syncCarrierOnce/5` has no unverified fallback. It structurally decodes each pulled frame, calls
`verifyCarrierOp/2`, and rejects the entire sync on the first invalid hash or signature before
`carrierOpsToSemanticOps`, `integrate`, or any push/relay call. All repository callers must make the
verification decision explicit. Validly signed but semantically unauthorized operations still flow
to the existing materializer and authority quarantine; cryptographic verification does not replace
capability or reducer authority.

This is the operation `Verifier` from `identity.ts`, whose author argument is the frame's base64
public key. It is distinct from the `CarrierVerifier` used for session authentication, whose public
key argument is already decoded bytes. Shell callers adapt the same WebCrypto/noble Ed25519
implementation to both shapes. The runtime `carrier.ts` to `codec.ts` import is intentional;
`codec.ts` imports carrier frame types only, so no value is read during module initialization.

### Read-only Township refresh

`clients/township-tauri-shell/src/township_feed.ts` adds:

```ts
export async function refreshTownshipFromCarrier(
  options: RefreshTownshipFromCarrierOptions,
): Promise<TownshipFeedProjection>;

export function createTownshipFeedController(
  options: CreateTownshipFeedControllerOptions,
): TownshipFeedController;
```

The refresh accepts an already authenticated feed client and native workflow. It loads only the
local semantic log and pulled delegation evidence, calls `pull(localOpIds)`, verifies every returned
frame, integrates the verified operations, persists the read log and merged delegation frames, and
materializes `TownshipMatterPreview`. It must not call `advertise`, `push`, `relay`,
`syncTownshipOutbox`, or any carrier-outbox load/save method.

The operation verifier uses the pulled frame's base64 Ed25519 author key only to verify the
canonical signed bytes. Semantic authority remains reducer/capability work after verification.

### Feed controller

The controller owns an opaque worker epoch before asynchronous connection starts. Its public
lifecycle and state-delivery seam are:

```ts
export type TownshipFeedState =
  | { phase: "unconfigured"; projection: null; message: string }
  | {
      phase: "connecting" | "refreshing" | "reconnecting" | "unavailable";
      projection: TownshipFeedProjection | null;
      message: string;
    }
  | { phase: "fresh"; projection: TownshipFeedProjection; message: string };

export interface CreateTownshipFeedControllerOptions {
  onState(state: TownshipFeedState): void;
  // The connection/session factory and abortable sleep are injectable test seams.
}

export interface TownshipFeedController {
  replacePeer(peer: TownshipCarrierPeerConfig | null): Promise<void>;
  stop(): Promise<void>;
}
```

`replacePeer/1` closes and awaits the old worker before starting a different pairing. A late connect
result from an obsolete epoch is closed and cannot publish. `stop/0` aborts backoff, closes the
client/subscription, waits for the in-flight refresh to settle, discards any trailing availability,
and prevents later state callbacks.

`onState` is ordered per worker epoch. The controller emits connecting before opening, refreshing
with the last verified projection (if any), fresh only after verified refresh succeeds, and
reconnecting/unavailable while retaining that last verified projection. Once replacement or stop
invalidates an epoch, that epoch may emit nothing further. The callback is the only path by which
the controller publishes a projection to Vue, so lifecycle tests can observe every state transition
without reaching into controller internals.

For each live session, a notification pump continuously receives typed availability values while a
separate drain owns the refresh. The baseline is enqueued first. While one refresh runs, newer hints
overwrite one nullable trailing availability; intermediate generations do not allocate work. A
refresh failure closes the session and enters bounded reconnect. The highest verified projection is
retained and labeled reconnecting rather than replaced by unverified/stale input.

Reconnect delay grows through a fixed finite sequence and caps at five seconds. There is one timer,
one worker, one subscription, one refresh, and one trailing availability per controller. Stop,
pairing replacement, and reconnect never send `unsubscribe` or another control request while a
refresh pull occupies the client's one atomic request slot; they close the client, await the worker
and refresh, then open the replacement session.

### Vue projection

`townshipPreviewFromOps/1` materializes the same `TownshipMatterPreview` shape from verified local
operations. `App.vue` starts from the current static browser-preview fallback, then replaces it only
with a controller `fresh` projection. The visible feed status carries stable data attributes for
phase, generation, op count, and post count. A dev-trace build records those attributes after
`nextTick`, so the packaged smoke proves the rendered Vue DOM changed, not merely that KV was
written.

The trace hook reads the committed DOM with `document.querySelector`, `getAttribute`,
`document.querySelectorAll`, and `textContent` after `nextTick`; it does not format a trace from the
same reactive state it is meant to prove. In particular, it reads the primary matter status and
visible proceedings rows, not only the feed-status strip. It records ordered DOM-derived SHA-256
digests of those row values, never raw proceedings content. The packaged smoke independently hashes
the Sim read-model posts with Node crypto and compares the ordered digests. The headless
`township_feed.ts` contract tests the pure preview and controller behavior. Existing source
contracts pin App.vue wiring. Actual rendered evidence belongs exclusively to the real packaged
smoke; this plan adds no jsdom, happy-dom, or Vue test-utils dependency.

Saving a different pairing replaces the feed. Unmount stops it. Existing onboarding, action intent,
Post, Sync, health, cap, and mobile paths keep their explicit controls and storage boundaries.

## Verification and no-write invariants

- Hash or signature failure rejects the complete refresh. No pulled operation, delegation frame, or
  preview is saved or published.
- The controller never feeds `frontier` or `frontierTruncated` into pull or materialization.
- Read refresh may save verified pulled semantic operations and delegation/cap evidence. It may not
  load or save `TOWNSHIP_CARRIER_OUTBOX_KEY` and may not submit any operation.
- A hint is only a wakeup. The rendered projection changes only after a successful verified pull,
  integration, persistence, and materialization.
- The app's native signer is used for carrier-session authentication only. Feed refresh does not
  author an operation or invoke the explicit Sync action.
- Pairing replacement and unmount cannot allow an obsolete worker to persist or render a later
  result.

## Real packaged-app gate

Add `clients/township-tauri-shell/test/tauri_carrier_feed_smoke.ts`. It builds and launches the real
dev-trace `Township.app` with an isolated native KV file, observer native key seed, and saved
stable-server pairing. It reuses `stable_relay_fixture.exs`, fixed-port
`spawnStableCarrierServer`, and separate identities: the packaged app authenticates only as the
read-only observer while the external resident identity alone exercises relay.

The gate must prove:

1. On first mount, the subscription baseline causes a verified pull and the rendered Vue matter
   reaches the Sim base projection without a Sync action. The shared fixture adds a `base`
   projection beside `afterPost` and `afterRestartPost`; all three carry Sim-derived op ids,
   read-model posts, and causal replay.
2. External relay of `expectedPost` emits a newer hint; the app automatically pulls and the rendered
   generation/op/post attributes, primary matter op count, ordered DOM-derived SHA-256 proceedings
   digests, and persisted local ids equal the Sim `afterPost` oracle. The expected digests are
   independently computed from `readModel.threads.posts`, not from a count recomputed by the smoke
   or a hidden `data-posts` serialization, and raw proceedings content never enters native trace.
3. Trace and KV evidence show no automatic `TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED`, no authored frame,
   and no outbox compaction or mutation.
4. Killing the server labels the last verified projection reconnecting/stale without replacing its
   values. A same-path/fixed-port restart replaces the old subscription. The smoke records the
   reconnecting trace index and requires the otherwise byte-identical post-restart `fresh`
   projection at a strictly later index.
5. External relay of `expectedRestartPost` produces a second generation; rendered attributes and
   persisted ids equal `afterRestartPost` from Sim.
6. Quitting the app terminates the worker; no later trace update appears from the obsolete session.
7. Native observer key seed material remains absent from KV and trace output. The authored outbox
   remains absent or empty, no Sync trace appears, and no persisted operation is authored by the
   observer public key; session-handshake signing is not treated as participant authoring.

The gate may use dev-trace-only DOM introspection after Vue `nextTick`, but it must launch the real
packaged app and read actual rendered attributes plus DOM-derived SHA-256 commitments to the
proceedings text. The trace payload is produced from post-render
`document.querySelector(...).getAttribute(...)` and `document.querySelectorAll(...).textContent`
reads, then independently matched to hashes of the Sim oracle without recording raw content. A
headless module-only pass cannot satisfy this gate.

## Files

- `clients/lattice-client/src/carrier.ts` and generated `dist` output
- affected shared-client sync/live tests
- `clients/township-tauri-shell/src/township_feed.ts`
- `clients/township-tauri-shell/src/township_preview.ts`
- `clients/township-tauri-shell/src/App.vue`
- `clients/township-tauri-shell/test/township_feed.ts`
- `clients/township-tauri-shell/test/tauri_carrier_feed_smoke.ts`
- `clients/township-tauri-shell/test/support/stable_relay_fixture.exs`
- `clients/township-tauri-shell/package.json`
- `.github/workflows/flagship.yml`
- Plan 134 cumulative contract tests and status documentation

The headless controller contract runs in the hosted `Unit + property suite` after shell dependency
installation. The packaged smoke runs as a third hard step in `Packaged macOS convergence`. It is
also included in local `app:convergence`. Neither step may use `continue-on-error`, a platform skip,
a stale prebuilt bundle, mocked native IPC, or a headless substitute.

The packaged job moves to `timeout-minutes: 90`. Each of the three packaged smokes builds its own
fresh bundle with its required compile-time environment; this deliberately favors gate isolation
over sharing a possibly mismatched or stale app. The closure review must use observed hosted timing
to confirm adequate margin.

## Stop conditions

Stop and redesign if any is true:

- Feed refresh calls `syncTownshipOutbox`, `advertise`, `push`, or `relay`, or reads/writes/compacts
  the authored carrier outbox.
- A pulled frame is converted, integrated, persisted, or rendered before canonical hash and Ed25519
  signature verification succeeds.
- `syncCarrierOnce` retains an unverified fallback.
- A diagnostic/truncated frontier becomes pull or materialization input.
- More than one active subscription, refresh, reconnect timer, or latest trailing availability is
  retained per controller.
- Stop, reconnect, or pairing replacement issues a control request while refresh pull is in flight.
- An obsolete pairing/epoch can persist or render after replacement or unmount.
- The packaged proof checks only KV/trace setup and does not prove the rendered Vue projection
  changes to the Sim oracle.
- A feed DOM trace records raw proceedings or action content instead of ordered DOM-derived SHA-256
  digests.
- The implementation requires automatic authored-frame publication, custody/mobile/device work,
  broader controls, deployment, complete G1/Phase G, or W4.
- Reactive app feed code ships without the real packaged macOS gate in mandatory hosted CI.

## TDD plan

1. **Plan/public seam RED.** Add the Plan 134 contract and index row. Assert required verification,
   feed/controller exports, Vue rendering seam, headless and packaged scripts, hard CI steps, and
   unchanged non-claims; observe missing implementation.
2. **Verification RED.** Give `syncCarrierOnce` a pulled frame with a tampered id/signature and a
   push-capable fake. Prove the current implementation converts and may submit after the bad pull.
3. **Verification GREEN.** Require a `Verifier`, run `verifyCarrierOp` for every pulled frame before
   conversion, and prove invalid input rejects with zero push and valid signed fixtures remain
   Sim-equal. Update every repository caller explicitly.
4. **Read-only refresh RED/GREEN.** With fake workflow/client stores, prove a clean verified pull
   persists integrated read ops and cap evidence and returns a live preview, while tampered input
   leaves every store byte-identical. Assert zero advertise/push/relay/outbox access.
5. **Controller lifecycle RED/GREEN.** Prove baseline refresh, burst coalescing to current plus latest
   trailing generation, reconnect replacement, capped backoff, pairing replacement, late-connect
   discard, refresh failure, and stop/unmount teardown.
6. **Vue reactivity RED/GREEN.** Headless tests pin `townshipPreviewFromOps` and state delivery;
   source contracts pin feed data attributes, pairing replacement, unmount stop, and DOM-query trace
   wiring while preserving explicit Post/Sync. They do not claim a mounted Vue DOM.
7. **Packaged gate RED/GREEN.** Launch the app against the real stable server and prove base, first,
   reconnect, and second rendered Sim convergence with unchanged outbox and no Sync trace. This is
   the only gate that satisfies the post-`nextTick` rendered-DOM claim.
8. **CI/docs RED/GREEN.** Wire headless and packaged gates as hard steps; advance cumulative pins
   through 134 and update all status/non-claim surfaces.
9. **Regression.** Run all shared-client scripts, both typechecks, shell contracts and
   `app:convergence`, full pinned-OTP `mix verify`/`mix check`, warning compiles, xref, Sobelow,
   actionlint, and affected browser/package gates.
10. **Independent review.** Claude reviews each RED diagnosis, verification boundary, controller
    lifecycle, packaged oracle, final exact diff, stop conditions, and closure evidence.

## Independent scope review

Claude's read-only scope review returned `PROCEED TO PLAN`. It confirmed that automatic
`syncTownshipOutbox` would silently publish and compact participant-authored frames, that current
production pull materializes before app-side cryptographic verification, and that the static Vue
preview makes a storage-only proof insufficient. It classified operation verification as a blocker,
automatic write-capable sync as a high-risk design error, and reactive rendering plus a packaged
gate as required for an honest Plan 134.

Claude's exact-plan review returned `PROCEED TO TDD`. It required the explicit `onState` delivery
contract, DOM-sourced post-`nextTick` trace evidence, a Sim base/read-model oracle, deliberate
co-scoping of manual Sync verification, session-versus-operation verifier wording, serialized
control requests, and a fresh-build `timeout-minutes: 90` packaged strategy; those corrections are
folded into this plan before implementation.

## Local implementation evidence

Full local regression passed on 2026-07-12:

- The shared TypeScript client passes strict typecheck, build, Sim conformance, canonical parity,
  Township authoring, Tauri bridge, carrier vector, relay, relay-aware verified sync, direct feed,
  and real BEAM carrier scripts.
- The shell passes typecheck, 30 frontend contracts, native/action/Sync/direct-feed/reactive-feed
  contracts, the Rust native command core, and complete `app:convergence`. That cumulative app gate
  rebuilds and passes browser onboarding, live peer, native launch, generic packaged onboarding,
  stable-relay onboarding, packaged action handoff, the new packaged reactive feed, and installed
  deep-link delivery.
- The full regression caught and fixed five cross-feature assumptions through focused RED/GREEN
  slices: ordinal Sync status selectors, pre-reactive cap availability, expected reconnect console
  refusals, raw proceedings content in native DOM traces, and total-sign counters racing background
  carrier-session authentication. Claude reviewed every diagnosis and GREEN correction.
- The real packaged action and feed gates now pass together. Native trace records only ordered
  DOM-derived SHA-256 proceedings digests; the action URL/text/replica remain redacted while an
  independent Node digest of the Sim oracle still proves rendered proceedings equality.
- Pinned OTP 28 `mix verify` and `mix check` each pass 375 tests plus 25 properties. Forced test and
  production compiles pass with warnings as errors, xref retains the known five cycles, both HTTP
  boundary Sobelow scans exit zero, actionlint and `git diff --check` are clean, and the Rust core
  passes 23 native/runtime tests.
- Browser acceptance passes six static Township instrument cases, live carrier projection,
  stable-server restart, LiveView-to-app action handoff, shared browser carrier, and full flagship
  Worker/video/artifact verification.
- Final exact-worktree Claude review returned `PROCEED` with no blocker, high, or medium finding. It
  independently read the complete diff plus all untracked Plan 134 files, checked every stop
  condition, generated parity, the five regression fixes, CI executability, and all non-claims.

## Hosted implementation evidence

Hosted implementation run `29210581826` is green at
`bfe8bcf2c2d3e7276ba92922f6e991922992b1c2`:

- `Verify flagship artifact` completed in 3m28s.
- `Unit + property suite` completed in 4m34s, including the reactive controller and live stable
  carrier availability feed steps.
- `Packaged macOS convergence` completed in 8m16s. Its stable-relay onboarding, action handoff,
  and reactive carrier feed steps all passed without a skipped or soft-failed gate.

## Completion claim

Complete for this scoped increment. Required pulled-frame verification, the read-only refresh,
bounded controller lifecycle, rendered Vue projection, and the real packaged restart gate are
locally green; final exact-worktree independent review passed; and hard hosted CI is green. This
increment does not claim automatic authored-frame publication, custody/mobile changes, broader
controls, deployment, complete G1/Phase G, or receipt-free W4.
