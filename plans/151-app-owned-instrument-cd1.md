# Plan 151: App-owned instrument — Phoenix leaves the demo loop (toward CD1)

## Status

Disposition 2026-09-06: superseded for Treehouse delivery by unified packets R10-R15; their app-owned
experience reuses the verified intent/custody patterns below. Any independent Township instrument
remainder belongs to R34. This does not mark the original Township implementation complete, remove
Phoenix, or authorize additional CD1 work. The original draft follows for reference.

TODO (proposed draft — not yet reviewed or resumed by the operator). Sequenced after or in
parallel with Plan 150; it runs against the operator stable server and must not require host
mode, so the two plans do not block each other.

## Objective

Make the packaged Tauri/Vue app a **complete instrument**: it prepares its own versioned
action intents (v1-v6) from its local fresh projection and renders its own read/audit surface
(matter state, causal replay, authority and quarantine attribution, exportable outsider
bundle) — so a full W0-W3 demo storyline runs between packaged apps and a carrier server with
**no Phoenix process anywhere**. The existing review → sign → Sync custody ceremony, native
key path, outbox, and relay seams are consumed unchanged; only the *source of the unsigned
request* and the *rendering of verified state* move into the app.

The Phoenix LiveView instrument is not removed, demoted, or de-CI'd. It remains the hosted
observer surface and its gates stay green; this plan removes it as a *requirement* of the
demo loop.

Planned at commit `ba4d4eff` on `codex/township-build-map`.

## Why this increment

- The v1-v6 handoff ladder (Plans 130, 135-139) deliberately made a fresh Phoenix LiveView
  the only producer of unsigned action requests, to prove the custody boundary: Phoenix never
  receives keys, caps, deps, or signatures. That proof is complete and stays. But it leaves
  the demo dependent on a hosted web app — a center — for every action.
- Most of the app-side substance already exists: direct Vue authoring existed in Plans
  043-051 before the ladder moved preparation out; Plan 134 gives the app a verified reactive
  read-only projection; Plan 143 consolidated all intent descriptors, review surfaces, and
  ceremony routing into one runtime descriptor list; Plans 147/148 made the app's local
  TypeScript reduction authoritative for capability/revocation/authority decisions with the
  carrier report demoted to a fail-closed cross-check. What is missing is composition: an
  in-app preparation surface that emits the *same* versioned intent payloads, and an in-app
  rendering of the replay/attribution views the LiveView instrument owns (Plans 122-124).
- Without this plan, Plan 150's device-hosted server still needs an operator-hosted Phoenix
  to do anything, and CD1 is unreachable.

## Critical trust separation

- Intent preparation is not authority. An unsigned intent — whoever prepares it — conveys
  nothing until the existing ceremony rechecks the paired replica, local capability and
  delegation evidence, and frontier, then signs through native custody. Moving preparation
  in-app must not shortcut any recheck: the app-prepared intent enters the **same** staging,
  review, accept, sign, and Sync path as a deep-linked LiveView intent, through the same
  descriptor list. One ceremony, two producers.
- The versioned intent contract stays frozen. v1 remains post-only, v2 clerk-status-only, v3
  field-edit-only, v4 roster-only, v5 grant-only, v6 revocation-only. The in-app producer
  emits payloads that the existing decoder fixtures already accept; no new version, field, or
  command routing is introduced. The shared fixtures are the oracle that Phoenix-prepared and
  app-prepared intents are byte-compatible.
- The fresh-projection precondition carries over: LiveView prepares only from a fresh carrier
  projection, so the app prepares only when its own reactive projection state (Plan 134) is
  `fresh`. Stale, connecting, and unavailable states disable preparation with visible cause.
- The read/audit surface renders only locally verified state: the Plan 147/148 retained-frame
  materialization and authority analysis. It must not render carrier authority reports as
  state (they remain a fail-closed divergence check), and it must label verification failure
  by withholding authoritative values, mirroring the LiveView instrument's rule.

## Architecture

### In-app preparation through the existing descriptor list

- Extend the Plan 143 runtime descriptor list so each of v1-v6 carries an app-side
  `prepare` capability alongside its existing review/sign/dismiss arms: a pure function from
  the fresh local projection plus bounded user input to the exact versioned intent payload,
  validated against the same schema the deep-link decoder enforces
  (`clients/township-tauri-shell/src/township_action_intent.ts`,
  `use_action_intent.ts`, `township_actions.ts`).
- Command applicability derives from the local projection exactly as the LiveView handlers
  fix it today: close prepares only on an open matter, reopen only on locked, revocation only
  for delegations the local evidence shows issued-and-unrevoked, and so on. Client parameters
  must not be able to choose a different command than the surface offered — same rule the
  server handlers enforce, now enforced by the local producer and pinned by fixtures.
- Prepared intents enter the identical staging slot used by deep-link ingress, marked with a
  distinct `local` provenance for display; Use/review/sign/Sync behavior is provenance-blind.

### In-app read, replay, and audit surface

- Extend the Vue projection (Plan 134's dynamic matter view) with: causal replay scrubbing
  over locally verified frames (the Plan 124 island's interaction grammar, fed by local
  reduction instead of server-derived frames); authority timeline and holder attribution;
  and quarantine attribution with reasons from the local quarantine path (Plan 147).
- Add an audit-bundle export: exact stored signed frames plus a manifest sufficient for the
  existing BEAM outsider-replay verifier (`mix lattice.township.verify_bundle`, Plan 121) to
  replay and match — the outsider check stays BEAM-side; the app only exports bytes it
  already holds. Export is a trusted-event boundary like the Plan 146 Seam 8 export: exact
  bytes, human-readable confirmation, no carrier contact.

### The no-Phoenix storyline gate

- One consolidated packaged storyline smoke drives two app identities (issuer/clerk and
  member) through W0-W3 beats — post, clerk close/reopen, field edit, roster admit/remove,
  grant, revoked-capability refusal — entirely from app-prepared intents against the stable
  server, with `township_web` not started anywhere in the harness. `Lattice.Sim` remains the
  oracle for every beat; the bundle export replays green.

## Public TDD seams

1. Producer parity seam: for each v1-v6 fixture scenario, the app-side producer's payload is
   accepted by the existing decoder and byte-equal (canonical form) to the Phoenix-prepared
   fixture; non-fresh projection, inapplicable command, and out-of-bounds input refuse.
2. Ceremony equivalence seam: an app-prepared intent traverses staging, review, accept,
   native signing, outbox, and Sync identically to a deep-linked one — including local-cap
   refusal before signing (`missing_delegation`, no-cap) — with provenance affecting only
   display.
3. Instrument seam: the app renders replay/authority/quarantine views from local verified
   state for the Plan 139/147 adversarial scenarios (revoked-cap post absent from state and
   attributed; unsound grant `not_attenuated`/`invalid_capability`); verification failure
   withholds values; the exported bundle passes the BEAM outsider verifier.
4. Storyline seam (packaged): the two-identity no-Phoenix W0-W3 smoke above, Sim-equal at
   every beat, with restart of the carrier server mid-storyline and post-restart convergence.

## Scope

- The descriptor-list `prepare` extension, per-version producers, provenance-marked staging,
  and bounded preparation UI for v1-v6.
- The in-app replay/authority/quarantine views and audit-bundle export.
- Fixture extensions pinning producer parity; the four seams; the packaged storyline smoke
  wired into CI.
- Plan index, build map (CD1 track), and status/non-claim updates.

## Non-goals

- No new intent version, command, field, or semantic; no v7/succession surface (Plan 146
  owns that ladder).
- No removal, deprecation, or CI reduction of the Phoenix instrument, the LiveView handoff
  gates, or any hosted job.
- No TypeScript re-derivation of *server*-side preparation authority claims: parity is
  proven by fixtures, not asserted by construction.
- No change to native custody, outbox, relay, availability feed, pairing, or onboarding
  seams; no automatic publication (Sync stays explicit).
- No host mode (Plan 150), no serverless onboarding (Plan 152), no TLS/deployment, no mobile
  claim, no receipt-free W4 or G1/Phase G completion claim.

## STOP conditions

- Stop if app-prepared intents bypass or weaken any recheck, review, presence, or explicit
  Sync step of the existing ceremony, or if provenance affects ceremony behavior.
- Stop if a producer can emit a command the current surface/projection state does not offer,
  or a payload the deep-link decoder would reject.
- Stop if the read surface renders carrier-reported authority as state, renders unverified
  frames, or the export contacts the carrier.
- Stop if the storyline smoke starts `township_web` or any Phoenix process, or passes only
  with a Phoenix-prepared intent.
- Stop if any existing v1-v6 handoff gate, fixture, or hosted job is modified to
  accommodate parity rather than the producer being fixed.

## TDD plan

1. PRODUCER RED/GREEN: per-version parity fixtures fail on the absent producer; implement
   each pure producer minimally; refusal matrix (non-fresh, inapplicable, out-of-bounds).
2. CEREMONY RED/GREEN: provenance-marked staging and the equivalence seam, including the
   local-cap pre-sign refusals.
3. INSTRUMENT RED/GREEN: replay/authority/quarantine views over the adversarial fixture set;
   export + BEAM outsider-verifier round trip.
4. STORYLINE RED/GREEN: the packaged two-identity no-Phoenix W0-W3 smoke with mid-storyline
   server restart, wired as a hard CI step through the Plan 143 harness.
5. DOCS RED/GREEN: CD1 track, index row, build map, non-claims.
6. VERIFY: focused suites, both typechecks, full `npm run app:convergence`,
   `PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix verify`,
   the corresponding `~/.asdf/shims/mix check`, Sobelow boundaries, xref baseline, formatting/diff, hosted
   three-job green at the exact tip.
7. REVIEW: written-plan, per-seam, packaged, docs, and release-diff reviews with no
   unresolved P0-P2 finding.
