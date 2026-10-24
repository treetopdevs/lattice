import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { carrierDelegationsFromFrames, authorTreehouseCommand, treehouseCommandDecoders, continuationFamily } from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { authorTownshipGenesis, bindTownshipReplica } from "../../lattice-client/src/township";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import type { PreviewNative, Draft } from "../src/treehouse_state";

// Plan 245 PR 1 / row 258: a persisted bounded Thread profile reloads through verifyProfile (the app never creates
// one yet, row 254), and the near-misses of the bounded Thread grammar are refused at load.
class MemoryNative implements PreviewNative {
  record: string | null = null;
  seed: Uint8Array | null = null;
  async open() {
    return {
      record: this.record,
      publicKey: this.seed ? Buffer.from(ed25519.getPublicKey(this.seed)).toString("base64") : null,
      keyStatus: (this.seed ? "available" : "absent") as "available" | "absent",
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
  async exportSpaceFrames(fileName: string) {
    return `/downloads/${fileName}`;
  }
}
const fresh = async (n: MemoryNative) => {
  const w = new TreehouseWorkflow(n);
  await w.open();
  return w;
};

const native = new MemoryNative();
const app = await fresh(native);
await app.createSpace("Canopy");
const space = app.state.profiles[0]!;
const publicKey = app.state.publicKey!;
const signer = {
  publicKey: Uint8Array.from(Buffer.from(publicKey, "base64")),
  sign: (bytes: Uint8Array) => native.sign(bytes),
};

// Hand-build a bounded Thread (the app cannot yet, row 254) and the Space's reference to it.
const nonce = "A".repeat(42) + "A";
const bounded = await bindTownshipReplica(
  `replica:treehouse:thread:${nonce}#authority:bounded-continuation-v1`,
  signer.publicKey,
);
assert.equal(continuationFamily(bounded), "thread");
const genesis = await authorTownshipGenesis({
  replica: bounded,
  signer,
  ops: [...treehouseCommandDecoders("Treehouse.Thread").keys()],
  roles: ["moderator"],
  policies: {},
});
const capId = carrierDelegationsFromFrames([genesis])[0]!.id;
const title = await authorTreehouseCommand({
  product: "Treehouse.Thread",
  replica: bounded,
  signer,
  deps: [genesis.id],
  capId,
  command: { command: "create_thread", title: "Bounded notes" },
});
const spaceCap = carrierDelegationsFromFrames([space.frames[0]!])[0]!.id;
const reference = await authorTreehouseCommand({
  product: "Treehouse.Space",
  replica: space.replica,
  signer,
  deps: [space.frames[space.frames.length - 1]!.id],
  capId: spaceCap,
  command: { command: "create_thread", title: "Bounded notes", threadReplica: bounded },
});
const withBounded = (replica: string, frames: CarrierOpFrame[]) => {
  const record = parseState(native.record);
  const sp = record.profiles[0]!;
  record.profiles = [
    { ...sp, frames: [...sp.frames, reference], outbox: [...sp.outbox, reference.id] },
    { product: "Treehouse.Thread", replica, frames, outbox: frames.map((f) => f.id), acked: [] },
  ];
  record.active = replica;
  const n = new MemoryNative();
  n.seed = native.seed;
  n.record = JSON.stringify(record);
  return n;
};

const reloaded = await fresh(withBounded(bounded, [genesis, title]));
assert.equal(reloaded.state.profiles.length, 2);
assert.equal(reloaded.state.profiles[1]!.replica, bounded);
assert.equal(reloaded.views.get(bounded)!.state.title, "Bounded notes");
console.log("PASS a persisted bounded Thread profile reloads through verifyProfile");

// The non-canonical root tag (ends B) and kind-mismatched bounded names stay refused at load.
const tag = bounded.slice(bounded.lastIndexOf("#root:") + 6);
for (const bad of [
  bounded.slice(0, -1) + "B",
  bounded.replace(`${nonce}#`, `${"A".repeat(42)}B#`),
  bounded.replace("#authority:bounded-continuation-v1", "#authority:bounded-continuation-v2"),
  bounded.replace("#root:", "#authority:bounded-continuation-v1#root:"),
  `${bounded}#authority:bounded-continuation-v1`,
  bounded.replace("thread", "space"),
]) {
  const frames = [genesis, title].map((f) => ({ ...f, replica: bad }));
  await assert.rejects(fresh(withBounded(bad, frames)), /invalid_profile_replica/, bad);
}
// A well-formed bounded name whose tag does not commit to the genesis author is refused by the root commitment check.
const foreignTag = tag.slice(0, -1) === "" ? tag : (tag[0] === "A" ? "C" : "A") + tag.slice(1);
const foreign = bounded.slice(0, bounded.lastIndexOf("#root:") + 6) + foreignTag;
assert.equal(continuationFamily(foreign), "thread");
await assert.rejects(
  fresh(withBounded(foreign, [genesis, title].map((f) => ({ ...f, replica: foreign })))),
  /wrong_profile_root|invalid_retained_history/,
);
console.log("PASS near-miss and foreign-tag bounded Thread profiles are refused at load");
