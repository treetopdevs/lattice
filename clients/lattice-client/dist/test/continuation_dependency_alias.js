import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyCarrierOp } from "../src/codec";
import { ed25519 } from "@noble/curves/ed25519.js";
import { fixture, judge, negativeFrames, produce } from "./support/continuation_dependency_alias_peer";
test("canonical dependency header aliases preserve Space/Thread authority and cutoff", async () => {
    await produce();
});
test("unsigned unique dependencies and malformed signed claims retain refusal", async () => {
    for (const kind of ["space", "thread"]) {
        const f = await fixture(kind);
        const forged = { ...f.frame, deps: [...f.frame.deps, f.prior[0].id] };
        assert.equal((await verifyCarrierOp(forged, { verify: async (pub, b, s) => ed25519.verify(s, b, Buffer.from(pub, "base64"), { zip215: false }) })).valid, false);
        for (const n of await negativeFrames(f))
            assert.equal((await judge(kind, f.replica, [...f.prior, n.frame])).reasons[n.frame.id], n.reason);
    }
});
