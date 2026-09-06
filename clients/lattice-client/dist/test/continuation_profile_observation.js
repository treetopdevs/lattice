import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveContinuationProfileFromFrames } from "../src/authority";
import { continuationProfileId } from "../src/continuation";
import { continuationProfileToCarrierTerm } from "../src/continuation";
import { authorCarrierDelegation, authorCarrierOp } from "../src/codec";
import { ed25519 } from "@noble/curves/ed25519.js";
const vectors = JSON.parse(readFileSync(new URL("./vectors/continuation/ts_authoring.json", import.meta.url), "utf8")).vectors;
test("profile observation derives the actual root and later pin from authenticated Space and Thread histories", async () => {
    for (const vector of vectors) {
        const frames = vector.frames;
        assert.deepEqual(await resolveContinuationProfileFromFrames({ replica: vector.replica, frames }), {
            ok: true, replica: vector.replica, root: frames[0].author,
            profileGenesis: vector.claim.profileGenesis, profileId: continuationProfileId(vector.profile),
            profile: vector.profile, verifiedFrontier: [vector.finalOpId],
        });
    }
});
test("missing, forged, duplicated and cross-replica history cannot establish a pin", async () => {
    const v = vectors[0], frames = v.frames;
    for (const bad of [frames.slice(1), [...frames, frames[0]],
        [...frames.slice(0, -1), { ...frames.at(-1), sig: Buffer.alloc(64).toString("base64") }],
        [...frames, vectors[1].frames[0]], [null]]) {
        assert.deepEqual(await resolveContinuationProfileFromFrames({ replica: v.replica, frames: bad }), { ok: false, reason: "invalid_verified_history" });
    }
    assert.deepEqual(await resolveContinuationProfileFromFrames({ replica: v.replica, frames: frames.slice(0, 2) }), { ok: false, reason: "continuation_not_configured" });
    assert.deepEqual(await resolveContinuationProfileFromFrames({ replica: "legacy", frames: [] }), { ok: false, reason: "unauthorized_continuation" });
    assert.deepEqual(await resolveContinuationProfileFromFrames({ replica: v.replica.replace("-v1", "-v2"), frames: [] }), { ok: false, reason: "unsupported_authority_profile" });
});
test("latest valid root pin wins while signed impostor and malformed pins remain in the frontier", async () => {
    const v = vectors[0], frames = structuredClone(v.frames);
    async function pin(seedByte, profile, malformed = false) {
        const seed = new Uint8Array(32).fill(seedByte);
        const signer = { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
        const d = await authorCarrierDelegation({ replica: v.replica, audiencePubkey: signer.publicKey, signer });
        const term = malformed ? ["map", []] : continuationProfileToCarrierTerm(profile);
        const frame = await authorCarrierOp({ replica: v.replica, deps: [frames.at(-1).id],
            signer, cap: ["nil"], kind: "authority", body: ["tuple", [["atom", "genesis"], ["delegation", d],
                    ["map", [[["atom", "__continuation__"], term]]]]] });
        frames.push(frame);
        return frame;
    }
    await pin(9, { ...v.profile, maxLeaseEpochs: 2 });
    const profile = { ...v.profile, maxLeaseEpochs: 3 };
    const selected = await pin(1, profile);
    const malformed = await pin(1, profile, true);
    const result = await resolveContinuationProfileFromFrames({ replica: v.replica, frames });
    assert.equal(result.ok, true);
    if (result.ok) {
        assert.equal(result.profileGenesis, selected.id);
        assert.deepEqual(result.profile, profile);
        assert.deepEqual(result.verifiedFrontier, [malformed.id]);
    }
});
