import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
const id = (label) => createHash("sha256").update(`member-codec-test:${label}`).digest("base64url");
const key = (label) => {
    const seed = createHash("sha256").update(`member-codec-test:${label}`).digest();
    return { pub: Buffer.from(ed25519.getPublicKey(seed)).toString("base64"), sign: (bytes) => Buffer.from(ed25519.sign(bytes, seed)).toString("base64") };
};
function fixture() {
    const old = key("old"), next = key("new");
    const vouchers = [key("member-a"), key("member-b")].sort((a, b) => Buffer.compare(Buffer.from(a.pub, "base64"), Buffer.from(b.pub, "base64")));
    const claim = { version: 1, product: "treehouse",
        space: `replica:treehouse:space:${id("space")}#authority:bounded-continuation-v1#root:${id("root")}`,
        oldPub: old.pub, newPub: next.pub, oldAdmission: id("old-admission"), oldMembership: "active",
        nonce: Buffer.alloc(32, 7).toString("base64"), deps: [id("dep")], epoch: 0, epochBasis: [id("beacon")], parents: [],
        vouchers: vouchers.map((member, i) => ({ member: member.pub, admission: id(`member-admission-${i}`) })) };
    return { old, next, vouchers, claim };
}
test("closed member claim preserves exact reviewed key, admission, epoch and ordered voucher evidence", async () => {
    const { normalizeMemberContinuityClaim } = await import("../src/index");
    const { claim } = fixture();
    assert.deepEqual(normalizeMemberContinuityClaim(claim), claim);
    const bad = [null, { ...claim, extra: 1 }, { ...claim, oldPub: claim.newPub }, { ...claim, epoch: 2 ** 53 },
        { ...claim, deps: [] }, { ...claim, deps: [claim.deps[0], claim.deps[0]] }, { ...claim, epochBasis: [] },
        { ...claim, parents: Array.from({ length: 17 }, (_, i) => id(`parent-${i}`)).sort() },
        { ...claim, vouchers: [...claim.vouchers].reverse() }, { ...claim, vouchers: [...claim.vouchers, claim.vouchers[0]] },
        { ...claim, vouchers: [{ ...claim.vouchers[0], member: claim.oldPub }, claim.vouchers[1]] },
        { ...claim, space: claim.space.replace(":space:", ":thread:") }, { ...claim, nonce: "AA==" },
        Object.fromEntries(Object.entries(claim).filter(([name]) => name !== "oldAdmission"))];
    for (const value of bad)
        assert.equal(normalizeMemberContinuityClaim(value), null);
    const normalized = normalizeMemberContinuityClaim(claim);
    normalized.deps.push(id("changed"));
    assert.equal(claim.deps.length, 1, "normalization copies retained review arrays");
});
test("member possession and both vouches bind the exact independent claim and distinct byte purposes", async () => {
    const codec = await import("../src/index");
    const { claim, next, vouchers } = fixture();
    const possession = next.sign(codec.canonicalBytesForMemberContinuityPossession(claim));
    const certificate = { claim, possession, vouches: vouchers.map((member) => ({ member: member.pub, signature: member.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession)) })) };
    assert.equal(codec.verifyMemberContinuityCertificate(certificate, claim), true);
    assert.deepEqual(codec.normalizeMemberContinuityCertificate(certificate), certificate);
    const canonical = await import("../src/codec");
    const term = codec.memberContinuityClaimToCarrierTerm(claim);
    const bin = (value) => ["bin", Buffer.from(value).toString("base64")];
    for (const [domain, payload] of [
        ["treehouse-member-key-claim-v1", codec.canonicalBytesForMemberContinuityClaim(claim)],
        ["treehouse-member-key-possession-v1", codec.canonicalBytesForMemberContinuityPossession(claim)],
    ])
        assert.deepEqual(payload, canonical.canonicalBytesForCarrierTerm(["list", [bin(domain), term]]));
    assert.equal(codec.memberContinuityClaimId(claim), createHash("sha256").update(codec.canonicalBytesForMemberContinuityClaim(claim)).digest("base64url"));
    assert.notDeepEqual(codec.canonicalBytesForMemberContinuityClaim(claim), codec.canonicalBytesForMemberContinuityPossession(claim));
    const bad = [
        { ...certificate, possession: next.sign(codec.canonicalBytesForMemberContinuityClaim(claim)) },
        { ...certificate, possession: vouchers[0].sign(codec.canonicalBytesForMemberContinuityPossession(claim)) },
        { ...certificate, vouches: certificate.vouches.map((v) => ({ ...v, signature: possession })) },
        { ...certificate, vouches: [...certificate.vouches].reverse() }, { ...certificate, vouches: certificate.vouches.slice(0, 1) },
        { ...certificate, vouches: [...certificate.vouches, certificate.vouches[0]] },
        { ...certificate, vouches: [certificate.vouches[0], { ...certificate.vouches[1], signature: Buffer.alloc(64).toString("base64") }] },
        { ...certificate, extra: true }, { ...certificate, claim: { ...claim, epoch: 1 } },
    ];
    for (const value of bad)
        assert.equal(codec.verifyMemberContinuityCertificate(value, claim), false);
    assert.equal(codec.verifyMemberContinuityCertificate(certificate, { ...claim, oldMembership: "removed" }), false);
    assert.equal(codec.verifyMemberContinuityCertificate(certificate, { ...claim, nonce: Buffer.alloc(32, 8).toString("base64") }), false);
    assert.equal(codec.memberContinuityClaimId({ ...claim, extra: true }), null);
    assert.throws(() => codec.canonicalBytesForMemberContinuityClaim({ ...claim, extra: true }), TypeError);
});
test("old-key return binds the exact reviewed challenge and proves no expiry or one-use policy", async () => {
    const codec = await import("../src/index");
    const { old, next, claim } = fixture();
    const challenge = { version: 1, product: "treehouse", space: claim.space,
        oldPub: old.pub, heads: [id("claim")], deps: [...claim.deps], reviewer: next.pub, nonce: claim.nonce };
    const bytes = codec.canonicalBytesForMemberContinuityReturn(challenge), signature = old.sign(bytes);
    assert.deepEqual(codec.normalizeMemberKeyReturnChallenge(challenge), challenge);
    assert.equal(codec.verifyMemberKeyReturn(challenge, signature, challenge), true);
    assert.equal(codec.verifyMemberKeyReturn(challenge, signature, challenge), true, "pure verification has no session, deadline or consumed-attempt state");
    assert.equal(codec.verifyMemberKeyReturn(challenge, next.sign(bytes), challenge), false);
    assert.equal(codec.verifyMemberKeyReturn(challenge, old.sign(codec.canonicalBytesForMemberContinuityClaim(claim)), challenge), false);
    for (const changed of [{ ...challenge, reviewer: old.pub }, { ...challenge, nonce: Buffer.alloc(32, 9).toString("base64") },
        { ...challenge, heads: [id("other-claim")] }, { ...challenge, deps: [id("other-frontier")] }]) {
        assert.equal(codec.verifyMemberKeyReturn(challenge, signature, changed), false);
    }
    for (const malformed of [{ ...challenge, heads: [] }, { ...challenge, heads: Array.from({ length: 17 }, (_, i) => id(`h-${i}`)).sort() },
        { ...challenge, deps: [] }, { ...challenge, expires: 60 }, { ...challenge, oldPub: "AA==" }]) {
        assert.equal(codec.normalizeMemberKeyReturnChallenge(malformed), null);
        assert.throws(() => codec.canonicalBytesForMemberContinuityReturn(malformed), TypeError);
    }
});
test("carrier adapters preserve closed maps and reject duplicate keys, tags and malformed text before signature use", async () => {
    const codec = await import("../src/index");
    const { claim, next, vouchers } = fixture();
    const possession = next.sign(codec.canonicalBytesForMemberContinuityPossession(claim));
    const certificate = { claim, possession, vouches: vouchers.map((member) => ({ member: member.pub, signature: member.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession)) })) };
    const term = codec.memberContinuityCertificateToCarrierTerm(certificate);
    assert.deepEqual(codec.memberContinuityCertificateFromCarrierTerm(term), certificate);
    assert.deepEqual(codec.memberContinuityClaimFromCarrierTerm(codec.memberContinuityClaimToCarrierTerm(claim)), claim);
    const reversed = structuredClone(term);
    assert.equal(reversed[0], "map");
    if (reversed[0] === "map")
        reversed[1].reverse();
    assert.deepEqual(codec.memberContinuityCertificateFromCarrierTerm(reversed), certificate, "canonical map pair input order is irrelevant");
    const rawClaim = codec.memberContinuityClaimToCarrierTerm(claim);
    assert.equal(rawClaim[0], "map");
    if (rawClaim[0] !== "map")
        return;
    const duplicate = structuredClone(rawClaim);
    duplicate[1][1] = structuredClone(duplicate[1][0]);
    assert.equal(codec.memberContinuityClaimFromCarrierTerm(duplicate), null);
    for (const [field, value] of [["space", ["bin", "/w=="]], ["product", ["bin", Buffer.from("treehouse").toString("base64")]],
        ["old_pub", ["bin", Buffer.alloc(31).toString("base64")]], ["epoch", ["int", "9007199254740992"]],
        ["epoch", ["int", "00"]], ["deps", ["tuple", []]]]) {
        const bad = structuredClone(rawClaim);
        bad[1].find(([key]) => JSON.stringify(key) === JSON.stringify(["atom", field]))[1] = value;
        assert.equal(codec.memberContinuityClaimFromCarrierTerm(bad), null, field);
    }
    const challenge = { version: 1, product: "treehouse", space: claim.space, oldPub: claim.oldPub,
        heads: [id("claim")], deps: claim.deps, reviewer: claim.newPub, nonce: claim.nonce };
    assert.deepEqual(codec.memberKeyReturnChallengeFromCarrierTerm(codec.memberKeyReturnChallengeToCarrierTerm(challenge)), challenge);
    const args = codec.memberContinuityCommandArgumentsToCarrierTerm(certificate);
    assert.equal(args[0], "list");
    assert.equal(args[0] === "list" && args[1].length, 3);
});
test("the narrow decoded-argument adapter consumes real signed carrier decode and refuses metadata sentinels", async () => {
    const codec = await import("../src/index");
    const { authorCarrierOp } = await import("../src/codec");
    const { carrierOpsToSemanticOps } = await import("../src/carrier");
    const { claim, next, vouchers } = fixture();
    const possession = next.sign(codec.canonicalBytesForMemberContinuityPossession(claim));
    const certificate = { claim, possession, vouches: vouchers.map((v) => ({ member: v.pub,
            signature: v.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession)) })) };
    const args = codec.memberContinuityCommandArgumentsToCarrierTerm(certificate);
    let captured;
    let decoded = [];
    const decoders = new Map([["attest_member_key_v1", { arity: 3, decode: (values) => {
                    decoded = values;
                    captured = codec.memberContinuityCertificateFromDecodedArguments(values);
                    return { field: "admin_actions", mutation: "write", value: "attest_member_key_v1", command: "attest_member_key_v1" };
                } }]]);
    const frame = await authorCarrierOp({ replica: claim.space, deps: claim.deps, kind: "command", cap: ["nil"],
        signer: { publicKey: Buffer.from(next.pub, "base64"), sign: (bytes) => Buffer.from(next.sign(bytes), "base64") },
        body: ["tuple", [["atom", "attest_member_key_v1"], args]] });
    carrierOpsToSemanticOps([frame], {}, decoders);
    assert.deepEqual(captured, certificate);
    for (const position of [0, 1, 2]) {
        const invalid = structuredClone(decoded);
        invalid[position] = { type: "invalid_beacon_integer" };
        assert.equal(codec.memberContinuityCertificateFromDecodedArguments(invalid), null);
    }
    const bad = structuredClone(decoded);
    assert.ok(bad[0] !== null && typeof bad[0] === "object" && bad[0].type === "map");
    if (bad[0]?.type === "map")
        bad[0].pairs[1] = structuredClone(bad[0].pairs[0]);
    assert.equal(codec.memberContinuityCertificateFromDecodedArguments(bad), null);
    assert.equal(codec.memberContinuityCertificateFromDecodedArguments([...decoded, null]), null);
});
test("detached return accepts the largest v1 challenge below64000 and refuses its next genuinely signed size", async () => {
    const codec = await import("../src/index");
    const { canonicalBytesForCarrierTerm } = await import("../src/codec");
    const { claim, old } = fixture();
    // The exact ASCII Space has fixed width. All other scalars are fixed width.
    // Near the bound, list headers are fixed and each head/dependency adds45 bytes:
    // bytes+signature =450+45*(deps+heads). Valid v1 cannot equal64000 exactly.
    for (const heads of [1, 16]) {
        const challenge = { version: 1, product: "treehouse", space: claim.space, oldPub: old.pub,
            reviewer: claim.newPub, nonce: claim.nonce, heads: Array.from({ length: heads }, (_, i) => id(`return-head-${i}`)).sort(),
            deps: Array.from({ length: 1412 - heads }, (_, i) => id(`return-dep-${i}`)).sort() };
        const payload = codec.canonicalBytesForMemberContinuityReturn(challenge);
        assert.equal(payload.length + 64, 63_990);
        assert.equal(codec.verifyMemberKeyReturn(challenge, old.sign(payload), challenge), true);
        const oversized = { ...challenge, deps: [...challenge.deps, id("one-more-dep")].sort() };
        const term = codec.memberKeyReturnChallengeToCarrierTerm(challenge);
        assert.equal(term[0], "map");
        if (term[0] !== "map")
            return;
        term[1].find(([key]) => key[0] === "atom" && key[1] === "deps")[1] = ["list", oversized.deps.map((value) => ["bin", Buffer.from(value).toString("base64")])];
        const bytes = canonicalBytesForCarrierTerm(["list", [["bin", Buffer.from("treehouse-member-key-return-v1").toString("base64")], term]]);
        assert.equal(bytes.length + 64, 64_035);
        assert.equal(codec.normalizeMemberKeyReturnChallenge(oversized), null);
        assert.equal(codec.verifyMemberKeyReturn(oversized, old.sign(bytes), oversized), false);
        assert.throws(() => codec.canonicalBytesForMemberContinuityReturn(oversized), TypeError);
    }
});
test("every closed claim field is bound and scalar/array ambiguities never normalize into consent", async () => {
    const codec = await import("../src/index");
    const { claim, next, vouchers } = fixture();
    const possession = next.sign(codec.canonicalBytesForMemberContinuityPossession(claim));
    const certificate = { claim, possession, vouches: vouchers.map((v) => ({ member: v.pub,
            signature: v.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession)) })) };
    const values = { version: 2, product: "other", space: claim.space.replace(id("space"), id("other-space")),
        oldPub: key("other-old").pub, newPub: key("other-new").pub, oldAdmission: id("other-admission"), oldMembership: "removed",
        nonce: Buffer.alloc(32, 3).toString("base64"), deps: [id("other-dep")], epoch: 1, epochBasis: [id("other-beacon")], parents: [id("parent")],
        vouchers: claim.vouchers.map((v) => ({ ...v, admission: id(v.admission) })) };
    for (const [field, value] of Object.entries(values)) {
        const altered = { ...claim, [field]: value };
        assert.equal(codec.verifyMemberContinuityCertificate(certificate, altered), false, field);
        assert.equal(codec.verifyMemberContinuityCertificate({ ...certificate, claim: altered }, claim), false, field);
    }
    const extra = Object.defineProperty({ ...claim }, "hidden", { value: true });
    const accessor = Object.defineProperty({ ...claim }, "oldPub", { get() { throw new Error("getter must never execute"); } });
    for (const value of [extra, accessor, { ...claim, [Symbol("extra")]: true }, { ...claim, oldPub: claim.oldPub.slice(0, -1) },
        { ...claim, oldPub: claim.oldPub + "\n" }, { ...claim, space: claim.space + "\n" }, { ...claim, space: claim.space + "\uFEFF" },
        { ...claim, space: claim.space.replace(id("space"), `${id("space")}A`) }, { ...claim, space: claim.space.replace(id("space"), "é".repeat(43)) },
        { ...claim, oldAdmission: "A".repeat(42) + "B" }, { ...claim, epoch: NaN }, { ...claim, epoch: Infinity }, { ...claim, epoch: -1 },
        { ...claim, vouchers: [{ ...claim.vouchers[0], extra: true }, claim.vouchers[1]] }, { ...claim, vouchers: [claim.vouchers[0], claim.vouchers[0]] }]) {
        assert.equal(codec.normalizeMemberContinuityClaim(value), null);
    }
    const parents = Array.from({ length: 16 }, (_, i) => id(`parent-${i}`)).sort();
    assert.ok(codec.normalizeMemberContinuityClaim({ ...claim, parents, epoch: Number.MAX_SAFE_INTEGER, oldMembership: "removed" }));
});
test("nested voucher and signature maps remain closed and byte order is unsigned key order", async () => {
    const codec = await import("../src/index");
    const { claim, next, vouchers } = fixture();
    const possession = next.sign(codec.canonicalBytesForMemberContinuityPossession(claim));
    const certificate = { claim, possession, vouches: vouchers.map((v) => ({ member: v.pub,
            signature: v.sign(codec.canonicalBytesForMemberContinuityVouch(claim, possession)) })) };
    const low = Buffer.alloc(32).toString("base64"), high = Buffer.alloc(32, 208).toString("base64");
    assert.ok(high < low, "Base64 character order differs from the public byte order in this control");
    const rawOrdered = { ...claim, vouchers: [{ member: low, admission: id("zero-member") }, { member: high, admission: id("high-member") }] };
    assert.ok(codec.normalizeMemberContinuityClaim(rawOrdered));
    assert.equal(codec.normalizeMemberContinuityClaim({ ...rawOrdered, vouchers: [...rawOrdered.vouchers].reverse() }), null);
    const term = codec.memberContinuityCertificateToCarrierTerm(certificate);
    for (const target of ["claim-voucher", "vouch"]) {
        const copy = structuredClone(term);
        const fields = new Map(copy[1].map(([key, value]) => [key[1], value]));
        const entries = target === "vouch" ? fields.get("vouches") :
            new Map(fields.get("claim")[1].map(([key, value]) => [key[1], value])).get("vouchers");
        entries[1][0][1][1] = structuredClone(entries[1][0][1][0]);
        assert.equal(codec.memberContinuityCertificateFromCarrierTerm(copy), null, target);
    }
    for (const malformed of [{ ...certificate, possession: possession.slice(0, -1) },
        { ...certificate, vouches: [{ ...certificate.vouches[0], extra: true }, certificate.vouches[1]] },
        { ...certificate, vouches: [certificate.vouches[0], { ...certificate.vouches[1], member: claim.oldPub }] },
        { ...certificate, vouches: [certificate.vouches[0], { ...certificate.vouches[1], signature: "AA==" }] }]) {
        assert.equal(codec.normalizeMemberContinuityCertificate(malformed), null);
    }
});
for (const producer of ["beam", "ts"])
    test(`${producer} independently signed fixture verifies all four purposes and remains ungranted under its historical ceiling`, async () => {
        const { readFile } = await import("node:fs/promises");
        const { verifyMemberContinuityVector } = await import("./support/export_member_continuity");
        const vector = JSON.parse(await readFile(new URL(`./vectors/member_continuity/${producer}_codec.json`, import.meta.url), "utf8"));
        assert.equal(vector.producer, producer === "ts" ? "typescript" : "beam");
        await verifyMemberContinuityVector(vector);
    });
