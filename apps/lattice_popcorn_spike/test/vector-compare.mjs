// Plan 185: compare one browser-judge verdict with the Sim oracle recorded in a vector.
// Shared by the Chromium harness and the in-app (Tauri) judge page; no Node APIs here.
const codePoints = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const sortedPairs = pairs => [...pairs].map(p => [p[0], p[1]]).sort((a, b) => codePoints(a[0], b[0]) || codePoints(a[1], b[1]));
export const stable = value => Array.isArray(value)
  ? value.map(stable)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort(codePoints).map(key => [key, stable(value[key])]))
    : value;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

// Identity.fingerprint/1: url-safe unpadded base64 of the pubkey, first 12 characters.
const fingerprint = b64 => b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 12);
const realmOf = (realms, b64) => b64 === null || b64 === undefined
  ? null
  : (realms?.[b64] ?? fingerprint(b64));

export function compareVerdict(vector, result) {
  const expected = vector.expectAtFullFrontier;
  const oracle = {
    quarantine: expected.authorityQuarantine === undefined ? null : sortedPairs(expected.authorityQuarantine),
    quarantineIds: [...expected.quarantine].sort(codePoints),
    state: expected.state
  };
  if (!result?.ok) {
    return { pass: false, oracle, browser: { error: result?.error ?? "no_result", detail: result?.detail,
      undecodable: result?.undecodable, decodableSubset: result?.decodable_subset } };
  }
  const browserPairs = sortedPairs(result.quarantine);
  const quarantine = oracle.quarantine === null
    ? { equal: same(result.quarantine_ids, oracle.quarantineIds), compared: "ids (vector has no authorityQuarantine)" }
    : { equal: same(browserPairs, oracle.quarantine), compared: "[id, reason] pairs" };
  const idsEqual = same(result.quarantine_ids, oracle.quarantineIds);
  const holders = Object.entries(result.holders).map(([role, pub]) => ({
    role, browser: realmOf(vector.realmByPubkey, pub),
    oracle: Object.hasOwn(expected.state, role) ? expected.state[role] : undefined
  }));
  const holdersEqual = holders.every(h => h.oracle === undefined || h.browser === h.oracle);
  const browserState = JSON.parse(result.state);
  const stateEqual = same(browserState, expected.state);
  // Every signed frame must be admitted and judged: a frame that Sync.deliver rejected, left
  // pending or quarantined structurally can leave quarantine, holders and state unchanged (a
  // corrupted standalone heartbeat, for instance), so equality alone would overstate the result.
  // op_count is the log's unique size (Log.accept is idempotent), so count distinct frames;
  // Sim-exported vectors never repeat a frame today.
  const frames = new Set(vector.oracleCarrierOps.map(frame => JSON.stringify(frame))).size;
  const structural = result.structural ?? null;
  const admitted = structural !== null && result.op_count === frames
    && structural.rejected === 0 && structural.pending === 0 && structural.quarantined === 0;
  const pass = quarantine.equal && idsEqual && holdersEqual && stateEqual && admitted;
  return {
    pass, quarantine: { ...quarantine, idsEqual }, holders: { equal: holdersEqual, roles: holders },
    state: { equal: stateEqual }, admission: { equal: admitted, opCount: result.op_count ?? null, frames, structural },
    ...(pass ? {} : { oracle, browser: { quarantine: browserPairs, quarantineIds: result.quarantine_ids, state: browserState } })
  };
}
