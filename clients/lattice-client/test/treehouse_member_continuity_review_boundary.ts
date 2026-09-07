import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {ed25519} from "@noble/curves/ed25519.js";
import {authorCarrierOp} from "../src/codec";
import {townshipCapTerm} from "../src/township";
import {reviewMemberContinuityFromFrames as review, observeMemberContinuityFromFrames as observe, type MemberContinuityReviewRequest} from "../src/treehouse_member_continuity";
import type {CarrierOpFrame} from "../src/carrier";

const corpus = JSON.parse(readFileSync(new URL("./vectors/member_continuity_semantics/ts_semantics.json", import.meta.url), "utf8"));
const digest = (label: string) => createHash("sha256").update(label).digest();
const seed = digest("ts-semantic-independent:admin");
const signer = {publicKey: ed25519.getPublicKey(seed), sign: (bytes: Uint8Array) => ed25519.sign(bytes, seed)};
const missing = digest("missing-review-target").toString("base64url");
function request(): MemberContinuityReviewRequest {
  const a = structuredClone(corpus.authoring), r = a.request;
  return {replica: a.replica, frames: a.frames, oldPub: r.old_pub, oldAdmission: r.old_admission,
    newPub: r.new_pub, oldMembership: r.old_membership, nonce: r.nonce,
    voucherAdmissions: r.voucher_admissions, author: r.author, capId: r.cap_id};
}
const refusal = (reason: string) => ({ok: false, reason});

test("signed review works without Node Buffer in a browser-like runtime", async () => {
  const input = request();
  const saved = globalThis.Buffer;
  try {
    (globalThis as unknown as {Buffer: unknown}).Buffer = undefined;
    const result = await review(input);
    assert.equal(result.ok, true, JSON.stringify(result));
  } finally { globalThis.Buffer = saved; }
});

test("review canonicalizes both voucher admission orders to identical consent bytes", async () => {
  const input = request();
  const first = await review(input);
  const second = await review({...input, voucherAdmissions: [...input.voucherAdmissions].reverse() as [string, string]});
  assert.ok(first.ok); assert.ok(second.ok, JSON.stringify(second));
  assert.deepEqual(second.review.claimBytes, first.review.claimBytes);
});

test("an exact Space namespace without a root-authenticated pin is unsupported", async () => {
  const input = request();
  const genesis = (input.frames as CarrierOpFrame[]).find(frame => frame.deps.length === 0)!;
  assert.deepEqual(await observe({replica: input.replica, frames: [genesis]}), refusal("unsupported_continuity_history"));
  assert.deepEqual(await review({...input, frames: [genesis]}), refusal("unsupported_continuity_history"));
  const genuinePin = (input.frames as CarrierOpFrame[]).find(frame => frame.kind === "authority" && frame.deps.includes(genesis.id))!;
  const outsiderSeed = digest("non-root-profile-pinner");
  const impostor = await authorCarrierOp({replica: input.replica, deps: [genesis.id], kind: "authority",
    cap: ["nil"], body: genuinePin.body, signer: {publicKey: ed25519.getPublicKey(outsiderSeed),
      sign: bytes => ed25519.sign(bytes, outsiderSeed)}});
  assert.deepEqual(await observe({replica: input.replica, frames: [genesis, impostor]}), refusal("unsupported_continuity_history"));
});

test("closed review input refuses extra authority fields and non-tuple vouchers before history", async () => {
  const input = request();
  for (const extra of ["epoch", "parents", "verifiedFrontier"]) {
    assert.deepEqual(await review({...input, [extra]: []}), refusal("application_invalid_continuity"));
  }
  for (const vouchers of [input.voucherAdmissions[0], new Set(input.voucherAdmissions), [], [input.voucherAdmissions[0]],
    [...input.voucherAdmissions, input.voucherAdmissions[0]], [input.voucherAdmissions[0], input.voucherAdmissions[0]], [null, null]]) {
    assert.deepEqual(await review({...input, voucherAdmissions: vouchers as never}), refusal("application_invalid_continuity"));
  }
});

test("signed missing and quarantined admission references preserve target precedence", async () => {
  const input = request();
  assert.deepEqual(await review({...input, oldAdmission: missing}), refusal("application_target_not_visible"));
  assert.deepEqual(await review({...input, voucherAdmissions: [missing, input.voucherAdmissions[1]]}), refusal("application_target_not_visible"));
  // Voucher decoding precedes candidate construction; old targets belong to the ordinary judge.
  assert.deepEqual(await review({...input, capId: missing, oldAdmission: missing}), refusal("no_capability"));
  assert.deepEqual(await review({...input, capId: missing, voucherAdmissions: [missing, input.voucherAdmissions[1]]}), refusal("application_target_not_visible"));
  const frames = input.frames as CarrierOpFrame[];
  for (const target of [input.oldAdmission, input.voucherAdmissions[0]]) {
    const admission = frames.find(frame => frame.id === target)!;
    const invalid = await authorCarrierOp({replica: input.replica, deps: [frames.at(-1)!.id], kind: "command",
      body: admission.body, cap: townshipCapTerm(missing), signer});
    const selected = target === input.oldAdmission ? {oldAdmission: invalid.id} : {voucherAdmissions: [invalid.id, input.voucherAdmissions[1]] as [string, string]};
    assert.deepEqual(await review({...input, frames: [...frames, invalid], ...selected}), refusal("application_target_quarantined"));
  }
});

test("wide authenticated frontier refuses oversized placeholder before consent bytes", async () => {
  const input = request();
  const frames = input.frames as CarrierOpFrame[];
  const leaves = await Promise.all(Array.from({length: 600}, (_, index) => authorCarrierOp({replica: input.replica,
    deps: [frames.at(-1)!.id], kind: "inbox", cap: ["nil"], signer,
    body: ["tuple", [["atom", "request"], ["int", index], ["nil"]]]})));
  assert.deepEqual(await review({...input, frames: [...frames, ...leaves]}), refusal("continuity_capacity_stop"));
});
