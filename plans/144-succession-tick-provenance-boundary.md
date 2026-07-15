# Plan 144: Succession tick-provenance boundary

## Status

IN PROGRESS - executable RED/GREEN, mutation, full local, and Claude final-audit evidence is green;
the hosted gate remains open.

Hosted flagship run `29373501735` passed all three jobs at exact Plan 139 tip
`0e4d2b0fff8cdac281fd64f2b4e0ed923c8770c5`. That lands and isolates the prerequisite slice, so
Plan 144 may now begin as a separate TDD increment. This hosted result is prerequisite evidence,
not Plan 144 implementation or completion evidence.

The focused implementation checkpoint is green: RED 1 failed on the missing named vector before
the Sim exporter supplied it; RED 2 failed on the missing TypeScript metadata contract before the
test-only shape was added; and both focused suites now pass. A temporary `at_tick: 2` mutation
changed the clerk winner and failed the exporter assertion, then the intended `at_tick: 1_000_000`
was restored. Full OTP 28 `mix check`, both Sobelow boundary scans, and Claude's exact-worktree
claim review are green; its final publication audit also found no P0-P2 issue. This is
characterization evidence only; the hosted completion gate below is still open.

Originally planned against commit `020c1f64d706` on `codex/township-build-map`, with the live Plan
139 worktree intentionally left dirty and preserved at planning time.

## Objective

Make the remaining Township succession limitation executable and impossible to mistake for a
production dormancy proof:

- prove that BEAM and TypeScript already agree on `Township.Matter` heartbeat/succession reduction;
- add one adversarial cross-oracle vector showing that a successor-signed but otherwise unproven,
  arbitrarily inflated `at_tick` is honored immediately by the current semantics; and
- record that user-facing succession authoring remains blocked until a separate design selects an
  honest tick/liveness provenance model.

Completion of this plan characterizes and gates the limitation. It does not fix tick provenance
and must not mark succession complete.

## Current State

### What is already real

- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` emits
  `township_succession_w3` over `Township.Matter`: a genesis clerk policy, clerk heartbeat at tick
  1, resident succession at tick 4, a stale clerk close, a resident close, merged carrier frames,
  and the BEAM authority quarantine.
- `clients/lattice-client/src/carrier.ts` decodes genesis policies, `heartbeat`, and `succeed`.
- `clients/lattice-client/src/authority.ts` mirrors the BEAM visible-ancestor dormancy calculation.
  Plan 140 removed the old succession refusal, and generic conformance reduces every checked
  vector.
- `apps/lattice_core/test/township/export_vectors_test.exs` requires the existing W3 vector.

Do not duplicate any of that work and do not describe succession as absent from the reducer.

### What is not proven

- `Sim.succeed/4` accepts `at_tick` from the successor call and places it directly in the signed
  operation.
- `Lattice.Authority` checks that value against visible acquire/heartbeat ticks, but does not bind
  it to `Lattice.Clock`, a carrier generation, a causal-height rule, a quorum, or any other
  independent source.
- `Lattice.Clock` is an in-process Agent advanced only by tests/demo; no authoring or carrier path
  reads it when building a heartbeat or succession operation.
- The signature authenticates that the successor asserted the tick. It does not prove that much
  logical time elapsed or that the current holder was unavailable.
- `clients/lattice-client/src/township.ts` deliberately has no heartbeat/succession authoring API.

An OTP 28 probe against the planned commit reproduced the consequence with no heartbeat and no
clock advancement:

```text
at_tick: 1_000_000
%{verdict: false, resident_is_clerk: true}
```

`verdict: false` is `Sim.quarantined/3` reporting that the inflated-tick succession was honored.

## Scope

### 1. Add one named adversarial oracle scenario

Add `township_succession_unproven_tick` to the existing Sim exporter. It must:

- use `Township.Matter`, a clerk root, and a genesis policy naming the resident as successor with a
  non-zero dormancy threshold;
- author no heartbeat and perform no logical-clock advancement;
- let the resident immediately author `succeed` with a deliberately large `at_tick`;
- prove the current BEAM result exactly: the succession operation is not quarantined and the
  resident becomes clerk; and
- export real carrier frames, the realm map, BEAM authority quarantine, the succession operation
  id, and an explicit `tickProvenance: "author_asserted_untrusted"` marker.

The marker is evidence metadata, not authority input. Production reduction must not branch on it.

### 2. Make the current limitation cross-oracle executable

Extend the existing TypeScript conformance harness only enough to make the adversarial vector's
claim explicit:

- independently decode/verify the exported carrier frames through the existing path;
- assert the named succession operation is absent from both structural and authority quarantine;
- assert the Sim-pinned clerk winner is the resident; and
- assert the provenance marker is exactly `author_asserted_untrusted`.

Generic state/quarantine/winner equality remains the primary BEAM-to-TypeScript gate. Do not add a
second succession reducer or a special production-materialization path.

### 3. Correct the claim boundary

- Rename the W3 workflow test so its title says what that test actually proves: Township
  dump/restore survival. The existing exporter/conformance vector continues to own the Township
  succession-reduction claim.
- Amend `docs/adr/0004-succession-validation.md` to distinguish an author-signed tick from
  independently proven logical time and to state that `Lattice.Clock` is not currently wired into
  operation authoring.
- Update `docs/lattice_poc_status.md` and `TOWNSHIP_BUILD_MAP.md` so W3 reduction remains credited,
  while user-facing succession stays blocked on tick/liveness provenance.
- Keep the carrier server's transport-only identity and authority-oracle non-claim unchanged.

### 4. Produce the next-decision input

The plan's final notes must name, without selecting by implication, the questions a future
remediation design must answer:

- Who or what advances a tick, and under which trust anchor?
- How is fast-forward by the designated successor rejected?
- How are monotonicity, replay, restart, and rollback handled?
- What does a partition mean: holder failure, successor-local absence, or an explicit availability
  tradeoff?
- Does a carrier become semantic liveness authority, does a quorum attest ticks, is dormancy
  redefined as causal activity distance, or is production succession removed?

That future design requires its own adversarial review and plan. This plan must not smuggle in a
choice through a helper API or UI label.

## TDD Sequence

### RED 1 - exporter contract

In `apps/lattice_core/test/township/export_vectors_test.exs`, first require the new vector file and
parse it to assert:

- `tickProvenance == "author_asserted_untrusted"`;
- the named inflated succession id exists in the carrier evidence;
- that id is absent from BEAM authority quarantine; and
- the expected clerk winner is the resident.

The provenance-marker equality is a label-integrity guard only. The load-bearing behavioral pins
are the honored succession id and resident winner; the mutation below must exercise those.

Run the focused exporter test and capture the missing-vector RED before changing the exporter.

### GREEN 1 - Sim-generated evidence

Add the smallest exporter scenario and metadata pass-through needed to satisfy RED 1. Regenerate
the checked vector with the pinned OTP 28 toolchain. Do not change `Lattice.Authority`,
`Lattice.Clock`, `Lattice.Sim`, or `Township.Matter` in this slice.

### RED/GREEN 2 - explicit TypeScript diagnostic

Add the conformance assertions for the new metadata/id before adding the corresponding `Vector`
shape and handling. The first typecheck or conformance run must fail on the missing contract; then
make only the harness/fixture changes needed for GREEN.

As a mutation check, temporarily reduce the exported succession tick below the dormancy threshold.
The focused exporter assertion must fail because the operation becomes quarantined and the winner
does not move. Restore the adversarial tick immediately after the mutation proof.

### GREEN 3 - claim-boundary documents

Apply the W3 title and documentation corrections only after the executable evidence is green. The
wording must say both truths together: deterministic succession reduction exists, and trustworthy
dormancy provenance does not.

## Expected Files

- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`
- `apps/lattice_core/test/township/export_vectors_test.exs`
- `apps/lattice_core/test/township/workflows_test.exs` (title only)
- `clients/lattice-client/test/conformance.ts`
- `clients/lattice-client/test/vectors/township_succession_unproven_tick.json`
- generated `clients/lattice-client/dist/test/conformance.js` if the normal build requires it
- `docs/adr/0004-succession-validation.md`
- `docs/lattice_poc_status.md`
- `TOWNSHIP_BUILD_MAP.md`
- `plans/README.md`
- this plan

Any production shell, LiveView, carrier, or authority-engine edit is scope drift and requires a
new plan.

## STOP Conditions

- Stop if the work starts adding `authorTownshipHeartbeat`, `authorTownshipSuccession`, a v7
  action intent, a Tauri button, or any other participant authoring surface.
- Stop if a wall clock, process uptime, carrier generation, causal height, or arbitrary client
  counter is presented as trustworthy dormancy without a separately reviewed trust model.
- Stop if the test is changed to call the inflated tick valid elapsed time. It is current accepted
  behavior and a security/claim limitation, not a positive liveness guarantee.
- Stop if the change modifies authority semantics, operation wire shape, genesis policy format, or
  the current honest-tick W3 vector. Those are remediation/migration work.
- Stop if the work adds another two-BEAM, socket, packaged-app, Android, iOS, or physical-device
  permutation. Transporting the same self-asserted tick adds no provenance evidence.
- Stop if Plan 139 is not hosted-green and isolated before implementation begins.
- Preserve Plan 077 parked-device boundaries, Phase F/M4 text, W4 non-claims, and the carrier-BEAM
  authority-oracle boundary.

## Verification

Use the local asdf/OTP 28 rule from `AGENTS.md`; never invoke the Homebrew Erlang or broken mise
shim.

```sh
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" \
  MIX_ENV=test "$HOME/.asdf/shims/mix" test \
  apps/lattice_core/test/township/export_vectors_test.exs

PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" \
  MIX_ENV=test "$HOME/.asdf/shims/mix" lattice.export_vectors \
  --out clients/lattice-client/test/vectors

cd clients/lattice-client && npm run conformance
cd clients/lattice-client && npm run typecheck

PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" \
  MIX_ENV=test "$HOME/.asdf/shims/mix" check

git diff --check
```

Run Claude Code first against the RED evidence, again against the GREEN diff, and finally against
the exact claim wording. The final review must specifically check that the vector is not being
described as a fix and that no authoring surface slipped in.

## Completion Gate

Plan 144 is `DONE` only when:

- the named adversarial vector is Sim-generated and checked in;
- BEAM and TypeScript both explicitly pin current inflated-tick acceptance;
- the mutation check proves the assertion is load-bearing;
- the W3 survival/reduction wording is accurate;
- the docs block user-facing succession on provenance rather than calling the reducer absent;
- focused and full local gates pass;
- Claude returns no P0-P2 finding on implementation or claims; and
- a new hosted flagship run passes the exporter and conformance chain.

Even then, succession remains incomplete. A later remediation plan must select and implement the
tick/liveness trust model before any user-facing succession ceremony can begin. That remediation
is expected to intentionally replace this characterization vector's accepted-inflated-tick
expectation rather than preserve it as desirable behavior.

## Second Opinion

Claude Code's first read-only review correctly rejected a v7 ceremony but initially missed the
existing `Township.Matter` W3 exporter/conformance evidence and proposed duplicate work. After the
live vector and Plan 140 evidence were supplied, its focused reconsideration withdrew those claims
and converged on the narrow boundary here: no TS authoring, no carrier permutation, one adversarial
cross-oracle pin, and explicit provenance non-claims.
