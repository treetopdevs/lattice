import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import { BoundedNative } from "./support/bounded_native";
import { resolveContinuationProfileFromFrames, carrierDelegationsFromFrames, authorTownshipRevocation, encodeTreehouseJoinRequest, decodeTreehouseOffer, signTreehouseAcceptance, encodeTreehouseAcceptance, memberCapability } from "@treetopdevs/lattice-client";

const pub = (n: number) => Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(n))).toString("base64");
const setup = { nominee: pub(101), witnesses: [102, 103, 104].map(pub), threshold: 2, maxLeaseEpochs: 7 };

const native = new BoundedNative();
let app = new TreehouseWorkflow(native);
await app.open(); await app.createSpace("Canopy");
const before = native.record;
await assert.rejects(() => app.createThread("Owner nominee", { ...setup, nominee: app.state.publicKey! }), /invalid_thread_setup/);
await assert.rejects(() => app.createThread("Owner witness", { ...setup, witnesses: [app.state.publicKey!, pub(103)] }), /invalid_thread_setup/);
assert.equal(native.record, before);
await assert.rejects(() => app.createThread("Too many witnesses", { ...setup, witnesses: Array.from({ length: 17 }, (_, i) => pub(120 + i)) }), /invalid_thread_setup/);
assert.equal(native.record, before);
assert.equal(native.created, 0);
await assert.rejects(() => app.createThread("Invalid", { ...setup, threshold: 4 }), /invalid_thread_setup/);
assert.equal(native.record, before);
native.failAfterKey = true;
await assert.rejects(() => app.createThread("General", setup), /disk_write_refused/);
const intent = app.state.intent!;
assert.deepEqual(intent.setup, setup);
assert.equal(app.state.profiles.length, 1, "no half-Thread/reference/admission is published");
assert.equal(native.created, 1);
const pendingKey = await native.initializeThread(intent.nonce);
native.failAfterKey = false; native.failCommit = false;
app = new TreehouseWorkflow(native); await app.open(); await app.resumeCreation();
const child = app.state.profiles.find((p) => p.product === "Treehouse.Thread")!;
const root = child.frames.find((f) => f.deps.length === 0)!;
assert.equal(root.author, pendingKey);
assert.notEqual(root.author, app.state.publicKey);
assert.equal(native.created, 1);
assert.equal(app.state.intent, null);
const pin = await resolveContinuationProfileFromFrames({ replica: child.replica, frames: child.frames });
assert(pin.ok);
if (pin.ok) assert.deepEqual(pin.profile.witnesses, [...setup.witnesses].sort());
const grants = carrierDelegationsFromFrames(child.frames).filter((d) => d.audience === app.state.publicKey);
assert(grants.some((d) => d.ops.includes("post")));
assert.deepEqual(app.views.get(app.state.profiles[0]!.replica)!.state.members, [app.state.publicKey]);
await app.command(child.replica, { command: "post", text: "Participant post" });
const post = app.state.profiles[1]!.frames.at(-1)!;
assert.equal(post.author, app.state.publicKey);
async function exportArtifact(current: TreehouseWorkflow, path: string | undefined) {
  if (!path) return;
  const { writeFileSync } = await import("node:fs");
  writeFileSync(path, JSON.stringify({
    version: 1, product: "treehouse", readiness: "recovery_not_ready", publicKey: current.state.publicKey,
    profiles: current.state.profiles.map((profile) => {
      const view = current.views.get(profile.replica)!;
      return { ...profile, expect: { state: view.state, posts: view.posts, order: view.order,
        quarantine: [...view.quarantineReasons].sort(), operationCount: view.operationCount } };
    }),
  }));
}
await exportArtifact(app, process.env.TREEHOUSE_BOUNDED_CREATION_ARTIFACT);

const persisted = native.record;
app = new TreehouseWorkflow(native); await app.open();
assert.equal(native.record, persisted, "reopen does not write history");
assert.equal(native.created, 1);
assert(app.canAuthor(child.replica, "archive_thread"));
await app.command(child.replica, { command: "archive_thread" });
assert.equal(app.state.profiles[1]!.frames.at(-1)!.author, pendingKey, "moderation uses the native child signer");
assert.equal(app.views.get(child.replica)!.state.archived, true);

// A completed uncertain write is recognized; a missing child key is never replaced.
native.failAfterWrite = true;
await app.createThread("Second", setup);
assert.equal(app.state.profiles.length, 3);
assert.equal(native.created, 2);
native.failAfterWrite = false;
const second = app.state.profiles[2]!;
const secondNonce = second.replica.split(":")[3]!.split("#")[0]!;
const secondKey = await native.initializeThread(secondNonce);
const secondGrant = carrierDelegationsFromFrames(second.frames).find((d) => d.audience === app.state.publicKey)!;
const revoke = await authorTownshipRevocation({ replica: second.replica,
  signer: { publicKey: Buffer.from(secondKey, "base64"), sign: (bytes) => native.signThread(secondNonce, bytes) },
  deps: [second.frames.at(-1)!.id], delegationId: secondGrant.id });
const revoked = structuredClone(app.state); revoked.revision++; revoked.profiles[2]!.frames.push(revoke);
assert(await native.commit(app.state.revision, JSON.stringify(revoked)));
app = new TreehouseWorkflow(native); await app.open();
assert(!app.canAuthor(second.replica, "post"));
assert(app.canAuthor(second.replica, "archive_thread"));
const beforeRefusedPost = native.record;
await assert.rejects(() => app.command(second.replica, { command: "post", text: "Must refuse" }), /no_capability/);
assert.equal(native.record, beforeRefusedPost, "no child-root posting fallback after participant revocation");
const beforeAdditional = native.record;
await assert.rejects(() => app.createThread("Blocked", setup), /existing_thread_grant_unavailable/);
assert.equal(native.record, beforeAdditional, "a revoked existing grant refuses before persisting a new intent");
assert.equal(native.created, 2);
native.children.delete(intent.nonce);
app = new TreehouseWorkflow(native); await app.open();
assert.equal(app.threadKeyIssue(child.replica), "thread_key_missing");
assert(!app.canAuthor(child.replica, "archive_thread"));
assert.equal(native.created, 2);
assert.equal(app.views.get(child.replica)!.state.title, "General");


const capNative = new BoundedNative();
const capApp = new TreehouseWorkflow(capNative); await capApp.open(); await capApp.createSpace("Scope cap");
for (const title of ["One", "Two", "Three"]) await capApp.createThread(title, setup);
const beforeFourth = capNative.record;
await assert.rejects(() => capApp.createThread("Fourth", setup), /thread_cap_reached/);
assert.equal(capNative.record, beforeFourth);
assert.equal(capNative.created, 3);
const malformed = { ...parseState(capNative.record), intent: { kind: "thread", name: "Bad", nonce: "A".repeat(43), setup: null } };
assert.throws(() => parseState(JSON.stringify(malformed)), /invalid_creation_intent/);
const noncanonical = { ...parseState(capNative.record), intent: { kind: "thread", name: "Bad", nonce: "A".repeat(42) + "B", setup } };
assert.throws(() => parseState(JSON.stringify(noncanonical)), /invalid_creation_intent/);
const firstCapChild = capApp.state.profiles[1]!;
const firstCapNonce = firstCapChild.replica.split(":")[3]!.split("#")[0]!;
const childRoot = await capNative.threadIdentity(firstCapNonce);
const genesisCap = carrierDelegationsFromFrames(firstCapChild.frames).find((d) => d.parent_id === null && d.ops.includes("archive_thread"))!;
const rootRevoke = await authorTownshipRevocation({ replica: firstCapChild.replica,
  signer: { publicKey: Buffer.from(childRoot, "base64"), sign: (bytes) => capNative.signThread(firstCapNonce, bytes) },
  deps: [firstCapChild.frames.at(-1)!.id], delegationId: genesisCap.id });
const withoutRoot = structuredClone(capApp.state); withoutRoot.revision++; withoutRoot.profiles[1]!.frames.push(rootRevoke);
assert(await capNative.commit(capApp.state.revision, JSON.stringify(withoutRoot)));
const noRoot = new TreehouseWorkflow(capNative); await noRoot.open();
assert(!noRoot.canAuthor(firstCapChild.replica, "archive_thread"), "empty continuation pin grants no moderation");
await assert.rejects(() => noRoot.command(firstCapChild.replica, { command: "archive_thread" }), /no_capability/);

const maxNative = new BoundedNative(); const maxApp = new TreehouseWorkflow(maxNative);
await maxApp.open(); await maxApp.createSpace("Maximum setup");
const sizeBefore = Buffer.byteLength(maxNative.record!);
await maxApp.createThread("\u0000".repeat(16_384), { ...setup, threshold: 16, witnesses: Array.from({ length: 16 }, (_, i) => pub(120 + i)) });
assert(Buffer.byteLength(maxNative.record!) - sizeBefore < 131_072, "maximum title/profile fits the reserved creation transaction");
console.log("PASS bounded workflow: atomic creation, independent custody, exact retry, restart, participant posting, root moderation and missing-key refusal");

// Abandoning a lost, never-committed child keeps old Threads writable and never reuses its binding.
const lostNative = new BoundedNative(); let lostApp = new TreehouseWorkflow(lostNative);
await lostApp.open(); await lostApp.createSpace("Recoverable setup"); await lostApp.createThread("Retained", setup);
const retained = structuredClone(lostApp.state.profiles);
lostNative.failAfterKey = true;
await assert.rejects(() => lostApp.createThread("Lost", setup), /disk_write_refused/);
const lostNonce = lostApp.state.intent!.nonce;
lostNative.failAfterKey = false; lostNative.failCommit = false;
await assert.rejects(() => lostApp.abandonThreadCreation(), /thread_abandon_not_allowed/);
lostNative.children.delete(lostNonce);
lostApp = new TreehouseWorkflow(lostNative); await lostApp.open();
await assert.rejects(() => lostApp.resumeCreation(), /thread_key_missing/);
await lostApp.abandonThreadCreation();
assert.equal(lostApp.state.intent, null);
assert.deepEqual(lostApp.state.profiles, retained);
assert(lostNative.bindings.has(lostNonce));
await lostApp.command(retained[1]!.replica, { command: "post", text: "Existing Thread still works" });
assert.equal(lostNative.created, 2);

// Later participants receive direct child-root grants, independent of the founder's posting grant.
const grantNative = new BoundedNative(); const grantApp = new TreehouseWorkflow(grantNative);
await grantApp.open(); await grantApp.createSpace("Independent grants"); await grantApp.createThread("General", setup);
const [grantSpace, grantChild] = grantApp.state.profiles;
await grantApp.configureRoutes(JSON.stringify({ localRealm: "founder", routes: [grantSpace!, grantChild!].map((p, i) => ({
  replica: p.replica, url: `wss://relay.example.test/r/${i}`, expectedPeerRealm: "service", expectedPeerPubkey: pub(170),
})) }));
const memberSeed = new Uint8Array(32).fill(171);
const memberSigner = { publicKey: ed25519.getPublicKey(memberSeed), sign: (bytes: Uint8Array) => ed25519.sign(bytes, memberSeed) };
const memberKey = Buffer.from(memberSigner.publicKey).toString("base64");
const offer = decodeTreehouseOffer(await grantApp.issueInvitation(encodeTreehouseJoinRequest({ publicKey: memberKey }), "member"));
const accepted = await signTreehouseAcceptance({ replica: grantSpace!.replica, frames: grantApp.state.profiles[0]!.frames,
  invitationId: offer.invitationId, signer: memberSigner });
await grantApp.admitAndGrant(encodeTreehouseAcceptance(accepted));
let grantedFrames = grantApp.state.profiles[1]!.frames;
const childRootKey = grantedFrames[0]!.author;
const memberGrant = carrierDelegationsFromFrames(grantedFrames).find((d) => d.audience === memberKey)!;
const rootGrant = carrierDelegationsFromFrames(grantedFrames).find((d) => d.parent_id === null && d.ops.includes("post"))!;
assert.equal(memberGrant.issuer, childRootKey); assert.equal(memberGrant.parent_id, rootGrant.id);
const founderGrant = carrierDelegationsFromFrames(grantedFrames).find((d) => d.audience === grantApp.state.publicKey)!;
const grantNonce = grantChild!.replica.split(":")[3]!.split("#")[0]!;
const revokedFounder = await authorTownshipRevocation({ replica: grantChild!.replica,
  signer: { publicKey: Buffer.from(childRootKey, "base64"), sign: (bytes) => grantNative.signThread(grantNonce, bytes) },
  deps: [grantedFrames.at(-1)!.id], delegationId: founderGrant.id });
grantedFrames = [...grantedFrames, revokedFounder];
assert(memberCapability(grantedFrames, memberKey, grantChild!.replica, { product: "Treehouse.Thread", command: "post" }));
// Membership invitations cover every honored Thread; adding a Thread makes old scope stale.
await grantApp.createThread("After invitation", setup);
const laterNonce = grantApp.state.profiles[2]!.replica.split(":")[3]!.split("#")[0]!;
grantNative.children.delete(laterNonce);
const staleApp = new TreehouseWorkflow(grantNative); await staleApp.open();
const staleRecord = grantNative.record;
await assert.rejects(() => staleApp.admitAndGrant(encodeTreehouseAcceptance(accepted)), /stale_scope/);
assert.equal(grantNative.record, staleRecord, "stale invitation cannot alter any history or outbox");
grantNative.outOfScope.add(grantNonce);
const restored = new TreehouseWorkflow(grantNative); await restored.open();
assert.equal(restored.threadKeyIssue(grantChild!.replica), "thread_key_mismatch");
assert.equal(restored.views.get(grantChild!.replica)!.state.title, "General");
console.log("PASS lost-key abandonment, direct child-root member grants, and out-of-scope read-only recovery");

await exportArtifact(maxApp, process.env.TREEHOUSE_BOUNDED_MAX_ARTIFACT);
const minNative = new BoundedNative(); const minApp = new TreehouseWorkflow(minNative);
await minApp.open(); await minApp.createSpace("Minimum setup");
await minApp.createThread("One witness", { ...setup, witnesses: [pub(102)], threshold: 1 });
await exportArtifact(minApp, process.env.TREEHOUSE_BOUNDED_MIN_ARTIFACT);
