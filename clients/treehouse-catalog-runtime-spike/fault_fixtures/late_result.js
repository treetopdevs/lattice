// Private test-only fault fixture. Runs work past the deadline, then returns
// a plausible refusal. The harness must refuse it out-of-band even if no
// interrupt fired at the exact completion point.
(function () {
  "use strict";
  const start = Date.now();
  let n = 0;
  while (Date.now() - start < 700) { n = (n + 1) % 1000000007; }
  return JSON.stringify({ kind: "reject", reason: "malformed_catalog", detail: { ids: [], coreReason: null, pendingProofIds: [] }, n });
})()
