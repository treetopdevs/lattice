// Operator integration fixture: real ordinary workflow and client signatures, isolated seed-store double.
// Uses supported offline workflow methods; no relay routes are fabricated or network dialed.
import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { ed25519 } from "@noble/curves/ed25519.js";
import { TreehouseWorkflow } from "../../src/treehouse_workflow";
import { BoundedNative } from "./bounded_native";
import { FaultNative } from "./fault_native";

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
  async exportPublicEvidence(_name: string, contents: string) { this.publicExport = contents; return "/fixture/public-evidence.json"; }
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

const memberNative = new FaultNative(); const member = new TreehouseWorkflow(memberNative);
await member.open(); const request = await member.beginJoin();
const recipient = await founder.reviewOfflineRecipient(request);
const invitation = await founder.issueOfflineInvitation(recipient.recipient);
await founder.exportOfflineInvitation("invitation.json", invitation);
const candidate = await member.reviewOfflineInvitation(new TextEncoder().encode(invitation));
assert.equal(candidate.fingerprint, recipient.fingerprint);
const acceptance = await member.acceptOfflineInvitation(recipient.fingerprint);
assert.equal(member.state.profiles.length, 0);
assert.equal(member.state.relay, null);
await founder.admitAndGrant(acceptance);
assert.equal(founder.state.relay, null);
await founder.command(founder.state.profiles[1]!.replica, { command: "post", text: "Ready for staging" });
await founder.exportInitialProvisioning("initial.json");
const bundle = native.publicExport;
process.stdout.write(JSON.stringify({ phase: "bundle", bytes: bundle, invitation, fingerprint: candidate.fingerprint }) + "\n", () => {
  lines.close(); process.stdin.destroy();
});
