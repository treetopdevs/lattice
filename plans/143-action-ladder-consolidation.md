# Plan 143: Consolidate the versioned action ladder (pay down accretion)

## Status

IN PROGRESS — coverage migration and descriptor/composable consolidation are active.

## Priority

**P2 — do after 140/141/142 and before any v7 action.** This is the first plan in ~115 whose
deliverable is *fewer* lines, not more. It must run before the next feature slice or the
consolidation only gets more expensive.

## Why this exists

Five versioned action handoffs (v1 post, v2 clerk-status, v3 field, v4 roster, v5 grant)
landed by pure accretion: ~2,150 insertions against 4 deletions in `township_web` across the
five, per-version marginal cost flat at ~400–540 lines, `App.vue` grown 167 → 2,336 lines as
the only component in the app, and each packaged smoke a new 700–900-line file at 71–79%
line-similarity with its predecessor. The wire/parser/signing **core** is genuinely
converged and is NOT the target here. The target is the duplicated UI and test estate, and
the tests that pin it in place.

## Coverage-migration prerequisite (do first, in this plan)

Replacement coverage must land **before** any source-layout or prose-pinning assertion is
removed. The existing tests mix brittle pins with real behavior, API, configuration, and
non-overclaiming contracts; only the brittle part may be retired:

- Replace `clients/township-tauri-shell/test/frontend_shell.mjs` source slices, exact
  `ref<…>(null)` declarations, and function-name regexes with composable/component behavior
  tests. Preserve rendered non-overclaiming copy, trace redaction, boot ordering, and re-entry
  refusal as executable behavior assertions. Keep package-script, Tauri config, Cargo feature,
  and hosted-workflow wiring in one small config-contract test rather than pretending a mounted
  component covers them.
- Replace the markdown-prose greps in `apps/*/test/**/plan_contract_test.exs` with a single
  non-prose contract. Preserve the existing `function_exported?` checks for the WebSocket client,
  carrier adapter, and Holder APIs; those are runtime API contracts, not documentation pins.
- Record a green baseline, add each replacement assertion, prove it fails when its behavior or
  contract is deliberately removed, and only then delete the superseded source/prose assertion.

## Objective

Adding a v(N+1) action touches a bounded, small set of sites (target: one descriptor entry +
one generic path per layer), not ~13 edit sites in `App.vue` plus parallel blocks in four
files. No behavior change; every existing gate stays green.

## Scope

### Included — the extractions

- **Phoenix**: replace the per-version `handle_event`/`retain_*`/`clear_*`/`*_intent_form`
  clusters in `instrument_live.ex` with intent-slot descriptors and one generic
  handler/retain/clear path. The descriptor must model form-backed command variants and the
  model-derived, formless status slot explicitly rather than forcing them into one false shape.
  Collapse the six near-identical `<section :if={@source_state == :fresh}>` panels in
  `instrument_live.html.heex` into one `<.intent_panel>` function component. Kill the twin
  28-line `initialize_action_intent`/`clear_action_intent` lists (the manual-sync hazard) by
  deriving both from the descriptor list. Rename the fossil `retain_action_intent` (it is the
  v1 *post* slot, not a generic).
- **Vue**: extract an `IntentReviewPanel` component and a `useActionIntent(version)`
  composable so the five accepted-intent refs, `sign*`/`dismiss*` pairs, dev-trace
  route pairs, and per-version trace helpers collapse to one parameterized path. Replace the
  five copies of the byte-identical `trace*IntentDevControl` helper with one taking the slot
  name. Replace the shared `actionIntentStatus` ref (currently clobbered across five flows)
  with per-slot status owned by the composable.
- **Smoke tests**: extract the ~500 lines of copy-pasted process/trace/KV harness shared by
  `tauri_*_action_handoff_smoke.ts` into `test/support`; each smoke keeps only its
  slot-specific choreography.

### Explicitly deferred

- No new action version. No custody/boundary change. No wire-contract change (the frozen
  v1–v5 envelopes stay byte-identical).

## Required gates

- The full behavior suite green **before and after**, proving no regression: LiveView
  instrument tests, TS parser/action/dispatcher tests, all packaged smokes, hosted flagship.
- A net **negative** production diff in `App.vue`, `instrument_live.ex`, and the heex, measured
  separately from deleted test lines; and a separately net-negative smoke estate after shared
  support extraction. Coverage removal cannot be used to satisfy either count.
- Demonstrate the new marginal cost: a short note in the plan showing the exact sites a
  hypothetical v6 would touch under the new structure (do not implement v6).

## STOP conditions

- If any extraction forces a change to a frozen wire envelope or a custody boundary, STOP —
  that is out of scope and means the seam was drawn wrong.
- If removing `plan_contract_test.exs` reveals a doc invariant genuinely worth keeping,
  re-express it as one doc-lint assertion, not a per-plan prose grep.

## Non-claims

- No behavior change, no new capability, no G1/Phase G or W4 movement. This plan's entire
  value is a lower marginal cost for the next real feature.

## Vue preservation constraints

- `IntentReviewPanel` forwards the native click `Event` unchanged. The composable keeps the
  existing `event && !event.isTrusted` refusal, while calls with no event remain the explicit
  development-control path.
- Each controller owns its status, but the shell projects only the most recently written slot
  into the existing single status line in the Post panel. This removes state clobbering without
  changing the rendered last-writer-wins location or tone.
- v1 post and v2 status retain their existing shared submission lifecycles. A controller must
  observe `postSubmitting` or `statusSubmitting`; it may not create a competing guard that can
  drift from the standalone Post or Matter status surface.
- The combined `township://dev/action-intent/submit` v1 path remains bespoke. Generic slot
  routing covers only `action-{slot}/{use,sign}`, and one carrier sync still emits all five
  redacted slot trace outcomes.

## Likely files

- `apps/township_web/lib/township_web/{instrument_live.ex,instrument_live.html.heex,action_intent.ex}`
- `apps/*/test/**/plan_contract_test.exs` (removal)
- `clients/township-tauri-shell/src/App.vue` (+ new component/composable files)
- `clients/township-tauri-shell/test/frontend_shell.mjs`,
  `test/tauri_*_action_handoff_smoke.ts`, `test/support/`

## Completion claim

Complete when the ladder is descriptor-driven, the source-text/prose tests are gone or
demoted, every behavior gate is still green, and the net line count fell.
