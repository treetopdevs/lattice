import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  prepareTreehouseBoundedSpaceCreation, prepareTreehouseBoundedThreadCreation,
  authorTreehouseCommand, authorTreehouseIssueInvitation, authorTreehouseOfflineInvitation, signTreehouseAcceptance,
  authorTreehouseAdmitAndGrant, authorTownshipRevocation, carrierDelegationsFromFrames,
  resolveContinuationProfileFromFrames,
  carrierOpsToSemanticOps, treehouseCommandDecoders, observeTreehouse, memberCapability,
} from "../src/index";
import type { CarrierOpFrame, TreehouseProduct } from "../src/index";
import { frontier } from "../src/sync";

const signer = (byte: number) => {
  const seed = new Uint8Array(32).fill(byte);
  return { publicKey: ed25519.getPublicKey(seed), sign: (bytes: Uint8Array) => ed25519.sign(bytes, seed) };
};
const root = signer(81), member = signer(82), stranger = signer(83), child = signer(85);
const key = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const nonce = Buffer.alloc(32, 84).toString("base64url");
const space = await prepareTreehouseBoundedSpaceCreation({ replica: `replica:treehouse:space:${nonce}`, name: "Canopy", signer: root });
const threadInput = { replica: `replica:treehouse:thread:${nonce}`, title: "General", signer: child,
  spaceRoot: root.publicKey, nominee: signer(86).publicKey,
  witnesses: [87, 88, 89].map((n) => signer(n).publicKey), threshold: 2, maxLeaseEpochs: 7 };
const thread = await prepareTreehouseBoundedThreadCreation(threadInput);
assert.notEqual(key(root.publicKey), key(child.publicKey));
const selected = await resolveContinuationProfileFromFrames({ replica: thread.replica, frames: thread.pending });
assert(selected.ok);
if (selected.ok) {
  assert.equal(selected.profile.kind, "thread");
  assert.equal(selected.profile.role, "moderator");
  assert.equal(selected.profileGenesis, thread.pending[2]!.id);
}
for (const invalid of [
  { nominee: root.publicKey }, { witnesses: [root.publicKey, signer(88).publicKey] },
  { nominee: child.publicKey }, { witnesses: [child.publicKey, signer(88).publicKey] },
  { witnesses: [threadInput.nominee, signer(88).publicKey] }, { threshold: 4 },
]) await assert.rejects(() => prepareTreehouseBoundedThreadCreation({ ...threadInput, ...invalid }));
await assert.rejects(() => prepareTreehouseBoundedThreadCreation({ ...threadInput, signer: root }), /thread_root_reused/);
assert.match(thread.replica, /#authority:bounded-continuation-v1#root:/);
assert.deepEqual(thread, await prepareTreehouseBoundedThreadCreation(threadInput));
for (const replica of [`replica:treehouse:space:${nonce}`, `replica:treehouse:thread:${nonce}#root:x`, `replica:treehouse:thread:${"A".repeat(42)}B`, `replica:treehouse:thread:${nonce}\n`]) {
  await assert.rejects(() => prepareTreehouseBoundedThreadCreation({ ...threadInput, replica }), /invalid_replica/);
}
const ops = (product: TreehouseProduct, frames: CarrierOpFrame[]) => carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders(product));
const rootCap = (frames: CarrierOpFrame[]) => carrierDelegationsFromFrames(frames)[0]!.id;
const reference = await authorTreehouseCommand({ product: "Treehouse.Space", replica: space.replica, signer: root,
  deps: frontier(ops("Treehouse.Space", space.pending)), capId: rootCap(space.pending),
  command: { command: "create_thread", threadReplica: thread.replica, title: "General" } });
let spaceFrames = [...space.pending, reference];
// The founder's participant identity joins the roster too, so both apps post/handshake
// as participant keys; the independent child root is reserved for setup/grants.
let initialThreadFrames = [...thread.pending];
const founderInvite = await authorTreehouseIssueInvitation({ signer: root, replica: space.replica, frames: spaceFrames,
  threadFrames: { [thread.replica]: initialThreadFrames }, routes: [{ replica: thread.replica }], recipient: key(root.publicKey) });
spaceFrames.push(founderInvite.frame);
const founderAcceptance = await signTreehouseAcceptance({ replica: space.replica, frames: spaceFrames,
  invitationId: founderInvite.frame.id, signer: root });
const founderAdmission = await authorTreehouseAdmitAndGrant({ signer: root, replica: space.replica, frames: spaceFrames,
  threadFrames: { [thread.replica]: initialThreadFrames }, acceptance: founderAcceptance, threadSigners: { [thread.replica]: child } });
assert(founderAdmission.admit);
spaceFrames.push(founderAdmission.admit);
initialThreadFrames.push(...founderAdmission.grants.map((g) => g.frame));
const invitation = await authorTreehouseIssueInvitation({ signer: root, replica: space.replica, frames: spaceFrames,
  threadFrames: { [thread.replica]: initialThreadFrames }, routes: [{ replica: thread.replica }], recipient: key(member.publicKey) });
const offlineInput = { signer: root, replica: space.replica, frames: spaceFrames,
  threadFrames: { [thread.replica]: initialThreadFrames }, heldReplicas: [space.replica, thread.replica], recipient: key(member.publicKey) };
assert.deepEqual(await authorTreehouseOfflineInvitation(offlineInput), invitation);
let signatures = 0;
await assert.rejects(() => authorTreehouseOfflineInvitation({ ...offlineInput, heldReplicas: [space.replica],
  signer: { publicKey: root.publicKey, sign: (bytes) => { signatures++; return root.sign(bytes); } } }), /thread_scope_not_held/);
assert.equal(signatures, 0);
await assert.rejects(() => authorTreehouseOfflineInvitation({ ...offlineInput, threadFrames: {} }), /thread_not_available/);
spaceFrames.push(invitation.frame);
await assert.rejects(() => signTreehouseAcceptance({ replica: space.replica, frames: spaceFrames, invitationId: invitation.frame.id, signer: stranger }), /wrong_recipient/);
const acceptance = await signTreehouseAcceptance({ replica: space.replica, frames: spaceFrames, invitationId: invitation.frame.id, signer: member });
const input = { signer: root, replica: space.replica, frames: spaceFrames, threadFrames: { [thread.replica]: initialThreadFrames }, acceptance, threadSigners: { [thread.replica]: child } };
await assert.rejects(() => authorTreehouseAdmitAndGrant({ ...input, acceptance: { ...acceptance, acceptance: key(new Uint8Array(64)) } }), /invalid_acceptance/);
await assert.rejects(() => authorTreehouseAdmitAndGrant({ ...input, threadSigners: { [thread.replica]: stranger } }), /no_capability/);
const admitted = await authorTreehouseAdmitAndGrant(input);
assert(admitted.admit);
assert.equal(admitted.grants.length, 1);
assert.equal(admitted.grants[0]!.frame.author, key(child.publicKey));
spaceFrames.push(admitted.admit);
let threadFrames = [...initialThreadFrames, admitted.grants[0]!.frame];
const cap = memberCapability(threadFrames, member.publicKey, thread.replica, { product: "Treehouse.Thread", command: "post" });
assert(cap, "bounded member grant is usable under existing authority rules");
const post = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: thread.replica, signer: member,
  deps: frontier(ops("Treehouse.Thread", threadFrames)), capId: cap.id, command: { command: "post", text: "Hello from the second app" } });
threadFrames.push(post);
const founderCap = memberCapability(threadFrames, root.publicKey, thread.replica, { product: "Treehouse.Thread", command: "post" });
assert(founderCap);
const founderPost = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: thread.replica, signer: root,
  deps: frontier(ops("Treehouse.Thread", threadFrames)), capId: founderCap.id, command: { command: "post", text: "Hello from the founder" } });
threadFrames.push(founderPost);
const observed = observeTreehouse("Treehouse.Thread", ops("Treehouse.Thread", threadFrames));
assert.equal(observed.quarantineReasons.size, 0);
assert.deepEqual(observed.posts.map((p) => p.text), ["Hello from the second app", "Hello from the founder"]);
assert.equal(observeTreehouse("Treehouse.Space", ops("Treehouse.Space", spaceFrames)).quarantineReasons.size, 0);
const repeat = await authorTreehouseAdmitAndGrant({ ...input, frames: spaceFrames, threadFrames: { [thread.replica]: threadFrames } });
assert.deepEqual(repeat, { admit: null, grants: [] });
const revoke = await authorTownshipRevocation({ replica: thread.replica, signer: child,
  deps: frontier(ops("Treehouse.Thread", threadFrames)), delegationId: cap.id });
const revoked = [...threadFrames, revoke];
assert.equal(memberCapability(revoked, member.publicKey, thread.replica, { product: "Treehouse.Thread", command: "post" }), null);
const refusedPost = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: thread.replica, signer: member,
  deps: frontier(ops("Treehouse.Thread", revoked)), capId: cap.id, command: { command: "post", text: "Must refuse" } });
const revokedView = observeTreehouse("Treehouse.Thread", ops("Treehouse.Thread", [...revoked, refusedPost]));
assert.equal(revokedView.quarantineReasons.get(refusedPost.id), "revoked_capability");
const wrongPost = await authorTreehouseCommand({ product: "Treehouse.Thread", replica: thread.replica, signer: stranger,
  deps: frontier(ops("Treehouse.Thread", threadFrames)), capId: cap.id, command: { command: "post", text: "Wrong recipient" } });
const wrongView = observeTreehouse("Treehouse.Thread", ops("Treehouse.Thread", [...threadFrames, wrongPost]));
assert.equal(wrongView.quarantineReasons.get(wrongPost.id), "capability_wrong_audience");
const describe = (product: TreehouseProduct, frames: CarrierOpFrame[]) => {
  const view = observeTreehouse(product, ops(product, frames));
  return { product, replica: frames[0]!.replica, frames, reasons: Object.fromEntries(view.quarantineReasons), state: view.state };
};
if (process.env.TREEHOUSE_BOUNDED_ENROLLMENT_ARTIFACT) writeFileSync(process.env.TREEHOUSE_BOUNDED_ENROLLMENT_ARTIFACT, JSON.stringify({
  logs: [describe("Treehouse.Space", spaceFrames), describe("Treehouse.Thread", threadFrames),
    describe("Treehouse.Thread", [...revoked, refusedPost]), describe("Treehouse.Thread", [...threadFrames, wrongPost])],
  postId: post.id, postIds: [post.id, founderPost.id], refusedPostId: refusedPost.id, wrongPostId: wrongPost.id,
}));
console.log("PASS bounded Thread creation and enrollment: invitation, acceptance, admission, exact-audience grant, post, retry and refusals");
