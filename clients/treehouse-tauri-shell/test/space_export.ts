import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import { verifyCarrierOp } from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import {
  SPACE_EXPORT_FORMAT,
  buildSpaceFramesExport,
  isExportFileName,
  suggestExportFileName,
} from "../src/space_export";
import { TreehouseWorkflow, strictVerifier } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import type { PreviewNative, Draft } from "../src/treehouse_state";

// Space frames export v1: the shared format the catalog ceremony accepts as --space-log. Public signed frames
// only, compact JSON, keys sorted at every level, frames sorted by id.

const verify = async (frame: CarrierOpFrame) => (await verifyCarrierOp(frame, strictVerifier)).valid;
const vector = JSON.parse(
  readFileSync(new URL("../../lattice-client/test/vectors/treehouse/bounded_space_binding_v1.json", import.meta.url), "utf8"),
) as { replica: string; record: { space_root: string }; ops: { label: string; frame: CarrierOpFrame }[] };
const frames = vector.ops.map((o) => o.frame);
const root = vector.record.space_root;
const sortedKeys = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.every(sortedKeys)
    : v !== null && typeof v === "object"
      ? Object.keys(v).every((k, i, a) => i === 0 || a[i - 1]! < k) && Object.values(v).every(sortedKeys)
      : true;

// ---- 1. the cross-runtime fixture ---------------------------------------------------------------------------
const fixture = new URL("./fixtures/space_frames_export_v1.json", import.meta.url);
const built = await buildSpaceFramesExport({ space: vector.replica, rootPublicKey: root, frames, verify });
if (process.env.UPDATE_FIXTURE === "1") writeFileSync(fixture, built);
assert.equal(built, readFileSync(fixture, "utf8"), "the export is byte-identical to the shared fixture");
const parsed = JSON.parse(built);
assert.deepEqual(Object.keys(parsed), ["format", "frames", "root", "space"]);
assert.equal(parsed.format, SPACE_EXPORT_FORMAT);
assert.equal(parsed.space, vector.replica);
assert.equal(parsed.root, root);
assert.equal(Buffer.from(parsed.root, "base64").length, 32);
assert.equal(parsed.frames.length, 4);
assert.ok(sortedKeys(parsed), "keys are sorted at every level");
assert.equal(built, JSON.stringify(parsed), "compact, and parse/stringify of sorted JSON is stable");
assert.ok(!built.endsWith("\n"));
const ids = parsed.frames.map((f: CarrierOpFrame) => f.id);
assert.deepEqual(ids, [...ids].sort(), "frames sorted by id");
assert.deepEqual(
  new Set(ids),
  new Set(frames.map((f) => f.id)),
  "every vector frame is present (genesis, create_space, pin, catalog_bootstrap_v1)",
);
for (const f of parsed.frames) assert.deepEqual(Object.keys(f), ["author", "body", "cap", "deps", "id", "kind", "replica", "sig", "v"]);
// Input order does not matter.
assert.equal(
  await buildSpaceFramesExport({ space: vector.replica, rootPublicKey: root, frames: [...frames].reverse(), verify }),
  built,
);
console.log("PASS fixture and format");

// ---- 2. refusals --------------------------------------------------------------------------------------------
const base = { space: vector.replica, rootPublicKey: root, verify };
await assert.rejects(buildSpaceFramesExport({ ...base, frames: [] }), /export_empty/);
await assert.rejects(
  buildSpaceFramesExport({ ...base, frames: [...frames, { ...frames[0]!, replica: vector.replica + "x" }] }),
  /export_wrong_replica/,
);
await assert.rejects(buildSpaceFramesExport({ ...base, frames: [...frames, frames[1]!] }), /export_duplicate_frame/);
const flipped = Buffer.from(frames[2]!.sig, "base64");
flipped[0] = flipped[0]! ^ 1;
await assert.rejects(
  buildSpaceFramesExport({ ...base, frames: [frames[0]!, { ...frames[2]!, sig: flipped.toString("base64") }] }),
  /export_invalid_frame/,
);
await assert.rejects(
  buildSpaceFramesExport({ ...base, frames: Array.from({ length: 4001 }, (_, i) => ({ ...frames[0]!, id: `id${i}` })) }),
  /export_too_large/,
);
// An extra property on a retained frame never reaches the file.
const extra = { ...frames[0]!, outbox: ["x"], state: { secret: 1 } } as CarrierOpFrame;
const trimmed = await buildSpaceFramesExport({ ...base, frames: [extra] });
assert.ok(!trimmed.includes("outbox") && !trimmed.includes("secret"));
// Codex row 234 /1: map pairs and mapset elements in non-canonical order (as the app authors them) are re-ordered
// to the BEAM order; the signed bytes do not change, so the frame still verifies.
const reorder = (t: unknown): unknown => {
  if (!Array.isArray(t)) return t;
  if (t[0] === "map") return ["map", [...(t[1] as unknown[][])].reverse().map(([k, x]) => [reorder(k), reorder(x)])];
  if (t[0] === "mapset") return ["mapset", [...(t[1] as unknown[])].reverse().map(reorder)];
  if (t[0] === "list" || t[0] === "tuple") return [t[0], (t[1] as unknown[]).map(reorder)];
  return t;
};
const shuffled = frames.map((f) => ({ ...f, body: reorder(f.body), cap: reorder(f.cap) }) as CarrierOpFrame);
assert.notDeepEqual(shuffled, frames, "precondition: the vector has multi-entry maps to reorder");
for (const f of shuffled) assert.ok(await verify(f), "reordered pairs leave the signed bytes unchanged");
assert.equal(await buildSpaceFramesExport({ ...base, frames: shuffled }), built, "map order is canonicalized");
// Codex row 234 /1 and Claude row 234 /1: unknown nested properties are never exported; malformed terms are refused.
const nested = structuredClone(frames) as CarrierOpFrame[];
const walk = (t: any): void => {
  if (!Array.isArray(t)) return;
  if (t[0] === "delegation") t[1].secret = "LEAK";
  else if (Array.isArray(t[1])) t[1].forEach(walk);
};
nested.forEach((f) => {
  walk(f.body);
  walk(f.cap);
  (f.deps as any).extra = "LEAK";
});
assert.ok(JSON.stringify(nested).includes("LEAK"), "precondition: the leak is planted");
assert.equal(await buildSpaceFramesExport({ ...base, frames: nested }), built, "nested extras are dropped");
const malformed = structuredClone(frames[0]!) as any;
malformed.body = ["tuple", [["bogus", 1]]];
await assert.rejects(
  buildSpaceFramesExport({ ...base, frames: [malformed], verify: async () => true }),
  /export_invalid_frame/,
);
console.log("PASS refusals");

// ---- 3. file names ------------------------------------------------------------------------------------------
for (const ok of ["a.json", "treehouse-space-abc.frames.json", "A_b-c.1.json", "a".repeat(96) + ".json"])
  assert.ok(isExportFileName(ok), ok);
for (const bad of ["", ".json", ".hidden.json", "../x.json", "a/b.json", "a\\b.json", "a..b.json", "x.txt", "x", "a b.json", "a".repeat(97) + ".json", "é.json"])
  assert.ok(!isExportFileName(bad), bad);
assert.equal(suggestExportFileName(vector.replica), "treehouse-space-gp7fsTd3aqK6.frames.json");
assert.ok(isExportFileName(suggestExportFileName(vector.replica)));
assert.ok(isExportFileName(suggestExportFileName("")));
console.log("PASS file names");

// ---- 4. the workflow action: root only, public frames only ---------------------------------------------------
class MemoryNative implements PreviewNative {
  record: string | null = null;
  seed: Uint8Array | null = null;
  exported = new Map<string, string>();
  async open() {
    return {
      record: this.record,
      publicKey: this.seed ? Buffer.from(ed25519.getPublicKey(this.seed)).toString("base64") : null,
      keyStatus: (this.seed ? "available" : parseState(this.record).publicKey ? "missing" : "absent") as
        | "available"
        | "missing"
        | "absent",
    };
  }
  async initialize() {
    this.seed ??= crypto.getRandomValues(new Uint8Array(32));
    return (await this.open()).publicKey!;
  }
  async commit(expected: number, next: string) {
    if (parseState(this.record).revision !== expected) return false;
    this.record = next;
    return true;
  }
  async loadDraft(): Promise<Draft | null> {
    return null;
  }
  async saveDraft(_replica: string, expected: number, text: string) {
    return { version: 1, revision: expected + 1, text } as Draft;
  }
  async sign(bytes: Uint8Array) {
    return ed25519.sign(bytes, this.seed!);
  }
  async exportSpaceFrames(fileName: string, contents: string) {
    this.exported.set(fileName, contents);
    return `/downloads/${fileName}`;
  }
}
const fresh = async (n: MemoryNative) => {
  const w = new TreehouseWorkflow(n);
  await w.open();
  return w;
};
const spaceOf = (a: TreehouseWorkflow) => a.state.profiles.find((p) => p.product === "Treehouse.Space")!;

const native = new MemoryNative();
const app = await fresh(native);
await app.createSpace("Canopy");
const space = spaceOf(app);
assert.ok(space.outbox.length > 0, "an unsent outbox exists");
const before = native.record;
const path = await app.exportSpaceFrames("mine.json");
assert.equal(path, "/downloads/mine.json");
const text = native.exported.get("mine.json")!;
const file = JSON.parse(text);
assert.deepEqual(Object.keys(file), ["format", "frames", "root", "space"]);
assert.equal(file.space, space.replica);
assert.equal(file.root, app.state.publicKey);
assert.deepEqual(file.frames.map((f: CarrierOpFrame) => f.id), space.frames.map((f) => f.id).sort());
assert.ok(!/outbox|acked|routes|clearedDrafts/.test(text), "no local-only state in the file");
assert.equal(native.record, before, "exporting leaves the saved record untouched");
await assert.rejects(app.exportSpaceFrames("../x.json"), /invalid_export_name/);
await assert.rejects(app.exportSpaceFrames("x.txt"), /invalid_export_name/);
assert.equal(native.exported.size, 1);

{
  // A joiner (not the root) holding the Space is refused.
  const joiner = new MemoryNative();
  const j = await fresh(joiner);
  await j.beginJoin();
  const into = parseState(joiner.record);
  into.profiles = parseState(native.record)
    .profiles.filter((p) => p.product === "Treehouse.Space")
    .map((p) => ({ ...p, outbox: [], acked: p.frames.map((f) => f.id) }));
  into.revision += 1;
  joiner.record = JSON.stringify(into);
  const jr = await fresh(joiner);
  await assert.rejects(jr.exportSpaceFrames("j.json"), /not_root/);
  assert.equal(joiner.exported.size, 0);
}
{
  // No Space at all.
  const empty = new MemoryNative();
  const e = await fresh(empty);
  await e.native.initialize();
  await assert.rejects(e.exportSpaceFrames("e.json"));
  assert.equal(empty.exported.size, 0);
}
console.log("PASS workflow export is root-only and public-only");
