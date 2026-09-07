import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ancestors, canonicalOrder, concurrent } from "../src/dag";
import * as codec from "../src/treehouse_member_continuity_codec";
import { memberContinuityCommandConflicts } from "../src/treehouse_member_continuity";
const corpus = JSON.parse(readFileSync(new URL("./vectors/member_continuity_semantics/ts_semantics.json", import.meta.url), "utf8"));
const certificate = codec.memberContinuityCertificateFromCarrierTerm(corpus.authoring.certificate_term);
const digest = (label) => createHash("sha256").update(`conflict-index:${label}`).digest();
const pub = (label) => digest(label).toString("base64");
const id = (label) => digest(label).toString("base64url");
function statement(label, claim) {
    return { id: id(label), hash: id(label), replica: claim.space, deps: claim.deps, kind: "command",
        author: pub("admin"), field: "admin_actions", mutation: "write", value: "attest_member_key_v1",
        command: "attest_member_key_v1", commandArgs: [claim, certificate.possession, certificate.vouches] };
}
function certificateFor(op) {
    return op.kind === "command" && op.command === "attest_member_key_v1" && op.commandArgs?.length === 3
        ? codec.normalizeMemberContinuityCertificate({ claim: op.commandArgs[0], possession: op.commandArgs[1], vouches: op.commandArgs[2] }) : null;
}
function removalOf(op, key) { return op.kind === "command" && op.command === "remove_member" && op.commandArgs?.[0] === key; }
const memberContinuityClaimId = codec.memberContinuityClaimId;
// Frozen pre-index algorithm: independent semantic reference for deny-only graph output.
function referenceConflicts(ops, verdicts) {
    const byId = new Map(ops);
    const ancestorCache = new Map();
    const candidates = canonicalOrder([...ops.values()], byId)
        .map((id) => byId.get(id))
        .filter((op) => verdicts.get(op.id) === "honored")
        .map((op) => ({ op, certificate: certificateFor(op) }))
        .filter((entry) => entry.certificate !== null);
    const removals = [...ops.values()].filter((op) => verdicts.get(op.id) === "honored");
    const denied = new Map();
    for (const candidate of candidates) {
        const stale = candidate.certificate.claim.vouchers.some((voucher) => removals.some((removal) => removalOf(removal, voucher.member) && concurrent(candidate.op.id, removal.id, byId, ancestorCache) &&
            ancestors(removal.id, byId, ancestorCache).has(voucher.admission)));
        const collision = candidates.some((other) => candidate.certificate.claim.oldPub !== other.certificate.claim.oldPub &&
            candidate.certificate.claim.newPub === other.certificate.claim.newPub &&
            concurrent(candidate.op.id, other.op.id, byId, ancestorCache));
        if (stale)
            denied.set(candidate.op.id, "application_continuity_stale_voucher");
        else if (collision)
            denied.set(candidate.op.id, "application_continuity_conflicting_target");
    }
    for (const candidate of candidates) {
        const invalid = candidate.certificate.claim.parents.some((parent) => !candidates.some((wrapper) => memberContinuityClaimId(wrapper.certificate.claim) === parent &&
            wrapper.certificate.claim.oldPub === candidate.certificate.claim.oldPub &&
            ancestors(candidate.op.id, byId, ancestorCache).has(wrapper.op.id) && !denied.has(wrapper.op.id)));
        if (invalid && !denied.has(candidate.op.id)) {
            denied.set(candidate.op.id, "application_continuity_invalid_parent");
        }
    }
    return denied;
}
test("independent parentless targets do not repeatedly classify unrelated operations", () => {
    const count = 64;
    let kindReads = 0;
    const ops = new Map(Array.from({ length: count }, (_, index) => {
        const claim = { ...certificate.claim, oldPub: pub(`old:${index}`), newPub: pub(`new:${index}`), parents: [] };
        const op = statement(`independent:${index}`, claim);
        Object.defineProperty(op, "kind", { get: () => { kindReads++; return "command"; } });
        return [op.id, op];
    }));
    const verdicts = new Map([...ops.keys()].map(id => [id, "honored"]));
    assert.deepEqual([...memberContinuityCommandConflicts(ops, verdicts)], []);
    assert.ok(kindReads <= count * 3, `unrelated operation classifications: ${kindReads} for ${count} candidates`);
});
test("grouped graph equals pre-index reference for collisions, stale vouchers, duplicate wrappers and inherited refusals", () => {
    for (let seed = 0; seed < 16; seed++) {
        const ops = [];
        const claims = [];
        for (let index = 0; index < 12; index++) {
            const parent = index >= 4 ? index - 4 : null;
            const claim = codec.normalizeMemberContinuityClaim({ ...certificate.claim,
                oldPub: pub(`old:${index % 4}`), newPub: pub(`new:${(index + seed) % (seed % 2 ? 3 : 12)}`),
                nonce: pub(`nonce:${seed}:${index}`),
                parents: parent === null ? [] : [codec.memberContinuityClaimId(claims[parent])],
                deps: parent === null ? certificate.claim.deps : [ops[parent].id] });
            claims.push(claim);
            ops.push(statement(`mixed:${seed}:${index}`, claim));
        }
        const duplicate = statement(`duplicate:${seed}`, claims[0]);
        ops.push(duplicate);
        const voucher = certificate.claim.vouchers[seed % 2];
        ops.push({ ...statement(`remove:${seed}`, certificate.claim), command: "remove_member", commandArgs: [voucher.member],
            deps: seed % 3 === 0 ? [voucher.admission] : [id("unrelated-admission")] });
        for (const ordered of [ops, [...ops].reverse()]) {
            const byId = new Map(ordered.map(op => [op.id, op]));
            const verdicts = new Map(ordered.map((op, index) => [op.id, (index + seed) % 7 === 0 ? "application_wrong_target" : "honored"]));
            assert.deepEqual(memberContinuityCommandConflicts(byId, verdicts), referenceConflicts(byId, verdicts), `seed ${seed}`);
        }
    }
});
