import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeContinuationProfile } from "../src/continuation";

const lowKey = Buffer.alloc(32, 1).toString("base64");
const highKey = Buffer.alloc(32, 251).toString("base64");
const profile = {
  mode: "bounded_continuation", version: 1, product: "treehouse",
  kind: "space", role: "admin", nominee: lowKey,
  witnesses: [highKey, lowKey], threshold: 2, maxLeaseEpochs: 7,
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
