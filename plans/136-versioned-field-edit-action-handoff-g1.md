# Plan 136: Versioned field-edit action handoff (toward G1)

## Status

DONE

## Objective

Advance the remaining broader-participant-control frontier with the first named LWW field edits
across the existing LiveView-to-Tauri custody seam. A fresh carrier-backed
`/township` instrument prepares an unsigned title or summary edit; the paired app validates and
reviews it, derives command capability and dependencies from persisted local evidence, signs
through the native key boundary, and publishes only after a separate explicit Sync.

The existing post and clerk-status contracts are immutable. v1 and v2 remain exactly unchanged.
Plan 136 introduces a fail-closed v3 in which one v3 command union bundles both `set_title` and
`set_summary`; it does not reinterpret or widen either earlier version.

The real packaged gate must prove both commands through the installed app. Its stronger summary
case signs from the shared base frontier, admits a concurrent peer summary edit while the app frame
is deliberately pending, and then requires the stable source, Tauri feed, and LiveView projection
to match the independent `Lattice.Sim` contested-summary result after explicit Sync.

## Why this increment

- Plan 135 established a fail-closed versioned handoff and explicit Use, Sign, and Sync ceremony,
  but intentionally stopped after argument-free close/reopen requests.
- Plan 048 already supplies local `set_title` and `set_summary` authoring through app-owned
  capability selection, dependency derivation, native signing, local persistence, and outbox
  append. Re-testing those local functions alone would add no new runtime boundary.
- Field edits are the smallest remaining command family that replaces named convergent state
  instead of appending a post. They deepen the handoff without first introducing roster identity
  or observed-remove UI.
- A concurrent summary proof exercises the LWW conflict semantics used by Township W1. It is
  materially stronger than another sequential command permutation and keeps Sim authoritative.
- The two text-field commands are structurally identical. Splitting them into separate plans or
  packaged builds would be fake incrementalism, so this plan bundles them.
- The contested proof directly exercises Plan 128's multi-realm relay boundary and Plan 134's
  reactive feed, inherited through Plan 135's cumulative dependency chain.
- iOS, physical-device, QR-camera, LAN, cross-device pairing, and further Android probe variants
  remain parked by `TOWNSHIP_BUILD_MAP.md` section 4a.

## Scope

### Included

1. An exact v3 unsigned action-intent schema for `set_title` and `set_summary`, while preserving
   the exact v1 post and v2 clerk-status producers, decoders, fixtures, and packaged proofs.
2. Separate fresh-only LiveView title and summary preparation controls. The server handler fixes
   each command; client parameters cannot replace it with another command.
3. Command-aware Tauri review and accepted-edit state that stages v3 without signing, persistence,
   local-draft replacement, or network activity.
4. A visible field-edit ceremony with three separate participant steps:
   Use request -> Sign edit -> Sync outbox.
5. No-cap participant refusal before operation construction, native signing, or KV mutation.
6. Sim-generated title and concurrent-summary fixtures plus a dedicated packaged macOS smoke
   against the real stable path-backed relay and carrier-backed LiveView.
7. Hard unit and packaged CI gates that reuse one already-built app bundle, plus cumulative Plan
   136 documentation contracts.

### Explicitly deferred

- `admit`, `remove_member`, delegation, revocation, succession, arbitrary command intents, or a
  general command bus.
- Automatic Sync, background authored-frame publication, server-side authoring, or operation
  materialization from an availability hint.
- Signed intents, intent receipts, cryptographic intent-to-operation correlation, cancellation,
  or duplicate intent suppression.
- Mobile secure-store implementation, iOS, Expo, physical-device behavior, QR/LAN work, or
  cross-device pairing state exchange.
- Production ingress, TLS, notarization, deployment, complete G1/Phase G, or receipt-free W4.

## Public contracts

### Frozen v1 and v2 intents

Plan 130's v1 post shape and Plan 135's v2 clerk-status shape remain byte-for-byte and
behaviorally unchanged.

- v1 accepts only `post` with exactly `command` and `text` in its nested object.
- v2 accepts only `close_matter` or `reopen_matter` with exactly `command` in its nested object.
- v1 and v2 retain their existing trim, byte-bound, URL, intent-id, replica, parser-result, and
  packaged behavior.
- A v1 or v2 field edit remains invalid. A v3 post or clerk-status request remains invalid.
- Plan 130's packaged post handoff and Plan 135's packaged clerk-status handoff remain unchanged
  and mandatory.

### New v3 field-edit intent

The canonical summary shape is exactly:

```json
{"v":3,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"set_summary","text":"<text>"}}
```

The canonical title shape is exactly:

```json
{"v":3,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"set_title","text":"<text>"}}
```

- v3 supports only `set_title` and `set_summary`.
- The top level permits exactly `command`, `id`, `replica`, and `v`.
- The nested command permits exactly `command` and `text`. Member ids, cap ids, dependencies,
  authors, signatures, and every other field are rejected.
- Text uses the existing ASCII-edge trim, valid UTF-8, non-empty, and 4096-byte producer/parser
  contract. Replica and intent-id bounds remain no weaker than v1 and v2.
- Unknown versions and cross-version keys fail closed in both runtimes.
- `id` remains an unsigned diagnostic correlation label. It does not become part of the authored
  operation.
- The app requires the intent replica to equal the saved pairing replica before acceptance and
  again before signing.

### LiveView preparation

The connected instrument exposes separate title and summary edit forms only when its carrier
source is fresh. The event name and server handler fix the command atom; no client-sent `command`
or `field` parameter selects or replaces it.

- `prepare_title_edit` emits v3 `set_title` with the submitted title text.
- `prepare_summary_edit` emits v3 `set_summary` with the submitted summary text.
- Verified-bundle, connecting, stale, unavailable, and unverified states do not prepare a field
  request.
- A prepared field request survives only while the source remains fresh and the replica remains
  the same. It clears on loss of freshness, replica replacement, another prepared field request,
  or producer validation failure.
- Preparing a field edit does not clear or overwrite the existing local post draft in Phoenix or
  in the app.
- Phoenix receives no participant identity, private key, capability, delegation frame, dependency
  frontier, signature, or authority verdict.

### Tauri custody ceremony

The decoder extends the existing discriminated `TownshipActionIntent` union with
`TownshipFieldActionIntent`. Shared deep-link dispatch remains one listener and stages every
version through the same inert ingress seam.

The pending review panel uses command-specific labels and shows the bounded public text. `Use
request` moves a v3 request into a separate accepted field-edit state. It does not invoke native
signing, mutate local storage, replace the unrelated summary draft, or touch the network. The
accepted state exposes `Sign title edit` or `Sign summary edit`.

Signing calls the existing `submitTownshipCommand/1` path, so the app alone selects the capability,
derives dependencies from its persisted local frontier, invokes the native signer, and appends
local log/outbox evidence. It does not Sync. `Sync outbox` remains a separate existing control.

Test-only development routes may drive the same production functions. The packaged proof pauses
after each Sign and proves one pending outbox frame before invoking the separate Sync route. The
new Use/Sign routes ride the existing `township-dev-trace` Cargo feature and Vite environment; no
new compile-time flag or app variant is allowed.

### No-cap participant refusal

A participant whose persisted delegations do not include the requested field command fails
locally as `missing_delegation` before operation construction. This is not a substrate
`:not_holder` or authority-quarantine claim.

The focused authoring contract proves zero native signatures and zero KV writes with signer and
KV-write spies. Native key and KV reads remain allowed because identity and delegation discovery
precede the refusal. Relay is not a dependency of author-only submission. Browser and packaged
boundaries prove no automatic publication through zero Sync trace and an unchanged stable source
before explicit Sync.

## Independent oracle and packaged proof

`Lattice.Sim` is the independent oracle. A BEAM fixture starts from
`LatticeNodeSpike.TownshipOnboardingScenario.base_sim/0` and derives every expected signed frame,
op id, read model, and replay frame.

### Concurrent summary sequence

1. The stable path starts at the shared base Township prefix and authorizes both the participant
   and distinct peer relay realms. The packaged participant app pulls and persists that base plus
   its capability evidence.
2. A fresh LiveView prepares v3 `set_summary`; LaunchServices delivers the request; the app stages,
   accepts, and signs one participant frame from the base frontier while leaving it pending.
3. Before participant Sync, a distinct authorized peer relays a Sim-generated `set_summary` frame
   whose dependencies are also the base frontier. The source now contains the peer branch while
   the participant frame remains unchanged and pending.
4. The smoke asserts that the stored participant outbox frame id remains byte-identical to Sim's
   expected base-frontier frame immediately after the peer relay and again immediately before
   Sync. A non-empty-outbox assertion alone is insufficient.
5. The participant explicitly Syncs its already-signed frame. The two writes are concurrent, and
   Sim independently decides the LWW winner from canonical operations rather than a hand-authored
   expected value.
6. The stable source, Tauri feed, and LiveView projection must all match Sim's exact op ids, title,
   summary, and causal replay after the contested merge.

### Title sequence

The same installed app then receives v3 `set_title`, stages and signs it inertly, proves the
pending frame and unchanged source, invokes separate Sync, drains only after durable
acknowledgement, and converges all three surfaces to the exact Sim title result.

The dedicated `tauri_field_action_handoff_smoke.ts` must also prove:

- v1 post and v2 clerk handoffs remain runnable before it in the same convergence chain;
- request ingress and Use are inert, Sign does not Sync, and the source changes only after Sync;
- no server or observer operation is authored;
- trace, native KV, rendered output, and action diagnostics contain no private seed or complete
  action URL;
- the app bundle registers and receives the real `township://` scheme through LaunchServices.

The smoke builds when run standalone unless `TOWNSHIP_SKIP_FIELD_ACTION_APP_BUILD=1`. Hosted CI
runs it immediately after the no-build Plan 135 clerk smoke and before the reactive feed smoke,
with that switch set. It reuses the existing action-handoff app bundle in hosted CI. A second
Tauri build in the hosted field-edit step is a STOP condition.

## TDD sequence

Work one vertical slice at a time. Every GREEN preserves all prior contracts before the next RED.

1. **Plan/public-seam RED.** Add the cumulative Plan 136 contract and `IN PROGRESS` index row before
   this file. Record the missing-file failure, obtain the Claude review, then add only the reviewed
   plan and correct frontier wording.
2. **Cross-runtime v3 summary RED/GREEN.** Add an exact summary fixture produced by
   `TownshipWeb.ActionIntent.field_url/4`; consume its literal URL in the TypeScript contract.
   Record Elixir function-undefined and TS `unsupported_action_version` REDs before implementing
   the producer and parser branch. Prove unchanged v1/v2, unknown versions, malformed base64url,
   bounds, extra keys, cross-version text/status smuggling, and unsupported commands.
3. **Cross-runtime v3 title RED/GREEN.** Add the title case to the same union and fixture contract.
   This slice is not green until both commands share the exact v3 schema and neither broadens the
   other versions.
4. **Fresh LiveView summary RED/GREEN.** Test the public event/rendered-link seam: fresh summary
   preparation, non-fresh refusal, exact v3 URL, replica replacement clearing, producer error, and
   inability for client params to switch the command. Implement only summary preparation.
5. **Fresh LiveView title RED/GREEN.** Add the parallel title public event and rendered link,
   keeping one pending field request and preserving post/status behavior.
6. **App review RED/GREEN.** Extend the dispatcher and focused action contract for v3 staging,
   replica mismatch, duplicate delivery, inert ingress, Use, command-specific accepted state,
   Sign for both commands, no automatic Sync, and unrelated local-draft preservation.
7. **No-cap RED/GREEN.** Strengthen the public command test so a participant with post-only
   capability evidence gets `missing_delegation`; signer and KV-write spies receive zero calls.
8. **Packaged contested-summary RED/GREEN.** Add the Sim fixture and installed-app smoke through
   pending participant Sign, then relay the independent concurrent peer frame. Capture RED before
   adding the app v3 consumer and dev controls. GREEN requires one unchanged pending participant
   frame and the peer-only source before Sync.
9. **Explicit Sync and title RED/GREEN.** Sync the pending summary frame and prove all three
   surfaces equal Sim's contested result. Repeat the complete inert/pending/Sync sequence for title.
10. **Hard CI RED/GREEN.** Add fast v3 contracts to the unit job and the dedicated no-rebuild
    packaged step after clerk status. Add the smoke to `app:convergence` before the feed smoke. A
    second hosted build is forbidden.
11. **Cumulative verification.** Run focused Elixir/TS tests, all three packaged action smokes,
    reactive feed, complete app convergence, browser and flagship lanes, pinned umbrella checks,
    warning-free compiles, xref, security/static gates, Rust tests, workflow lint, formatting, and
    exact diff checks.
12. **Independent review and closure.** Claude reviews each meaningful RED/GREEN evaluation and the
    exact final worktree diff. Hosted implementation and closure runs must be green before DONE.

## Required gates

Focused:

- pinned OTP 28 `mix test` for `TownshipWeb.ActionIntent` and `InstrumentLive`
- `npm run typecheck`
- `npm run action-intent:contract`
- `npm run deeplink:dispatcher:contract`
- `npm run action:contract`
- `npm run frontend:contract`
- `npm run build`
- `npm run tauri:field-action-handoff:smoke`

Cumulative:

- existing `npm run tauri:action-handoff:smoke`
- existing `npm run tauri:clerk-action-handoff:smoke`
- `npm run tauri:feed:smoke`
- `npm run app:convergence`
- root browser and flagship verification
- pinned OTP 28 `mix verify` and `mix check`
- forced test and production warnings-as-errors compiles
- xref, both HTTP-boundary Sobelow scans, actionlint, formatting, and `git diff --check`
- hard hosted unit, flagship, and packaged macOS jobs

## STOP conditions

- Any change to v1 or v2 payloads, accepted commands, trim/bound rules, parser results, fixtures,
  or packaged behavior.
- Any v3 member, cap, dependency, author, signature, unknown command, or unknown field accepted by
  either runtime.
- Any v3 command other than `set_title` or `set_summary`, or either field command split into a
  separate plan/build variant.
- Any non-fresh LiveView source prepares a field request or client parameters replace the
  server-handler command.
- Staging, Use request, or Sign invokes Sync, mutates the source, or replaces an unrelated draft.
- A no-cap participant reaches native signing, KV mutation, outbox append, or relay.
- Phoenix receives custody material, chooses participant capability/dependencies, or derives
  semantic authority.
- The packaged proof uses hand-authored expected state, signs after learning the peer branch,
  bypasses the installed app/LaunchServices, or lets polling masquerade as reactive convergence.
- The hosted field smoke rebuilds Tauri instead of using the immediately preceding bundle.
- Plan 130 or Plan 135 packaged evidence is weakened, folded into the new smoke, or made optional.
- The implementation enters a parked section 4a area.
- Any claim of automatic publication, deployment, mobile completion, complete G1/Phase G, or W4.

## Non-claims

- No automatic authored-frame publication.
- No mobile secure-store implementation change.
- No complete G1/Phase G claim and no receipt-free W4 claim.
- No roster, delegation, revocation, succession, general command bus, signed receipt, production
  ingress, or deployment.
- No authority-quarantine proof: title and summary are capability-gated LWW fields, not the
  authority-gated clerk field.

## Likely files

- `apps/township_web/lib/township_web/action_intent.ex`
- `apps/township_web/lib/township_web/instrument_live.ex`
- `apps/township_web/lib/township_web/instrument_live.html.heex`
- focused `apps/township_web/test/township_web/*` tests
- `clients/township-tauri-shell/src/township_action_intent.ts`
- `clients/township-tauri-shell/src/township_deep_link_dispatcher.ts`
- `clients/township-tauri-shell/src/App.vue`
- focused TypeScript intent, dispatcher, action, and frontend contracts
- new v3 cross-runtime fixtures and a Sim concurrent-field fixture
- `clients/township-tauri-shell/test/tauri_field_action_handoff_smoke.ts`
- `clients/township-tauri-shell/package.json`
- `.github/workflows/flagship.yml`
- cumulative plan/status/build-map docs

## Pre-implementation evidence

- Live code inspection confirmed both field commands already use the generic app-owned authoring
  path. The missing behavior is their argument-bearing cross-surface handoff and a real contested
  convergence proof.
- The first Claude architecture review ranked the bundled v3 field-edit handoff ahead of roster,
  delegation/revocation, deployment, and blocked W4 work. It required a real packaged Sim gate and
  returned `PROCEED`.
- The Plan 136 cumulative contract failed first with 10 tests, 1 failure because this plan file was
  absent. No prior plan contract failed.
- Claude reviewed that exact RED and returned `PROCEED`. It confirmed dependencies 048 and 135 are
  sufficient and non-circular, then identified and prompted the stronger assertion that both title
  and summary belong to the one v3 union.

## Implementation evidence

- Exact v3 summary and title producer/parser slices were each driven from failing cross-runtime
  fixture tests. v1 and v2 remain frozen, malformed and unknown variants fail closed, and the
  focused producer plus connected LiveView slice passes 16 ExUnit tests. Claude reviewed every
  meaningful RED/GREEN evaluation and returned `PROCEED` after the replica/error/isolation
  coverage was made explicit.
- The shared dispatcher and Tauri app now stage v3 through the inert review seam, preserve the
  unrelated local draft, recheck the saved replica before signing, and call the existing
  app-owned field command path without Sync. Action-intent, dispatcher, action, typecheck, build,
  and 33 frontend source contracts are green. The post-only no-cap fixture proves both field
  commands stop as `missing_delegation` with zero signer and KV-write calls.
- The Sim fixture supplies the shared base, distinct peer branch, exact contested-summary winner,
  and later title frame. The installed-app smoke is green through LaunchServices: the participant
  frame remains byte-identical and pending while the peer branch reaches the source, explicit
  Sync merges the contested summaries, and source, Tauri feed, and LiveView all match Sim before
  the same app repeats the complete title ceremony. The hosted script reuses the immediately
  preceding action-handoff bundle with `TOWNSHIP_SKIP_FIELD_ACTION_APP_BUILD=1`.
- Complete local regression passed on 2026-07-12. Pinned OTP 28 `mix verify` and `mix check` pass
  383 tests plus 25 properties; forced test and production compiles are warning-free; xref retains
  the unchanged five-cycle baseline; both Sobelow boundaries, actionlint, formatting, diff
  hygiene, and 23 Rust native/runtime tests are green. Complete `app:convergence` passes the
  unchanged post smoke, no-build clerk smoke, no-build field smoke, reactive feed, and installed
  deep-link in the required order.
- Browser and flagship verification passes six static instrument cases, real live pull, stable
  server restart, production action handoff, browser Worker isolation, recorded flagship video
  evaluation, and regenerated graph/claims validation. The stable-server cumulative gate first
  failed because its exhaustive fresh-event whitelist omitted the new field forms; the narrow
  test-only GREEN adds both events and zero-handoff assertions while retaining the empty stale
  checkpoint. Claude reviewed that RED as `UPDATE_EXPECTATION` and the resulting 1/1 GREEN as
  `PROCEED`, with no blocker, high, or medium finding.
- Final exact-worktree Claude review returned `PROCEED` with no blocker, high, or medium finding.
  Its optional observation about the phrase "immediately before Sync" drove a literal second
  exact-frame assertion inside the Sync helper for both commands. A no-build rerun against the
  later feed smoke's incompatible autosync-off bundle failed before that assertion; Claude
  confirmed the skip precondition was violated and required the strict missing-key check to stay.
  The fresh standalone autosync-on field smoke then passed with the new assertion exercised.
- Hosted implementation run `29223172342` is green at
  `0382f96b582b4efd9a751b8b81c76be58f719691`. `Verify flagship artifact` completed in 3m49s,
  `Unit + property suite` completed in 4m30s, and `Packaged macOS convergence` completed in 11m24s.
  Stable-relay onboarding, the unchanged post handoff, the no-build clerk handoff, the no-build
  field-edit handoff, and the reactive feed smoke all passed in the required order.

## Completion claim

Complete for this scoped increment. Exact cross-runtime v3 compatibility, fresh-only LiveView
preparation, command-specific app review/signing with separate Sync, local no-cap refusal, real
packaged contested-summary and title convergence against Sim, unchanged v1/v2 evidence, hard
hosted CI, cumulative docs, and final independent review are green. This completion does not claim
the deferred or parked work above.
