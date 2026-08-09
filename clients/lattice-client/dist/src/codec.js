export const canonicalSuite = "lattice-cbor-v1";
const textEncoder = new TextEncoder();
const uint64Max = 18446744073709551615n;
const atomTag = 60_000;
const tupleTag = 60_001;
const mapsetTag = 60_002;
const delegationTermTag = 60_003;
const opTag = "lattice-op-v2";
const delegationPayloadTag = "lattice-delegation-v2";
const delegationV3PayloadTag = "lattice-delegation-v3";
const witnessedRecoveryPolicyDomain = "lattice-recovery-policy-v1";
const witnessedSuccessionClaimDomain = "lattice-succession-witness-v1";
const witnessedSuccessionArtifactDomain = "lattice-succession-witness-artifact-v1";
/**
 * Encode the signed/hashable core of a BEAM carrier op frame using the same
 * narrow CBOR-shaped subset as `Lattice.Canonical.op_payload/1`.
 */
export function canonicalBytesForCarrierOp(frame) {
    return encodeArray([
        encodeBinaryString(opTag),
        encodeBinaryString(frame.replica),
        encodeBytes(base64ToBytes(frame.author)),
        encodeArray(uniqueSorted(frame.deps).map(encodeBinaryString)),
        encodeAtom(frame.kind),
        encodeCarrierTerm(frame.body),
        encodeCarrierTerm(frame.cap),
    ]);
}
/** Hash canonical signed bytes to the Lattice op id format. */
export async function canonicalHash(bytes) {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle)
        throw new Error("crypto.subtle unavailable");
    const digestInput = new Uint8Array(bytes);
    const digest = new Uint8Array(await subtle.digest("SHA-256", digestInput));
    return bytesToBase64Url(digest);
}
export async function verifyCarrierOpHash(frame) {
    return (await canonicalHash(canonicalBytesForCarrierOp(frame))) === frame.id;
}
export async function verifyCarrierOp(frame, verifier) {
    const canonicalBytes = canonicalBytesForCarrierOp(frame);
    const hash = (await canonicalHash(canonicalBytes)) === frame.id;
    const signature = await verifier.verify(frame.author, canonicalBytes, base64ToBytes(frame.sig));
    return { hash, signature, valid: hash && signature };
}
export async function authorCarrierOp(input) {
    const unsignedFrame = {
        v: 1,
        id: "",
        replica: input.replica,
        author: bytesToBase64(input.signer.publicKey),
        deps: uniqueSorted(input.deps),
        kind: input.kind,
        body: input.body,
        cap: input.cap,
        sig: "",
    };
    const canonicalBytes = canonicalBytesForCarrierOp(unsignedFrame);
    const id = await canonicalHash(canonicalBytes);
    const signature = await input.signer.sign(canonicalBytes);
    return {
        ...unsignedFrame,
        id,
        sig: bytesToBase64(signature),
    };
}
export function canonicalBytesForCarrierDelegation(delegation) {
    const expiresEpoch = delegation.expires_epoch;
    const leased = expiresEpoch !== undefined && expiresEpoch !== null;
    const shared = [
        encodeBinaryString(delegation.replica),
        encodeBytes(base64ToBytes(delegation.issuer)),
        encodeBytes(base64ToBytes(delegation.audience)),
        delegation.parent_id === null ? bytes(0xf6) : encodeBinaryString(delegation.parent_id),
        encodeArray(uniqueSorted(delegation.ops).map(encodeAtom)),
        encodeArray(uniqueSorted(delegation.roles).map(encodeAtom)),
        bytes(delegation.live ? 0xf5 : 0xf4),
    ];
    // Plan 149: unleased delegations keep the v2 bytes verbatim; a lease selects
    // the v3 tag with the epoch as the final element — mirroring
    // Lattice.Canonical.delegation_bytes/8.
    if (!leased) {
        return encodeArray([encodeBinaryString(delegationPayloadTag), ...shared]);
    }
    return encodeArray([
        encodeBinaryString(delegationV3PayloadTag),
        ...shared,
        encodeUint(expiresEpoch),
    ]);
}
/** Canonical policy-id preimage shared with `Lattice.Authority.SuccessionCertificate`. */
export function canonicalBytesForWitnessedRecoveryPolicy(policy) {
    const witnesses = policy.witnesses.map(canonicalEvidenceBytes).sort(compareBytes);
    return encodeArray([
        encodeBinaryString(witnessedRecoveryPolicyDomain),
        encodeCanonicalMap([
            ["mode", encodeAtom("witnessed")],
            ["version", encodeUint(policy.version)],
            ["witnesses", encodeArray(witnesses.map(encodeBytes))],
            ["threshold", encodeUint(policy.threshold)],
        ]),
    ]);
}
/** Canonical witness-signature payload shared with the BEAM certificate verifier. */
export function canonicalBytesForWitnessedSuccessionClaim(claim) {
    return encodeArray([
        encodeBinaryString(witnessedSuccessionClaimDomain),
        encodeCanonicalMap([
            ["version", encodeUint(claim.version)],
            ["replica", encodeBinaryString(claim.replica)],
            ["role", encodeAtom(claim.role)],
            ["holder", encodeBytes(canonicalEvidenceBytes(claim.holder))],
            ["holder_epoch", encodeBinaryString(claim.holderEpoch)],
            ["successor", encodeBytes(canonicalEvidenceBytes(claim.successor))],
            ["policy_id", encodeBinaryString(claim.policyId)],
        ]),
    ]);
}
/** Canonical storage-locator preimage for one public succession witness artifact. */
export function canonicalBytesForWitnessedSuccessionArtifactId(claim, witness) {
    return encodeArray([
        encodeBinaryString(witnessedSuccessionArtifactDomain),
        encodeBytes(canonicalBytesForWitnessedSuccessionClaim(claim)),
        encodeBytes(canonicalEvidenceBytes(witness)),
    ]);
}
export async function authorCarrierDelegation(input) {
    const unsignedDelegation = {
        replica: input.replica,
        issuer: bytesToBase64(input.signer.publicKey),
        audience: pubkeyBase64(input.audiencePubkey),
        parent_id: input.parentId ?? null,
        ops: uniqueSorted(input.ops ?? []),
        roles: uniqueSorted(input.roles ?? []),
        live: input.live ?? false,
    };
    const canonicalBytes = canonicalBytesForCarrierDelegation(unsignedDelegation);
    const id = await canonicalHash(canonicalBytes);
    const signature = await input.signer.sign(canonicalBytes);
    return {
        ...unsignedDelegation,
        ops: [...unsignedDelegation.ops],
        roles: [...unsignedDelegation.roles],
        id,
        sig: bytesToBase64(signature),
    };
}
function encodeCarrierTerm(term) {
    const [tag] = term;
    switch (tag) {
        case "nil":
            return bytes(0xf6);
        case "bool":
            return bytes(term[1] ? 0xf5 : 0xf4);
        case "int":
            return encodeUint(term[1]);
        case "bin":
            return encodeBytes(base64ToBytes(term[1]));
        case "atom":
            return encodeAtom(term[1]);
        case "list":
            return encodeArray(term[1].map(encodeCarrierTerm));
        case "tuple":
            return encodeTagged(tupleTag, encodeArray(term[1].map(encodeCarrierTerm)));
        case "map":
            return encodeMap(term[1]);
        case "mapset":
            return encodeTagged(mapsetTag, encodeArray(term[1].map(encodeCarrierTerm).sort(compareBytes)));
        case "delegation":
            return encodeDelegation(term[1]);
    }
}
function encodeDelegation(delegation) {
    const fields = [
        encodeBinaryString(delegation.id),
        encodeBinaryString(delegation.replica),
        encodeBytes(base64ToBytes(delegation.issuer)),
        encodeBytes(base64ToBytes(delegation.audience)),
        delegation.parent_id === null ? bytes(0xf6) : encodeBinaryString(delegation.parent_id),
        encodeArray(uniqueSorted(delegation.ops).map(encodeAtom)),
        encodeArray(uniqueSorted(delegation.roles).map(encodeAtom)),
        bytes(delegation.live ? 0xf5 : 0xf4),
        encodeBytes(base64ToBytes(delegation.sig)),
    ];
    if (delegation.expires_epoch !== undefined && delegation.expires_epoch !== null) {
        fields.push(encodeUint(delegation.expires_epoch));
    }
    return encodeTagged(delegationTermTag, encodeArray(fields));
}
function encodeMap(pairs) {
    const encoded = pairs
        .map(([key, value]) => [encodeCarrierTerm(key), encodeCarrierTerm(value)])
        .sort(([left], [right]) => compareBytes(left, right));
    return concat(major(5, BigInt(encoded.length)), ...encoded.flatMap(([key, value]) => [key, value]));
}
function encodeCanonicalMap(pairs) {
    const encoded = pairs
        .map(([key, value]) => [encodeAtom(key), value])
        .sort(([left], [right]) => compareBytes(left, right));
    return concat(major(5, BigInt(encoded.length)), ...encoded.flatMap(([key, value]) => [key, value]));
}
function encodeTagged(tag, encodedValue) {
    return concat(major(6, BigInt(tag)), encodedValue);
}
function encodeArray(elements) {
    return concat(major(4, BigInt(elements.length)), ...elements);
}
function encodeAtom(value) {
    return encodeTagged(atomTag, encodeBinaryString(value));
}
function encodeBinaryString(value) {
    return encodeBytes(textEncoder.encode(value));
}
function encodeBytes(value) {
    return concat(major(2, BigInt(value.length)), value);
}
function encodeUint(value) {
    const parsed = parseUint(value);
    return major(0, parsed);
}
function parseUint(value) {
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0) {
            throw new Error(`unsupported canonical integer: ${value}`);
        }
        return BigInt(value);
    }
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
        throw new Error(`unsupported canonical integer: ${value}`);
    }
    return BigInt(value);
}
function major(majorType, n) {
    if (n < 0n || n > uint64Max)
        throw new Error(`unsupported canonical integer: ${n}`);
    if (n < 24n)
        return bytes((majorType << 5) | Number(n));
    if (n < 256n)
        return bytes((majorType << 5) | 24, Number(n));
    if (n < 65536n)
        return bytes((majorType << 5) | 25, Number(n >> 8n), Number(n & 0xffn));
    if (n < 4294967296n) {
        return bytes((majorType << 5) | 26, Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn));
    }
    return bytes((majorType << 5) | 27, Number((n >> 56n) & 0xffn), Number((n >> 48n) & 0xffn), Number((n >> 40n) & 0xffn), Number((n >> 32n) & 0xffn), Number((n >> 24n) & 0xffn), Number((n >> 16n) & 0xffn), Number((n >> 8n) & 0xffn), Number(n & 0xffn));
}
function compareBytes(left, right) {
    const length = Math.min(left.length, right.length);
    for (let i = 0; i < length; i++) {
        const diff = left[i] - right[i];
        if (diff !== 0)
            return diff;
    }
    return left.length - right.length;
}
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
function concat(...chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}
function base64ToBytes(value) {
    if (typeof Buffer !== "undefined")
        return new Uint8Array(Buffer.from(value, "base64"));
    const atobFn = globalThis.atob;
    if (!atobFn)
        throw new Error("base64 decoding unavailable");
    return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}
function canonicalEvidenceBytes(value) {
    const decoded = base64ToBytes(value);
    if (bytesToBase64(decoded) !== value)
        throw new Error("non-canonical base64 evidence");
    return decoded;
}
function bytesToBase64Url(value) {
    return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function bytesToBase64(value) {
    if (typeof Buffer !== "undefined")
        return Buffer.from(value).toString("base64");
    const btoaFn = globalThis.btoa;
    if (!btoaFn)
        throw new Error("base64 encoding unavailable");
    return btoaFn(String.fromCharCode(...value));
}
function pubkeyBase64(value) {
    return typeof value === "string" ? value : bytesToBase64(value);
}
function bytes(...values) {
    return new Uint8Array(values);
}
/**
 * Placeholder for semantic op authoring. Carrier-frame canonical byte/hash
 * parity exists above, but this interface cannot honestly encode a reducer-level
 * `OpCore` until it also carries the real Lattice body/cap term and signer flow.
 */
export const UnavailableCodec = {
    encode() {
        throw new Error("semantic op authoring unavailable: build the real Lattice body/cap term and signer flow before using OpCore.");
    },
    async hash() {
        throw new Error("semantic op hashing unavailable for OpCore; use canonicalHash over canonical bytes.");
    },
};
