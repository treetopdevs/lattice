// Private test-only fault fixture. Overflows the JS stack, catches the
// (catchable) RangeError in-guest and returns a plausible refusal. Documents
// that stack exhaustion shares the sticky-OOM limitation.
(function () {
  "use strict";
  let overflowObserved = false;
  function recurse(depth) { return recurse(depth + 1) + 1; }
  try {
    recurse(0);
  } catch (error) {
    overflowObserved = true;
  }
  const refusal = { kind: "reject", reason: "malformed_catalog", detail: { ids: [], coreReason: null, pendingProofIds: [] } };
  return JSON.stringify({ overflowObserved, refusal });
})()
