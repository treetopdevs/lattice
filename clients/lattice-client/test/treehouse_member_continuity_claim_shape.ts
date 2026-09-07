import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {ed25519} from "@noble/curves/ed25519.js";
import {authorCarrierOp} from "../src/codec";
import {townshipCapTerm} from "../src/township";
import {observeMemberContinuityFromFrames as observe} from "../src/treehouse_member_continuity";
import * as codec from "../src/treehouse_member_continuity_codec";
import type {CarrierOpFrame, CarrierTerm} from "../src/carrier";
const a = JSON.parse(readFileSync(new URL("./vectors/member_continuity_semantics/ts_semantics.json", import.meta.url), "utf8")).authoring;
const digest = (label: string) => createHash("sha256").update(`ts-semantic-independent:${label}`).digest();
const key = (label: string) => {const seed = digest(label); return {publicKey: ed25519.getPublicKey(seed), sign: (bytes: Uint8Array) => ed25519.sign(bytes, seed)};};
const admin = key("admin"), successor = key("new"), witnesses = [key("voucher-a"), key("voucher-b")];
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const original = codec.memberContinuityCertificateFromCarrierTerm(a.certificate_term)!;
const originalArgs = codec.memberContinuityCommandArgumentsToCarrierTerm(original)![1] as CarrierTerm[];
function signed(args: CarrierTerm[], deps = original.claim.deps): Promise<CarrierOpFrame> {
  return authorCarrierOp({replica: a.replica, deps: [...deps], kind: "command", signer: admin,
    cap: townshipCapTerm(a.request.cap_id), body: ["tuple", [["atom", "attest_member_key_v1"], ["list", args]]]});
}
async function resolution(parent: CarrierOpFrame, additional: CarrierOpFrame[] = []) {
  const claim = codec.normalizeMemberContinuityClaim({...original.claim, deps: [parent.id, ...additional.map(frame => frame.id)].sort(),
    nonce: b64(digest(`shape-resolution:${parent.id}`)), parents: [a.claim_id]})!;
  const possession = b64(successor.sign(codec.canonicalBytesForMemberContinuityPossession(claim)));
  const certificate = {claim, possession, vouches: claim.vouchers.map(voucher => {
    const witness = witnesses.find(key => b64(key.publicKey) === voucher.member)!;
    return {member: voucher.member, signature: b64(witness.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession)))};
  })};
  return signed(codec.memberContinuityCommandArgumentsToCarrierTerm(certificate)![1] as CarrierTerm[], claim.deps);
}
const cases = Promise.all([
  {name: "four_arguments", terms: [...originalArgs, ["nil"] as CarrierTerm], hasClaim: false},
  {name: "one_argument", terms: originalArgs.slice(0, 1), hasClaim: false},
  {name: "two_arguments", terms: originalArgs.slice(0, 2), hasClaim: false},
  {name: "malformed_possession", terms: [originalArgs[0]!, ["bin", ""] as CarrierTerm, originalArgs[2]!], hasClaim: true},
  {name: "malformed_vouch_list", terms: [originalArgs[0]!, originalArgs[1]!, ["list", []] as CarrierTerm], hasClaim: true},
  {name: "malformed_vouch_type", terms: [originalArgs[0]!, originalArgs[1]!, ["nil"] as CarrierTerm], hasClaim: true},
].map(async entry => {const parent = await signed(entry.terms);return {...entry, parent, child: await resolution(parent)};}));
for (const name of ["four_arguments", "one_argument", "two_arguments", "malformed_possession", "malformed_vouch_list", "malformed_vouch_type"]) {
  test(`signed ${name} preserves BEAM exact-three-argument observation and target precedence`, async () => {
    const entry = (await cases).find(entry => entry.name === name)!;
    const parents = [...a.frames, entry.parent];
    const parent = await observe({replica: a.replica, frames: parents});
    assert.ok(parent.ok, JSON.stringify(parent)); assert.deepEqual(parent.records, []);
    // BEAM claim_of/1 matches exactly [claim, _, _], independently of certificate decoding.
    assert.equal(parent.links.length, entry.hasClaim ? 1 : 0);
    if (entry.hasClaim) {
      assert.equal(parent.links[0]!.oldPub, original.claim.oldPub);
      assert.deepEqual(parent.links[0]!.affectedWrappers, [{opId: entry.parent.id, reason: "application_invalid_continuity"}]);
    }
    for (const frames of [[...parents, entry.child], [...parents, entry.child].reverse()]) {
      const observed = await observe({replica: a.replica, frames}); assert.ok(observed.ok, JSON.stringify(observed));
      assert.equal(observed.quarantine.find(item => item.opId === entry.child.id)?.reason,
        entry.hasClaim ? "application_target_quarantined" : "application_target_not_visible");
    }
  });
}
test("a malformed wrapper cannot hide an honored exact-three-argument wrapper for the same parent claim", async () => {
  const entry = (await cases).find(entry => entry.name === "malformed_possession")!;
  const child = await resolution(entry.parent, [a.frame]);
  const observed = await observe({replica: a.replica, frames: [...a.frames, a.frame, entry.parent, child]});
  assert.ok(observed.ok, JSON.stringify(observed));
  assert.equal(observed.quarantine.find(item => item.opId === child.id), undefined);
  assert.ok(observed.records.some(record => record.wrappers.some(wrapper => wrapper.opId === child.id)));
});
test("optional authenticated parity export contains untouched base and independently signed edge histories", async () => {
  if (process.env.TREEHOUSE_CONTINUITY_SHAPE_EXPORT) writeFileSync(process.env.TREEHOUSE_CONTINUITY_SHAPE_EXPORT,
    JSON.stringify((await cases).map(entry => ({name: entry.name, replica: a.replica, parent: entry.parent.id,
      child: entry.child.id, has_claim: entry.hasClaim, frames: [...a.frames, entry.parent, entry.child]}))));
});

test("all six independently BEAM-judged signed histories reproduce exact link and quarantine projections", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./vectors/member_continuity_claim_shape/beam.json", import.meta.url), "utf8"));
  assert.equal(fixture.source_sha, "0ca940fc3243b1c59451d1bc95a908af272bd6a4");
  for (const entry of await cases) {
    const expected = fixture.cases.find((item: {name: string}) => item.name === entry.name);
    assert.deepEqual(expected.frames, [...a.frames, entry.parent, entry.child]);
    for (const [frames, projection] of [[expected.frames.filter((frame: CarrierOpFrame) => frame.id !== entry.child.id), expected.expected_parent],
      [expected.frames, expected.expected_child]] as const) {
      const observed = await observe({replica: a.replica, frames});
      assert.ok(observed.ok, JSON.stringify(observed));
      assert.deepEqual({links: observed.links, quarantine: observed.quarantine}, projection, entry.name);
    }
  }
});
