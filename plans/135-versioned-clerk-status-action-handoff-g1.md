# Plan 135: Versioned clerk status action handoff (toward G1)

## Status

DONE

## Objective

Advance the remaining broader-participant-control frontier by carrying the first clerk-only matter
status requests across the existing LiveView-to-Tauri custody seam. A fresh carrier-backed
`/township` instrument prepares an unsigned close or reopen request; the paired app validates and
reviews it, derives the command capability and dependency frontier from persisted local evidence,
signs through the native key boundary, and publishes only after a separate explicit Sync.

The existing post intent contract is immutable. v1 remains exactly post-only. Plan 135 introduces a
fail-closed v2 for `close_matter` and `reopen_matter`; it does not reinterpret or widen v1.

The real packaged gate must prove Open -> Locked -> Open convergence through the stable relay in
both the Tauri feed and the LiveView projection, with `Lattice.Sim` as the independent oracle.

## Why this increment

- Plan 130 proved one custody-free participant handoff, but intentionally froze v1 to `post`.
- Plans 050 and 054 already provide close/reopen authoring controls, native signing, and persisted
  capability evidence inside the app. Re-proving those local functions alone would add no new
  boundary.
- Plan 134 proved the packaged reactive read path. The next useful dependency is a clerk-only write
  crossing the same real app boundary and becoming visible through both reactive projections.
- Automatic authored-frame publication would erase the explicit participant ceremony preserved by
  Plans 130 and 134. It is not this increment.
- iOS, physical-device, QR-camera, LAN, and cross-device pairing work remain parked by
  `TOWNSHIP_BUILD_MAP.md` section 4a.

## Scope

### Included

1. An exact v2 unsigned action-intent schema for `close_matter` and `reopen_matter` while preserving
   the exact v1 post producer, decoder, fixtures, and packaged proof.
2. A fresh-only LiveView status-action control derived from the verified current matter state:
   open matters prepare close; locked matters prepare reopen. Client parameters do not choose the
   command.
3. A command-aware Tauri review state that stages v1 and v2 requests without signing, persistence,
   local-draft replacement, or network activity.
4. A visible status ceremony with command-specific language and three separate participant steps:
   Use request -> Sign close/reopen -> Sync outbox.
5. Local capability refusal: a resident without clerk authority cannot sign a v2 status request.
6. A Sim-generated clerk status fixture and a dedicated packaged macOS smoke against the real
   stable path-backed relay and carrier-backed LiveView.
7. Hard unit and packaged CI gates plus cumulative Plan 135 documentation contracts.

### Explicitly deferred

- `set_title`, `set_summary`, `admit`, `remove_member`, delegation, revocation, succession, or
  arbitrary command intents.
- Automatic Sync, background authored-frame publication, server-side authoring, or operation
  materialization from an availability hint.
- Signed intents, intent receipts, cryptographic intent-to-operation correlation, or duplicate
  intent suppression.
- Mobile secure-store implementation, iOS, Expo, physical-device behavior, QR/LAN work, or
  cross-device pairing state exchange.
- Production ingress, TLS, notarization, deployment, complete G1/Phase G, or receipt-free W4.

## Public contracts

### Frozen v1 post intent

Plan 130's v1 contract stays byte-for-byte and behaviorally unchanged:

```json
{"v":1,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"post","text":"<text>"}}
```

- The producer still trims and bounds post text.
- The TypeScript decoder still requires the exact top-level and nested key sets.
- A v1 `close_matter` or `reopen_matter` payload remains invalid.
- Plan 130's packaged post handoff remains unchanged and mandatory.

### New v2 clerk status intent

The canonical close shape is exactly:

```json
{"v":2,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"close_matter"}}
```

`reopen_matter` has the same shape with only the command discriminator changed.

- v2 supports only `close_matter` and `reopen_matter`.
- The top level permits exactly `command`, `id`, `replica`, and `v`.
- The nested command permits exactly `command`; `text`, `member`, cap ids, dependencies, authors,
  signatures, and every other field are rejected.
- Unknown versions and cross-version keys fail closed.
- `id` remains a diagnostic correlation label only. It is unsigned and does not become part of the
  authored operation.
- Replica and URL bounds remain no weaker than v1, and the app still requires the intent replica to
  equal the saved pairing replica before acceptance and again before signing.

### LiveView preparation

The connected instrument exposes one command-named control only when the carrier source is fresh.
The server derives the command from `@model.threads.clerk_locked?`; it does not trust a client-sent
command name.

- Open state renders `Prepare close in app` and emits v2 `close_matter`.
- Locked state renders `Prepare reopen in app` and emits v2 `reopen_matter`.
- Verified-bundle, connecting, stale, unavailable, and unverified states do not prepare a status
  action.
- A prepared status request survives only while source, replica, and relevant locked/open state
  remain compatible. It clears on loss of freshness, replica replacement, or opposing state.
- Phoenix receives no participant identity, private key, capability, delegation frame, dependency
  frontier, signature, or authority verdict.

### Tauri custody ceremony

The decoder returns a discriminated `TownshipActionIntent` union while preserving the existing
`TownshipPostActionIntent` type for v1 callers. Shared deep-link dispatch remains one listener and
stages either version through the same inert ingress seam.

The pending review panel uses command-specific text. `Use request` moves a v2 status request into a
separate accepted state; it does not invoke native signing or mutate local storage. The accepted
state exposes `Sign close` or `Sign reopen`. Signing calls the existing
`submitTownshipCommand/1` path, so the app alone selects the capability, derives dependencies,
invokes the native signer, and appends local log/outbox evidence. It does not Sync.

`Sync outbox` remains the existing separate control. Test-only development routes may drive the
same production functions, but the packaged proof must pause after signing and demonstrate one
pending outbox frame before it invokes the separate Sync route. The new Use/Sign development
control rides the existing `township-dev-trace` Cargo feature and Vite environment; it introduces
no new compile-time flag, so Plan 130's action-handoff bundle already contains it.

### No-cap resident refusal

The no-cap resident path is not a substrate `:not_holder` case. The app has no selectable
clerk-capable delegation, so the command fails locally as `missing_delegation` before operation
construction. The focused authoring contract proves zero native signatures and zero KV writes with
the signer and KV-write spies specifically; native key/KV reads remain allowed. Relay is not a
dependency of author-only submission. The browser and packaged boundaries prove zero publication
with zero Sync trace and an unchanged stable-relay source before explicit Sync. No-cap resident
refusal cannot be represented as a successfully relayed authority quarantine.

W2 already owns the stale ex-clerk `:not_holder` proof. Plan 135 references that established core
evidence and does not add a packaged succession/partition variant.

## Independent oracle and packaged proof

`Lattice.Sim` is the independent oracle. A BEAM fixture derives all expected frames and
projections from `LatticeNodeSpike.TownshipOnboardingScenario.base_sim/0`:

1. The path-backed source starts at the shared open Township prefix.
2. Sim authors clerk `close_matter`, syncs all realms, and exports the exact carrier frame, op ids,
   read model, and causal replay for the locked projection.
3. Sim then authors clerk `reopen_matter`, syncs all realms, and exports the exact reopened
   projection.

The dedicated `tauri_clerk_action_handoff_smoke.ts` gate must:

1. Start the real stable carrier server with the deterministic clerk native identity as the
   selected relay realm and a distinct read-only LiveView observer.
2. Save only public pairing metadata into an isolated native KV file and pull the clerk's existing
   capability evidence through the real app.
3. Prepare a v2 close request in the real fresh LiveView and deliver it through LaunchServices.
4. Prove staging is inert and redacted, then drive `Use request` and `Sign close` through the
   development-control seam.
5. Observe exactly one pending signed frame, no Sync trace, and no server source change before the
   separate explicit Sync control.
6. Sync, then prove the stable source, Tauri rendered feed, and LiveView projection equal Sim's
   locked op ids and `clerk_locked? = true` state.
7. Repeat the real handoff/sign/pending-outbox/Sync sequence for reopen and prove all three surfaces
   equal Sim's final open projection.
8. Prove the outbox drains only after acknowledgement, no server/observer operation is authored,
   and native KV, dev trace, LiveView output, and action traces contain no private seed or complete
   action URL.

The smoke builds when run standalone unless `TOWNSHIP_SKIP_CLERK_ACTION_APP_BUILD=1`. The hosted
packaged job sets that switch, runs the clerk step immediately after
`tauri:action-handoff:smoke`, and reuses the existing action-handoff app bundle in hosted CI. It
must run before `tauri:feed:smoke`, which rebuilds and replaces the bundle. A second Tauri build in
the hosted clerk step is a STOP condition.

## TDD sequence

Work one vertical slice at a time. Every GREEN must preserve earlier contracts before the next RED.

1. **Plan/public-seam RED.** Add this cumulative plan contract and index row before the plan file.
   Record the missing-file failure, then add the reviewed plan and correct the stale index frontier.
2. **Cross-runtime v2 RED/GREEN.** Add an exact v2 fixture produced by
   `TownshipWeb.ActionIntent`; consume that literal in the TypeScript decoder contract. Prove close
   and reopen, unchanged v1, v1-with-status rejection, v2-with-text rejection, unknown version,
   smuggled keys, malformed encoding, and bounds.
3. **Fresh LiveView RED/GREEN.** Add LiveView tests for open->close and locked->reopen preparation,
   non-fresh refusal, state-change clearing, replica replacement, exact v2 URLs, and unchanged post
   preparation. Implement only the state-derived status control and producer needed to pass.
4. **App review RED/GREEN.** Extend the dispatcher and focused TypeScript contract for v2 staging,
   replica mismatch, duplicate delivery, inert ingress, Use request, command-specific accepted
   state, Sign close/reopen, and no automatic Sync. Preserve an unrelated local post draft.
5. **No-cap RED/GREEN.** Strengthen the existing command test so missing clerk capability leaves
   storage evidence unchanged. Assert the signer and KV-write spies receive no call while permitting
   the native reads needed to discover the local identity and delegation evidence. Keep relay out of
   this author-only API; assert zero Sync and unchanged relay state at the browser/package boundaries.
6. **Packaged close RED/GREEN.** Add the Sim fixture and dedicated smoke through the first explicit
   sign boundary. Capture RED before adding the app status-intent consumer and development control.
   Turn it green through one signed close frame and a deliberately pending outbox.
7. **Explicit Sync and reopen RED/GREEN.** Add the separate Sync transition and Sim-equal locked
   projection, then repeat for reopen and final open projection.
8. **Hard CI RED/GREEN.** Add fast action-intent/action contracts to the unit job and the dedicated
   no-rebuild packaged step after the existing action handoff. Require the script from
   `app:convergence` without weakening any existing hard gate.
9. **Cumulative verification.** Run focused producer/LiveView/decoder/action tests, both packaged
   action smokes, reactive feed, complete app convergence, full umbrella verification, security
   gates, workflow lint, and exact diff checks.
10. **Independent review and closure.** Claude reads the exact worktree diff, every new file, all
    RED/GREEN evidence, v1 compatibility, custody boundaries, Sim oracle, packaged trace, CI wiring,
    and non-claims before commit. Hosted implementation and closure runs must be green before DONE.

## Required gates

Focused:

- pinned OTP 28 `mix test` for `TownshipWeb.ActionIntent` and `InstrumentLive`
- `npm run typecheck`
- `npm run action-intent:contract`
- `npm run deeplink:dispatcher:contract`
- `npm run action:contract`
- `npm run frontend:contract`
- `npm run build`
- `npm run tauri:clerk-action-handoff:smoke`

Cumulative:

- existing `npm run tauri:action-handoff:smoke`
- `npm run tauri:feed:smoke`
- `npm run app:convergence`
- root browser and flagship verification
- pinned OTP 28 `mix verify` and `mix check`
- forced test and production warnings-as-errors compiles
- xref, both HTTP-boundary Sobelow scans, actionlint, formatting, and `git diff --check`
- hard hosted unit, flagship, and packaged macOS jobs

## STOP conditions

- Any change to v1's exact payload, accepted command, trim/bound rules, parser result, or packaged
  post behavior.
- Any v2 `text`, `member`, cap, dependency, author, signature, or unknown field accepted by either
  runtime.
- Any non-fresh LiveView source prepares a status request or client parameters choose the command.
- Staging, Use request, or Sign automatically invokes Sync.
- A no-cap resident reaches native signing, KV mutation, outbox append, or relay.
- Phoenix receives participant custody material or derives semantic authority.
- The packaged proof uses hand-authored expected frames/state instead of Sim, bypasses the installed
  app/LaunchServices, or lets polling masquerade as the reactive result.
- The hosted clerk smoke rebuilds the Tauri app instead of using the immediately preceding bundle.
- Plan 130's post smoke is weakened, folded into the new smoke, or made optional.
- The implementation enters any parked section 4a area.
- Any claim of automatic publication, deployment, mobile completion, complete G1/Phase G, or W4.

## Non-claims

- No automatic authored-frame publication.
- No mobile secure-store implementation change.
- No complete G1/Phase G claim and no receipt-free W4 claim.
- No general command bus, broader member/delegation controls, signed receipt, production ingress,
  or deployment.

## Likely files

- `apps/township_web/lib/township_web/action_intent.ex`
- `apps/township_web/lib/township_web/instrument_live.ex`
- `apps/township_web/lib/township_web/instrument_live.html.heex`
- focused `apps/township_web/test/township_web/*` tests
- `clients/township-tauri-shell/src/township_action_intent.ts`
- `clients/township-tauri-shell/src/township_deep_link_dispatcher.ts`
- `clients/township-tauri-shell/src/App.vue`
- focused TypeScript intent, dispatcher, action, and frontend contracts
- a new v2 cross-runtime fixture and Sim clerk-status fixture
- `clients/township-tauri-shell/test/tauri_clerk_action_handoff_smoke.ts`
- `clients/township-tauri-shell/package.json`
- `.github/workflows/flagship.yml`
- cumulative plan/status/build-map docs

## Pre-implementation evidence

- Live code inspection confirmed that close/reopen authoring and availability already use the
  generic native-custody path; the missing boundary is the post-only cross-surface handoff.
- The initial Claude architecture review recommended command-parameterized close/reopen instead of
  a packaged-only command variant or automatic publication.
- A correction review then caught two important distinctions: Plan 130 freezes v1 as post-only, so
  v2 is required; and a no-cap resident must fail locally rather than being mislabeled
  `:not_holder`. It returned `PROCEED` for this corrected architecture.
- The Plan 135 cumulative contract failed first because this plan file was absent.

## Implementation evidence

- Exact v1/v2 producer and decoder contracts, the shared dispatcher, fresh-only LiveView
  preparation, replica replacement, no-cap refusal, command-specific app review, replica-bound
  signing, frontend source contracts, typecheck, and the focused Plan 135 contract are green.
- Packaged close/reopen smoke is green when run standalone. The real installed app stages and uses
  each request inertly, signs exactly one Sim-equal local frame, leaves it pending until the
  separate Sync, and converges the stable source, Tauri feed, and LiveView projection through
  Open -> Locked -> Open without leaking custody material.
- The shell convergence command and flagship workflow are wired to run the new smoke after the
  existing Plan 130 action handoff and before the feed smoke, reusing the identical dev-trace app
  bundle with `TOWNSHIP_SKIP_CLERK_ACTION_APP_BUILD=1` rather than building twice.
- Full local regression passed on 2026-07-12. Pinned OTP 28 `mix verify` and `mix check` each pass
  378 tests plus 25 properties; complete shell convergence, all Township browser lanes, flagship
  Worker/video/artifact verification, forced warning-free test/production compiles, the unchanged
  five-cycle xref baseline, both Sobelow boundaries, actionlint, formatting, diff hygiene, and 23
  Rust native/runtime tests are green.
- Final exact-worktree Claude review returned `PROCEED` with no blocker, high, or medium finding.
  Its focused no-cap boundary follow-up also returned `PROCEED` after the plan matched the actual
  author-only and publication boundaries.
- The first hosted run `29216313162` proved the flagship and all four packaged macOS steps, but its
  new frontend-contract step exposed a stale exact mirror of `app:convergence`. The focused local
  RED reproduced 30/31; Claude returned `UPDATE_EXPECTATION`, and the one-line exact mirror fix
  restored 31/31 without changing runtime behavior.
- Hosted implementation run `29216789652` is green at
  `6a55a91ad82ccc30cc52ed09142864b8d76c1bb4`. `Verify flagship artifact` completed in 3m19s,
  `Unit + property suite` completed in 4m14s, and `Packaged macOS convergence` completed in 11m39s.
  Stable-relay onboarding, unchanged Plan 130 action handoff, Plan 135 no-rebuild clerk handoff,
  and the reactive feed smoke all passed in the required order.

## Completion claim

Complete for this scoped increment. Exact cross-runtime v2 compatibility, fresh-only LiveView
preparation, command-specific app review/signing with separate Sync, local no-cap refusal, real
packaged Open -> Locked -> Open convergence against Sim, unchanged Plan 130 evidence, hard hosted
CI, cumulative docs, and final independent review are green. This completion does not claim the
deferred or parked work above.
