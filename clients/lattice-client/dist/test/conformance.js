// Conformance harness: the TS reducer MUST reproduce Lattice.Sim's output.
//
// Sim (Elixir) is the oracle. For each vector (exported by the mix task, or
// hand-authored from a verified scenario), we materialize with the TS reducer
// and assert equality of state, quarantine set, and the partial-frontier LWW
// behaviour. Any drift here is exactly the two-implementations bug V-01 exists
// to prevent — so this file is the guardrail that lets a second (TS)
// implementation of the reducer exist at all.
//
// Run:  npx tsx test/conformance.ts   (from lattice-client/)
// Tier B (byte-identical op hashes) is added here once ADR-P08 / CBOR lands and
// vectors carry `encoding`.
import { readFileSync, readdirSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { canonicalBytesForCarrierDelegation, canonicalHash, carrierDelegationsFromFrames, carrierOpsToSemanticOps, decodeCarrierOpFrame, materialize, verifyCarrierOp, } from "../src/index";
const here = dirname(fileURLToPath(import.meta.url));
const vecDir = join(here, "vectors");
const verifier = { verify: verifyEd25519 };
let failures = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) {
    const ok = eq(got, want);
    if (!ok)
        failures++;
    const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${tag} ${name}`);
    if (!ok) {
        console.log(`       got : ${JSON.stringify(got)}`);
        console.log(`       want: ${JSON.stringify(want)}`);
    }
}
for (const file of readdirSync(vecDir).filter((f) => f.endsWith(".json"))) {
    const vec = JSON.parse(readFileSync(join(vecDir, file), "utf8"));
    console.log(`\n▸ ${vec.scenario}  (${file})`);
    const carrierFrames = vec.oracleCarrierOps?.map(decodeCarrierOpFrame);
    const ops = carrierFrames !== undefined && vec.realmByPubkey !== undefined
        ? carrierOpsToSemanticOps(carrierFrames, vec.realmByPubkey)
        : vec.ops;
    if (vec.scenario === "township_authority_forged_root") {
        const [frame] = carrierFrames ?? [];
        check("impostor genesis carrier hash/signature", frame === undefined ? null : await verifyCarrierOp(frame, verifier), { hash: true, signature: true, valid: true });
        const [delegation] = frame === undefined ? [] : carrierDelegationsFromFrames([frame]);
        const delegationBytes = delegation === undefined ? undefined : canonicalBytesForCarrierDelegation(delegation);
        check("impostor genesis delegation hash", delegationBytes === undefined ? null : await canonicalHash(delegationBytes), delegation?.id);
        check("impostor genesis delegation signature", delegation === undefined || delegationBytes === undefined
            ? false
            : await verifyEd25519(delegation.issuer, delegationBytes, Buffer.from(delegation.sig, "base64")), true);
    }
    if (vec.scenario === "township_authority_forged_delegation_sig") {
        const [frame] = carrierFrames ?? [];
        check("forged delegation signature outer op hash/signature", frame === undefined ? null : await verifyCarrierOp(frame, verifier), { hash: true, signature: true, valid: true });
        const [delegation] = frame === undefined ? [] : carrierDelegationsFromFrames([frame]);
        const delegationBytes = delegation === undefined ? undefined : canonicalBytesForCarrierDelegation(delegation);
        check("forged delegation signature hash", delegationBytes === undefined ? null : await canonicalHash(delegationBytes), delegation?.id);
        check("forged delegation signature verification", delegation === undefined || delegationBytes === undefined
            ? true
            : await verifyEd25519(delegation.issuer, delegationBytes, Buffer.from(delegation.sig, "base64")), false);
    }
    if (vec.scenario === "township_authority_delegation_id_collision") {
        const [forgedFrame, pristineFrame] = carrierFrames ?? [];
        check("delegation collision outer op hash/signatures", forgedFrame === undefined || pristineFrame === undefined
            ? null
            : [
                await verifyCarrierOp(forgedFrame, verifier),
                await verifyCarrierOp(pristineFrame, verifier),
            ], [
            { hash: true, signature: true, valid: true },
            { hash: true, signature: true, valid: true },
        ]);
        const [forgedDelegation, pristineDelegation] = forgedFrame === undefined || pristineFrame === undefined
            ? []
            : carrierDelegationsFromFrames([forgedFrame, pristineFrame]);
        const forgedBytes = forgedDelegation === undefined
            ? undefined
            : canonicalBytesForCarrierDelegation(forgedDelegation);
        const pristineBytes = pristineDelegation === undefined
            ? undefined
            : canonicalBytesForCarrierDelegation(pristineDelegation);
        check("delegation collision canonical identity", forgedBytes === undefined ||
            pristineBytes === undefined ||
            forgedDelegation === undefined ||
            pristineDelegation === undefined
            ? null
            : {
                bytesEqual: Buffer.from(forgedBytes).equals(Buffer.from(pristineBytes)),
                forgedHash: await canonicalHash(forgedBytes),
                forgedId: forgedDelegation.id,
                pristineHash: await canonicalHash(pristineBytes),
                pristineId: pristineDelegation.id,
            }, forgedDelegation === undefined || pristineDelegation === undefined
            ? null
            : {
                bytesEqual: true,
                forgedHash: pristineDelegation.id,
                forgedId: pristineDelegation.id,
                pristineHash: pristineDelegation.id,
                pristineId: pristineDelegation.id,
            });
        const forgedSig = forgedDelegation === undefined ? undefined : Buffer.from(forgedDelegation.sig, "base64");
        const pristineSig = pristineDelegation === undefined
            ? undefined
            : Buffer.from(pristineDelegation.sig, "base64");
        check("delegation collision embedded signature asymmetry", forgedDelegation === undefined ||
            pristineDelegation === undefined ||
            forgedBytes === undefined ||
            pristineBytes === undefined ||
            forgedSig === undefined ||
            pristineSig === undefined
            ? null
            : {
                signaturesEqual: forgedSig.equals(pristineSig),
                lengths: [forgedSig.length, pristineSig.length],
                forgedValid: await verifyEd25519(forgedDelegation.issuer, forgedBytes, forgedSig),
                pristineValid: await verifyEd25519(pristineDelegation.issuer, pristineBytes, pristineSig),
            }, {
            signaturesEqual: false,
            lengths: [64, 64],
            forgedValid: false,
            pristineValid: true,
        });
        check("delegation collision forged outer op sorts first", forgedFrame === undefined || pristineFrame === undefined
            ? null
            : forgedFrame.id < pristineFrame.id, true);
    }
    // full-frontier materialization
    const full = materialize(vec.schema, ops);
    const exp = vec.expectAtFullFrontier;
    for (const [field, want] of Object.entries(exp.state)) {
        check(`state.${field}`, full.state[field], want);
    }
    check("quarantine set", [...full.quarantine].sort(), [...exp.quarantine].sort());
    if (exp.winners) {
        for (const [field, want] of Object.entries(exp.winners)) {
            check(`winner.${field}`, full.winners[field], want);
        }
    }
    if (vec.scenario === "township_succession_unproven_tick") {
        const successionId = vec.successionOperationId ?? "<missing succession operation id>";
        const verificationResults = carrierFrames === undefined
            ? null
            : await Promise.all(carrierFrames.map((frame) => verifyCarrierOp(frame, verifier)));
        check("unproven-tick carrier hash/signatures", verificationResults, [
            { hash: true, signature: true, valid: true },
            { hash: true, signature: true, valid: true },
        ]);
        check("unproven-tick succession id in carrier evidence", carrierFrames?.some((frame) => frame.id === successionId) ?? false, true);
        check("unproven-tick provenance marker", vec.tickProvenance, "author_asserted_untrusted");
        check("unproven-tick succession absent from TS quarantine", full.quarantine.includes(successionId), false);
        check("unproven-tick succession absent from BEAM authority quarantine", exp.authorityQuarantine?.some(([id]) => id === successionId) ?? null, false);
        check("unproven-tick clerk state", full.state.clerk, "resident");
        check("unproven-tick clerk winner", full.winners.clerk, successionId);
    }
    // partial-frontier assertions (the LWW flip, perspective, etc.)
    for (const fr of vec.expectAtFrontier ?? []) {
        const m = materialize(vec.schema, ops, new Set(fr.include));
        for (const [field, want] of Object.entries(fr.state)) {
            check(`@frontier[${fr.include.length}] state.${field}${fr.note ? ` (${fr.note})` : ""}`, m.state[field], want);
        }
    }
}
console.log("\n▸ externally determined quarantine");
{
    const schema = {
        name: "ExternalQuarantine",
        fields: { posts: { merge: "causal_list" } },
    };
    const accepted = {
        id: "accepted",
        deps: [],
        kind: "command",
        author: "resident",
        field: "posts",
        mutation: "append",
        value: "accepted",
        hash: "accepted",
    };
    const quarantined = {
        id: "quarantined",
        deps: [accepted.id],
        kind: "command",
        author: "resident",
        field: "posts",
        mutation: "append",
        value: "quarantined",
        hash: "quarantined",
    };
    const result = materialize(schema, [accepted, quarantined], undefined, new Set([quarantined.id]));
    check("externally quarantined mutation is not applied", result.state.posts, ["accepted"]);
    check("externally quarantined op remains in canonical order", result.order, [accepted.id, quarantined.id]);
    check("externally quarantined op remains auditable", result.quarantine, [quarantined.id]);
}
console.log(`\n${failures === 0 ? "\x1b[32m✓ all conformance checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
async function verifyEd25519(author, bytes, signature) {
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = createPublicKey({
        key: Buffer.concat([spkiPrefix, Buffer.from(author, "base64")]),
        format: "der",
        type: "spki",
    });
    return edVerify(null, Buffer.from(bytes), publicKey, Buffer.from(signature));
}
