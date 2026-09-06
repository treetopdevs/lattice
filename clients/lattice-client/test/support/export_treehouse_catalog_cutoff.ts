import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp } from "../../src/codec";
import type { CarrierOpFrame, CarrierTerm } from "../../src/carrier";
import { bindTownshipReplica, townshipCapTerm } from "../../src/township";

export async function cutoffFixture() {
  const seed = createHash("sha256").update("r11a-cutoff-ts-root").digest();
  const signer = { publicKey: ed25519.getPublicKey(seed), sign: (bytes: Uint8Array) => ed25519.sign(bytes, seed) };
  const replica = await bindTownshipReplica("treehouse:cutoff:ts", signer.publicKey);
  const delegation = await authorCarrierDelegation({ replica, signer, audiencePubkey: signer.publicKey,
    ops: ["create_space", "create_thread"], roles: ["admin", "moderator"], live: true });
  const atom = (value: string): CarrierTerm => ["atom", value];
  const text = (value: string): CarrierTerm => ["bin", Buffer.from(value).toString("base64")];
  const tuple = (...values: CarrierTerm[]): CarrierTerm => ["tuple", values];
  const genesis = await authorCarrierOp({ replica, signer, deps: [], kind: "authority", cap: ["nil"],
    body: tuple(atom("genesis"), ["delegation", delegation], ["map", []]) });
  const name = await authorCarrierOp({ replica, signer, deps: [genesis.id], kind: "command", cap: townshipCapTerm(delegation.id),
    body: tuple(atom("create_space"), ["list", [text("Canopy")]]) });
  const denied = await authorCarrierOp({ replica, signer, deps: [name.id], kind: "command", cap: townshipCapTerm(delegation.id),
    body: tuple(atom("create_thread"), ["list", [["list", []], text("Invalid")]]) });
  const high = await authorCarrierOp({ replica, signer, deps: [denied.id], kind: "authority", cap: ["nil"],
    body: tuple(atom("beacon"), ["int", "18446744073709551615"]) });
  const genuine = await authorCarrierOp({ replica, signer, deps: [high.id], kind: "command", cap: townshipCapTerm(delegation.id),
    body: tuple(atom("create_space"), ["list", [text("Retained")]]) });
  const forged = { ...genuine, sig: Buffer.alloc(64).toString("base64") };
  const supplied = { ...denied, id: "retained:\uFEFF\u{1F33F}", deps: ["not-an-accepted-dependency"], sig: "" };
  const frames = [genesis, name, denied, high, genuine];
  return { replica, signer, genesis, name, denied, high, genuine, forged, supplied, frames };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--verify-beam" && args[1]) {
    const { deriveTreehouseCatalogCutoff } = await import("../../src/treehouse_catalog_cutoff");
    const input = JSON.parse(await readFile(resolve(args[1]), "utf8"));
    assert.equal(input.version, 1);
    assert.ok(Array.isArray(input.vectors) && input.vectors.length > 0);
    for (const vector of input.vectors) {
      const result = await deriveTreehouseCatalogCutoff(vector);
      assert.deepEqual(JSON.parse(serialize(result)), vector.result, vector.name);
      const reversed = await deriveTreehouseCatalogCutoff({ ...vector, frames: [...vector.frames].reverse(), rejected: [...vector.rejected].reverse() });
      assert.deepEqual(JSON.parse(serialize(reversed)), vector.result, `${vector.name}: inverse input order`);
      console.log(`PASS BEAM→TS exact cutoff records/bytes/digest/frontier: ${vector.name}`);
    }
    return;
  }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out" || !args[1])) throw new Error("usage: export_treehouse_catalog_cutoff.ts [--out <path> | --verify-beam <path>]");
  const output = args[1] === undefined ? fileURLToPath(new URL("../vectors/catalog/ts_cutoff.json", import.meta.url)) : resolve(args[1]);
  const { deriveTreehouseCatalogCutoff } = await import("../../src/treehouse_catalog_cutoff");
  const f = await cutoffFixture();
  const inputs: { name: string; replica: string; frames: CarrierOpFrame[]; rejected: { frame: CarrierOpFrame; reason: "bad_signature" }[] }[] = [
    { name: "accepted-including-semantic-refusal-and-high-legacy-epoch", replica: f.replica, frames: f.frames, rejected: [] },
    { name: "genuine-and-rejected-same-id-plus-arbitrary-rejected-id-and-signature", replica: f.replica, frames: f.frames,
      rejected: [{ frame: f.forged, reason: "bad_signature" }, { frame: f.supplied, reason: "bad_signature" }] },
  ];
  const vectors = await Promise.all(inputs.map(async (input) => {
    const result = await deriveTreehouseCatalogCutoff(input);
    assert.equal(result.ok, true, input.name);
    return { ...input, result };
  }));
  const json = serialize({ version: 1, vectors });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${json}\n`);
  console.log(`Exported ${vectors.length} TS-authored cutoff histories to ${output}`);
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, value) => value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value, 2);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
