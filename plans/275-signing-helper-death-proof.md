# Plan 275: signing-helper death proof

## Status

IN PROGRESS. The closed-port helper-death proof, targeted ACK-bypass negative
control, repeated real kills and signing-package family pass. Full repository
checks, both boundary scans and required independent/adversarial reviews pass.
Production signing behavior is unchanged. The final exact-tip hosted gate passes and the correction is adopted locally
into the native evaluator. Its combined repository gate remains before completion.

## Contract and scope

The signing ledger releases a callback result only after durable helper ACK and
exit. Killing the helper before ACK must never release that value or advance the
ledger. The existing test uses a linked Task, so a port's asynchronous `:epipe`
exit can terminate the test observer before it checks that contract.

Use an unlinked monitored worker for this test. First prepare a real signed,
advancing proposal with the production signer and restore the fixture to genesis.
The callback reports its actual worker PID and starting head while blocked;
inspect that worker's owned port, monitor the port, kill only its verified helper
PID, and observe port DOWN plus closed-port state before releasing the callback.
Require normal worker completion with the exact ledger failure. Do not accept a
worker death that could hide an early successful return. The proposed envelope
would advance the ledger in the ordinary success path. Final unchanged genesis
bytes and an empty chain confirm fixture integrity and lock release; the exact
refusal reply is the decisive withholding oracle. Durable-write atomicity remains
covered by the existing owner-fault tests. Clean up a still-live worker on test exit and
wait for its monitor so a failed assertion cannot retain its helper/lock.

This is test-only proof of the existing fail-closed contract. Do not add a global
trap-exit policy, alter production process ownership, swallow arbitrary failures,
change ACK/persistence semantics or turn caller survival into an unproved claim.

## Work order

1. Start a managed worktree from the latest published source tip, preserving all
   native evaluator WIP and unrelated primary changes. Prepare the real Node
   client and shell prerequisites; use the pinned asdf BEAM toolchain.
2. Replace the linked test worker with a monitored worker and exact outcome
   checks. Preserve the real Python helper, OS kill and all durable-state checks.
3. Temporarily bypass the production ACK checks only for the gated callback;
   prove that the observer rejects its premature successful return. Restore the
   production file and repeat the real closed-port helper-death case. Existing signing
   success tests remain positive controls for the ordinary ACK path.
4. Run the complete signing-package test family, full mix check and boundary
   security checks. Obtain independent/adversarial reviews appropriate to this
   test-only diff, commit and open a dependent PR with one exact-tip hosted gate.
5. Adopt the gated test correction into the native evaluator before claiming its
   combined suite complete. Keep software proof separate from real-relay and
   installed catalog readiness.
