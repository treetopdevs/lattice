// Operator integration fixture: real ordinary workflow and client signatures, isolated seed-store double.
// The routed invitation is test orchestration until plan 262 B supplies offline controls; no network is dialed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { ed25519 } from "@noble/curves/ed25519.js";
import { TreehouseWorkflow } from "../../src/treehouse_workflow";
import { buildSpaceFramesExport } from "../../src/space_export";
import { BoundedNative } from "./bounded_native";
import { FaultNative } from "./fault_native";
import { decodeTreehouseOffer, signTreehouseAcceptance, encodeTreehouseAcceptance,
  verifyCarrierOp, carrierOpsToSemanticOps, treehouseCommandDecoders } from "@treetopdevs/lattice-client";
import type { LocalProfile } from "../../src/treehouse_state";

const lines = createInterface({ input: process.stdin });
const input = lines[Symbol.asyncIterator]();
const ask = async (message: unknown) => {
  process.stdout.write(JSON.stringify(message) + "\n");
  const reply = await input.next();
  assert(!reply.done, "operator must reply to the public ceremony step");
  return JSON.parse(reply.value);
};
class CapturingNative extends BoundedNative {
  publicExport = "";
  override async exportSpaceFrames(_name: string, contents: string) {
    this.publicExport = contents; return "/fixture/public-export.json";
  }
}
const pub = (n: number) => Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(n))).toString("base64");
const setup = { nominee: pub(111), witnesses: [112, 113, 114].map(pub), threshold: 2, maxLeaseEpochs: 7 };
const native = new CapturingNative();
const founder = new TreehouseWorkflow(native);
await founder.open(); await founder.createSpace("Ordinary provisioning");
await founder.pinContinuation(founder.reviewContinuation({ ...setup, witnesses: setup.witnesses.join("\n") }));
await founder.exportSpaceFrames("pre-binding.json");
const payload = await ask({ phase: "space", exported: native.publicExport });
const binding = await founder.reviewCatalogBinding(JSON.stringify(payload));
const bootstrapId = await founder.signCatalogBinding();
await founder.exportSpaceFrames("bound-space.json");
assert.equal(await ask({ phase: "bound", exported: native.publicExport }), "verified");
await founder.createThread("General", setup);

const realm = (key: string) => "treehouse-client:" + Buffer.from(key, "base64").toString("base64url");
const route = (replica: string) => "/r/" + createHash("sha256")
  .update(JSON.stringify(["treehouse-initial-route-v1", replica])).digest("base64url");
await founder.configureRoutes(JSON.stringify({ localRealm: realm(founder.state.publicKey!),
  routes: founder.state.profiles.map((profile) => ({ replica: profile.replica,
    url: binding.record.origin + route(profile.replica), expectedPeerRealm: "treehouse-service:" + binding.record.serviceId,
    expectedPeerPubkey: binding.record.serviceKey })) }));
const memberNative = new FaultNative(); const member = new TreehouseWorkflow(memberNative);
await member.open(); const request = await member.beginJoin();
const offer = decodeTreehouseOffer(await founder.issueInvitation(request, realm(member.state.publicKey!)));
const acceptance = await signTreehouseAcceptance({ replica: offer.space,
  frames: founder.state.profiles[0]!.frames, invitationId: offer.invitationId,
  signer: { publicKey: Buffer.from(member.state.publicKey!, "base64"), sign: (bytes) => memberNative.sign(bytes) } });
await founder.admitAndGrant(encodeTreehouseAcceptance(acceptance));
await founder.command(founder.state.profiles[1]!.replica, { command: "post", text: "Ready for staging" });
const verifier = { verify: async (key: string, bytes: Uint8Array, signature: Uint8Array) =>
  ed25519.verify(signature, bytes, Buffer.from(key, "base64"), { zip215: false }) };
const exported = async (profile: LocalProfile) => {
  const root = profile.frames.find((frame) => frame.kind === "authority" && frame.deps.length === 0)!.author;
  // Reuse the production canonical frame encoder and verifier; the receiving bundle verifies product semantics.
  const frames = JSON.parse(await buildSpaceFramesExport({ space: profile.replica, rootPublicKey: root,
    frames: profile.frames, verify: async (frame) => (await verifyCarrierOp(frame, verifier)).valid })).frames;
  return { product: profile.product, replica: profile.replica, frames };
};
const space = founder.state.profiles[0]!;
const reference = carrierOpsToSemanticOps(space.frames, {}, treehouseCommandDecoders("Treehouse.Space")).find((op) => op.command === "create_thread")!;
assert(reference, "ordinary creation must retain its signed Space reference");
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const bundle = canonical({ format: "treehouse-initial-provisioning-v1", product: "treehouse",
  space: space.replica, spaceRoot: founder.state.publicKey, bootstrapId, referenceId: reference.id,
  profiles: await Promise.all(founder.state.profiles.map(exported)) });
process.stdout.write(JSON.stringify({ phase: "bundle", bytes: bundle }) + "\n", () => {
  lines.close(); process.stdin.destroy();
});
