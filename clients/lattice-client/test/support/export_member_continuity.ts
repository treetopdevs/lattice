import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, canonicalBytesForCarrierOp, verifyCarrierOp } from "../../src/codec";
import type { CarrierOpSigner } from "../../src/codec";
import { carrierOpsToSemanticOps, decodeCarrierOpFrame } from "../../src/carrier";
import { bindTownshipReplica, townshipCapTerm } from "../../src/township";
import { treehouseCommandDecoders, treehouseSpaceSchema } from "../../src/treehouse";
import { materialize } from "../../src/materialize";
import { deriveTreehouseCatalogCutoff } from "../../src/treehouse_catalog_cutoff";
import * as codec from "../../src/treehouse_member_continuity_codec";

const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const hash = (label: string) => createHash("sha256").update(`r19b-ts-export:${label}`).digest();
const id = (label: string) => hash(label).toString("base64url");
function signer(label: string): CarrierOpSigner {
  const seed = hash(label);
  return {publicKey: ed25519.getPublicKey(seed), sign: (value) => ed25519.sign(value, seed)};
}

/** Synthetic consent bytes only: these claim IDs do not prove real membership or a current epoch. */
export async function memberContinuityFixture() {
  const root = signer("root"), old = signer("old-member"), next = signer("new-member");
  const vouchers = [signer("voucher-a"), signer("voucher-b")].sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  const replica = await bindTownshipReplica(`replica:treehouse:space:${id("space")}#authority:bounded-continuation-v1`, root.publicKey);
  const delegation = await authorCarrierDelegation({replica, signer: root, audiencePubkey: root.publicKey,
    roles: ["admin", "moderator"], ops: ["create_space", "create_thread", "issue_invitation", "revoke_invitation", "admit_member", "remove_member"], live: true});
  const genesis = await authorCarrierOp({replica, signer: root, deps: [], kind: "authority", cap: ["nil"],
    body: ["tuple", [["atom", "genesis"], ["delegation", delegation], ["map", []]]]});
  const claim: codec.MemberContinuityClaim = {version: 1, product: "treehouse", space: replica,
    oldPub: b64(old.publicKey), newPub: b64(next.publicKey), oldAdmission: id("old-admission"), oldMembership: "removed",
    nonce: b64(hash("claim-nonce")), deps: [genesis.id], epoch: 0, epochBasis: [id("beacon")], parents: [],
    vouchers: vouchers.map((member, i) => ({member: b64(member.publicKey), admission: id(`voucher-admission-${i}`)}))};
  const possession = b64(await next.sign(codec.canonicalBytesForMemberContinuityPossession(claim)));
  const certificate: codec.MemberContinuityCertificate = {claim, possession,
    vouches: await Promise.all(vouchers.map(async (member) => ({member: b64(member.publicKey),
      signature: b64(await member.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession)))})))};
  const challenge: codec.MemberKeyReturnChallenge = {version: 1, product: "treehouse", space: replica, oldPub: claim.oldPub,
    heads: [codec.memberContinuityClaimId(claim)!], deps: [genesis.id], reviewer: b64(root.publicKey), nonce: b64(hash("return-nonce"))};
  const returnSignature = b64(await old.sign(codec.canonicalBytesForMemberContinuityReturn(challenge)));
  const command = await authorCarrierOp({replica, signer: root, deps: [genesis.id], kind: "command", cap: townshipCapTerm(delegation.id),
    body: ["tuple", [["atom", "attest_member_key_v1"], codec.memberContinuityCommandArgumentsToCarrierTerm(certificate)!]]});
  return {claim, certificate, challenge, returnSignature, frames: [genesis, command], replica, command};
}

export async function verifyMemberContinuityVector(vector: unknown) {
  const value = vector as Record<string, any>;
  assert.equal(value.version, 1);
  const claim = codec.memberContinuityClaimFromCarrierTerm(value.claim_term);
  const certificate = codec.memberContinuityCertificateFromCarrierTerm(value.certificate_term);
  const challenge = codec.memberKeyReturnChallengeFromCarrierTerm(value.return_challenge_term);
  assert.ok(claim && certificate && challenge);
  assert.equal(codec.verifyMemberContinuityCertificate(certificate, claim), true);
  assert.equal(codec.verifyMemberKeyReturn(challenge, value.return_signature, challenge), true);
  assert.equal(codec.memberContinuityClaimId(claim), value.claim_id);
  assert.equal(b64(codec.canonicalBytesForMemberContinuityClaim(claim)), value.claim_bytes);
  assert.equal(b64(codec.canonicalBytesForMemberContinuityPossession(claim)), value.possession_bytes);
  assert.equal(b64(codec.canonicalBytesForMemberContinuityVouch(claim, certificate.possession)), value.vouch_bytes);
  assert.equal(b64(codec.canonicalBytesForMemberContinuityReturn(challenge)), value.return_bytes);
  assert.equal(codec.verifyMemberContinuityCertificate({...certificate, possession: certificate.vouches[0]!.signature}, claim), false);
  assert.equal(codec.verifyMemberKeyReturn(challenge, certificate.possession, challenge), false);
  assert.equal(codec.verifyMemberContinuityCertificate(certificate, {...claim, epoch: claim.epoch + 1}), false);
  for (const reversed of [false, true]) {
    const frames = (value.unknown_command.frames as unknown[]).map(decodeCarrierOpFrame);
    if (reversed) frames.reverse();
    for (const frame of frames) {
      assert.equal(frame.replica, value.unknown_command.replica);
      assert.deepEqual(await verifyCarrierOp(frame, {verify: async (pub, payload, signature) =>
        ed25519.verify(signature, payload, Buffer.from(pub, "base64"), {zip215: false})}), {hash: true, signature: true, valid: true});
      assert.ok(frame.deps.every((dependency) => frames.some((other) => other.id === dependency)));
      assert.equal(b64(canonicalBytesForCarrierOp(frame)).length > 0, true);
    }
    assert.deepEqual(await deriveTreehouseCatalogCutoff({replica: value.unknown_command.replica, frames, rejected: []}),
      {ok: false, reason: "unsupported_cutoff"}, "the unchanged cutoff vocabulary does not enable new command history");
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    const projection = materialize(treehouseSpaceSchema, ops, new Set(ops.map((op) => op.id)), null, value.unknown_command.replica);
    assert.equal(projection.quarantineReasons.get(value.unknown_command.op_id), value.unknown_command.expected_reason);
    assert.equal(value.unknown_command.expected_reason, "unknown_command");
    const before = ops.filter((op) => op.id !== value.unknown_command.op_id);
    assert.deepEqual(projection.state, materialize(treehouseSpaceSchema, before, new Set(before.map((op) => op.id)), null, value.unknown_command.replica).state);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === "--verify-beam" && args[1] !== undefined) {
    await verifyMemberContinuityVector(JSON.parse(await readFile(resolve(args[1]), "utf8")));
    console.log("PASS BEAM→TS member claim/certificate/return bytes, purposes, signatures, and signed unimplemented-command refusal");
    return;
  }
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out" || args[1] === undefined)) throw new Error("usage: export_member_continuity.ts [--out path | --verify-beam path]");
  const f = await memberContinuityFixture();
  const vector = {version: 1, producer: "typescript", claim_term: codec.memberContinuityClaimToCarrierTerm(f.claim),
    certificate_term: codec.memberContinuityCertificateToCarrierTerm(f.certificate), return_challenge_term: codec.memberKeyReturnChallengeToCarrierTerm(f.challenge),
    return_signature: f.returnSignature, claim_id: codec.memberContinuityClaimId(f.claim), claim_bytes: b64(codec.canonicalBytesForMemberContinuityClaim(f.claim)),
    possession_bytes: b64(codec.canonicalBytesForMemberContinuityPossession(f.claim)), vouch_bytes: b64(codec.canonicalBytesForMemberContinuityVouch(f.claim, f.certificate.possession)),
    return_bytes: b64(codec.canonicalBytesForMemberContinuityReturn(f.challenge)),
    unknown_command: {replica: f.replica, frames: f.frames, op_id: f.command.id, expected_reason: "unknown_command"}};
  await verifyMemberContinuityVector(vector);
  const output = args[1] === undefined ? fileURLToPath(new URL("../vectors/member_continuity/ts_codec.json", import.meta.url)) : resolve(args[1]);
  await mkdir(dirname(output), {recursive: true}); await writeFile(output, `${JSON.stringify(vector, null, 2)}\n`);
  console.log(`Exported independently TS-signed detached member statements and unimplemented-command control: ${output}`);
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
