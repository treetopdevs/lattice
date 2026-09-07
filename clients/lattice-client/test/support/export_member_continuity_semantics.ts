import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {readFile, writeFile, mkdir} from "node:fs/promises";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ed25519} from "@noble/curves/ed25519.js";
import type {CarrierOpFrame, CarrierTerm} from "../../src/carrier";
import {carrierDelegationsFromFrames, carrierOpsToSemanticOps} from "../../src/carrier";
import {authorCarrierDelegation, authorCarrierOp, canonicalBytesForCarrierOp, canonicalBytesForCarrierTerm} from "../../src/codec";
import {continuationProfileToCarrierTerm} from "../../src/continuation";
import {materialize} from "../../src/materialize";
import {authorTownshipGenesis, townshipCapTerm} from "../../src/township";
import {authorTreehouseCommand, treehouseCommandDecoders, treehouseInvitationAcceptanceBytes, treehouseSpaceSchema} from "../../src/treehouse";
import * as codec from "../../src/treehouse_member_continuity_codec";
import {assembleMemberContinuityFromFrames, observeMemberContinuityFromFrames, reviewMemberContinuityFromFrames} from "../../src/treehouse_member_continuity";

const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const digest = (label: string) => createHash("sha256").update(`ts-semantic-independent:${label}`).digest();
const id = (label: string) => digest(label).toString("base64url");
const key = (label: string) => {const seed = digest(label); return {publicKey: ed25519.getPublicKey(seed), sign: (bytes: Uint8Array) => ed25519.sign(bytes, seed)};};
const atom = (value: string): CarrierTerm => ["atom", value];
const tuple = (...values: CarrierTerm[]): CarrierTerm => ["tuple", values];
const bin = (value: Uint8Array): CarrierTerm => ["bin", b64(value)];
const integer = (value: number): CarrierTerm => ["int", value];
const map = (values: Record<string, CarrierTerm>): CarrierTerm => ["map", Object.entries(values).map(([k,v]) => [atom(k), v])];

export async function semanticSummary(replica: string, frames: readonly CarrierOpFrame[], oldPub: string) {
  const observed = await observeMemberContinuityFromFrames({replica, frames, oldPub});
  assert.ok(observed.ok, JSON.stringify(observed));
  const ops = carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders("Treehouse.Space"));
  const fullState = materialize(treehouseSpaceSchema, ops, new Set(ops.map(op => op.id)), null, replica).state;
  const {admin, moderator, ...state} = fullState;
  const holders = {admin, moderator};
  return {frontier: observed.verifiedFrontier,
    records: observed.records.map(record => ({claim_id: record.claimId,
      claim_bytes: b64(codec.canonicalBytesForMemberContinuityClaim(record.claim)),
      wrappers: record.wrappers.map(wrapper => ({op_id: wrapper.opId, author: wrapper.author,
        cap_id: wrapper.capId, certificate_bytes: b64(canonicalBytesForCarrierTerm(codec.memberContinuityCertificateToCarrierTerm(wrapper.certificate)!))}))})),
    links: observed.links.map(link => ({old_pub: link.oldPub, heads: link.heads, status: link.status,
      affected_wrappers: link.affectedWrappers.map(wrapper => ({op_id: wrapper.opId, reason: wrapper.reason}))})),
    quarantine: observed.quarantine.map(item => ({op_id: item.opId, reason: item.reason})), state, holders};
}

export async function semanticCorpus() {
  const admin = key("admin"), old = key("old"), next = key("new"), nominee = key("nominee");
  const vouchers = [key("voucher-a"), key("voucher-b")].sort((a,b) => Buffer.compare(a.publicKey, b.publicKey));
  const genesis = await authorTownshipGenesis({replica: `replica:treehouse:space:${id("space")}#authority:bounded-continuation-v1`,
    signer: admin, roles: ["admin", "moderator"],
    ops: ["create_space", "create_thread", "issue_invitation", "revoke_invitation", "admit_member", "remove_member", "attest_member_key_v1"]});
  const replica = genesis.replica;
  const cap = carrierDelegationsFromFrames([genesis])[0]!;
  const witnesses = [old, ...vouchers].sort((a,b) => Buffer.compare(a.publicKey, b.publicKey));
  const empty = await authorCarrierDelegation({replica, audiencePubkey: admin.publicKey, signer: admin});
  const profile = continuationProfileToCarrierTerm({mode: "bounded_continuation", version: 1, product: "treehouse", kind: "space",
    role: "admin", nominee: b64(nominee.publicKey), witnesses: witnesses.map(w => b64(w.publicKey)), threshold: 2, maxLeaseEpochs: 7})!;
  const beaconPolicy = map({mode: atom("witnessed"), version: integer(1), witnesses: ["list", witnesses.map(w => bin(w.publicKey))],
    threshold: integer(2), max_epoch_step: integer(1)});
  const pin = await authorCarrierOp({replica, deps: [genesis.id], kind: "authority", cap: ["nil"], signer: admin,
    body: tuple(atom("genesis"), ["delegation", empty], map({__continuation__: profile, __beacon__: beaconPolicy}))});
  const frames = [genesis, pin];
  const admissions: string[] = [];
  for (const member of [old, ...vouchers]) {
    const invite = await authorTreehouseCommand({product: "Treehouse.Space", replica, deps: [frames.at(-1)!.id], signer: admin, capId: cap.id,
      command: {command: "issue_invitation", recipient: b64(member.publicKey), threads: []}});
    frames.push(invite);
    const semantic = carrierOpsToSemanticOps([invite], {}, treehouseCommandDecoders("Treehouse.Space"))[0]!;
    const acceptance = b64(member.sign(treehouseInvitationAcceptanceBytes(replica, semantic)));
    const admitted = await authorTreehouseCommand({product: "Treehouse.Space", replica, deps: [invite.id], signer: admin, capId: cap.id,
      command: {command: "admit_member", invitationId: invite.id, recipient: b64(member.publicKey), level: "member", acceptance}});
    admissions.push(admitted.id); frames.push(admitted);
  }
  const epoch = await authorCarrierOp({replica, deps: [frames.at(-1)!.id], kind: "authority", cap: ["nil"], signer: admin,
    body: tuple(atom("beacon"), integer(0))});
  frames.push(epoch);
  const request = {replica, frames, oldPub: b64(old.publicKey), oldAdmission: admissions[0]!,
    newPub: b64(next.publicKey), oldMembership: "active" as const, nonce: b64(digest("nonce")),
    voucherAdmissions: [admissions[1]!, admissions[2]!] as [string,string], author: b64(admin.publicKey), capId: cap.id};
  const reviewed = await reviewMemberContinuityFromFrames(request);
  assert.ok(reviewed.ok, JSON.stringify(reviewed));
  const original = reviewed.review.claim;
  const certificate = (claim: codec.MemberContinuityClaim) => {
    const possession = b64(next.sign(codec.canonicalBytesForMemberContinuityPossession(claim)));
    return {claim, possession, vouches: claim.vouchers.map(voucher => {
      const member = [admin, ...vouchers].find(member => b64(member.publicKey) === voucher.member)!;
      return {member: voucher.member, signature: b64(member.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession)))};
    })};
  };
  const cert = certificate(original);
  const assembled = await assembleMemberContinuityFromFrames({frames, review: reviewed.review, certificate: cert, signer: admin});
  assert.ok(assembled.ok, JSON.stringify(assembled));
  const valid = assembled.frame;
  const signed = (claim: codec.MemberContinuityClaim, capId = cap.id, custom = certificate(claim)) => authorCarrierOp({replica,
    deps: [...claim.deps], kind: "command", cap: townshipCapTerm(capId), signer: admin,
    body: tuple(atom("attest_member_key_v1"), codec.memberContinuityCommandArgumentsToCarrierTerm(custom)!)});
  const wrongCap = await signed(original, id("missing-cap"));
  const badCert = await signed(original, cap.id, {...cert, possession: b64(new Uint8Array(64))});
  const missing = await signed({...original, oldAdmission: id("missing-admission")});
  const stale = await signed({...original, deps: [valid.id], nonce: b64(digest("stale"))});
  const remove = await authorTreehouseCommand({product: "Treehouse.Space", replica, deps: [...original.deps], signer: admin, capId: cap.id,
    command: {command: "remove_member", recipient: original.vouchers[0]!.member}});
  const removed = await signed({...original, deps: [remove.id]});
  const forkClaim = {...original, nonce: b64(digest("fork"))};
  const fork = await signed(forkClaim);
  const resolved = await signed({...original, nonce: b64(digest("resolution")), deps: [valid.id, fork.id].sort(),
    parents: [codec.memberContinuityClaimId(original)!, codec.memberContinuityClaimId(forkClaim)!].sort()});
  const args = codec.memberContinuityCommandArgumentsToCarrierTerm(cert)!;
  assert.equal(args[0], "list");
  if (args[0] !== "list") throw new Error("invalid fixture args");
  const malformed = await authorCarrierOp({replica, deps: [...original.deps], kind: "command", cap: townshipCapTerm(cap.id), signer: admin,
    body: tuple(atom("attest_member_key_v1"), ["list", [args[1][0]!, ["bin", ""], args[1][2]!]])});
  const mixed = await signed({...original, nonce: b64(digest("mixed")), deps: [valid.id, malformed.id].sort(),
    parents: [codec.memberContinuityClaimId(original)!]});
  const rootInvite = await authorTreehouseCommand({product: "Treehouse.Space", replica, deps: [...original.deps], signer: admin, capId: cap.id,
    command: {command: "issue_invitation", recipient: b64(admin.publicKey), threads: []}});
  const rootInviteOp = carrierOpsToSemanticOps([rootInvite], {}, treehouseCommandDecoders("Treehouse.Space"))[0]!;
  const rootAdmission = await authorTreehouseCommand({product: "Treehouse.Space", replica, deps: [rootInvite.id], signer: admin, capId: cap.id,
    command: {command: "admit_member", invitationId: rootInvite.id, recipient: b64(admin.publicKey), level: "member",
      acceptance: b64(admin.sign(treehouseInvitationAcceptanceBytes(replica, rootInviteOp)))}});
  const parentClaim = {...original, deps: [rootAdmission.id]};
  const parent = await signed(parentClaim);
  const competing = await signed({...parentClaim, oldPub: b64(admin.publicKey), oldAdmission: rootAdmission.id});
  const removal = await authorTreehouseCommand({product: "Treehouse.Space", replica, deps: [rootAdmission.id], signer: admin, capId: cap.id,
    command: {command: "remove_member", recipient: original.vouchers[0]!.member}});
  const replacementVouchers = [{member: b64(admin.publicKey), admission: rootAdmission.id}, original.vouchers[1]!]
    .sort((a,b) => Buffer.compare(Buffer.from(a.member, "base64"), Buffer.from(b.member, "base64")));
  const dependent = await signed({...parentClaim, nonce: b64(digest("future-parent")), deps: [parent.id],
    parents: [codec.memberContinuityClaimId(parentClaim)!], vouchers: replacementVouchers});
  const cases = [];
  for (const [name, extras] of [
    ["review_assembled", [valid]], ["wrong_capability", [wrongCap]], ["bad_certificate", [badCert]],
    ["missing_admission", [missing]], ["stale_parent_context", [valid, stale]],
    ["causal_removed_voucher", [remove, removed]], ["concurrent_removed_voucher", [valid, remove]],
    ["same_old_fork", [valid, fork]], ["all_head_resolution", [valid, fork, resolved]],
    ["mixed_parent_wrappers", [valid, malformed, mixed]],
    ["cross_old_target_collision", [rootInvite, rootAdmission, parent, competing]],
    ["future_parent_invalidation", [rootInvite, rootAdmission, parent, dependent, removal]],
  ] as Array<[string, CarrierOpFrame[]]>) {
    const history = [...frames, ...extras];
    cases.push({name, replica, old_pub: original.oldPub, frames: history,
      expected: await semanticSummary(replica, history, original.oldPub)});
  }
  return {version: 1, producer: "typescript", cases, authoring: {replica, frames,
    request: {old_pub: original.oldPub, old_admission: original.oldAdmission, new_pub: original.newPub,
      old_membership: original.oldMembership, nonce: original.nonce, voucher_admissions: request.voucherAdmissions,
      author: request.author, cap_id: request.capId}, claim_term: codec.memberContinuityClaimToCarrierTerm(original),
    certificate_term: codec.memberContinuityCertificateToCarrierTerm(cert), claim_id: reviewed.review.claimId,
    claim_bytes: b64(reviewed.review.claimBytes), possession_bytes: b64(reviewed.review.possessionBytes),
    frame: valid, frame_bytes: b64(canonicalBytesForCarrierOp(valid))}};
}

const expectedReasons: Record<string, string[]> = {
  review_assembled: [], wrong_capability: ["no_capability"], bad_certificate: ["application_continuity_invalid_certificate"],
  missing_admission: ["application_target_not_visible"], stale_parent_context: ["application_continuity_stale_context"],
  causal_removed_voucher: ["application_continuity_ineligible_member"], concurrent_removed_voucher: ["application_continuity_stale_voucher"],
  same_old_fork: [], all_head_resolution: [], mixed_parent_wrappers: ["application_invalid_continuity"],
  cross_old_target_collision: ["application_continuity_conflicting_target", "application_continuity_conflicting_target"],
  future_parent_invalidation: ["application_continuity_invalid_parent", "application_continuity_stale_voucher"],
};

export async function verifySemanticCorpus(path: string) {
  const corpus = JSON.parse(await readFile(path, "utf8"));
  for (const item of corpus.cases) {
    assert.deepEqual(item.expected.quarantine.map((entry: {reason: string}) => entry.reason).sort(), expectedReasons[item.name], item.name);
    const expectedStatus = item.name === "same_old_fork" ? "contested" : item.name === "future_parent_invalidation" ? "review_required" :
      item.expected.records.length > 0 ? "attested" : "unlinked";
    assert.ok(item.expected.links.every((link: {status: string}) => link.status === expectedStatus), item.name);
    for (const frames of [item.frames, [...item.frames].reverse()]) {
      assert.deepEqual(await semanticSummary(item.replica, frames, item.old_pub), item.expected,
        `${corpus.producer}/${item.name}: actual public signed fold`);
    }
  }
  const a = corpus.authoring, r = a.request;
  const reviewed = await reviewMemberContinuityFromFrames({replica: a.replica, frames: a.frames,
    oldPub: r.old_pub, oldAdmission: r.old_admission, newPub: r.new_pub, oldMembership: r.old_membership,
    nonce: r.nonce, voucherAdmissions: r.voucher_admissions, author: r.author, capId: r.cap_id});
  assert.ok(reviewed.ok, JSON.stringify(reviewed));
  assert.equal(b64(reviewed.review.claimBytes), a.claim_bytes);
  assert.equal(b64(reviewed.review.possessionBytes), a.possession_bytes);
  assert.equal(reviewed.review.claimId, a.claim_id);
  const certificate = codec.memberContinuityCertificateFromCarrierTerm(a.certificate_term);
  assert.ok(certificate);
  let calls = 0;
  const result = await assembleMemberContinuityFromFrames({frames: a.frames, review: reviewed.review, certificate,
    signer: {publicKey: Buffer.from(r.author, "base64"), sign: bytes => {
      calls++; assert.equal(b64(bytes), a.frame_bytes); return Buffer.from(a.frame.sig, "base64");
    }}});
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(result.frame.id, a.frame.id);
  assert.equal(result.frame.sig, a.frame.sig);
  assert.equal(b64(canonicalBytesForCarrierOp(result.frame)), a.frame_bytes);
  return corpus.cases.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--verify") {
    const count = await verifySemanticCorpus(resolve(process.argv[3]!));
    process.stdout.write(`TS_SEMANTIC_RECIPROCAL_OK ${count}\n`);
  } else {
    const path = resolve(process.argv[2] ?? "test/vectors/member_continuity_semantics/ts_semantics.json");
    await mkdir(dirname(path), {recursive: true});
    await writeFile(path, JSON.stringify(await semanticCorpus(), null, 2) + "\n");
    process.stdout.write("TS_MEMBER_CONTINUITY_SEMANTICS_EXPORTED\n");
  }
}
