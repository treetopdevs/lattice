import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalBytesForContinuationClaim, canonicalBytesForContinuationProfile,
  continuationCertificateFromCarrierTerm, continuationCertificateToCarrierTerm,
  continuationClaimFromCarrierTerm, continuationClaimToCarrierTerm,
  continuationProfileFromCarrierTerm, continuationProfileId, continuationProfileToCarrierTerm,
  normalizeContinuationCertificate, normalizeContinuationClaim, normalizeContinuationProfile,
  verifyContinuationCertificate,
} from "../src/continuation";

const lowKey = Buffer.alloc(32, 1).toString("base64");
const highKey = Buffer.alloc(32, 251).toString("base64");
const profile = {
  mode: "bounded_continuation", version: 1, product: "treehouse",
  kind: "space", role: "admin", nominee: lowKey,
  witnesses: [highKey, lowKey], threshold: 2, maxLeaseEpochs: 7,
};
const digest = (name: string) => createHash("sha256").update(name).digest("base64url");
const claim = {
  version: 1, product: "treehouse", kind: "space", replica: "replica:fixture", role: "admin",
  profileId: digest("profile"), profileGenesis: digest("pin"), holder: lowKey,
  holderEpoch: digest("predecessor"), successor: highKey, delegationId: digest("delegation"),
  author: highKey, deps: [digest("dependency")], epoch: 9, epochBasis: [digest("beacon")],
};

test("normalizes exact continuation profiles by unsigned witness bytes", () => {
  assert.deepEqual(normalizeContinuationProfile(profile), { ...profile, witnesses: [lowKey, highKey] });
  assert.deepEqual(profile.witnesses, [highKey, lowKey], "normalization must not mutate caller evidence");
});

test("profile fields, paired roles, portable limits and canonical keys are closed", () => {
  for (const mutation of [
    { extra: true }, { version: 2 }, { mode: "witnessed" }, { product: "township" },
    { kind: "space", role: "moderator" }, { kind: "thread", role: "admin" },
    { nominee: lowKey.trimEnd().replace(/=+$/, "") }, { nominee: `${lowKey}\n` },
    { nominee: Buffer.alloc(31).toString("base64") }, { witnesses: [] },
    { witnesses: [lowKey, lowKey] }, { witnesses: [lowKey, "not-base64"] },
    { witnesses: [lowKey, , highKey] }, { threshold: 0 }, { threshold: 3 }, { threshold: 1.5 },
    { maxLeaseEpochs: 0 }, { maxLeaseEpochs: 65_536 }, { maxLeaseEpochs: NaN },
    { maxLeaseEpochs: Infinity }, { maxLeaseEpochs: "7" },
  ]) assert.equal(normalizeContinuationProfile({ ...profile, ...mutation }), null);
  for (const key of Object.keys(profile)) {
    const missing = { ...profile } as Record<string, unknown>;
    delete missing[key];
    assert.equal(normalizeContinuationProfile(missing), null, key);
  }
  for (const maxLeaseEpochs of [1, 65_535]) {
    assert.ok(normalizeContinuationProfile({ ...profile, kind: "thread", role: "moderator", maxLeaseEpochs }));
  }
});

test("valid claims and certificates preserve exact signed evidence", () => {
  assert.deepEqual(normalizeContinuationClaim(claim), claim);
  const certificate = { claim, signatures: [{ witness: lowKey, signature: Buffer.alloc(64, 7).toString("base64") }] };
  assert.deepEqual(normalizeContinuationCertificate(certificate), certificate);
});

test("claims reject unknown fields, unsafe epochs, noncanonical IDs and reordered dependencies", () => {
  const ordered = [digest("first"), digest("second")].sort();
  const noncanonicalId = `${digest("profile").slice(0, -1)}B`;
  for (const mutation of [
    { extra: true }, { version: 2 }, { product: "township" }, { replica: "" },
    { kind: "thread", role: "admin" }, { profileId: noncanonicalId },
    { profileGenesis: "pin" }, { holderEpoch: `${claim.holderEpoch}="` },
    { delegationId: lowKey }, { holder: "bad" }, { successor: Buffer.alloc(33).toString("base64") },
    { author: `${highKey}\n` }, { epoch: -1 }, { epoch: 1.5 }, { epoch: 9_007_199_254_740_992 },
    { epoch: "9" }, { epoch: Infinity }, { deps: [...ordered].reverse() },
    { deps: [ordered[0], ordered[0]] }, { deps: [ordered[0], , ordered[1]] },
    { epochBasis: [...ordered].reverse() }, { epochBasis: [ordered[0], "bad"] },
  ]) assert.equal(normalizeContinuationClaim({ ...claim, ...mutation }), null);
  for (const key of Object.keys(claim)) {
    const missing = { ...claim } as Record<string, unknown>;
    delete missing[key];
    assert.equal(normalizeContinuationClaim(missing), null, key);
  }
  for (const epoch of [0, Number.MAX_SAFE_INTEGER]) assert.ok(normalizeContinuationClaim({ ...claim, epoch }));
  assert.ok(normalizeContinuationClaim({ ...claim, deps: [], epochBasis: [] }), "authority resolves whether actual basis exists");
});

test("certificate shape distinguishes malformed entries from invalid consent", () => {
  const entry = { witness: lowKey, signature: Buffer.alloc(64, 7).toString("base64") };
  for (const malformed of [
    { claim, signatures: [entry], extra: true }, { claim, signatures: null },
    { claim, signatures: [{ ...entry, extra: true }] },
    { claim, signatures: [{ witness: lowKey }] },
    { claim, signatures: [{ ...entry, signature: Buffer.alloc(63).toString("base64") }] },
    { claim, signatures: [{ ...entry, witness: "bad" }] },
    { claim, signatures: [entry, , entry] },
  ]) assert.equal(normalizeContinuationCertificate(malformed), null);
  assert.ok(normalizeContinuationCertificate({ claim, signatures: [] }));
  assert.ok(normalizeContinuationCertificate({ claim, signatures: [entry, entry] }), "well-shaped duplicates are a certificate verdict, not malformed input");
});

test("carrier terms round-trip profile and full certificate without losing signed fields", () => {
  const encodedProfile = continuationProfileToCarrierTerm(profile);
  assert.ok(encodedProfile);
  assert.deepEqual(continuationProfileFromCarrierTerm(encodedProfile), normalizeContinuationProfile(profile));
  const encodedClaim = continuationClaimToCarrierTerm(claim);
  assert.ok(encodedClaim);
  assert.deepEqual(continuationClaimFromCarrierTerm(encodedClaim), claim);
  const certificate = { claim, signatures: [{ witness: highKey, signature: Buffer.alloc(64, 3).toString("base64") }] };
  assert.deepEqual(continuationCertificateFromCarrierTerm(continuationCertificateToCarrierTerm(certificate)), certificate);
  assert.ok(canonicalBytesForContinuationProfile(profile).length);
  assert.ok(canonicalBytesForContinuationClaim(claim).length);
  assert.match(continuationProfileId(profile)!, /^[A-Za-z0-9_-]{43}$/);
});

test("a complete sorted threshold certificate verifies against the exact expected claim", () => {
  const { signedProfile, boundClaim, certificate } = signedFixture();
  assert.equal(verifyContinuationCertificate(certificate, boundClaim, signedProfile), true);
});

function signedFixture() {
  const witnesses = [1, 2, 3].map((value) => {
    const seed = Buffer.alloc(32, value);
    return { seed, publicKey: Buffer.from(ed25519.getPublicKey(seed)).toString("base64") };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.publicKey, "base64"), Buffer.from(b.publicKey, "base64")));
  const signedProfile = { ...profile, witnesses: witnesses.map((witness) => witness.publicKey) };
  const boundClaim = { ...claim, profileId: continuationProfileId(signedProfile)! };
  const payload = canonicalBytesForContinuationClaim(boundClaim);
  const signatures = witnesses.map((witness) => ({
    witness: witness.publicKey,
    signature: Buffer.from(ed25519.sign(payload, witness.seed)).toString("base64"),
  }));
  return { signedProfile, boundClaim, witnesses, payload, certificate: { claim: boundClaim, signatures } };
}
