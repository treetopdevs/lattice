import assert from "node:assert/strict";
import { emptyState, parseState, HISTORY_BYTES } from "../src/treehouse_state";
const good = emptyState();
assert.deepEqual(parseState(JSON.stringify(good)), good);
for (const change of [
  { version: 9 },
  { product: "township" },
  { revision: -1 },
  { revision: Number.MAX_SAFE_INTEGER + 1 },
  { unexpected: "data" },
  { active: "missing" },
  { clearedDrafts: { x: -1 } },
]) {
  assert.throws(
    () => parseState(JSON.stringify({ ...good, ...change })),
    /invalid_/,
  );
}
assert.throws(
  () => parseState(" ".repeat(HISTORY_BYTES + 1)),
  /preview_storage_limit/,
);
assert.throws(
  () =>
    parseState(
      JSON.stringify({
        ...good,
        profiles: [
          { product: "Treehouse.Thread", replica: "x", frames: [], outbox: [] },
        ],
      }),
    ),
  /missing_public_identity/,
);
console.log("PASS closed product/version/shape/revision and aggregate limit");
const preceding = { ...good, version: 0 } as Record<string, unknown>;
delete preceding.clearedDrafts;
assert.deepEqual(
  parseState(JSON.stringify(preceding)),
  good,
  "closed N-1 envelope upgrades metadata while retaining public history",
);
assert.throws(
  () => parseState(JSON.stringify({ ...preceding, clearedDrafts: {} })),
  /invalid_/,
);
