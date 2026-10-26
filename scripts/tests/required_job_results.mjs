import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../../.github/scripts/required_job_results.sh", import.meta.url));
const success = { changes: { result: "success", outputs: { treehouse: "true", result: "failure" } }, unit: { result: "success" }, treehouse_native: { result: "success" }, packaged: { result: "skipped" } };
function run(results) {
  return spawnSync("bash", [script], { env: { ...process.env, RESULTS: typeof results === "string" ? results : JSON.stringify(results) }, encoding: "utf8" });
}
test("always-required jobs pass with a classified product skip", () => assert.equal(run(success).status, 0));
test("all product jobs may succeed", () => assert.equal(run({ ...success, packaged: { result: "success" } }).status, 0));
for (const job of Object.keys(success)) {
  for (const result of ["failure", "cancelled", "unknown"]) {
    test(`${job} ${result} fails the aggregate`, () => assert.equal(run({ ...success, [job]: { result } }).status, 1));
  }
}
for (const job of ["changes", "unit", "treehouse_native"]) {
  test(`${job} cannot be skipped`, () => assert.equal(run({ ...success, [job]: { result: "skipped" } }).status, 1));
  test(`${job} cannot be absent`, () => { const input = { ...success }; delete input[job]; assert.equal(run(input).status, 1); });
}
for (const input of ["invalid json", "null", "[]", "{}", { ...success, packaged: {} }]) {
  test(`invalid result input fails: ${JSON.stringify(input)}`, () => assert.notEqual(run(input).status, 0));
}
