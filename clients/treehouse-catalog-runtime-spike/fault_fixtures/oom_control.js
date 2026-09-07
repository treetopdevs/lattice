// Private test-only fault fixture. Control run: returns the same plausible
// refusal without ever hitting a resource limit.
(function () {
  "use strict";
  const refusal = { kind: "reject", reason: "malformed_catalog", detail: { ids: [], coreReason: null, pendingProofIds: [] } };
  return JSON.stringify({ oomObserved: false, refusal });
})()
