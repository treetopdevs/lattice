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
