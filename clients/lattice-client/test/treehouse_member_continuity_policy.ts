import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import type { Op } from "../src/op";
import * as codec from "../src/treehouse_member_continuity_codec";
import { bindTownshipReplica } from "../src/township";
import {
  memberContinuityCommandConflicts,
  memberContinuityCommandStatus,
  memberContinuityHeads,
  observeMemberContinuityFromFrames,
  type MemberContinuityContext,
} from "../src/treehouse_member_continuity";
import { memberContinuityFixture } from "./support/export_member_continuity";

const digest = (label: string) => createHash("sha256").update(`r19b-policy:${label}`).digest();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const opId = (label: string) => digest(label).toString("base64url");
const identity = (label: string) => ({seed: digest(label), pub: ed25519.getPublicKey(digest(label))});
const root = identity("root"), old = identity("old"), next = identity("next");
const voucherKeys = [identity("voucher-a"), identity("voucher-b")].sort((a, b) => Buffer.compare(a.pub, b.pub));
let replica = "";

function op(label: string, command: string, args: unknown[], deps: string[] = []): Op {
  const id = opId(label);
  return {id, hash: id, replica, deps, kind: "command", author: b64(root.pub), authorPubkey: b64(root.pub),
    field: "admin_actions", mutation: "write", value: command, command, commandArgs: args};
}
function admission(label: string, key: Uint8Array, deps: string[] = []) {
  return op(label, "admit_member", ["invite", b64(key), "member", "acceptance"], deps);
}
function removal(label: string, key: Uint8Array, deps: string[]) {
  return op(label, "remove_member", [b64(key)], deps);
}
function beacon(label: string, deps: string[] = []): Op {
  const value = op(label, "beacon", [], deps); return {...value, kind: "authority", authority: {type: "beacon", epoch: 0}};
}
async function fixture() {
  replica = await bindTownshipReplica(`replica:treehouse:space:${opId("space")}#authority:bounded-continuation-v1`, root.pub);
  const oldAdmission = admission("old-admission", old.pub);
  const vouchers = voucherKeys.map((key, index) => admission(`voucher-${index}`, key.pub));
  const epoch = beacon("beacon", [oldAdmission.id, ...vouchers.map((entry) => entry.id)]);
  const claim: codec.MemberContinuityClaim = {version: 1, product: "treehouse", space: replica,
    oldPub: b64(old.pub), newPub: b64(next.pub), oldAdmission: oldAdmission.id, oldMembership: "active",
    nonce: b64(digest("nonce")), deps: [epoch.id], epoch: 0, epochBasis: [epoch.id], parents: [],
    vouchers: voucherKeys.map((key, index) => ({member: b64(key.pub), admission: vouchers[index]!.id}))};
  const possession = b64(ed25519.sign(codec.canonicalBytesForMemberContinuityPossession(claim), next.seed));
  const certificate: codec.MemberContinuityCertificate = {claim, possession, vouches: voucherKeys.map((key) => ({member: b64(key.pub),
    signature: b64(ed25519.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession), key.seed))}))};
  const statement = op("statement", "attest_member_key_v1", [claim, possession, certificate.vouches], claim.deps);
  const visibleOps = new Map([oldAdmission, ...vouchers, epoch].map((entry) => [entry.id, entry]));
  const verdicts = new Map([...visibleOps.keys()].map((id) => [id, "honored"]));
  const context: MemberContinuityContext = {visibleOps, verdicts, validBeacons: [{opId: epoch.id, epoch: 0}]};
  return {claim, certificate, statement, context, oldAdmission, vouchers};
}

test("individual judgment follows shape, target, eligibility, epoch, context, certificate precedence", async () => {
  const f = await fixture();
  assert.deepEqual(memberContinuityCommandStatus(f.statement, new Set(f.context.visibleOps.keys()), f.context), {ok: true});
  const malformed = {...f.statement, commandArgs: [{...f.claim, extra: true}, f.certificate.possession, f.certificate.vouches]};
  assert.equal(reason(memberContinuityCommandStatus(malformed, new Set(), {visibleOps: new Map(), verdicts: new Map(), validBeacons: []})),
    "application_invalid_continuity");
  const missing = new Map(f.context.visibleOps); missing.delete(f.vouchers[0]!.id);
  const quarantined = new Map(f.context.verdicts); quarantined.set(f.oldAdmission.id, "bad_signature");
  assert.equal(reason(memberContinuityCommandStatus(f.statement, new Set(missing.keys()), {...f.context, visibleOps: missing})),
    "application_target_not_visible");
  assert.equal(reason(memberContinuityCommandStatus(f.statement, new Set(f.context.visibleOps.keys()), {...f.context, verdicts: quarantined})),
    "application_target_quarantined");
  const wrongOps = new Map(f.context.visibleOps);
  wrongOps.set(f.oldAdmission.id, {...f.oldAdmission, commandArgs: ["invite", b64(identity("stranger").pub), "member", "acceptance"]});
  assert.equal(reason(memberContinuityCommandStatus(f.statement, new Set(wrongOps.keys()), {...f.context, visibleOps: wrongOps})),
    "application_wrong_target");
  const voucherRemove = removal("causal-voucher-remove", voucherKeys[0]!.pub, [f.vouchers[0]!.id]);
  const removedOps = new Map([...f.context.visibleOps, [voucherRemove.id, voucherRemove]]);
  const removedVerdicts = new Map([...f.context.verdicts, [voucherRemove.id, "honored"]]);
  assert.equal(reason(memberContinuityCommandStatus(f.statement, new Set(removedOps.keys()),
    {...f.context, visibleOps: removedOps, verdicts: removedVerdicts})), "application_continuity_ineligible_member");
  assert.equal(reason(memberContinuityCommandStatus(f.statement, new Set(f.context.visibleOps.keys()), {...f.context, validBeacons: []})),
    "application_continuity_invalid_epoch");
  const prior = op("prior-wrapper", "attest_member_key_v1",
    [f.claim, f.certificate.possession, f.certificate.vouches], f.claim.deps);
  const priorOps = new Map([...f.context.visibleOps, [prior.id, prior]]);
  const priorVerdicts = new Map([...f.context.verdicts, [prior.id, "honored"]]);
  assert.equal(reason(memberContinuityCommandStatus(f.statement, new Set(priorOps.keys()),
    {...f.context, visibleOps: priorOps, verdicts: priorVerdicts})), "application_continuity_stale_context");
  const bad = {...f.statement, commandArgs: [f.claim, b64(new Uint8Array(64)), f.certificate.vouches]};
  assert.equal(reason(memberContinuityCommandStatus(bad, new Set(f.context.visibleOps.keys()), f.context)),
    "application_continuity_invalid_certificate");
});

function reason(result: {ok: true} | {ok: false; reason: string}): string | undefined {
  return result.ok ? undefined : result.reason;
}

test("deny-only graph seeds stale vouchers before target collision and propagates invalid parents", async () => {
  const f = await fixture();
  const remove = removal("remove", voucherKeys[0]!.pub, [f.vouchers[0]!.id]);
  const otherOld = identity("other-old");
  const otherClaim = {...f.claim, oldPub: b64(otherOld.pub), nonce: b64(digest("other-nonce"))};
  const otherPossession = b64(ed25519.sign(codec.canonicalBytesForMemberContinuityPossession(otherClaim), next.seed));
  const otherVouches = voucherKeys.map((key) => ({member: b64(key.pub), signature: b64(ed25519.sign(
    codec.canonicalBytesForMemberContinuityVouch(otherClaim, otherPossession), key.seed))}));
  const other = op("other", "attest_member_key_v1", [otherClaim, otherPossession, otherVouches], otherClaim.deps);
  const parent = codec.memberContinuityClaimId(f.claim)!;
  const resolutionClaim = {...f.claim, parents: [parent], deps: [f.statement.id, other.id].sort()};
  const resolutionPossession = b64(ed25519.sign(codec.canonicalBytesForMemberContinuityPossession(resolutionClaim), next.seed));
  const resolutionVouches = voucherKeys.map((key) => ({member: b64(key.pub), signature: b64(ed25519.sign(
    codec.canonicalBytesForMemberContinuityVouch(resolutionClaim, resolutionPossession), key.seed))}));
  const resolution = op("resolution", "attest_member_key_v1", [resolutionClaim, resolutionPossession, resolutionVouches], resolutionClaim.deps);
  const ops = new Map([f.statement, other, resolution, remove].map((entry) => [entry.id, entry]));
  const verdicts = new Map([...ops.keys()].map((id) => [id, "honored"]));
  const denied = memberContinuityCommandConflicts(ops, verdicts);
  assert.equal(denied.get(f.statement.id), "application_continuity_stale_voucher");
  assert.equal(denied.get(other.id), "application_continuity_stale_voucher");
  assert.equal(denied.get(resolution.id), "application_continuity_stale_voucher");
  const collisionOps = new Map([f.statement, other].map((entry) => [entry.id, entry]));
  const collisions = memberContinuityCommandConflicts(collisionOps,
    new Map([...collisionOps.keys()].map((id) => [id, "honored"])));
  assert.equal(collisions.get(f.statement.id), "application_continuity_conflicting_target");
  assert.equal(collisions.get(other.id), "application_continuity_conflicting_target");
  const parentOps = new Map([f.statement, other, resolution].map((entry) => [entry.id, entry]));
  const parents = memberContinuityCommandConflicts(parentOps,
    new Map([...parentOps.keys()].map((id) => [id, "honored"])));
  assert.equal(parents.get(resolution.id), "application_continuity_invalid_parent");
});

test("heads coalesce wrappers and retain every same-old unresolved claim", async () => {
  const f = await fixture();
  const secondClaim = {...f.claim, nonce: b64(digest("second"))};
  assert.deepEqual(memberContinuityHeads([
    {wrapperId: f.statement.id, certificate: f.certificate},
    {wrapperId: "duplicate", certificate: f.certificate},
    {wrapperId: "second", certificate: {...f.certificate, claim: secondClaim}},
  ], f.claim.oldPub), [codec.memberContinuityClaimId(f.claim), codec.memberContinuityClaimId(secondClaim)].sort());
});

test("public observation authenticates raw closure and uses the ordinary capability judge", async () => {
  const raw = await memberContinuityFixture();
  const observed = await observeMemberContinuityFromFrames({replica: raw.replica, frames: raw.frames, oldPub: raw.claim.oldPub});
  assert.equal(observed.ok, true);
  if (observed.ok) {
    assert.deepEqual(observed.verifiedFrontier, [raw.command.id]);
    assert.deepEqual(observed.records, []);
    assert.equal(observed.quarantine.find((entry) => entry.opId === raw.command.id)?.reason, "operation_not_granted");
    assert.equal(observed.links[0]?.status, "unlinked");
  }
  const forged = raw.frames.map((frame) => frame.id === raw.command.id ? {...frame, sig: b64(new Uint8Array(64))} : frame);
  assert.deepEqual(await observeMemberContinuityFromFrames({replica: raw.replica, frames: forged}),
    {ok: false, reason: "invalid_verified_history"});
  const partial = raw.frames.filter((frame) => frame.id === raw.command.id);
  assert.deepEqual(await observeMemberContinuityFromFrames({replica: raw.replica, frames: partial}),
    {ok: false, reason: "invalid_verified_history"});
});
