# Plan 137: Versioned roster action handoff (toward G1)

## Status

DONE

## Objective

Advance the remaining participant-control frontier with one fail-closed v4 roster handoff across
the existing LiveView-to-Tauri custody seam. A fresh carrier-backed `/township` instrument prepares
an unsigned `admit` or `remove_member` request; the paired app validates and reviews it, selects
persisted local capability evidence, derives dependencies from its local frontier, signs through
the native key boundary, and publishes only after a separate explicit Sync.

v1, v2, and v3 remain exactly unchanged. The contract's one v4 command union bundles both `admit` and
`remove_member`; it does not reinterpret or widen the post, clerk-status, or field-edit
versions.

The real packaged gate must exercise both commands through one installed clerk app identity. Its
stronger case signs an observed remove from a base where the contested member already exists,
admits a concurrent add from a distinct authorized peer, and requires the stable source, Tauri
feed, and LiveView projection to match the independent `Lattice.Sim` OR-set add-wins result after
explicit Sync.

## Why this increment

- Plans 048 and 051 already provide cap-gated local `admit` and `remove_member` authoring plus Vue
  controls. Rebuilding those controls would not cross a new runtime boundary.
- Plan 054 already persists onboarding-issued delegation evidence. This increment consumes that
  evidence through the real app custody path instead of inventing another cap source.
- Plans 130, 135, and 136 established the frozen versioned action ladder, fresh-only LiveView
  preparation, one shared app ingress, explicit review/sign/sync steps, and hard packaged CI.
- Roster actions are the only `Township.Matter` command family with local app controls but no
  LiveView-to-installed-app handoff.
- The two member commands share one argument shape and one OR-set field. Splitting them into
  separate versions, plans, or packaged builds would be fake incrementalism.
- A concurrent observed remove and add exercises a CRDT class not covered by post, clerk-status,
  or LWW field-edit handoffs. The proof is meaningful only when the remove actually observes an
  existing add tag and the concurrent add contributes a different unobserved tag.
- Delegation/revocation lifecycle handoff, production deployment, and receipt-free W4 remain
  separate, larger frontiers. iOS, QR-camera, LAN, physical-device, cross-device pairing, and more
  Android probe variants remain parked by `TOWNSHIP_BUILD_MAP.md` section 4a.

## Dependencies

- Plan 051: generic local member command authoring, cap-aware availability, and Vue controls.
- Plan 054: persisted onboarding delegation evidence and native-custody grant ceremony.
- Plan 130: exact unsigned action ingress and LiveView-to-app custody boundary.
- Plan 136: the immediately preceding versioned argument-bearing handoff and contested packaged
  convergence pattern.
- Transitively, Plan 128 supplies the multi-realm durable relay and Plan 134 supplies the reactive
  verified-pull feed. All dependencies are `DONE`; none depends on Plan 137.

## Scope

### Included

1. An exact v4 unsigned action-intent schema for `admit` and `remove_member`, while preserving the
   exact v1 post, v2 clerk-status, and v3 field-edit producers, decoders, fixtures, and packaged
   proofs.
2. Separate fresh-only LiveView admit and remove preparation controls. The server event and handler
   fix the command; client parameters can supply only the public member argument.
3. Command-aware Tauri review and accepted-roster state that stages v4 without signing,
   persistence, draft replacement, or network activity.
4. A visible participant ceremony with three separate steps:
   Use request -> Sign roster action -> Sync outbox.
5. Covered-cap success for both commands and local no-cap refusal before operation construction,
   native signing, or KV mutation.
6. A Sim-generated sequential admit fixture plus a contested observed-remove add-wins fixture,
   exercised by a real installed macOS app against the stable path-backed relay and carrier-backed
   LiveView.
7. Hard unit and packaged CI gates that reuse the existing action-handoff app bundle, plus
   cumulative Plan 137 documentation contracts.

### Explicitly deferred

- Delegation issuance handoff, revocation handoff, succession, arbitrary authority intents, or a
  general command bus. Existing local grant/revoke controls remain unchanged.
- Automatic Sync, background authored-frame publication, server-side authoring, or operation
  materialization from an availability hint.
- Signed intents, intent receipts, cryptographic intent-to-operation correlation, cancellation,
  or duplicate intent suppression.
- Mobile secure-store implementation, iOS, Expo, physical-device behavior, QR/LAN work,
  cross-device pairing state exchange, or another Android probe variant.
- Production ingress, TLS, notarization, deployment, complete G1/Phase G, or receipt-free W4.

## Public contracts

### Frozen v1, v2, and v3 intents

Plans 130, 135, and 136 remain byte-for-byte and behaviorally frozen.

- v1 accepts only `post` with exactly `command` and `text` in its nested object.
- v2 accepts only `close_matter` or `reopen_matter` with exactly `command` nested.
- v3 accepts only `set_title` or `set_summary` with exactly `command` and `text` nested.
- All three retain their existing URL, version, key allowlist, trim, UTF-8, byte-bound, replica,
  intent-id, parser-result, and packaged behavior.
- Cross-version commands and keys remain invalid. A v1-v3 roster action remains invalid, and a v4
  post, clerk-status, or field-edit request remains invalid.
- Plan 130's post, Plan 135's clerk-status, and Plan 136's field-edit packaged handoffs remain
  unchanged and mandatory.

### New v4 roster-action intent

The canonical admit shape is exactly:

```json
{"v":4,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"admit","member":"<member>"}}
```

The canonical remove shape is exactly:

```json
{"v":4,"id":"<32-lowercase-hex>","replica":"<replica>","command":{"command":"remove_member","member":"<member>"}}
```

- One v4 command union bundles both `admit` and `remove_member`; neither command receives a
  separate version or decoder path.
- The top level permits exactly `command`, `id`, `replica`, and `v`.
- The nested command permits exactly `command` and `member`.
- Member normalization is a separate producer/parser contract: valid UTF-8, ASCII-edge trim,
  non-empty after trim, and at most 4096 bytes. It does not reuse post or field-text semantics by
  implication.
- `text`, capability ids, dependencies, authors, signatures, and every other field are rejected.
  Unknown versions, malformed base64url, unsupported commands, and cross-version keys fail closed
  in both runtimes.
- Replica and intent-id validation remain no weaker than v1-v3. `id` is still only an unsigned
  diagnostic correlation label and never enters the authored operation.
- The app requires the intent replica to equal the saved pairing replica before acceptance and
  again immediately before signing.

### LiveView preparation

The connected instrument exposes separate roster forms only while its carrier source is fresh.
The event name and server handler fix the command; no client-sent `command` parameter selects or
replaces it.

- `prepare_admit` emits v4 `admit` with the submitted public member id.
- `prepare_remove_member` emits v4 `remove_member` with the submitted public member id.
- Verified-bundle, connecting, stale, unavailable, and unverified states do not prepare a roster
  request.
- One independent roster-request slot is shared by both commands. It survives only while the
  source remains fresh and the replica remains unchanged, and clears on freshness loss, replica
  replacement, another prepared roster request, or producer validation failure.
- Preparing a roster request does not clear or overwrite prepared post, clerk-status, or field-edit
  requests, the Phoenix post draft, or unrelated app drafts.
- Phoenix receives no participant identity, private key, capability, delegation frame, dependency
  frontier, signature, authored operation, or semantic-authority verdict.

### Tauri custody ceremony

The decoder extends the existing discriminated `TownshipActionIntent` union with
`TownshipRosterActionIntent`. The shared deep-link dispatcher remains one listener and stages v4
through the same inert ingress seam as v1-v3.

The pending review panel shows the command-specific action and bounded public member id. `Use
request` moves v4 into a separate accepted roster-action state. It does not invoke native signing,
mutate local storage, replace unrelated accepted state or drafts, or touch the network. The accepted
state exposes `Sign admit` or `Sign remove member`.

Signing calls the existing `submitTownshipCommand/1` path. The app alone selects persisted
capability evidence, derives dependencies from its persisted local frontier, invokes the native
signer, and appends local log/outbox evidence. Sign does not Sync; `Sync outbox` remains a separate
existing control.

Test-only development routes drive those same production functions through the existing
`township-dev-trace` Cargo feature and Vite environment. No new compile-time flag or app variant is
allowed. The trace exposes only member digests needed by the packaged projection and never a raw
member id or complete action URL.

### Covered-cap and no-cap boundaries

The packaged clerk fixture has persisted capability evidence for both roster commands. Both covered
commands must reach the existing public authoring seam and produce the exact Sim-derived frame from
the app's current frontier.

A participant whose persisted delegations do not include the requested roster command fails locally
as `missing_delegation` before operation construction.

Focused signer and KV-write spies prove zero native signatures and zero KV writes. Native key and
KV reads remain allowed because identity and delegation discovery precede refusal; relay is not a
dependency of author-only submission.

Roster membership is a capability-gated OR-set. This plan is not an authority-quarantine or authority-role proof.
It does not claim substrate `:not_holder` and does not reinterpret the clerk-only `clerk_locked?`
authority field.

## Independent oracle and packaged proof

`Lattice.Sim` is the independent oracle. A BEAM fixture starts from an onboarding-capable Township
simulation and derives every expected signed frame, op id, read model, and replay frame.

### Concurrent observed-remove sequence

1. The contested member is already admitted at the shared base frontier. The base therefore
   contains an existing OR-set add tag that the participant's remove can causally observe.
2. The stable path authorizes the installed clerk participant, a distinct authorized peer relay realm,
   and a pull-only observer. Persisted clerk evidence covers both roster commands; the resident
   peer's persisted Sim capability covers `admit`.
3. A fresh LiveView prepares v4 `remove_member` for the contested member. LaunchServices delivers
   it; the clerk app stages, accepts, and signs one remove frame from the shared base frontier while
   leaving it pending.
4. Before participant Sync, the distinct authorized peer relay submits a Sim-generated `admit` for
   that same member whose dependencies are also the shared base frontier.
   The proof requires that both roster operations are concurrent from that shared base and
   capability-valid on both branches.
5. The source now contains only the peer branch while the participant frame remains pending. The
   outbox frame remains byte-identical to Sim's expected base-frontier remove immediately after the
   peer relay and again immediately before Sync. A non-empty-outbox assertion is insufficient.
6. The participant explicitly Syncs its already-signed remove. The remove retires only the base tag
   it observed; the concurrent peer add tag survives. Sim independently decides the observed-remove add-wins
   result rather than a hand-authored expected member set.
7. Stable source, Tauri feed, and LiveView must all match Sim's exact op ids, member set, denied
   mutations, and causal replay after the contested merge.

### Sequential admit sequence

The same installed app then receives v4 `admit` for a new member, stages and signs it inertly,
proves the pending frame and unchanged source, invokes separate Sync, drains only after durable
acknowledgement, and converges all three surfaces to the exact Sim result.

The dedicated `tauri_roster_action_handoff_smoke.ts` must also prove:

- v1 post, v2 status, and v3 field handoffs remain runnable before it in one convergence chain;
- request ingress and Use are inert, Sign does not Sync, and the source changes only after Sync;
- the app has covered capability evidence for both roster commands while a separate no-cap control
  refuses before signing or persistence;
- no server or observer operation is authored;
- trace, native KV, rendered output, and action diagnostics contain no private seed or complete
  action URL; and
- the app bundle registers and receives the real `township://` scheme through LaunchServices.

The smoke builds when run standalone unless `TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD=1`. Hosted CI
runs it immediately after the no-build Plan 136 field smoke and before the reactive feed smoke,
with that switch set. It reuses the existing action-handoff app bundle in hosted CI. A second
Tauri build in the hosted roster step is a STOP condition.

## TDD sequence

Work one vertical slice at a time. Every GREEN preserves all prior contracts before the next RED.

1. **Plan/public-seam RED.** Add the cumulative Plan 137 contract and `IN PROGRESS` index row before
   this file. Record the missing-file failure, obtain Claude review, tighten the observed-remove
   and capability-boundary wording, then add only the reviewed plan.
2. **Cross-runtime v4 remove RED/GREEN.** Add an exact remove fixture produced by
   `TownshipWeb.ActionIntent.roster_url/4`; consume its literal URL in TypeScript. Record the
   producer function-undefined and parser unsupported-version failures before implementation.
3. **Cross-runtime v4 admit RED/GREEN.** Add admit to the same union. Prove frozen v1-v3, unknown
   versions, malformed base64url, member bounds, extra keys, `text` smuggling, and unsupported
   commands.
4. **Fresh LiveView remove RED/GREEN.** Test fresh preparation, non-fresh refusal, exact v4 URL,
   replica replacement, producer error, independent prior intents, and inability for client params
   to switch the command. Implement only remove preparation.
5. **Fresh LiveView admit RED/GREEN.** Add the parallel admit event and rendered link while keeping
   one roster request slot and preserving post/status/field behavior.
6. **App review RED/GREEN.** Extend dispatcher and frontend contracts for v4 staging, replica
   mismatch, duplicate delivery, inert Use, command-specific accepted state, covered-cap Sign for
   both commands, no automatic Sync, and unrelated-draft preservation.
7. **Capability RED/GREEN.** Pin covered availability for both roster commands under the clerk app
   fixture and no-cap `missing_delegation` with zero signer/KV-write calls.
8. **Packaged observed-remove RED/GREEN.** Add the Sim fixture and installed-app smoke through a
   pending base-frontier remove, then relay the independent concurrent admit. GREEN requires the
   base member/tag precondition, shared deps, capability-valid branches, exact unchanged pending
   remove, and peer-only source before Sync.
9. **Explicit Sync and admit RED/GREEN.** Sync the remove and prove all three surfaces equal Sim's
   add-wins result. Repeat the complete inert/pending/Sync sequence for a new-member admit.
10. **Hard CI RED/GREEN.** Add fast v4 contracts to the unit job and a dedicated no-rebuild packaged
    step after field edit. Add the smoke to `app:convergence` before feed. A second hosted build is
    forbidden.
11. **Cumulative verification.** Run focused Elixir/TS tests, all four packaged action smokes,
    reactive feed, complete app convergence, browser/flagship lanes, pinned umbrella checks,
    warning-free compiles, xref, security/static gates, Rust tests, workflow lint, formatting, and
    exact diff checks.
12. **Independent review and closure.** Claude reviews every meaningful RED/GREEN and the exact
    final worktree diff. Hosted implementation and branch-tip closure runs must be green before
    `DONE`.

## Required gates

Focused:

- pinned OTP 28 `mix test` for `TownshipWeb.ActionIntent` and `InstrumentLive`
- `npm run typecheck`
- `npm run action-intent:contract`
- `npm run deeplink:dispatcher:contract`
- `npm run action:contract`
- `npm run frontend:contract`
- `npm run build`
- `npm run tauri:roster-action-handoff:smoke`

Cumulative:

- existing post, clerk-status, and field-edit packaged handoff smokes
- `npm run tauri:feed:smoke`
- `npm run app:convergence`
- root browser and flagship verification
- pinned OTP 28 `mix verify` and `mix check`
- forced test and production warnings-as-errors compiles
- xref, both HTTP-boundary Sobelow scans, actionlint, formatting, and `git diff --check`
- hard hosted unit, flagship, and packaged macOS jobs

## STOP conditions

- Any change to v1, v2, or v3 payloads, accepted commands, bounds, parser results, fixtures, or
  packaged behavior.
- Any v4 `text`, cap, dependency, author, signature, unknown command, or unknown field accepted by
  either runtime.
- Either roster command split into a separate version, plan, app identity, or packaged build.
- The contested member is absent at base, the remove does not observe its base add tag, the two
  roster ops do not share base deps, or either branch lacks capability authorization.
- Any non-fresh LiveView source prepares a roster request or client parameters replace the
  server-handler command.
- Staging, Use request, or Sign invokes Sync, mutates the source, or replaces unrelated state.
- A no-cap participant reaches native signing, KV mutation, outbox append, or relay.
- Phoenix receives custody material, chooses participant capability/dependencies, or derives
  semantic authority.
- The packaged proof uses hand-authored expected membership, signs after learning the peer branch,
  bypasses the installed app/LaunchServices, or lets polling masquerade as reactive convergence.
- The hosted roster smoke rebuilds Tauri instead of using the immediately preceding bundle.
- Plan 130, 135, or 136 evidence is weakened, folded into the new smoke, or made optional.
- The implementation enters a parked section 4a area.
- Any claim of automatic publication, mobile completion, deployment, complete G1/Phase G, or W4.

## Non-claims

- No automatic authored-frame publication.
- No mobile secure-store implementation change.
- No delegation, revocation, or succession handoff and no general command bus.
- No authority-quarantine or authority-role proof and no `:not_holder` claim.
- No signed receipt, production ingress, TLS, notarization, or deployment.
- No complete G1/Phase G claim and no receipt-free W4 claim.

## Likely files

- `apps/township_web/lib/township_web/action_intent.ex`
- `apps/township_web/lib/township_web/instrument_live.ex`
- `apps/township_web/lib/township_web/instrument_live.html.heex`
- focused `apps/township_web/test/township_web/*` tests
- `clients/township-tauri-shell/src/township_action_intent.ts`
- `clients/township-tauri-shell/src/township_deep_link_dispatcher.ts`
- `clients/township-tauri-shell/src/App.vue`
- focused TypeScript intent, dispatcher, action, and frontend contracts
- new v4 fixtures and a Sim roster-concurrency fixture
- `clients/township-tauri-shell/test/tauri_roster_action_handoff_smoke.ts`
- stable-server multi-realm helpers, package/workflow gates, and cumulative docs

## Pre-implementation evidence

- Live code inspection confirms `admit` and `remove_member` already use the generic app-owned
  authoring path and have cap-aware Vue controls. The missing behavior is their versioned
  cross-surface handoff and a real roster convergence proof.
- Plan 054 already persists resident `admit` capability, while the clerk/root path can authorize
  both roster commands. The packaged fixture therefore uses the clerk app for covered Sign and a
  resident peer for the concurrent authorized admit; a separate under-provisioned fixture proves
  no-cap refusal.
- `Lattice.Reduce` implements OR-set remove by intersecting the removed element's add tags with the
  remove op's causal ancestors. The shared-base fixture can therefore prove a real observed remove
  while a concurrent add tag survives.
- Claude ranked the bundled v4 roster handoff ahead of delegation/revocation and deployment. Its
  first contract review returned `PROCEED` after requiring the base-member precondition,
  shared-base concurrency, capability-valid branches, and the non-authority distinction.
- The cumulative contract failed first with 11 tests, 1 failure because this plan file was absent.
  Every prior plan contract remained green.

## Implementation evidence

- Exact v4 remove and admit producer/parser slices were driven from failing cross-runtime fixture
  tests. The one union accepts only the two roster commands and exact key sets, enforces independent
  member bounds, rejects cross-version and smuggled fields, and leaves v1-v3 fixtures and behavior
  frozen. The focused producer plus connected LiveView slice passes 21 ExUnit tests; Claude reviewed
  each meaningful RED/GREEN and returned `PROCEED`.
- The fresh-only LiveView forms preserve the three prior prepared-intent slots while sharing one
  roster slot. Paired validation-error REDs prove both forms scope feedback to the public source
  replica: same-replica feedback remains visible, while replacement clears the error and form. The
  shared dispatcher and app stage v4 inertly, render command-specific review, preserve unrelated
  accepted state and drafts, recheck the paired replica immediately before Sign, author through the
  existing app-owned command path, and leave Sync separate. Typecheck, action-intent, dispatcher,
  action, build, and 36 frontend source contracts are green. The focused post-only participant
  control proves both roster commands stop as `missing_delegation` with zero signer calls and zero
  KV writes, while the covered clerk path authors both commands through the same public seam.
- The BEAM fixture supplies an existing base add tag, exact shared-base remove and concurrent peer
  admit frames, capability-valid branches, a sequential admit neighbor, and `Lattice.Sim` read
  models. The real installed-app smoke is green through LaunchServices: ingress and Use remain
  inert; Sign leaves the exact base-frontier remove pending and byte-identical across the peer
  relay; explicit Sync converges stable source, Tauri feed, and LiveView to Sim's observed-remove
  add-wins result; and the same app repeats the complete admit ceremony. Redaction checks exclude
  private seeds, raw member ids, complete action URLs, and server/observer authorship.
- Hard CI wiring runs the roster smoke exactly once after the no-build field smoke and before feed
  in both `app:convergence` and the packaged macOS job, with
  `TOWNSHIP_SKIP_ROSTER_ACTION_APP_BUILD=1`. The cumulative contract first exposed Plan 136's
  obsolete `field -> feed` adjacency; the reviewed test-only GREEN leaves Plan 136 owning
  `clerk -> field` and Plan 137 owning `field -> roster -> feed`. The resulting plan contract passes
  11 tests and the complete app convergence chain passes onboarding, post, clerk-status, field,
  roster, reactive-feed, and installed deep-link gates against one shared app bundle.
- Complete local regression passed on 2026-07-13. Pinned OTP 28 `mix verify` and `mix check` each
  pass 389 tests plus 25 properties; forced test and production compiles are warning-free; xref
  retains the unchanged five-cycle baseline; both Sobelow boundaries, actionlint, formatting, and
  diff hygiene are green; and all 23 Rust native/runtime tests pass. The standalone roster smoke
  also builds the current Tauri bundle and passes independently of the no-build cumulative run.
- Browser and flagship verification passes six static instrument cases, real carrier pull,
  stable-server restart, generic browser restart/resume, Worker isolation, recorded flagship video
  evaluation, production action handoff, and regenerated graph/claims validation. The stable-server
  gate first failed because its exhaustive fresh-event whitelist omitted the two new roster forms;
  the reviewed test-only GREEN adds both events and asserts no prepared roster handoff in fresh,
  stale, or restarted-fresh state. Claude returned `PROCEED` for the RED and the resulting 1/1
  GREEN with no weakening of v1-v3 coverage.
- Claude has returned `PROCEED` on every meaningful implementation, capability, packaged, CI, and
  cumulative evaluation. Its exact final-worktree review found no blocker, high, or medium issue;
  its one low replica-feedback observation drove the paired TDD slice above, and the resulting
  review left the commit-readiness verdict unchanged.
- Hosted implementation run `29233959489` is green at
  `cae78810b7858064a5c4ab07db950057a367df70`. `Verify flagship artifact` completed in 3m40s,
  `Unit + property suite` completed in 4m51s, and `Packaged macOS convergence` completed in 7m46s.
  Stable-relay onboarding, the unchanged post handoff, the no-build clerk handoff, the no-build
  field-edit handoff, the no-build roster handoff, and the reactive feed smoke all passed in the
  required order.

## Completion claim

Complete for this scoped increment. Exact cross-runtime v4 compatibility, fresh-only LiveView
preparation, command-specific app review/signing with separate Sync, local no-cap refusal, real
packaged observed-remove add-wins and sequential-admit convergence against Sim, unchanged v1-v3
evidence, hard hosted CI, cumulative docs, and final independent review are green. This completion
does not claim the deferred or parked work above.
