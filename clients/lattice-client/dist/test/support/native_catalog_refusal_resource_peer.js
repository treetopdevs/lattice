// Fresh malformed observations: refusal semantics remain owned by the real API.
import assert from "node:assert/strict";
import { trustFixture, fixtureSigner, fixtureId } from "./export_treehouse_catalog_trust";
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
const ids = [fixtureId("metadata-first"), fixtureId("metadata-second")].sort();
const cutoff = () => ({ replica: f.space.replica, logDigest: ids[0], frontier: [] });
function proof(shape) {
    switch (shape) {
        case "array": return wide();
        case "object": return { unexpected: wide() };
        case "closed": return { cutoff: wide(), history: {} };
        case "replica-type": return { cutoff: { ...cutoff(), replica: wide() }, history: {} };
        case "digest-type": return { cutoff: { ...cutoff(), logDigest: wide() }, history: {} };
        case "frontier-type": return { cutoff: { ...cutoff(), frontier: { unexpected: wide() } }, history: {} };
        case "frontier-member": return { cutoff: { ...cutoff(), frontier: wide() }, history: {} };
        case "frontier-duplicate": return { cutoff: { ...cutoff(), frontier: [ids[0], ids[0]] }, history: {} };
        case "frontier-order": return { cutoff: { ...cutoff(), frontier: [ids[1], ids[0]] }, history: {} };
        case "cutoff-extra": return { cutoff: { ...cutoff(), unexpected: wide() }, history: {} };
        case "empty-replica": return { cutoff: { ...cutoff(), replica: "" }, history: {} };
        case "bad-digest": return { cutoff: { ...cutoff(), logDigest: "!".repeat(43) }, history: {} };
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
    if (extra === "prior-proof") {
        assert.ok(f.cutoffProofs[0], "fresh proof prerequisite");
        const prior = structuredClone(f.cutoffProofs[0]);
        prior.cutoff.logDigest = fixtureId("metadata-wrong-claim");
        input.incoming.cutoffProofs = [prior, ...input.incoming.cutoffProofs];
    }
    const before = JSON.stringify(input), decision = await evaluateTreehouseCatalogTrust(input);
    assert.equal(JSON.stringify(input), before, "public owner mutated refusal input");
    const reason = extra === "forged" ? "invalid_verified_history" : extra === "foreign" ? "wrong_catalog_scope" : extra === "prior-proof" ? "recovery_incomplete" : frozen ? "authority_changed" : "malformed_catalog";
    assert.equal(decision.kind, frozen && !extra ? "retain_blocked" : "reject");
    assert.equal(decision.reason, reason);
    return { name, input, decision };
}
if (profile)
    console.log(JSON.stringify(await observe(`refusal-${form}-${security ? "security" : "unblocked"}`, form, security)));
else {
    const cases = [];
    for (const shape of ["array", "object", "closed", "string", "null", "boolean", "number", "replica-type", "digest-type", "frontier-type", "frontier-member", "frontier-duplicate", "frontier-order", "cutoff-extra", "empty-replica", "bad-digest"])
        for (const frozen of [false, true])
            cases.push(await observe(`refusal-${shape}-${frozen ? "security" : "unblocked"}`, shape, frozen));
    cases.push(await observe("refusal-proof-cannot-hide-forgery", "array", false, "forged"));
    cases.push(await observe("refusal-proof-cannot-hide-family", "array", false, "foreign"));
    cases.push(await observe("refusal-cutoff-cannot-hide-forgery", "frontier-member", false, "forged"));
    cases.push(await observe("refusal-cutoff-cannot-hide-family", "frontier-member", false, "foreign"));
    cases.push(await observe("refusal-cutoff-cannot-hide-earlier-proof", "frontier-member", false, "prior-proof"));
    console.log(JSON.stringify({ cases }));
}
