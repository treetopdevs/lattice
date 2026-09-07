import assert from "node:assert/strict";
import {readFile, writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {trustFixture} from "./export_treehouse_catalog_trust";
import {authorCarrierOp} from "../../src/codec";
import type {CarrierTerm} from "../../src/carrier";
import {carrierOpsToSemanticOps, decodeCarrierOpFrame} from "../../src/carrier";
import {materialize} from "../../src/materialize";
import {treehouseCommandDecoders, treehouseSpaceSchema} from "../../src/treehouse";
import {deriveTreehouseCatalogCutoff} from "../../src/treehouse_catalog_cutoff";
import {prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust} from "../../src/treehouse_catalog_trust";
import {transportCatalogId} from "../../src/treehouse_catalog_codec";

const serialize = (value: unknown) => JSON.stringify(value, (_key, item) => item instanceof Uint8Array ? Buffer.from(item).toString("base64") : item, 2);

/** Additive public data only. Original catalog producers and fixtures stay unchanged. */
export async function continuityCatalogFixture() {
  const f = await trustFixture();
  const names = JSON.parse(await readFile(new URL("../vectors/catalog/cutoff_atoms_with_member_continuity_v1.json", import.meta.url), "utf8")) as string[];
  const command = await authorCarrierOp({replica: f.space.replica, signer: f.root, deps: [f.space.frames.at(-1)!.id], kind: "command", cap: ["nil"],
    body: ["tuple", [["atom", "attest_member_key_v1"], ["list", [["list", names.map((name): CarrierTerm => ["atom", name])]]]]]});
  const history = {...f.histories[0]!, frames: [...f.space.frames, command], rejected: [{frame: {...command, sig: ""}, reason: "bad_signature" as const}]};
  const histories = [history, ...f.histories.slice(1)];
  const cutoffs = await Promise.all(histories.map(deriveTreehouseCatalogCutoff));
  assert.ok(cutoffs.every((c) => c.ok));
  return {version: 1, review: f.review, catalogJson: f.catalogJson, histories, cutoffProofs: [],
    expected: {catalogId: transportCatalogId(f.catalog), cutoffs}};
}

export async function verifyContinuityCatalogVector(input: unknown) {
  // This is a test fixture schema. Every history is independently authenticated by public APIs below.
  const vector = input as Awaited<ReturnType<typeof continuityCatalogFixture>>;
  assert.equal(vector.version, 1);
  const expected = {trustRevision: 0, historyGeneration: 0};
  const states = [];
  for (const reverse of [false, true]) {
    const histories = vector.histories.map((h) => ({...h, frames: reverse ? [...h.frames].reverse() : h.frames,
      rejected: reverse ? [...h.rejected].reverse() : h.rejected}));
    for (let index = 0; index < histories.length; index++) {
      const cutoff = await deriveTreehouseCatalogCutoff(histories[index]!);
      assert.equal(cutoff.ok, true);
      assert.deepEqual(JSON.parse(serialize(cutoff)), vector.expected.cutoffs[index]);
    }
    if (reverse) histories.reverse();
    const space = histories.find((h) => h.replica === vector.review.space)!;
    const prepare = await prepareTreehouseCatalogInstallation({review: vector.review, history: space, store: {kind: "verified_fresh", expected}});
    assert.equal(prepare.kind, "propose");
    const result = await evaluateTreehouseCatalogTrust({installed: prepare.next, expected,
      incoming: {catalogs: [vector.catalogJson], rotations: [], histories, cutoffProofs: []}});
    assert.equal(result.kind, "propose"); assert.equal(result.next.accepted?.catalog, vector.expected.catalogId);
    assert.equal(result.routes.length, 2);
    const reopened = await evaluateTreehouseCatalogTrust({installed: result.next, expected,
      incoming: {catalogs: [], rotations: [], histories: [], cutoffProofs: []}});
    assert.equal(reopened.kind, "unchanged"); assert.deepEqual(reopened.next, result.next);
    const frames = space.frames.map(decodeCarrierOpFrame);
    const commands = frames.filter((f) => f.body[0] === "tuple" && JSON.stringify(f.body[1][0]) === '["atom","attest_member_key_v1"]');
    assert.equal(commands.length, 1);
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    const projection = materialize(treehouseSpaceSchema, ops, new Set(ops.map((op) => op.id)), null, space.replica);
    assert.equal(projection.quarantineReasons.get(commands[0]!.id), "unknown_command");
    const before = ops.filter((op) => op.id !== commands[0]!.id);
    assert.deepEqual(projection.state, materialize(treehouseSpaceSchema, before, new Set(before.map((op) => op.id)), null, space.replica).state);
    states.push(result.next);
  }
  assert.deepEqual(states[0], states[1]);
}

async function main() {
  const [mode, path, ...extra] = process.argv.slice(2);
  assert.ok(path && extra.length === 0 && (mode === "--out" || mode === "--verify-beam"));
  if (mode === "--verify-beam") {
    await verifyContinuityCatalogVector(JSON.parse(await readFile(path, "utf8")));
    console.log("PASS BEAM→TS continuity catalog install/reopen, exact cutoff records and unknown command in both orders");
  } else {
    const vector = JSON.parse(serialize(await continuityCatalogFixture()));
    await verifyContinuityCatalogVector(vector);
    await writeFile(path, `${serialize(vector)}\n`);
    console.log("Exported independently TS-signed continuity catalog evidence");
  }
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
