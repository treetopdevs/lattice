// Fresh malformed observations: refusal semantics remain owned by the real API.
import assert from "node:assert/strict";
import { trustFixture, fixtureSigner } from "./export_treehouse_catalog_trust";
import { authorTreehouseRoleTransfer } from "../../src/treehouse";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
const profile = process.argv[2] === "input", width = profile ? Number(process.argv[3] ?? 4096) : 4096;
const form = process.argv[4] ?? "array", security = process.argv[5] === "security";
assert.ok(Number.isInteger(width) && width >= 0 && width <= 1_048_576);
const f = await trustFixture(0), expected = { trustRevision: 0, historyGeneration: 0 };
const empty = () => ({ catalogs: [], rotations: [], histories: [], cutoffProofs: [] });
const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
assert.equal(prepared.kind, "propose");
const accepted = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected, incoming: { ...empty(), catalogs: [f.catalogJson], histories: f.histories } });
assert.equal(accepted.kind, "propose");
const installed = accepted.next;
const { frame: transfer } = await authorTreehouseRoleTransfer({ replica: f.space.replica, deps: [f.space.creation.id], signer: f.root, parent: f.space.delegation,
    recipient: fixtureSigner("refusal-resource-successor").publicKey, action: "transfer_admin" });
const changed = { ...f.histories[0], frames: [...f.space.frames, transfer] };
const wide = () => Array.from({ length: width }, () => []);
function proof(shape) {
    switch (shape) {
        case "array": return wide();
        case "object": return { unexpected: wide() };
        case "closed": return { cutoff: wide(), history: {} };
        case "string": return "x".repeat(width);
        case "null": return null;
        case "boolean": return true;
        case "number": return 7;
        default: throw Error("unknown refusal shape");
    }
}
async function observe(name, shape, frozen, extra) {
    const input = { installed: structuredClone(installed), expected, incoming: { ...empty(),
            cutoffProofs: [proof(shape)], histories: frozen ? [structuredClone(changed)] : [] } };
    if (extra === "forged") {
        const history = structuredClone(f.histories[0]);
        history.frames[0].sig = Buffer.alloc(64).toString("base64");
        input.incoming.histories = [history];
    }
    if (extra === "foreign")
        input.incoming.histories = [{ replica: "foreign", frames: [], rejected: [] }];
    const before = JSON.stringify(input), decision = await evaluateTreehouseCatalogTrust(input);
    assert.equal(JSON.stringify(input), before, "public owner mutated refusal input");
    const reason = extra === "forged" ? "invalid_verified_history" : extra === "foreign" ? "wrong_catalog_scope" : frozen ? "authority_changed" : "malformed_catalog";
    assert.equal(decision.kind, frozen && !extra ? "retain_blocked" : "reject");
    assert.equal(decision.reason, reason);
    return { name, input, decision };
}
if (profile)
    console.log(JSON.stringify(await observe(`refusal-${form}-${security ? "security" : "unblocked"}`, form, security)));
else {
    const cases = [];
    for (const shape of ["array", "object", "closed", "string", "null", "boolean", "number"])
        for (const frozen of [false, true])
            cases.push(await observe(`refusal-${shape}-${frozen ? "security" : "unblocked"}`, shape, frozen));
    cases.push(await observe("refusal-proof-cannot-hide-forgery", "array", false, "forged"));
    cases.push(await observe("refusal-proof-cannot-hide-family", "array", false, "foreign"));
    console.log(JSON.stringify({ cases }));
}
