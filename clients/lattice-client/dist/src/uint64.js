// Check the lexical bound before any BigInt conversion. Representation/admission
// rules (for example safe JSON numbers versus high decimal text) stay with readers.
const MAX_UINT64_TEXT = "18446744073709551615";
export function canonicalUint64Text(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 20 &&
        !/[^0-9]/.test(value) && (value.length === 1 || value[0] !== "0") &&
        (value.length < 20 || value <= MAX_UINT64_TEXT);
}
export function canonicalUint64Scalar(value) {
    return typeof value === "number" ? Number.isSafeInteger(value) && value >= 0 : canonicalUint64Text(value);
}
export function parseCanonicalUint64(value) {
    if (!canonicalUint64Scalar(value))
        throw new Error("unsupported canonical integer");
    return BigInt(value);
}
export function canonicalHighUint64Text(value) {
    return canonicalUint64Text(value) && (value.length > 16 ||
        (value.length === 16 && value > "9007199254740991"));
}
/** Complete portable wire admission: small values use JSON numbers. */
export function portableUint64Scalar(value) {
    return typeof value === "number" ? Number.isSafeInteger(value) && value >= 0 : canonicalHighUint64Text(value);
}
