import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  buildInitialProvisioningBundle, authorTreehouseOfflineInvitation, authorTreehouseCommand, authorTreehouseAdmitAndGrant, signTreehouseAcceptance, carrierDelegationsFromFrames,
  carrierOpsToSemanticOps, treehouseCommandDecoders, prepareTreehouseBoundedThreadCreation,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { buildOfflineInvitation, reviewOfflineInvitation, OFFLINE_EVIDENCE_MAX_BYTES } from "../src/offline_enrollment";

const vector = JSON.parse(readFileSync(new URL("../../lattice-client/test/vectors/treehouse/bounded_space_binding_v1.json", import.meta.url), "utf8"));
const seed = Buffer.from(vector.seeds.root, "hex");
const root = { publicKey: ed25519.getPublicKey(seed), sign: (bytes: Uint8Array) => ed25519.sign(bytes, seed) };
const memberSeed = new Uint8Array(32).fill(201);
const recipient = Buffer.from(ed25519.getPublicKey(memberSeed)).toString("base64");
const signer = (n: number) => { const key = new Uint8Array(32).fill(n); return { publicKey: ed25519.getPublicKey(key), sign: (bytes: Uint8Array) => ed25519.sign(bytes, key) }; };
const child = await prepareTreehouseBoundedThreadCreation({ replica: `replica:treehouse:thread:${Buffer.alloc(32, 203).toString("base64url")}`,
  title: "Private after admission", signer: signer(202), spaceRoot: root.publicKey,
  nominee: signer(204).publicKey, witnesses: [205, 206, 207].map(n => signer(n).publicKey), threshold: 2, maxLeaseEpochs: 7 });
const frames: CarrierOpFrame[] = vector.ops.map((op: { frame: CarrierOpFrame }) => op.frame);
const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
const referenced = new Set(ops.flatMap(op => op.deps));
const reference = await authorTreehouseCommand({ product: "Treehouse.Space", replica: vector.replica,
  signer: root, deps: ops.filter(op => !referenced.has(op.id)).map(op => op.id).sort(),
  capId: carrierDelegationsFromFrames(frames)[0]!.id,
  command: { command: "create_thread", threadReplica: child.replica, title: "Private after admission" } });
frames.push(reference);
const issued = await authorTreehouseOfflineInvitation({ signer: root, replica: vector.replica, frames,
  threadFrames: { [child.replica]: child.pending }, heldReplicas: [vector.replica, child.replica], recipient });
frames.push(issued.frame);
const text = await buildOfflineInvitation({ space: vector.replica, frames, invitationId: issued.frame.id, recipient });
const encoded = new TextEncoder().encode(text);
const review = await reviewOfflineInvitation(encoded, recipient);
assert.equal(review.spaceRoot, Buffer.from(root.publicKey).toString("base64"));
assert.deepEqual(review.threads, [child.replica]);
assert.match(review.fingerprint, /^(?:[a-f0-9]{4} ){15}[a-f0-9]{4}$/);
assert.equal(review.text, text);
assert.equal(text, await buildOfflineInvitation({ space: vector.replica, frames: [...frames].reverse(), invitationId: issued.frame.id, recipient }));
assert(!text.includes(child.pending[0]!.id), "invitation discloses Space evidence only");
const unchanged = structuredClone(frames);
const invalid = async (bytes: Uint8Array, who = recipient) => assert.rejects(() => reviewOfflineInvitation(bytes, who), /invalid_offline_invitation/);
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value, (_key, v) =>
  v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v));
await invalid(encoded, Buffer.from(signer(208).publicKey).toString("base64"));
await invalid(new Uint8Array(OFFLINE_EVIDENCE_MAX_BYTES + 1));
await invalid(new Uint8Array([255]));
await invalid(new TextEncoder().encode("\n" + text));
await invalid(new TextEncoder().encode('{"product":"treehouse",' + text.slice(1)));
for (const field of ["privateKey", "routes", "state", "trusted", "outbox"]) await invalid(json({ ...JSON.parse(text), [field]: "forbidden" }));
const doc = JSON.parse(text);
for (const changed of [
  { ...doc, bootstrapId: issued.frame.id },
  { ...doc, spaceRoot: recipient },
  { ...doc, profiles: [...doc.profiles, doc.profiles[0]] },
  { ...doc, profiles: [{ ...doc.profiles[0], frames: [...doc.profiles[0].frames, doc.profiles[0].frames[0]] }] },
  { ...doc, profiles: [{ ...doc.profiles[0], frames: doc.profiles[0].frames.filter((f: CarrierOpFrame) => f.id !== reference.id) }] },
  { ...doc, profiles: [{ ...doc.profiles[0], frames: doc.profiles[0].frames.map((f: CarrierOpFrame) => f.id === issued.frame.id ? { ...f, sig: Buffer.alloc(64).toString("base64") } : f) }] },
]) await invalid(json(changed));
assert.deepEqual(frames, unchanged);
console.log("PASS offline evidence: canonical bounded signed history, recipient/scope/fingerprint and fail-closed candidate review");

// Real workflow methods over isolated native stores; candidate history stays outside saved app state.
const { TreehouseWorkflow } = await import("../src/treehouse_workflow");
const { emptyState } = await import("../src/treehouse_state");
const { BoundedNative } = await import("./support/bounded_native");
const { FaultNative } = await import("./support/fault_native");
const founderNative = new BoundedNative(); founderNative.seed = seed;
const childNonce = child.replica.split(":")[3]!.split("#")[0]!;
founderNative.children.set(childNonce, new Uint8Array(32).fill(202)); founderNative.bindings.add(childNonce);
const selfInvite = await authorTreehouseOfflineInvitation({ signer: root, replica: vector.replica, frames,
  threadFrames: { [child.replica]: child.pending }, heldReplicas: [vector.replica, child.replica], recipient: Buffer.from(root.publicKey).toString("base64") });
frames.push(selfInvite.frame);
const selfAcceptance = await signTreehouseAcceptance({ replica: vector.replica, frames, invitationId: selfInvite.frame.id, signer: root });
const selfAdmission = await authorTreehouseAdmitAndGrant({ signer: root, replica: vector.replica, frames,
  threadFrames: { [child.replica]: child.pending }, acceptance: selfAcceptance, threadSigners: { [child.replica]: signer(202) } });
assert(selfAdmission.admit); frames.push(selfAdmission.admit);
const founderThreadFrames = [...child.pending, ...selfAdmission.grants.map(grant => grant.frame)];
founderNative.record = JSON.stringify({ ...emptyState(), publicKey: Buffer.from(root.publicKey).toString("base64"),
  active: child.replica, profiles: [
    { product: "Treehouse.Space", replica: vector.replica, frames, outbox: [], acked: [] },
    { product: "Treehouse.Thread", replica: child.replica, frames: founderThreadFrames, outbox: [], acked: [] },
  ] });
const founder = new TreehouseWorkflow(founderNative); await founder.open();
const memberNative = new FaultNative(); const member = new TreehouseWorkflow(memberNative); await member.open();
const request = await member.beginJoin();
const memberBefore = memberNative.record;
const recipientReview = await founder.reviewOfflineRecipient(request);
const founderBefore = founderNative.record;
await assert.rejects(() => founder.issueOfflineInvitation(recipient), /no_pending_offline_review/);
assert.equal(founderNative.record, founderBefore);
const invitationText = await founder.issueOfflineInvitation(recipientReview.recipient);
assert.equal(founder.state.relay, null);
const candidate = await member.reviewOfflineInvitation(new TextEncoder().encode(invitationText));
assert.equal(memberNative.record, memberBefore);
assert.equal(member.state.profiles.length, 0);
assert.equal(member.state.relay, null);
let signatures = 0;
const originalSign = memberNative.sign.bind(memberNative);
memberNative.sign = async bytes => { signatures++; return originalSign(bytes); };
const wrongFingerprint = (recipientReview.fingerprint[0] === "0" ? "1" : "0") + recipientReview.fingerprint.slice(1);
await assert.rejects(() => member.acceptOfflineInvitation(wrongFingerprint), /offline_fingerprint_mismatch/);
assert.equal(signatures, 0);
member.cancelOfflineReview();
await assert.rejects(() => member.acceptOfflineInvitation(candidate.fingerprint), /no_pending_offline_review/);
await member.reviewOfflineInvitation(new TextEncoder().encode(invitationText));
await member.open();
await assert.rejects(() => member.acceptOfflineInvitation(candidate.fingerprint), /no_pending_offline_review/);
await member.reviewOfflineInvitation(new TextEncoder().encode(invitationText));
memberNative.record = JSON.stringify({ ...JSON.parse(memberBefore!), revision: member.state.revision + 1 });
await assert.rejects(() => member.acceptOfflineInvitation(candidate.fingerprint), /stale_offline_review/);
assert.equal(signatures, 0);
memberNative.record = memberBefore;
const acceptance = await member.acceptOfflineInvitation(recipientReview.fingerprint.toUpperCase().replaceAll(" ", ""));
assert.equal(signatures, 1);
assert.equal(memberNative.record, memberBefore);
assert.equal(member.state.profiles.length, 0);
const admitted = await founder.admitAndGrant(acceptance);
assert(admitted.admit); assert.equal(admitted.grants.length, 1);
const after = founderNative.record;
assert.deepEqual(await founder.admitAndGrant(acceptance), { admit: null, grants: [] });
assert.equal(founderNative.record, after);
assert.equal(founder.state.relay, null);
await founder.reviewOfflineRecipient(request);
assert.equal(await founder.issueOfflineInvitation(recipientReview.recipient), await buildOfflineInvitation({ space: vector.replica,
  frames: founder.state.profiles[0]!.frames, invitationId: candidate.invitationId, recipient: recipientReview.recipient }));
console.log("PASS offline workflow: independent confirmations, cancel/reopen, no installed candidate/routes, direct child grant and replay");

const bundleInput = { space: vector.replica, spaceFrames: founder.state.profiles[0]!.frames,
  thread: child.replica, threadFrames: founder.state.profiles[1]!.frames };
const initialBundle = JSON.parse(await buildInitialProvisioningBundle(bundleInput));
assert.equal(initialBundle.spaceRoot, founder.state.publicKey);
assert.equal(initialBundle.profiles.length, 2);
await assert.rejects(() => buildInitialProvisioningBundle({ ...bundleInput, threadFrames: founderThreadFrames }), /invalid_initial_provisioning/);
console.log("PASS initial bundle checks the root binding and both direct live child grants before export");
