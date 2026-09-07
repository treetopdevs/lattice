// Private test-only fault fixture. Busy-loops forever inside try/catch that
// would return a plausible refusal if the interrupt were catchable. The engine
// interrupt is uncatchable, so the catch never runs.
(function () {
  "use strict";
  try {
    for (;;) { /* interrupt handler polls here */ }
  } catch (error) {
    return JSON.stringify({ kind: "reject", reason: "malformed_catalog", detail: { ids: [], coreReason: null, pendingProofIds: [] } });
  }
})()
