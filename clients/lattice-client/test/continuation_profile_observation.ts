import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveContinuationProfileFromFrames } from "../src/authority";
import type { CarrierOpFrame } from "../src/carrier";
import { continuationProfileId } from "../src/continuation";

const vectors = JSON.parse(readFileSync(new URL("./vectors/continuation/ts_authoring.json", import.meta.url), "utf8")).vectors;

test("profile observation derives the actual root and later pin from authenticated Space and Thread histories", async () => {
  for (const vector of vectors) {
    const frames: CarrierOpFrame[] = vector.frames;
    assert.deepEqual(await resolveContinuationProfileFromFrames({replica: vector.replica, frames}), {
      ok: true, replica: vector.replica, root: frames[0]!.author,
      profileGenesis: vector.claim.profileGenesis, profileId: continuationProfileId(vector.profile),
      profile: vector.profile, verifiedFrontier: [vector.finalOpId],
    });
  }
});
