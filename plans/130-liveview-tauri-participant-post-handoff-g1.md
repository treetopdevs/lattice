# Plan 130: LiveView-to-Tauri participant post handoff (toward G1)

## Status

DONE (2026-07-12)

## Objective

Add the first participant write control to the real `/township` instrument without giving Phoenix
participant keys, capabilities, delegation frames, operation dependencies, or authoring authority.
A fresh carrier-backed instrument prepares one versioned, unsigned `post` intent; the installed Tauri
app receives it as a review-only draft, validates it against the saved pairing, and uses its existing
native key, local delegation evidence, local frontier, and one-op relay path only after an explicit
participant action. The carrier projection must then observe the resulting operation and match the
`Lattice.Sim` oracle.

This is one vertical participant-post slice. It does not make Phoenix an operation author, add a
generic command bus, or complete all `/township` controls, server push, deployment, Phase G, or W4.

## Why this increment

- Plan 128 created a durable client-signs/server-relays producer and Plan 129 proved the packaged
  desktop app can use it through native custody and persisted capability evidence.
- The remaining product gap is that the `/township` participant cannot initiate even one civic
  action through that proven path; Plan 129's post begins in a test-only environment probe.
- A browser-to-installed-app custom-scheme handoff is same-host desktop behavior already exercised
  by the installed pairing smokes. It is not the parked cross-device, camera, LAN, iOS, or physical
  device work in `TOWNSHIP_BUILD_MAP.md` section 4a.
- Server-push delivery improves latency but is not a prerequisite: the existing honest pull
  projection can observe a relayed post without weakening custody.
- Production deployment remains downstream of a usable participant loop. Receipt-free W4 remains
  blocked on the named M4 research verdict.
- The current GitHub workflow does not enforce the packaged Plan 129 lane. This plan therefore puts
  its cross-surface correctness core in an Ubuntu-running flagship gate and records packaged macOS
  execution separately; a subsequent small CI-hardening plan must make the macOS lane non-optional.

Follow-up: Plan 131 now runs both the packaged stable-relay onboarding and action-handoff smokes as
a non-optional `macos-15-intel` flagship job. Plan 130's original completion claim remains scoped to
the local packaged proof available at that time; the current branch is CI-enforced.

## Critical trust separation

1. `/township` prepares an **unsigned request**, not an operation. It may hold public post text, a
   target replica, and an opaque intent id. It never receives or emits an author key, signature,
   capability id, delegation frame, dependency frontier, local realm, carrier credential, or
   authority verdict.
2. The Tauri app treats every deep link as untrusted input. Ingress can only load a reviewable draft;
   it cannot sign, persist an operation, enqueue an outbox frame, save pairing state, or contact the
   carrier.
3. Before authoring, the app requires the intent replica to equal the saved pairing replica. The app
   derives dependencies from its persisted local log, selects a matching capability from its local
   delegation frames, and signs with the existing native key command.
4. The stable carrier structurally verifies and durably relays the already-signed operation. Its
   transport key remains absent from operation authors, and it still makes no semantic authority
   decision.
5. `/township` never renders an optimistic post. The only authoritative result is the existing
   arrival-verified carrier projection reduced through `Township.ReadModel`; the terminal verifier
   compares that result with `Lattice.Sim`.

## Architecture

### Versioned unsigned action intent

Add `TownshipWeb.ActionIntent` as the server-side producer and a strict TypeScript decoder/listener
in the Tauri shell. The v1 payload has exactly this public shape:

```json
{
  "v": 1,
  "id": "32-lowercase-hex-characters",
  "replica": "replica:matter:...",
  "command": {"command": "post", "text": "resident text"}
}
```

The UTF-8 JSON is base64url encoded without padding in:

```text
township://action?intent=<payload>
```

Contract rules:

- `v` must be exactly `1`; unknown versions fail closed.
- The payload and nested command use exact-key allowlists; smuggled fields fail closed.
- `id` is a 128-bit random lowercase-hex correlation label. It is not signed, trusted, or included
  in the resulting operation and therefore is not an op-level idempotency guarantee.
- `replica` must be a present string within the bounded payload and must match the app's persisted
  carrier pairing before the draft can be submitted.
- v1 supports only `post`; text is trimmed, non-empty, and bounded by UTF-8 bytes before either side
  accepts it.
- No dependencies or capability hints cross the boundary. The app derives both from local evidence.
- The app must never write the complete action URL or post text to its development trace. It may
  trace the validated intent id and outcome only.

An unarmed action link is allowed to stage a pending request because staging has no signing,
persistence, local-draft replacement, or network side effect and still requires an explicit in-app
action. This differs intentionally from pairing ingress, whose one-shot armed state protects
configuration replacement. Malformed links, replica mismatches, and repeated delivery remain inert
and visibly rejected or review-only.

The action parser requires the exact `township://action` route and sole `intent` query parameter; it
fails closed for pairing, development-control, canonical-probe, and all unknown routes. Participant
action and pairing ingress use one shared subscription to the Tauri deep-link plugin and dispatch by
route before parsing or tracing. The existing Android-synthesized pairing URL reaches only the
pairing branch. Plan 130 must not assume the plugin supports concurrent action and pairing
subscriptions. The established canonical diagnostic probe may retain its independent best-effort
poll/listener because it is not participant ingress and this plan must not regress that mobile
diagnostic contract.

### `/township` preparation control

When the source is `:fresh`, render one compact post form in the instrument. Submitting it invokes a
LiveView event that validates the text, reads the target replica only from
`socket.assigns.provenance.replica`, and assigns a generated action URL. The UI then renders an
explicit `Open in Township app` link and labels the request as prepared but unsigned and unconfirmed.
It does not mutate the read model or call any authoring/carrier API. The verified offline bundle also
contains `provenance.replica`, but Plan 130 intentionally withholds the control there because that
instrument has no projection that could observe the result.

Do not prepare intents from `:verified`, `:stale`, `:connecting`, or `:unverified` state. A projection update may
replace the model only through the existing PubSub path. Seeing matching text later is not enough to
claim intent confirmation because v1 has no signed intent id in the operation.

### Tauri review and existing authoring path

The Tauri shell adds an action-intent branch to a single shared dispatcher over the existing plugin
deep-link source. Warm and cold delivery parse the same strict contract. A valid, pairing-matched
intent populates a separate pending-request review state; it never overwrites an unsaved local post
draft. The participant must first accept that request into the post form and then press the existing
post action. Before those explicit actions:

- no native signing command has run;
- local semantic log, delegation store, carrier-frame store, and outbox are unchanged;
- no carrier socket has opened; and
- no pairing value has changed.

Accepting the request copies its text into the local post draft but still performs no custody or
network action. The explicit post action calls `submitTownshipPost/1` with the intent replica. The existing sync
control then uses the saved peer's explicit `relay` submission mode and acknowledged-only outbox
drain. Missing local capability, absent pairing, wrong replica, relay refusal, persistence failure,
or offline carrier remain visible app failures with the locally authored frame retained according to
the existing outbox contract. If a participant explicitly submits the same staged request twice,
two causal-list post operations are expected, exactly like manually posting the same text twice; v1
does not pretend its unsigned diagnostic id provides operation deduplication.

### Cross-surface convergence proof

The Ubuntu-running core gate must exercise the actual boundaries, not call the authoring function
directly:

1. Generate a base log, resident delegation, participant identity, expected post operation, and
   expected post-state from `Lattice.Sim`.
2. Start the production stable carrier server with distinct server, relay, and observer identities.
3. Start `/township` against its real `CarrierProjection` and load the built Tauri frontend in a
   second browser page with the established native IPC signer/storage seam.
4. Type the post in the real LiveView form and capture its rendered `township://action` link.
5. Deliver that exact link through the Tauri deep-link callback. Assert isolated pending-request
   behavior and zero local-draft/sign/storage/outbox/carrier side effects before the participant
   accepts it.
6. Click the Tauri accept, post, and sync controls. Assert the native signer authored the exact Sim operation,
   the stable relay durably acknowledged it, and the outbox became empty.
7. Refresh through the real projection and assert the original `/township` LiveView and Vue replay
   expose the Sim-equal read model, causal replay, quarantine, and canonical op ids without any
   server-authored operation.
8. Restart the carrier server on the same path/port and use a distinct fresh observer to re-prove
   the persisted result.

The macOS packaged gate repeats the action ingress through LaunchServices and the actual app bundle,
native key custody, isolated KV file, and stable relay. A development-only control may activate the
same visible accept/submit/sync functions after the test has proved ingress itself was inert; the gate must
not replace the production parser or bypass the LiveView-produced link. This packaged proof remains
locally required but is not claimed CI-enforced until the later macOS workflow increment.

### Dependency graph

```text
Plan 123 LiveView instrument + Plan 126 projection
                    |
Plan 129 packaged native-custody stable relay
                    |
                    v
Plan 130 unsigned post intent -> Tauri review -> native author/relay -> projection/Sim equality
                    |
                    +--> later server-push feed
                    +--> later broader participant controls
                    +--> later macOS CI enforcement
                    +--> later production deployment
```

## Public TDD seams

These are the pre-agreed public seams for this increment:

1. `TownshipWeb.ActionIntent.post_url/3`: exact v1 URI generation, bounded validation, injectable
   intent id for deterministic contract tests, and no custody-bearing fields.
2. `TownshipWeb.InstrumentLive`: a `prepare_post` event and rendered explicit handoff link only for
   fresh carrier source state; the read model remains projection-owned.
3. `parseTownshipActionIntentDeepLink/1` plus the single-subscription action/pairing dispatcher:
   strict route separation, warm/cold parsing, exact-field rejection, bounded input, and inert
   pending-request application.
4. The Tauri `App.vue` action-intent review state: pairing-replica validation, no ingress side
   effects, and explicit reuse of `submitTownshipPost` plus `syncTownshipOutbox`.
5. The cross-surface Playwright gate: real LiveView link -> Tauri UI -> native IPC seam -> stable
   carrier relay -> real projection -> Sim-equal browser state.
6. The packaged macOS gate: actual custom-scheme delivery, native key/KV custody, stable relay,
   restart durability, and fresh-observer verification.

## Scope

- `apps/township_web/lib/township_web/action_intent.ex`
- `apps/township_web/lib/township_web/instrument_live.ex`
- `apps/township_web/lib/township_web/instrument_live.html.heex`
- focused `township_web` action-intent and LiveView tests
- `clients/township-tauri-shell/src/township_action_intent.ts`
- focused TypeScript intent/listener tests and package scripts
- minimal `App.vue` ingress/review wiring and styles
- one Ubuntu-running cross-surface Playwright contract
- one packaged macOS action-handoff smoke reusing the Plan 129 stable fixture/oracle
- flagship workflow/script wiring for the Ubuntu core gate
- plan/docs/status contracts through Plan 130

## Non-goals

- No key, signer, capability, delegation frame, dependency frontier, local cap inventory, or
  participant identity custody in Phoenix.
- No server-side operation authoring, generic carrier `push`, or semantic authority decision.
- No automatic signing, saving, syncing, or optimistic read-model update on deep-link ingress.
- No signed intent receipt or cryptographic intent-to-op correlation. The v1 id is diagnostic only.
- No op-level duplicate-intent guarantee; repeated ingress is inert until the participant explicitly
  submits again.
- No summary, title, member, status, grant, revoke, vouch, attestation, or generic command handoff.
- No server-initiated notification, subscription, WebSocket demultiplexer, autonomous browser feed,
  or replacement of the existing pull projection.
- No Android/iOS/device/camera/LAN/cross-device probe; all section-4a parked boundaries stay parked.
- No new secure-store implementation or change to the mobile secure-store strategy.
- No TLS, public ingress, release, backup, database, multi-writer transaction, or production
  deployment claim.
- No G1/Phase G completion and no real receipt-free W4 or `receipt_free? = true` claim.
- No claim that the packaged macOS gate runs in CI until a macOS job actually executes it.

## STOP conditions

- Stop if the LiveView contract needs any participant key, cap id, delegation frame, dependency set,
  carrier credential, or authority claim.
- Stop if action-link ingress signs, persists, queues, syncs, saves pairing, or contacts the carrier
  before an explicit in-app participant action.
- Stop if the app trusts a browser-provided replica without comparing it to persisted pairing state,
  or trusts browser-provided deps/capability hints.
- Stop if the core convergence test manufactures the expected operation in TypeScript or Phoenix
  instead of consuming a `Lattice.Sim` oracle fixture.
- Stop if the core gate bypasses the real LiveView-generated link, Tauri listener, visible Tauri
  submit/sync controls, stable relay, or real projection.
- Stop if the test claims browser confirmation by matching post text rather than proving the
  observed operation id and Sim-derived reduction.
- Stop if the full deep link or post text enters traces, logs, telemetry, or custody-leak fixtures.
- Stop if the only executable correctness proof is the macOS packaged smoke; the Ubuntu flagship
  gate must enforce the cross-surface core.
- Stop if this work adds another parked mobile/device probe or is relabeled as server push,
  deployment, G1/Phase G completion, or receipt-free W4.

## TDD plan

Use vertical red -> green slices. Run each RED in isolation and record why it fails before adding the
minimum production behavior.

1. **Intent contract RED/GREEN.** Add an Elixir public-contract test for an exact deterministic v1
   post URL and a TS decoder test consuming that literal. Prove strict versions/keys, malformed
   base64/JSON, empty/oversized text, invalid ids/replicas, and forbidden custody fields fail closed.
2. **LiveView preparation RED/GREEN.** Add connected LiveView tests proving a fresh post submission
   renders an explicit unsigned link using `provenance.replica`; verified snapshot, stale,
   connecting, and unavailable sources cannot prepare one; and no model/op count changes before
   projection input.
3. **Tauri ingress RED/GREEN.** Add parser/shared-dispatcher tests for warm and cold delivery,
   pairing/action route isolation, the synthesized Android pairing URL, pairing-replica mismatch,
   malformed/smuggled payloads, bounded input, repeated delivery, and redacted tracing. Prove the
   local post draft and all KV/log/outbox/sign/socket spies remain untouched while a valid request is
   merely staged.
4. **Tauri review RED/GREEN.** Drive the built Vue app with mocked native IPC. Deliver the exact
   LiveView contract, prove a separate review state renders without replacing the post draft, then
   explicitly click accept, post, and sync. Prove the native key signs, local deps/cap selection
   remains app-owned, and failures remain visible without optimistic success.
5. **Ubuntu cross-surface RED/GREEN.** Add the real stable-server/LiveView/Tauri-front-end browser
   path above, with expected op/state/quarantine/canonical order exported by Sim. Wire it into the
   Ubuntu flagship script/workflow so omission is itself test-visible.
6. **Packaged macOS RED/GREEN.** Deliver the exact LiveView-produced link through LaunchServices to
   the actual app. Prove no ingress side effect, then activate the same submit/sync path, inspect
   isolated native KV/trace for custody leaks, restart the server, and verify with a fresh BEAM
   observer against Sim.
7. **Docs/contracts RED/GREEN.** Add Plan 130 cumulative markers and advance the build map, CLAUDE,
   POC status, path-to-real, and shell docs while retaining server-push, deployment, mobile, parked,
   W4, and incomplete-Phase-G non-claims.
8. **Full verification.** Run focused tests after each slice, then the full TS/shell/browser matrix,
   packaged macOS smoke, immutable bundle check, warnings-as-errors compile, xref baseline, both
   Sobelow boundaries, `mix verify`, `mix check`, and an exact-diff Claude review.

## TDD evidence

The implementation advanced as vertical public-seam slices, with each failure observed before the
minimum behavior was added:

1. The cross-runtime intent contracts first failed because neither producer nor decoder existed.
   `TownshipWeb.ActionIntent` and the TypeScript decoder now accept the same exact v1 keys, route,
   id, replica, ASCII-edge trimming, and UTF-8 byte bound while rejecting malformed, smuggled, or
   custody-bearing input.
2. Connected LiveView tests first failed without `prepare_post`; they now prove only a fresh carrier
   projection can render the explicit unsigned handoff link, with the replica sourced from
   `provenance.replica` and no read-model mutation.
3. Dispatcher and frontend contracts exposed the old parallel-listener assumption and stale static
   expectations. One shared participant deep-link subscription now routes pairing and action URLs,
   stages action review separately from an unsaved local draft, and leaves key/KV/outbox/socket
   seams untouched before visible participant actions.
4. The Ubuntu cross-surface test went red in succession on the missing launcher, Mix argument
   handling, browser origin, ambiguous selectors, pre-sync store expectation, and whitespace-safe
   selection. Each correction tightened the real LiveView -> built app -> relay -> projection seam;
   the final test proves exact Sim frame/state equality and same-path/port restart recovery.
5. The packaged macOS source contract first failed without a test-only activation route. The first
   packaged run then exposed native-hydration ordering, and Claude review exposed a weaker
   build-time-only dev gate. The final route calls the production accept/post/sync functions only
   after a successful native dev-trace capability handshake; LaunchServices ingress itself remains
   inert and the native KV/trace evidence remains redacted.
6. The documentation contract failed with this plan still marked `IN PROGRESS`; the cumulative
   Plan 130 status and non-claims were then advanced together. The broader release run exposed
   additional Plan-129-pinned expectations in the mobile-readiness and historical build-map
   contracts; those tests were advanced to the Plan 130 frontier without weakening their original
   mobile or custody non-claims. One release-BEAM probe timed out only while fixed-runtime contracts
   were incorrectly run concurrently and passed immediately in isolation; all runtime gates were
   serialized after that.

## Second opinion

Claude Code Opus reviewed the clean `05c18eaf` frontier read-only before this plan was written. It
ranked the candidates:

1. `/township` participant action handoff without Phoenix custody;
2. server-initiated carrier feed and client demultiplexing;
3. macOS CI enforcement for the existing packaged lane; and
4. production release/TLS/deployment.

Its initial `PROCEED` verdict required an unsigned intent and a non-tautological LiveView -> app ->
relay -> projection proof. This plan tightens that recommendation by excluding browser-provided
deps/cap hints, declining an unsupported duplicate-op claim, and requiring inert staged ingress.

Claude then reviewed this exact written plan and returned `PROCEED` with two concrete specification
edits: name `provenance.replica` as the sole LiveView replica source and define route separation plus
a single plugin subscription rather than assuming concurrent listeners. Both are incorporated above.
Its two low findings are also resolved: preparation is fresh-carrier-only, and repeated explicit
submission is documented as two ordinary causal-list posts rather than false idempotency.

Claude then reviewed the integrated parser/dispatcher/`App.vue` path and returned `PROCEED` with no
blockers. Its two low observations were checked against the consume-once Android pairing handoff and
the intentional failed-post retry behavior; neither required a behavior change.

Claude reviewed the Ubuntu LiveView-to-app convergence gate and returned `PROCEED` with no blockers.
The gate was still strengthened to scan every browser-console level for URL/text leakage and to
prove that staging preserves a pre-existing unsaved local draft.

Claude reviewed the packaged macOS gate and returned `PROCEED` with no blockers. Its one meaningful
hardening observation became a new failing source contract: a build-time development flag alone was
not enough. The app now accepts test-control links only after the native trace command proves the
matching Rust feature is present, and the freshly rebuilt packaged smoke passes that dual gate.

Claude's final exact-diff review returned `PROCEED` with no blocker or high finding after inspecting
the tracked diff and every untracked file. It found one medium test/claim gap: the post-only Ubuntu
gate compared an empty quarantine with an empty oracle. A new RED required the final replay to include
the Sim fixture's authority-invalid operation and failed on the missing `no_capability` node. The gate
now relays that separately signed negative-control frame only after the app-authored post succeeds,
then proves a positive `no_capability` quarantine control in LiveView, Vue replay, and the fresh
process verifier after restart.

The final low observations also tightened executable evidence: Android pairing-intent inclusion is
now explicit on the shared participant source while canonical diagnostics remain opted out; the
parser covers valid-base64 malformed JSON; and private-seed representations are scanned across KV,
native trace, browser console, and LiveView/server output. The packaged dev-control path still has
both a source-level false/true gate contract and a positive native-feature smoke, but no second
packaged build whose frontend flag is enabled while the native feature is absent. The restart
verifier is a fresh BEAM process using the configured observer identity, not a rotated observer key.
Claude's focused follow-up returned `PROCEED` and marked the prior medium resolved, with no blocker,
high, or medium finding remaining.

## Verification

Focused implementation gates passed on 2026-07-12:

- the action-intent and connected LiveView slice: 10 ExUnit tests, 0 failures;
- shell frontend contracts: 30 tests, 0 failures, plus action-intent, shared-dispatcher, pairing,
  deep-link-source, canonical-probe, and `vue-tsc --noEmit` contracts;
- `npm run township:action-handoff:e2e`: 1 Playwright test passed against the production stable
  server, real projection, built app surface, and Sim oracle, including a positive
  `no_capability` quarantine control;
- `npm run township:instrument:server-e2e`: 1 Playwright regression passed;
- `npm run tauri:action-handoff:smoke`: a fresh release-mode packaged app build passed
  LaunchServices delivery, native-custody authoring, exact Sim equality, trace/KV redaction, and
  fresh-observer restart verification; and
- the focused Plan 130 documentation contract passed after its intentional status RED.

Full release verification passed on 2026-07-12:

- `clients/lattice-client` passed build, strict typecheck, Sim conformance, canonical parity,
  Township authoring, Tauri bridge, carrier vector/live carrier, relay, and relay-drain scripts;
- `clients/township-tauri-shell` passed its complete source/mobile/release contract inventory, and
  `npm run app:convergence` passed browser click-through, live app, generic packaged onboarding,
  stable-relay packaged onboarding, packaged action handoff, and installed deep-link lanes;
- the changed shell lockfile installed exactly with `npm ci --ignore-scripts`, reported zero audit
  vulnerabilities, and the resolved set repeated typecheck plus 30 frontend contracts;
- all six static Township browser cases, live projection, stable-server recovery, action handoff,
  shared browser carrier E2E, and the flagship worker/video/action mirror passed;
- the outsider audit bundle verified and remained byte-unchanged; forced test and production
  warnings-as-errors compiles passed; xref remained at the known five cycles; both HTTP-boundary
  Sobelow scans exited zero; and `git diff --check` passed; and
- pinned-OTP-28 `mix verify` and `mix check` each passed the umbrella with 336 tests and 25
  properties. Strict Credo exited zero with the repository's existing non-blocking suggestions.

## Completion claim

Complete for this scoped increment: one real `/township` post intent crosses the installed-app
custody boundary without moving authoring authority into Phoenix. The Ubuntu gate drives the visible
Use request, Post, and Sync controls; the packaged macOS gate uses the native-gated development
control to invoke those same production functions only after proving LaunchServices ingress inert.
The projection and fresh observer match Sim, the Ubuntu core gate is flagship-CI-wired, the packaged
macOS local gate passes, the complete release matrix is green, and every server-push,
broader-control, deployment, mobile/device, Phase G, and W4 non-claim above remains explicit.
