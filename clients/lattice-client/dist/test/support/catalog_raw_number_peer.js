// Fresh actual public-owner requests with preserved numeric JSON spellings.
// A number is compared by value; artifact JSON text remains opaque and strict.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trustFixture, fixtureId, signedCatalog } from "./export_treehouse_catalog_trust";
import { authorCarrierOp, authorCarrierDelegation, canonicalBytesForCarrierOp } from "../../src/codec";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
import { catalogRotationEnvelopeFromCarrierTerm, catalogRotationId } from "../../src/treehouse_catalog_codec";
const empty = () => ({ catalogs: [], rotations: [], histories: [], cutoffProofs: [] });
const expected = { trustRevision: 0, historyGeneration: 0 };
if (process.argv[2] === "consume") {
    const requests = JSON.parse(readFileSync(process.argv[3] ?? 0, "utf8"));
    const results = [];
    for (const request of requests.cases)
        results.push({ name: request.name, decision: await evaluateTreehouseCatalogTrust(JSON.parse(request.requestJson)) });
    console.log(JSON.stringify({ results }));
}
else {
    const f = await trustFixture(1);
    const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
    assert.equal(prepared.kind, "propose");
    const accepted = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { ...empty(), catalogs: [f.catalogJson], histories: f.histories } });
    assert.equal(accepted.kind, "propose");
    const marker = "__raw_number_test_only_1749__";
    const inputs = [];
    const add = (name, installed, incoming, reason, spelling, kind) => inputs.push({ name, input: { installed: structuredClone(installed), expected: { ...expected }, incoming: structuredClone(incoming) }, reason, spelling, kind });
    const markVersion = (frame) => { frame.v = marker; };
    add("canonical-saved-control", accepted.next, empty(), null, undefined, "unchanged");
    for (const [name, spelling] of [["decimal", "1.0"], ["exponent", "1e0"]]) {
        const saved = structuredClone(accepted.next);
        markVersion(saved.histories[0].frames[0]);
        add(`saved-version-${name}`, saved, empty(), null, spelling, "unchanged");
    }
    const incoming = structuredClone(f.histories);
    markVersion(incoming[1].frames[0]);
    add("incoming-version-decimal", prepared.next, { ...empty(), catalogs: [f.catalogJson], histories: incoming }, null, "1.0", "propose");
    const alias = structuredClone(f.histories[0]);
    alias.frames = [alias.frames[0]];
    markVersion(alias.frames[0]);
    add("coalesced-version-alias", accepted.next, { ...empty(), histories: [alias] }, null, "1.0", "unchanged");
    function markOne(value, replacement) {
        if (!Array.isArray(value))
            return false;
        if (value[0] === "int" && value[1] === 1) {
            value[1] = replacement;
            return true;
        }
        return value.some(item => markOne(item, replacement));
    }
    const saved = structuredClone(accepted.next);
    assert(saved.histories[0].frames.some(frame => markOne(frame.body, marker)));
    add("saved-tagged-integer-decimal", saved, empty(), null, "1.0", "unchanged");
    const smallText = structuredClone(f.histories[0]);
    const textAlias = smallText.frames.find(frame => markOne(frame.body, "1"));
    assert(textAlias);
    smallText.frames = [textAlias];
    add("coalesced-small-text-control", accepted.next, { ...empty(), histories: [smallText] }, null, undefined, "unchanged");
    async function numericFrame(value, deps = [f.bootstrap.id]) {
        return authorCarrierOp({ replica: f.space.replica, signer: f.space.signer, deps, kind: "command", cap: ["nil"], body: ["list", [["int", value]]] });
    }
    for (const [name, value, spelling] of [["zero", 0, "0.0"], ["negative-zero", 0, "-0.0"], ["safe-edge", Number.MAX_SAFE_INTEGER, "9007199254740991.0"]]) {
        const frame = await numericFrame(value);
        frame.body[1][0] = ["int", marker];
        add(`incoming-int-${name}`, accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [frame], rejected: [] }] }, null, spelling, "propose");
    }
    const unadmittedSmallText = await numericFrame(1);
    unadmittedSmallText.body[1][0] = ["int", "1"];
    add("new-small-text-remains-unsupported", accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [unadmittedSmallText], rejected: [] }] }, "unsupported_cutoff", undefined, "reject");
    for (const [name, spelling] of [["fraction", "0.5"], ["negative", "-1.0"], ["unsafe", "9007199254740992.0"], ["text-decimal", '"1.0"']]) {
        const frame = await numericFrame(0);
        frame.body[1][0] = ["int", marker];
        add(`incoming-int-${name}`, accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [frame], rejected: [] }] }, "invalid_verified_history", spelling, "reject");
    }
    for (const [name, spelling] of [["wrong", "2.0"], ["fraction", "1.5"], ["boolean", "true"], ["text", '"1.0"']]) {
        const frame = structuredClone(f.histories[0].frames[0]);
        markVersion(frame);
        add(`incoming-version-${name}`, accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [frame], rejected: [] }] }, "invalid_verified_history", spelling, "reject");
    }
    const rejected = structuredClone(f.histories[0].frames[0]);
    rejected.sig = Buffer.alloc(64).toString("base64");
    markVersion(rejected);
    add("rejected-signature-version-alias", accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [], rejected: [{ frame: rejected, reason: "bad_signature" }] }] }, null, "1.0", "propose");
    const relabel = structuredClone(f.histories[0].frames[0]);
    markVersion(relabel);
    add("authentic-cannot-be-relabelled", accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [], rejected: [{ frame: relabel, reason: "bad_signature" }] }] }, "invalid_verified_history", "1.0", "reject");
    const partial = await numericFrame(0, [fixtureId("numeric-missing-parent")]);
    markVersion(partial);
    add("authentic-before-missing", accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [partial], rejected: [] }] }, "trust_pending", "1.0", "reject");
    const forged = structuredClone(partial);
    forged.sig = Buffer.alloc(64).toString("base64");
    add("forgery-before-missing", accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [forged], rejected: [] }] }, "invalid_verified_history", "1.0", "reject");
    const rotation = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson));
    const rotated = await signedCatalog({ ...f.catalog, binding: catalogRotationId(rotation) }, f.nextCatalogSigner);
    const versionProofs = structuredClone(f.cutoffProofs);
    markVersion(versionProofs[0].history.frames[0]);
    add("cutoff-proof-version-alias", accepted.next, { ...empty(), catalogs: [rotated], rotations: [f.rotationJson], cutoffProofs: versionProofs }, null, "1.0", "propose");
    const integerProofs = structuredClone(f.cutoffProofs);
    assert(integerProofs[0].history.frames.some(frame => markOne(frame.body, marker)));
    add("cutoff-proof-integer-alias", accepted.next, { ...empty(), catalogs: [rotated], rotations: [f.rotationJson], cutoffProofs: integerProofs }, null, "1.0", "propose");
    const invalidProofs = structuredClone(f.cutoffProofs);
    markVersion(invalidProofs[0].history.frames[0]);
    add("cutoff-proof-invalid-version", accepted.next, { ...empty(), catalogs: [rotated], rotations: [f.rotationJson], cutoffProofs: invalidProofs }, "recovery_incomplete", "1.5", "reject");
    const delegation = await authorCarrierDelegation({ replica: f.space.replica, signer: f.space.signer, audiencePubkey: f.space.signer.publicKey,
        parentId: f.space.delegation.id, ops: [], roles: [], live: false, expiresEpoch: 1 });
    const grant = await authorCarrierOp({ replica: f.space.replica, signer: f.space.signer, deps: [f.bootstrap.id], kind: "authority", cap: ["nil"], body: ["tuple", [["atom", "grant"], ["delegation", delegation]]] });
    grant.body[1][1][1].expires_epoch = marker;
    add("delegation-expiry-alias", accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [grant], rejected: [] }] }, null, "1.0", "propose");
    for (const [name, spelling] of [["fraction", "0.5"], ["negative", "-1.0"], ["unsafe", "9007199254740992.0"]]) {
        add(`delegation-expiry-${name}`, accepted.next, { ...empty(), histories: [{ replica: f.space.replica, frames: [structuredClone(grant)], rejected: [] }] }, "invalid_verified_history", spelling, "reject");
    }
    const corrupt = structuredClone(accepted.next);
    markVersion(corrupt.histories[0].frames[0]);
    add("corrupt-original-before-repair", corrupt, { ...empty(), histories: f.histories }, "trust_recovery_required", "1.5", "reject");
    for (const [name, spelling] of [["fractional-token", "1.0"], ["negative-zero-token", "-0"]]) {
        const artifact = f.catalogJson.replace('["int",1]', `["int",${spelling}]`);
        assert.notEqual(artifact, f.catalogJson);
        add(`artifact-${name}`, accepted.next, { ...empty(), catalogs: [artifact] }, "malformed_catalog", undefined, "reject");
    }
    if (process.argv[2] === "metadata") {
        for (const [name, path, spelling, reason] of [
            ["state-version", ["installed", "version"], "1.0", null],
            ["review-version", ["installed", "review", "version"], "1e0", null],
            ["watermark-generation", ["installed", "accepted", "generation"], "0.0", null],
            ["watermark-revision", ["installed", "accepted", "revision"], "0.0", null],
            ["token-trust", ["expected", "trustRevision"], "0.0", null],
            ["token-history", ["expected", "historyGeneration"], "1.0", null],
            ["token-safe-edge", ["expected", "trustRevision"], "9007199254740990.0", null],
            ["token-fraction", ["expected", "trustRevision"], "0.5", "malformed_catalog"],
            ["token-negative", ["expected", "trustRevision"], "-1.0", "malformed_catalog"],
            ["token-string", ["expected", "trustRevision"], '"1.0"', "malformed_catalog"],
            ["token-trust-exhausted", ["expected", "trustRevision"], "9007199254740991", "malformed_catalog"],
            ["token-history-exhausted", ["expected", "historyGeneration"], "9007199254740991", "malformed_catalog"],
            ["watermark-fraction", ["installed", "accepted", "revision"], "0.5", "trust_recovery_required"],
            ["watermark-unsafe", ["installed", "accepted", "revision"], "9007199254740992.0", "trust_recovery_required"]
        ]) {
            add(`metadata-${name}`, accepted.next, empty(), reason, spelling, reason === null ? "unchanged" : "reject");
            let owner = inputs.at(-1).input;
            for (const key of path.slice(0, -1))
                owner = owner[key];
            owner[path.at(-1)] = marker;
        }
    }
    const cases = [];
    for (const item of inputs) {
        const orders = [];
        for (const reverse of [false, true]) {
            const input = structuredClone(item.input);
            if (reverse) {
                input.installed.histories.reverse();
                input.incoming.histories = [...input.incoming.histories].reverse();
                for (const h of [...input.installed.histories, ...input.incoming.histories])
                    h.frames = [...h.frames].reverse();
            }
            let requestJson = JSON.stringify(input);
            if (item.spelling !== undefined) {
                assert.equal(requestJson.split(JSON.stringify(marker)).length, 2, item.name);
                requestJson = requestJson.replace(JSON.stringify(marker), item.spelling);
            }
            const decoded = JSON.parse(requestJson), before = JSON.stringify(decoded);
            const decision = await evaluateTreehouseCatalogTrust(decoded);
            assert.equal(JSON.stringify(decoded), before, "input mutation");
            assert.equal(decision.reason, item.reason, item.name);
            if (item.kind)
                assert.equal(decision.kind, reverse && item.kind === "unchanged" ? "propose" : item.kind, item.name);
            // Authentic equivalent aliases are checked by the public owner; raw payload
            // bytes for the version-only aliases are independently unchanged below.
            if (item.name.startsWith("saved-version-")) {
                const frame = decoded.installed.histories.flatMap(h => h.frames).find(frame => frame.id === f.histories[0].frames[0].id);
                assert.deepEqual(canonicalBytesForCarrierOp(frame), canonicalBytesForCarrierOp(f.histories[0].frames[0]));
            }
            orders.push({ requestJson, decision });
        }
        cases.push({ name: item.name, orders });
    }
    assert.equal(cases.length, process.argv[2] === "metadata" ? 47 : 33);
    console.log(JSON.stringify({ cases }));
}
