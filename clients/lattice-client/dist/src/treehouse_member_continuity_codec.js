import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBase64Bytes, canonicalBytesForCarrierTerm } from "./codec";
const claimFields = ["version", "product", "space", "oldPub", "newPub", "oldAdmission", "oldMembership", "nonce", "deps", "epoch", "epochBasis", "parents", "vouchers"];
/** Shape only: an independent authenticated history review must derive every contextual field. */
export function normalizeMemberContinuityClaim(value) {
    try {
        if (!closed(value, claimFields) || value.version !== 1 || value.product !== "treehouse" || !space(value.space) ||
            !bytes(value.oldPub, 32) || !bytes(value.newPub, 32) || value.oldPub === value.newPub || !digest(value.oldAdmission) ||
            value.oldMembership !== "active" && value.oldMembership !== "removed" || !bytes(value.nonce, 32) ||
            !ids(value.deps, 1) || !ids(value.epochBasis, 1) || !ids(value.parents, 0, 16) || !epoch(value.epoch) ||
            !Array.isArray(value.vouchers) || value.vouchers.length !== 2)
            return null;
        const vouchers = [];
        for (const item of value.vouchers) {
            if (!closed(item, ["member", "admission"]) || !bytes(item.member, 32) || !digest(item.admission) ||
                item.member === value.oldPub || item.member === value.newPub ||
                vouchers.length > 0 && compareKeys(vouchers[0].member, item.member) >= 0)
                return null;
            vouchers.push({ member: item.member, admission: item.admission });
        }
        return { version: 1, product: "treehouse", space: value.space, oldPub: value.oldPub, newPub: value.newPub,
            oldAdmission: value.oldAdmission, oldMembership: value.oldMembership, nonce: value.nonce,
            deps: [...value.deps], epoch: value.epoch, epochBasis: [...value.epochBasis], parents: [...value.parents], vouchers };
    }
    catch {
        return null;
    }
}
function closed(value, fields) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    const keys = Reflect.ownKeys(value);
    return keys.length === fields.length && keys.every((key) => typeof key === "string" && fields.includes(key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}
function bytes(value, length) { return canonicalBase64Bytes(value, length) !== null; }
function digest(value) {
    return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) &&
        bytes(value.replaceAll("-", "+").replaceAll("_", "/") + "=", 32);
}
function space(value) {
    if (typeof value !== "string")
        return false;
    const match = /^replica:treehouse:space:([A-Za-z0-9_-]{43})#authority:bounded-continuation-v1#root:([A-Za-z0-9_-]{43})$/.exec(value);
    return match !== null && digest(match[1]) && digest(match[2]);
}
function epoch(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function ids(value, minimum, maximum = Infinity) {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
        return false;
    for (let i = 0; i < value.length; i++)
        if (!digest(value[i]) || i > 0 && value[i - 1] >= value[i])
            return false;
    return true;
}
function compareKeys(a, b) {
    const left = canonicalBase64Bytes(a, 32), right = canonicalBase64Bytes(b, 32);
    for (let i = 0; i < 32; i++)
        if (left[i] !== right[i])
            return left[i] - right[i];
    return 0;
}
export function normalizeMemberContinuityCertificate(value) {
    try {
        if (!closed(value, ["claim", "possession", "vouches"]) || !bytes(value.possession, 64) ||
            !Array.isArray(value.vouches) || value.vouches.length !== 2)
            return null;
        const claim = normalizeMemberContinuityClaim(value.claim);
        if (claim === null)
            return null;
        const vouches = [];
        for (const [i, item] of value.vouches.entries()) {
            if (!closed(item, ["member", "signature"]) || item.member !== claim.vouchers[i].member || !bytes(item.signature, 64))
                return null;
            vouches.push({ member: claim.vouchers[i].member, signature: item.signature });
        }
        return { claim, possession: value.possession, vouches };
    }
    catch {
        return null;
    }
}
export function memberContinuityClaimToCarrierTerm(value) {
    const claim = normalizeMemberContinuityClaim(value);
    if (claim === null)
        return null;
    return map({ version: integer(claim.version), product: atom(claim.product), space: text(claim.space),
        old_pub: binary(claim.oldPub), new_pub: binary(claim.newPub), old_admission: text(claim.oldAdmission),
        old_membership: atom(claim.oldMembership), nonce: binary(claim.nonce), deps: list(claim.deps.map(text)),
        epoch: integer(claim.epoch), epoch_basis: list(claim.epochBasis.map(text)), parents: list(claim.parents.map(text)),
        vouchers: list(claim.vouchers.map((v) => map({ member: binary(v.member), admission: text(v.admission) }))) });
}
export function canonicalBytesForMemberContinuityClaim(value) {
    return claimPurpose("treehouse-member-key-claim-v1", value);
}
export function canonicalBytesForMemberContinuityPossession(value) {
    return claimPurpose("treehouse-member-key-possession-v1", value);
}
export function canonicalBytesForMemberContinuityVouch(value, possession) {
    const claim = memberContinuityClaimToCarrierTerm(value);
    if (claim === null || !bytes(possession, 64))
        throw new TypeError("malformed member continuity certificate");
    return canonicalBytesForCarrierTerm(list([text("treehouse-member-key-vouch-v1"), claim, binary(possession)]));
}
export function memberContinuityClaimId(value) {
    if (normalizeMemberContinuityClaim(value) === null)
        return null;
    return base64(sha256(canonicalBytesForMemberContinuityClaim(value))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
/** Consent verification only. Membership, causal position and permission remain independent. */
export function verifyMemberContinuityCertificate(value, expected) {
    try {
        const certificate = normalizeMemberContinuityCertificate(value), claim = normalizeMemberContinuityClaim(expected);
        if (certificate === null || claim === null || !equal(canonicalBytesForMemberContinuityClaim(certificate.claim), canonicalBytesForMemberContinuityClaim(claim)))
            return false;
        if (!ed25519.verify(canonicalBase64Bytes(certificate.possession, 64), canonicalBytesForMemberContinuityPossession(claim), canonicalBase64Bytes(claim.newPub, 32), { zip215: false }))
            return false;
        const payload = canonicalBytesForMemberContinuityVouch(claim, certificate.possession);
        return certificate.vouches.every((v) => ed25519.verify(canonicalBase64Bytes(v.signature, 64), payload, canonicalBase64Bytes(v.member, 32), { zip215: false }));
    }
    catch {
        return false;
    }
}
function claimPurpose(domain, value) {
    const claim = memberContinuityClaimToCarrierTerm(value);
    if (claim === null)
        throw new TypeError("malformed member continuity claim");
    return canonicalBytesForCarrierTerm(list([text(domain), claim]));
}
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
function atom(value) { return ["atom", value]; }
function integer(value) { return ["int", value]; }
function binary(value) { return ["bin", value]; }
function text(value) { return binary(base64(encoder.encode(value))); }
function list(value) { return ["list", value]; }
function map(fields) { return ["map", Object.entries(fields).map(([key, value]) => [atom(key), value])]; }
function equal(a, b) { return a.length === b.length && a.every((value, i) => value === b[i]); }
function base64(value) {
    if (typeof Buffer !== "undefined")
        return Buffer.from(value).toString("base64");
    const encode = globalThis.btoa;
    if (encode === undefined)
        throw new Error("Base64 encoding unavailable");
    return encode(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
}
const returnFields = ["version", "product", "space", "oldPub", "heads", "deps", "reviewer", "nonce"];
export function normalizeMemberKeyReturnChallenge(value) {
    try {
        if (!closed(value, returnFields) || value.version !== 1 || value.product !== "treehouse" || !space(value.space) ||
            !bytes(value.oldPub, 32) || !ids(value.heads, 1, 16) || !ids(value.deps, 1) || !bytes(value.reviewer, 32) || !bytes(value.nonce, 32))
            return null;
        const challenge = { version: 1, product: "treehouse", space: value.space, oldPub: value.oldPub,
            heads: [...value.heads], deps: [...value.deps], reviewer: value.reviewer, nonce: value.nonce };
        return returnPayload(challenge).length + 64 <= 64_000 ? challenge : null;
    }
    catch {
        return null;
    }
}
export function memberKeyReturnChallengeToCarrierTerm(value) {
    const challenge = normalizeMemberKeyReturnChallenge(value);
    return challenge === null ? null : returnTerm(challenge);
}
export function canonicalBytesForMemberContinuityReturn(value) {
    const challenge = normalizeMemberKeyReturnChallenge(value);
    if (challenge === null)
        throw new TypeError("malformed or oversized member key return challenge");
    return returnPayload(challenge);
}
/** Exact expected bytes and old-key proof only; no freshness, consumption or authorization claim. */
export function verifyMemberKeyReturn(value, signature, expected) {
    try {
        const challenge = normalizeMemberKeyReturnChallenge(value), checked = normalizeMemberKeyReturnChallenge(expected);
        if (challenge === null || checked === null || !bytes(signature, 64))
            return false;
        const payload = returnPayload(challenge);
        return equal(payload, returnPayload(checked)) && ed25519.verify(canonicalBase64Bytes(signature, 64), payload, canonicalBase64Bytes(challenge.oldPub, 32), { zip215: false });
    }
    catch {
        return false;
    }
}
function returnTerm(value) {
    return map({ version: integer(value.version), product: atom(value.product), space: text(value.space), old_pub: binary(value.oldPub),
        heads: list(value.heads.map(text)), deps: list(value.deps.map(text)), reviewer: binary(value.reviewer), nonce: binary(value.nonce) });
}
function returnPayload(value) {
    return canonicalBytesForCarrierTerm(list([text("treehouse-member-key-return-v1"), returnTerm(value)]));
}
const wireClaimFields = ["version", "product", "space", "old_pub", "new_pub", "old_admission", "old_membership", "nonce", "deps", "epoch", "epoch_basis", "parents", "vouchers"];
const wireReturnFields = ["version", "product", "space", "old_pub", "heads", "deps", "reviewer", "nonce"];
const wireReader = {
    atom(value) { return tag(value, "atom") && typeof value[1] === "string" ? value[1] : null; },
    binary(value) { return tag(value, "bin") && canonicalBase64Bytes(value[1]) !== null ? value[1] : null; },
    integer(value) {
        if (!tag(value, "int"))
            return null;
        const raw = value[1];
        if (epoch(raw))
            return raw;
        if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw))
            return null;
        const number = Number(raw);
        return epoch(number) ? number : null;
    },
    list(value) { return tag(value, "list") && Array.isArray(value[1]) ? value[1] : null; },
    map(value, fields) { return tag(value, "map") ? pairs(value[1], fields, this) : null; },
};
const decodedReader = {
    atom(value) { return closed(value, ["type", "value"]) && value.type === "atom" && typeof value.value === "string" ? value.value : null; },
    binary(value) {
        return closed(value, ["type", "bytes", "text"]) && value.type === "bin" && value.bytes instanceof Uint8Array && typeof value.text === "string"
            ? base64(value.bytes) : null;
    },
    integer(value) { return epoch(value) ? value : null; },
    list(value) { return closed(value, ["type", "values"]) && value.type === "list" && Array.isArray(value.values) ? value.values : null; },
    map(value, fields) { return closed(value, ["type", "pairs"]) && value.type === "map" ? pairs(value.pairs, fields, this) : null; },
};
function readClaim(value, reader) {
    const c = reader.map(value, wireClaimFields);
    if (c === null)
        return null;
    return normalizeMemberContinuityClaim({ version: reader.integer(c.version), product: reader.atom(c.product), space: readText(c.space, reader),
        oldPub: reader.binary(c.old_pub), newPub: reader.binary(c.new_pub), oldAdmission: readText(c.old_admission, reader),
        oldMembership: reader.atom(c.old_membership), nonce: reader.binary(c.nonce), deps: readIds(c.deps, reader),
        epoch: reader.integer(c.epoch), epochBasis: readIds(c.epoch_basis, reader), parents: readIds(c.parents, reader),
        vouchers: reader.list(c.vouchers)?.map((value) => {
            const v = reader.map(value, ["member", "admission"]);
            return v === null ? null : { member: reader.binary(v.member), admission: readText(v.admission, reader) };
        }) });
}
function readCertificateArguments(args, reader) {
    if (args.length !== 3)
        return null;
    return normalizeMemberContinuityCertificate({ claim: readClaim(args[0], reader), possession: reader.binary(args[1]),
        vouches: reader.list(args[2])?.map((value) => {
            const v = reader.map(value, ["member", "signature"]);
            return v === null ? null : { member: reader.binary(v.member), signature: reader.binary(v.signature) };
        }) });
}
export function memberContinuityClaimFromCarrierTerm(value) {
    try {
        return readClaim(value, wireReader);
    }
    catch {
        return null;
    }
}
/** A valid claim remains target evidence even when its exact-three-argument certificate is malformed. */
export function memberContinuityClaimFromDecodedTerm(value) {
    try {
        return readClaim(value, decodedReader);
    }
    catch {
        return null;
    }
}
export function memberContinuityCertificateToCarrierTerm(value) {
    const certificate = normalizeMemberContinuityCertificate(value);
    if (certificate === null)
        return null;
    return map({ claim: memberContinuityClaimToCarrierTerm(certificate.claim), possession: binary(certificate.possession), vouches: vouchesTerm(certificate) });
}
export function memberContinuityCertificateFromCarrierTerm(value) {
    try {
        const fields = wireReader.map(value, ["claim", "possession", "vouches"]);
        return fields === null ? null : readCertificateArguments([fields.claim, fields.possession, fields.vouches], wireReader);
    }
    catch {
        return null;
    }
}
/** Three exact argument terms only; this neither registers a command nor signs an outer operation. */
export function memberContinuityCommandArgumentsToCarrierTerm(value) {
    const certificate = normalizeMemberContinuityCertificate(value);
    return certificate === null ? null : list([memberContinuityClaimToCarrierTerm(certificate.claim), binary(certificate.possession), vouchesTerm(certificate)]);
}
/** Only the existing decoder's three command arguments; unsupported metadata stays invalid. */
export function memberContinuityCertificateFromDecodedArguments(value) {
    try {
        return Array.isArray(value) ? readCertificateArguments(value, decodedReader) : null;
    }
    catch {
        return null;
    }
}
export function memberKeyReturnChallengeFromCarrierTerm(value) {
    try {
        const fields = wireReader.map(value, wireReturnFields);
        return fields === null ? null : normalizeMemberKeyReturnChallenge({ version: wireReader.integer(fields.version), product: wireReader.atom(fields.product),
            space: readText(fields.space, wireReader), oldPub: wireReader.binary(fields.old_pub), heads: readIds(fields.heads, wireReader),
            deps: readIds(fields.deps, wireReader), reviewer: wireReader.binary(fields.reviewer), nonce: wireReader.binary(fields.nonce) });
    }
    catch {
        return null;
    }
}
function vouchesTerm(value) {
    return list(value.vouches.map((v) => map({ member: binary(v.member), signature: binary(v.signature) })));
}
function tag(value, name) { return Array.isArray(value) && value.length === 2 && value[0] === name; }
function pairs(value, fields, reader) {
    if (!Array.isArray(value) || value.length !== fields.length)
        return null;
    const found = Object.create(null);
    for (const item of value) {
        if (!Array.isArray(item) || item.length !== 2)
            return null;
        const name = reader.atom(item[0]);
        if (name === null || !fields.includes(name) || Object.hasOwn(found, name))
            return null;
        found[name] = item[1];
    }
    return found;
}
function readText(value, reader) {
    const encoded = reader.binary(value);
    if (encoded === null)
        return null;
    try {
        return decoder.decode(canonicalBase64Bytes(encoded));
    }
    catch {
        return null;
    }
}
function readIds(value, reader) { return reader.list(value)?.map((item) => readText(item, reader)); }
