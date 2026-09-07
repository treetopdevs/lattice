import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBase64Bytes, canonicalBytesForCarrierTerm } from "./codec";
const profileDomain = "lattice-continuation-profile-v1";
const claimDomain = "lattice-continuation-witness-v1";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export function continuationProfileToCarrierTerm(value) {
    const profile = normalizeContinuationProfile(value);
    if (profile === null)
        return null;
    return atomMap({
        mode: atom(profile.mode), version: integer(profile.version), product: atom(profile.product),
        kind: atom(profile.kind), role: atom(profile.role), nominee: binary(profile.nominee),
        witnesses: ["list", profile.witnesses.map(binary)], threshold: integer(profile.threshold),
        max_lease_epochs: integer(profile.maxLeaseEpochs),
    });
}
export function continuationProfileFromCarrierTerm(value) {
    const fields = readAtomMap(value, [
        "mode", "version", "product", "kind", "role", "nominee", "witnesses", "threshold", "max_lease_epochs",
    ]);
    if (fields === null)
        return null;
    return normalizeContinuationProfile({
        mode: readAtom(fields.mode), version: readInteger(fields.version), product: readAtom(fields.product),
        kind: readAtom(fields.kind), role: readAtom(fields.role), nominee: readBinary(fields.nominee),
        witnesses: readList(fields.witnesses)?.map(readBinary), threshold: readInteger(fields.threshold),
        maxLeaseEpochs: readInteger(fields.max_lease_epochs),
    });
}
export function continuationClaimToCarrierTerm(value) {
    const claim = normalizeContinuationClaim(value);
    if (claim === null)
        return null;
    return atomMap({
        version: integer(claim.version), product: atom(claim.product), kind: atom(claim.kind),
        replica: text(claim.replica), role: atom(claim.role), profile_id: text(claim.profileId),
        profile_genesis: text(claim.profileGenesis), holder: binary(claim.holder),
        holder_epoch: text(claim.holderEpoch), successor: binary(claim.successor),
        delegation_id: text(claim.delegationId), author: binary(claim.author),
        deps: ["list", claim.deps.map(text)], epoch: integer(claim.epoch),
        epoch_basis: ["list", claim.epochBasis.map(text)],
    });
}
export function continuationClaimFromCarrierTerm(value) {
    const fields = readAtomMap(value, [
        "version", "product", "kind", "replica", "role", "profile_id", "profile_genesis", "holder",
        "holder_epoch", "successor", "delegation_id", "author", "deps", "epoch", "epoch_basis",
    ]);
    if (fields === null)
        return null;
    return normalizeContinuationClaim({
        version: readInteger(fields.version), product: readAtom(fields.product), kind: readAtom(fields.kind),
        replica: readText(fields.replica), role: readAtom(fields.role), profileId: readText(fields.profile_id),
        profileGenesis: readText(fields.profile_genesis), holder: readBinary(fields.holder),
        holderEpoch: readText(fields.holder_epoch), successor: readBinary(fields.successor),
        delegationId: readText(fields.delegation_id), author: readBinary(fields.author),
        deps: readList(fields.deps)?.map(readText), epoch: readInteger(fields.epoch),
        epochBasis: readList(fields.epoch_basis)?.map(readText),
    });
}
export function continuationCertificateToCarrierTerm(value) {
    const certificate = normalizeContinuationCertificate(value);
    if (certificate === null)
        return null;
    return atomMap({
        claim: continuationClaimToCarrierTerm(certificate.claim),
        signatures: ["list", certificate.signatures.map((entry) => atomMap({
                witness: binary(entry.witness), signature: binary(entry.signature),
            }))],
    });
}
export function continuationCertificateFromCarrierTerm(value) {
    const fields = readAtomMap(value, ["claim", "signatures"]);
    if (fields === null)
        return null;
    const entries = readList(fields.signatures);
    if (entries === null)
        return null;
    const signatures = [];
    for (const entry of entries) {
        const signature = readAtomMap(entry, ["witness", "signature"]);
        if (signature === null)
            return null;
        signatures.push({ witness: readBinary(signature.witness), signature: readBinary(signature.signature) });
    }
    return normalizeContinuationCertificate({ claim: continuationClaimFromCarrierTerm(fields.claim), signatures });
}
/** Domain-separated bytes from the existing canonical encoder; no independent codec. */
export function canonicalBytesForContinuationProfile(value) {
    const profile = continuationProfileToCarrierTerm(value);
    if (profile === null)
        throw new TypeError("malformed continuation profile");
    return canonicalBytesForCarrierTerm(["list", [text(profileDomain), profile]]);
}
export function canonicalBytesForContinuationClaim(value) {
    const claim = continuationClaimToCarrierTerm(value);
    if (claim === null)
        throw new TypeError("malformed continuation claim");
    return canonicalBytesForCarrierTerm(["list", [text(claimDomain), claim]]);
}
export function continuationProfileId(value) {
    if (normalizeContinuationProfile(value) === null)
        return null;
    return bytesToBase64(sha256(canonicalBytesForContinuationProfile(value)))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
/** Cryptographic consent only; the caller independently judges the causal authority history. */
export function verifyContinuationCertificate(certificate, expected, profile) {
    try {
        const normalized = normalizeContinuationCertificate(certificate);
        const expectedClaim = normalizeContinuationClaim(expected);
        const policy = normalizeContinuationProfile(profile);
        if (normalized === null || expectedClaim === null || policy === null ||
            normalized.claim.profileId !== continuationProfileId(policy) ||
            normalized.claim.product !== policy.product || normalized.claim.kind !== policy.kind ||
            normalized.claim.role !== policy.role || normalized.signatures.length < policy.threshold)
            return false;
        const payload = canonicalBytesForContinuationClaim(normalized.claim);
        if (!equalBytes(payload, canonicalBytesForContinuationClaim(expectedClaim)))
            return false;
        const allowed = new Set(policy.witnesses);
        let previous = null;
        for (const entry of normalized.signatures) {
            if (!allowed.has(entry.witness) || previous !== null && comparePublicKeys(previous, entry.witness) >= 0 ||
                !ed25519.verify(canonicalBase64Bytes(entry.signature, 64), payload, canonicalBase64Bytes(entry.witness, 32), { zip215: false }))
                return false;
            previous = entry.witness;
        }
        return true;
    }
    catch {
        return false;
    }
}
const claimKeys = [
    "version", "product", "kind", "replica", "role", "profileId", "profileGenesis",
    "holder", "holderEpoch", "successor", "delegationId", "author", "deps", "epoch", "epochBasis",
];
/** Shape validation only: authority must derive the expected claim from verified history. */
export function normalizeContinuationClaim(value) {
    if (!exactRecord(value, claimKeys) || value.version !== 1 || value.product !== "treehouse" ||
        !kindRoleMatch(value.kind, value.role) || !replicaText(value.replica) ||
        !digestId(value.profileId) || !digestId(value.profileGenesis) || !digestId(value.holderEpoch) ||
        !digestId(value.delegationId) || !publicKey(value.holder) || !publicKey(value.successor) ||
        !publicKey(value.author) || !sortedIds(value.deps) || !sortedIds(value.epochBasis) ||
        !integerIn(value.epoch, 0, Number.MAX_SAFE_INTEGER))
        return null;
    return {
        version: 1, product: "treehouse", kind: value.kind,
        replica: value.replica, role: value.role,
        profileId: value.profileId, profileGenesis: value.profileGenesis,
        holder: value.holder, holderEpoch: value.holderEpoch, successor: value.successor,
        delegationId: value.delegationId, author: value.author,
        deps: [...value.deps], epoch: value.epoch, epochBasis: [...value.epochBasis],
    };
}
/** Preserve signature order; quorum, order, membership and validity belong to verification. */
export function normalizeContinuationCertificate(value) {
    if (!exactRecord(value, ["claim", "signatures"]) || !Array.isArray(value.signatures))
        return null;
    const claim = normalizeContinuationClaim(value.claim);
    if (claim === null)
        return null;
    const signatures = [];
    for (const entry of value.signatures) {
        if (!exactRecord(entry, ["witness", "signature"]) || !publicKey(entry.witness) ||
            typeof entry.signature !== "string" || canonicalBase64Bytes(entry.signature, 64) === null)
            return null;
        signatures.push({ witness: entry.witness, signature: entry.signature });
    }
    return { claim, signatures };
}
const profileKeys = [
    "mode", "version", "product", "kind", "role", "nominee", "witnesses",
    "threshold", "maxLeaseEpochs",
];
/** Validate the closed profile and copy witnesses into unsigned byte order. */
export function normalizeContinuationProfile(value) {
    if (!exactRecord(value, profileKeys) ||
        value.mode !== "bounded_continuation" || value.version !== 1 || value.product !== "treehouse" ||
        !kindRoleMatch(value.kind, value.role) || !publicKey(value.nominee) ||
        !Array.isArray(value.witnesses) || value.witnesses.length === 0 ||
        !integerIn(value.threshold, 1, value.witnesses.length) ||
        !integerIn(value.maxLeaseEpochs, 1, 65_535))
        return null;
    const witnesses = [];
    for (const witness of value.witnesses) {
        if (!publicKey(witness) || witnesses.includes(witness))
            return null;
        witnesses.push(witness);
    }
    witnesses.sort(comparePublicKeys);
    return {
        mode: "bounded_continuation", version: 1, product: "treehouse",
        kind: value.kind,
        role: value.role,
        nominee: value.nominee, witnesses, threshold: value.threshold,
        maxLeaseEpochs: value.maxLeaseEpochs,
    };
}
function exactRecord(value, keys) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        return false;
    const actual = Reflect.ownKeys(value);
    return actual.length === keys.length && actual.every((key) => typeof key === "string" && keys.includes(key));
}
function kindRoleMatch(kind, role) {
    return kind === "space" && role === "admin" || kind === "thread" && role === "moderator";
}
function integerIn(value, minimum, maximum) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function publicKey(value) {
    return canonicalBase64Bytes(value, 32) !== null;
}
function replicaText(value) {
    return typeof value === "string" && value.length > 0 && textDecoder.decode(textEncoder.encode(value)) === value;
}
function digestId(value) {
    if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value))
        return false;
    return canonicalBase64Bytes(value.replaceAll("-", "+").replaceAll("_", "/") + "=", 32) !== null;
}
function sortedIds(value) {
    if (!Array.isArray(value))
        return false;
    let previous = null;
    for (const id of value) {
        if (!digestId(id) || previous !== null && previous >= id)
            return false;
        previous = id;
    }
    return true;
}
function comparePublicKeys(left, right) {
    const a = canonicalBase64Bytes(left, 32);
    const b = canonicalBase64Bytes(right, 32);
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i])
            return a[i] - b[i];
    }
    return 0;
}
function equalBytes(left, right) {
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function atom(value) { return ["atom", value]; }
function integer(value) { return ["int", value]; }
function binary(value) { return ["bin", value]; }
function text(value) { return binary(bytesToBase64(textEncoder.encode(value))); }
function atomMap(fields) {
    return ["map", Object.entries(fields).map(([key, value]) => [atom(key), value])];
}
function readAtomMap(value, keys) {
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== "map" || !Array.isArray(value[1]) ||
        value[1].length !== keys.length)
        return null;
    const fields = Object.create(null);
    for (const pair of value[1]) {
        if (!Array.isArray(pair) || pair.length !== 2)
            return null;
        const key = readAtom(pair[0]);
        if (key === null || !keys.includes(key) || Object.hasOwn(fields, key))
            return null;
        fields[key] = pair[1];
    }
    return fields;
}
function readAtom(value) {
    return Array.isArray(value) && value.length === 2 && value[0] === "atom" && typeof value[1] === "string"
        ? value[1] : null;
}
function readInteger(value) {
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== "int")
        return null;
    const raw = value[1];
    if (integerIn(raw, 0, Number.MAX_SAFE_INTEGER))
        return raw;
    if (typeof raw !== "string" || !/^(0|[1-9][0-9]*)$/.test(raw))
        return null;
    const parsed = Number(raw);
    return integerIn(parsed, 0, Number.MAX_SAFE_INTEGER) ? parsed : null;
}
function readBinary(value) {
    if (!Array.isArray(value) || value.length !== 2 || value[0] !== "bin" || typeof value[1] !== "string")
        return null;
    return canonicalBase64Bytes(value[1]) === null ? null : value[1];
}
function readText(value) {
    const encoded = readBinary(value);
    if (encoded === null)
        return null;
    try {
        return textDecoder.decode(canonicalBase64Bytes(encoded));
    }
    catch {
        return null;
    }
}
function readList(value) {
    return Array.isArray(value) && value.length === 2 && value[0] === "list" && Array.isArray(value[1])
        ? Array.from(value[1]) : null;
}
function bytesToBase64(value) {
    if (typeof Buffer !== "undefined")
        return Buffer.from(value).toString("base64");
    const encode = globalThis.btoa;
    if (!encode)
        throw new Error("base64 encoding unavailable");
    return encode(Array.from(value, (byte) => String.fromCharCode(byte)).join(""));
}
