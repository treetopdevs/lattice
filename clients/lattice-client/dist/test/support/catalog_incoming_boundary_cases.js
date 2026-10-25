import { authorCarrierOpUnchecked } from "./unchecked_author";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, canonicalBytesForCarrierDelegation, canonicalBytesForCarrierTerm, canonicalHash } from "../../src/codec";
const bin = (value) => ["bin", Buffer.from(value).toString("base64")];
export async function boundaryCases(f) {
    const missing = "A".repeat(43);
    const cap = ["nil"];
    const raw = async (kind, body, deps = []) => {
        const bytes = canonicalBytesForCarrierTerm(["list", [bin("lattice-op-v2"), bin(f.space.replica), bin(f.root.publicKey), ["list", [...new Set(deps)].sort().map(bin)], ["atom", kind], body, cap]]);
        return { v: 1, id: await canonicalHash(bytes), replica: f.space.replica, author: Buffer.from(f.root.publicKey).toString("base64"), deps, kind, body, cap, sig: Buffer.from(await f.root.sign(bytes)).toString("base64") };
    };
    const atSize = async (size, deps = []) => {
        for (const marker of [0, 10, 100, 1000]) {
            const body = (value) => ["tuple", [["atom", "post"], ["list", [bin(value), ["int", marker]]]]];
            const empty = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps, kind: "command", body: body(Buffer.alloc(0)), cap });
            const available = size - Buffer.byteLength(JSON.stringify({ type: "push", ops: [empty] }));
            if (available >= 0 && available % 4 === 0) {
                const frame = await authorCarrierOpUnchecked({ replica: f.space.replica, signer: f.root, deps, kind: "command", body: body(Buffer.alloc(available / 4 * 3, 120)), cap });
                if (Buffer.byteLength(JSON.stringify({ type: "push", ops: [frame] })) !== size)
                    throw new Error("exact push size producer");
                return frame;
            }
        }
        throw new Error("no exact push size encoding");
    };
    const unknownDelegation = await authorCarrierDelegation({ replica: f.space.replica, signer: f.root, audiencePubkey: f.root.publicKey, ops: ["create_space"], roles: ["future_incoming_role"], live: true });
    const delegatedBytes = canonicalBytesForCarrierDelegation(unknownDelegation);
    assert.equal(await canonicalHash(delegatedBytes), unknownDelegation.id);
    assert.ok(ed25519.verify(Buffer.from(unknownDelegation.sig, "base64"), delegatedBytes, f.root.publicKey, { zip215: false }));
    const alias64 = (value) => {
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", at = value.indexOf("=") - 1;
        assert.ok(at >= 0);
        const alias = value.slice(0, at) + alphabet[alphabet.indexOf(value[at]) + 1] + value.slice(at + 1);
        assert.deepEqual(Buffer.from(alias, "base64"), Buffer.from(value, "base64"));
        return alias;
    };
    const results = [];
    for (const deps of [[], [missing]]) {
        const suffix = deps.length === 0 ? "complete" : "partial";
        const delegatedUnknown = await raw("command", ["map", [[["nil"], ["delegation", unknownDelegation]]]], deps);
        results.push([`unknown-delegation-${suffix}`, [...f.histories[0].frames, delegatedUnknown]]);
        results.push([`forged-unknown-delegation-${suffix}`, [...f.histories[0].frames, { ...delegatedUnknown, sig: Buffer.alloc(64).toString("base64") }]]);
        const binary = await raw("command", ["bin", "Zg=="], deps);
        results.push([`canonical-bin-${suffix}`, [...f.histories[0].frames, binary]]);
        results.push([`padbits-bin-${suffix}`, [...f.histories[0].frames, { ...binary, body: ["bin", "Zh=="] }]]);
        const flat = await raw("command", ["delegation", f.space.delegation], deps);
        results.push([`canonical-delegation-bytes-${suffix}`, [...f.histories[0].frames, flat]]);
        results.push([`extra-delegation-field-${suffix}`, [...f.histories[0].frames, { ...flat, body: ["delegation", { ...f.space.delegation, extra: "unsigned" }] }]]);
        const missingParent = { ...f.space.delegation };
        delete missingParent.parent_id;
        results.push([`missing-delegation-parent-${suffix}`, [...f.histories[0].frames, { ...flat, body: ["delegation", missingParent] }]]);
        for (const field of ["issuer", "audience", "sig"]) {
            results.push([`padbits-delegation-${field}-${suffix}`, [...f.histories[0].frames, { ...flat, body: ["delegation", { ...f.space.delegation, [field]: alias64(f.space.delegation[field]) }] }]]);
        }
        results.push([`numeric-scalar-${suffix}`, [...f.histories[0].frames, await raw("command", ["int", 1], deps)]]);
        results.push([`small-text-scalar-${suffix}`, [...f.histories[0].frames, await raw("command", ["int", "1"], deps)]]);
        const nil = await raw("command", ["nil"], deps);
        results.push([`malformed-scalar-arity-${suffix}`, [...f.histories[0].frames, { ...nil, body: ["nil", 0] }]]);
        const unknown = await raw("future_incoming_kind", ["nil"], deps);
        results.push([`unknown-kind-${suffix}`, [...f.histories[0].frames, unknown]]);
        results.push([`forged-unknown-kind-${suffix}`, [...f.histories[0].frames, { ...unknown, sig: Buffer.alloc(64).toString("base64") }]]);
        for (const size of [64000, 64001]) {
            const frame = await atSize(size, deps);
            results.push([`push-${size}-${suffix}`, [...f.histories[0].frames, frame]]);
        }
        let delegated = ["delegation", f.space.delegation];
        for (let n = 0; n < 64; n++)
            delegated = ["map", [[["nil"], delegated]]];
        results.push([`map-64-delegation-leaf-${suffix}`, [...f.histories[0].frames, await raw("command", delegated, deps)]]);
        delegated = ["map", [[["nil"], delegated]]];
        results.push([`map-65-delegation-leaf-${suffix}`, [...f.histories[0].frames, await raw("command", delegated, deps)]]);
        for (const depth of [64, 65, 66]) {
            let body = ["nil"];
            for (let n = 0; n < depth; n++)
                body = ["map", [[["nil"], body]]];
            const frame = await raw("command", body, deps);
            results.push([`map-depth-${depth}-${suffix}`, [...f.histories[0].frames, frame]]);
        }
        for (const depth of [64, 65, 66]) {
            let body = ["nil"];
            for (let n = 0; n < depth; n++)
                body = ["list", [body]];
            const frame = await raw("command", body, deps);
            results.push([`depth-${depth}-${suffix}`, [...f.histories[0].frames, frame]]);
            results.push([`forged-depth-${depth}-${suffix}`, [...f.histories[0].frames, { ...frame, sig: Buffer.alloc(64).toString("base64") }]]);
        }
    }
    return results;
}
