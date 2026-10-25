import { authorCarrierOpUnchecked } from "./unchecked_author";
import { canonicalBytesForCarrierTerm, canonicalHash } from "../../src/codec";
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
    const results = [];
    for (const deps of [[], [missing]]) {
        const suffix = deps.length === 0 ? "complete" : "partial";
        const nil = await raw("command", ["nil"], deps);
        results.push([`malformed-scalar-arity-${suffix}`, [...f.histories[0].frames, { ...nil, body: ["nil", 0] }]]);
        const unknown = await raw("future_incoming_kind", ["nil"], deps);
        results.push([`unknown-kind-${suffix}`, [...f.histories[0].frames, unknown]]);
        results.push([`forged-unknown-kind-${suffix}`, [...f.histories[0].frames, { ...unknown, sig: Buffer.alloc(64).toString("base64") }]]);
        for (const size of [64000, 64001]) {
            const frame = await atSize(size, deps);
            results.push([`push-${size}-${suffix}`, [...f.histories[0].frames, frame]]);
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
