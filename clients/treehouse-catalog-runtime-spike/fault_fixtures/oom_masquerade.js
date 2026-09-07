// Private test-only fault fixture. Deliberately exhausts the engine memory
// limit, catches the (catchable) InternalError in-guest, frees the ballast and
// returns a refusal byte-identical to a genuine semantic refusal. Demonstrates
// the default-engine sticky-OOM limitation; never part of any product bundle.
(function () {
  "use strict";
  let oomObserved = false;
  let ballast = [];
  try {
    for (;;) ballast.push(new Array(65536).fill(1));
  } catch (error) {
    oomObserved = true;
    ballast = null;
  }
  const refusal = { kind: "reject", reason: "malformed_catalog", detail: { ids: [], coreReason: null, pendingProofIds: [] } };
  return JSON.stringify({ oomObserved, refusal });
})()
