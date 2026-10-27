// Fresh full-size source corpus; expected semantics remain a failing gate.
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {closeSync, openSync, readFileSync, writeFileSync, writeSync} from "node:fs";
import {resolve} from "node:path";
import {trustFixture, fixtureSigner} from "./export_treehouse_catalog_trust";
import {authorTreehouseRoleTransfer} from "../../src/treehouse";
import {prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";

const MAX = 64 * 1024 * 1024;
const request = JSON.parse(readFileSync(process.argv[2] ?? 0, "utf8"));
assert.ok(Object.keys(request).includes("directory") && Object.keys(request).every(key => ["directory", "targetBytes", "profile"].includes(key)));
const profile = request.profile ?? "dense";
assert.ok(profile === "dense" || profile === "composites");
const target = request.targetBytes ?? MAX;
assert.ok(Number.isSafeInteger(target) && target >= 16 * 1024 && target <= MAX);
const directory = resolve(request.directory);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const write = (name: string, bytes: Uint8Array) => {
  const path = resolve(directory, name);
  writeFileSync(path, bytes, {flag: "wx"});
  return {path, bytes: bytes.length, sha256: digest(bytes)};
};
const f = await trustFixture(0), expected = {trustRevision: 0, historyGeneration: 0};
const empty = {catalogs: [], rotations: [], histories: [], cutoffProofs: []};
const prepared = await prepareTreehouseCatalogInstallation({review: f.review, history: f.histories[0]!, store: {kind: "verified_fresh", expected}});
assert.equal(prepared.kind, "propose");
const accepted = await evaluateTreehouseCatalogTrust({installed: prepared.next, expected, incoming: {...empty, catalogs: [f.catalogJson], histories: f.histories}});
assert.equal(accepted.kind, "propose");
const installed = accepted.next;
const snapshot = write("snapshot.json", Buffer.from(JSON.stringify(installed)));
const {frame: transfer} = await authorTreehouseRoleTransfer({replica: f.space.replica, deps: [f.space.creation.id], signer: f.root, parent: f.space.delegation,
  recipient: fixtureSigner("density-successor").publicKey, action: "transfer_admin"});
const changed = {...f.histories[0]!, frames: [...f.space.frames, transfer]};

function digits(n: number): number {
  if (n === 0) return 0;
  let total = 1; // key zero
  for (let start = 1, width = 1; start < n; start *= 10, width++) total += (Math.min(n, start * 10) - start) * width;
  return total;
}
function payloadBytes(n: number, shape: string): number {
  return n === 0 ? 2 : shape === "array" ? 2 * n + 1 : shape === "composites" ? 3 * n + 1 : 1 + digits(n) + 5 * n;
}
async function generate(shape: "array" | "object" | "composites", frozen: boolean) {
  const name = `${shape}-${frozen ? "frozen" : "unblocked"}`;
  const prefix = Buffer.from(`{"catalogs":[],"rotations":[],"histories":${JSON.stringify(frozen ? [changed] : [])},"cutoffProofs":[`);
  const suffix = Buffer.from("]}");
  const available = target - prefix.length - suffix.length;
  assert.ok(available >= 2);
  let lo = 0, hi = available;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (payloadBytes(mid, shape) <= available) lo = mid; else hi = mid - 1;
  }
  const path = resolve(directory, `${name}.json`), fd = openSync(path, "wx");
  const append = (value: string | Buffer) => {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    for (let offset = 0; offset < bytes.length;) {
      const count = writeSync(fd, bytes, offset, bytes.length - offset);
      assert.ok(count > 0);
      offset += count;
    }
  };
  try {
    append(prefix);
    append(shape === "object" ? "{" : "[");
    for (let start = 0; start < lo; start += 8192) {
      const fields: string[] = [];
      for (let i = start; i < Math.min(lo, start + 8192); i++) fields.push(`${i === 0 ? "" : ","}${shape === "array" ? "0" : shape === "composites" ? "[]" : `"${i}":0`}`);
      append(fields.join(""));
    }
    append(shape === "object" ? "}" : "]");
    append(suffix);
    append(" ".repeat(available - payloadBytes(lo, shape)));
  } finally { closeSync(fd); }
  const raw = readFileSync(path);
  assert.equal(raw.length, target);
  const incoming = JSON.parse(raw.toString("utf8"));
  const decision = await evaluateTreehouseCatalogTrust({installed, expected, incoming});
  write(`${name}-source-decision.json`, Buffer.from(JSON.stringify(decision)));
  return {name, shape, frozen, entries: lo, payloadNodes: shape === "object" ? 2 * lo + 1 : lo + 1,
    keyBytes: shape === "object" ? digits(lo) : 0, page: {path, bytes: raw.length, sha256: digest(raw)}, decision};
}
const cases = [];
if (profile === "composites") cases.push(await generate("composites", true));
else for (const shape of ["array", "object"] as const) for (const frozen of [false, true]) cases.push(await generate(shape, frozen));
const manifest = write("manifest.json", Buffer.from(JSON.stringify({version: 1, targetBytes: target, snapshot, expected, cases})));
assert.ok(manifest.bytes <= 1024 * 1024);
// Retain all planned controls before reporting semantic mismatches. An owner
// disagreement still fails the producer and cannot become a native fallback.
const mismatches: string[] = [];
for (const row of cases) {
  const {decision, frozen} = row;
  if (decision.kind !== (frozen ? "retain_blocked" : "reject") ||
      decision.reason !== (frozen ? "authority_changed" : "malformed_catalog")) {
    mismatches.push(`${row.name}: ${decision.kind}/${decision.reason}`);
  } else if (frozen) {
    assert.equal(decision.kind, "retain_blocked");
    assert.deepEqual(decision.routes, []);
    assert.deepEqual(decision.next.accepted, installed.accepted);
  }
}
assert.deepEqual(mismatches, [], `source density mismatches: ${mismatches.join("; ")}`);
console.log(JSON.stringify(manifest));
