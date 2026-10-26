# Witness drain and owner-check overlap

## Current status

The production repair is published in PR 178. Required independent/adversarial
reviews and all local gates pass. The final published tip, 191e403dd, passes
Flagship 40273421121 and browser 40273420992. That gated repair is now adopted
into the native evaluator; its combined integration gate remains separate.

## Baseline finding

A PR 178 predecessor hosted native tracing run failed its usable-owner reuse control after the actual registry became idle. At the diagnosis checkpoint, only documentation had changed relative to that failing source. Passive registry observation fixed test interference but does not serialize internal owner reads.

The initial deterministic diagnostic on that baseline uses the actual NativePending, NativeDrain and WitnessOwner plus the existing test-only snapshot gate. The native dispatch check succeeds. The receiver then holds the owner mutex during its final current check. The physical drain completes. A finalizer-style owner check fails and permanently refuses the live owner; releasing the receiver yields cancelled. No sleeps, public polling, owner closure or production changes are involved. This proves the interleaving is possible; it does not prove every detail of the hosted scheduler.

The run_finished test flag is set on entry into finalization, before drain waits and the final owner check. The original test comment claiming it included the final owner check was corrected.

## Implementation contract

Preserve physical NativeDrain semantics and WitnessOwner's conservative refusal policy. Add an explicit flow-owned completion barrier for cancellation response consumption. The flow must retain its operation reservation until both the native callback has physically drained and its cancellation receiver has completed its final owner check. Only then may finalization query owner eligibility and release the slot. Do not solve this by deleting the successful-reuse control, polling admission, adding sleeps or increasing deadlines.

1. Trace every cancellation producer and terminal path, including registration failure, known-unlaunched and unknown callback failure. Define one completion token owned by the cancellation consumer. Reserve it before dispatch becomes observable; complete it on every normal/error/unwind exit. Failed or indeterminate native callbacks still retain the existing physical-drain refusal.
2. Extend finalization's existing registration/drain loop to wait for cancellation consumption outside the flow mutex, then recheck registration/generation before its final owner snapshot. Avoid waiting for work whose completion depends on finalization itself. Do not broaden physical drain into a promise about a dropped receiver.
3. Add a gated regression that drives the actual flow: hold the cancellation receiver's owner snapshot after callback completion, prove the operation remains reserved without another owner read, then release it and require a fresh public operation to execute and receive successfully. Keep explicit closed-owner and unknown-failure controls.
4. Correct run_finished naming/comments to describe entry into finalization. Apply the generic barrier consistently across the cancellation family, rather than patching one test's scheduling.
5. Obtain independent specification and standards reviews plus the requested adversarial review; run both native all-target configurations and constrained-runtime witness repeats with exit propagation. Run applicable full repository checks and one final exact-tip hosted gate. Carry the gated change into dependent source/native branches before claiming their integration complete.

## Operator decision

The operator approved finishing the production completion-barrier fix in PR 178. Preserve the catalog changes, owner lock-contention refusal policy and existing success/refusal controls. A separate PR or owner-policy change is not selected.

## Local evidence

Diagnostic patch: /tmp/lattice-witness-internal-owner-overlap-diagnostic.patch

Failing run: /tmp/lattice-witness-internal-owner-overlap-red.log (one test, deterministic failure, exit 101). The preliminary diagnostic remains saved outside the committed suite. The normal suite now contains a gated regression through the actual WitnessFlow cancellation path. Removing only the new sequencing checks deterministically fails its finalization-wait assertion; restoring them passes and permits a fresh public operation. Reviews and local gates are complete; the hosted gate was still pending at that checkpoint; its final result is recorded above.

## Finalization handshake and fixture scheduling

Independent review found the reverse ordering: cancellation can reserve after
finalization starts its own owner check. The flow now marks that check under its
mutex, clears/notifies with a scoped guard after the query, and defers cancellation
dispatch on the condition variable. Reservation can still mark cancellation during
the query, and finalization rechecks state before publication/release. It never
holds flow state during an owner query.

A second actual-flow gate holds the finalizer's owner snapshot, drops the caller,
observes cancellation waiting before dispatch and the actual slot reserved, then
releases the query and requires cancellation plus successful public reuse.
Removing only the dispatch handshake fails that assertion; restoring it passes.

The added gates exposed fixture runtime starvation: two independent tests can
hold both workers while waiting for tasks that must run on that same runtime.
Fake callback waits now use blocking workers; only the two deliberate synchronous
owner-lock tests share a fixture gate. Twenty complete 17-test constrained runs
passed after that change. The final repeat tightens its observer to require
finished registration and all physical drains before marking consumer wait.
These were intermediate results. Both final native configurations, full repository
checks and adversarial review subsequently passed, as recorded below. The hosted gate was still pending at that checkpoint; its final result is recorded
above. Superseded checkpoints are not final signoff.

## Verified local checkpoint

The final tightened observer passes twenty complete 17-test witness-family runs
with two runtime workers and four test threads. Both ordinary and tracing native
all-target suites also pass with two runtime workers, after moving the plugin-hook
fixture's fake callback wait onto a blocking worker. Desktop typecheck/tests and
both boundary security scans pass. The full mix check also passes; the final hosted
exact-tip result is recorded above.

Final independent specification and standards reviews find no actionable issue.
Actual first-party Sonnet 5.5 High reports no P1/P2; its optional observer hardening
is implemented. The hypothetical poisoned-state/panicking-owner hardening has no
identified reachable production trigger and is not added to this bounded repair.
The final state recheck remains in place, and comments clarify that run_finished
means entry into finalization rather than completed owner checking.

The final full mix check exits successfully: core 899 tests/26 properties and
carrier 643 tests, zero failures; carrier platform skips/exclusions remain
explicit. Final local checks are complete and the approved repair is published.
The final exact-tip hosted gate subsequently passed, as recorded above. Adoption
does not replace the dependent native branch's combined integration checks.
