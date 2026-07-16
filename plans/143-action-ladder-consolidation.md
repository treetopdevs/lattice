# Plan 143: Consolidate the versioned action ladder (pay down accretion)

## Status

DONE — local TDD, full OTP 28 verification, and full packaged convergence are green. Hosted run
`29358809212` is green across the complete flagship, 42-step unit/property, and packaged macOS
jobs.

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

## Local implementation evidence (2026-07-14)

- Replacement coverage landed first. Mounted Vue/composable tests, runtime API tests, the
  executable runtime-wiring contract, and the shared packaged-smoke support contract were green
  before the superseded source/prose pins were deleted or explicitly demoted.
- RED tests proved the replacement suite was load-bearing: removing trusted-event refusal and
  native-event forwarding each failed it; the final correction cycle also failed first for an
  untracked in-flight intent, conflated busy/`Signing` state, and absent local/hosted contract
  wiring. The restored implementations pass 16 Vue behavior tests and 3 wiring tests.
- The complete local `npm run app:convergence` command exits 0 with the wiring/support contracts,
  real Playwright click-through, all five packaged action handoffs, reactive feed, and installed
  deep-link smoke. One first long-chain roster run timed out during native hydration; the isolated
  roster smoke and the full command rerun both passed. The OTP 28 `mix check` gate is green. Claude
  independently returned `PROCEED` after the correction review with no P0/P1 findings.
- Hosted run `29358809212` passed all three jobs. Its unit lane executed all 42 steps, and its
  packaged lane passed stable-relay onboarding, v1-v5 handoffs, and the reactive feed without a
  skipped required gate.

### Line accounting

- Phoenix production: `instrument_live.ex` 592 -> 497 (-95) and
  `instrument_live.html.heex` 509 -> 452 (-57).
- Vue Plan 143 slice: the captured live pre-slice `App.vue` baseline was 2,458 lines and is now
  2,130 (-328). The new composable and component are 231 + 91 lines, so Plan 143-owned Vue
  production is 2,452 (-6). For auditability, the pre-integration parent `2acd1fc7^` has a
  2,377-line `App.vue`; the composite integration-commit comparison is therefore +75 because it
  also contains 81 earlier, unrelated lines. Both baselines are stated rather than conflated, and
  `App.vue` itself is net negative against either one.
- Packaged smoke estate: 4,251 -> 3,636 (-615), including shared support and its contract. Deleted
  source/prose assertions are not counted toward any production or smoke reduction.

### Hypothetical v6 marginal cost

No v6 is implemented. A future version would touch these bounded sites:

1. Phoenix: one `@intent_slots` entry, one `@intent_events` entry per command, its payload-specific
   `ActionIntent` builder clause, and one `<.intent_panel>` invocation. Generic prepare, retain,
   clear, initialization, and rendering infrastructure stays unchanged.
2. Vue: one slot/version and label branch in `use_action_intent.ts`, one runtime descriptor plus
   submit adapter in `App.vue`, and one payload render branch in `IntentReviewPanel.vue`. Generic
   accept/sign/dismiss/status/dev routing and sync fanout stay unchanged.
3. Packaged proof: one slot-specific choreography file using `test/support/packaged_action_handoff.ts`;
   process, trace, deep-link, KV, and cleanup infrastructure is not copied again.

Hosted run `29358809212` closes the final gate, so this plan is `DONE`.

## Completion claim

Complete when the ladder is descriptor-driven, the source-text/prose tests are gone or
demoted, every behavior gate is still green, and the net line count fell.
