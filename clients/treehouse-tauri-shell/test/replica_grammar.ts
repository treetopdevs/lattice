import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isProfileReplica } from "../src/treehouse_routes";

// Row 232: a profile replica (Space or Thread, plan 245 Design E) is exactly the legacy grammar OR the
// bounded-continuation grammar with canonical tails. src-tauri/tests/route_alphabet.rs replays the same cases through preview.rs.
const cases = JSON.parse(readFileSync(new URL("./replica_grammar_cases.json", import.meta.url), "utf8")) as {
  value: string;
  space: boolean;
  thread: boolean;
  note: string;
}[];
assert(cases.length >= 50);
for (const c of cases) {
  assert.equal(isProfileReplica("space", c.value), c.space, `space: ${c.note}`);
  assert.equal(isProfileReplica("thread", c.value), c.thread, `thread: ${c.note}`);
}
console.log(`PASS ${cases.length} replica grammar cases (legacy or exact bounded Space or Thread; near-misses refused)`);
