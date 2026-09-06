import { canonicalBase64Bytes } from "./codec";
export function createTauriKeyValueStore(invoke, opts = {}) {
    const getCommand = opts.getCommand ?? "lattice_kv_get";
    const setCommand = opts.setCommand ?? "lattice_kv_set";
    return {
        getItem(key) {
            return invoke(getCommand, { key: storageKey(opts.namespace, key) });
        },
        async setItem(key, value) {
            await invoke(setCommand, { key: storageKey(opts.namespace, key), value });
        },
    };
}
export function createTauriCarrierSigner(invoke, opts) {
    const signCommand = opts.signCommand ?? "lattice_sign_carrier";
    const publicKey = typeof opts.publicKey === "string"
        ? canonicalBase64Bytes(opts.publicKey, 32)
        : opts.publicKey;
    if (publicKey === null || publicKey.length !== 32) {
        throw new Error("invalid canonical Ed25519 public key");
    }
    return {
        publicKey,
        async sign(bytes) {
            const signature = await invoke(signCommand, {
                keyId: opts.keyId,
                bytes: bytesToBase64(bytes),
            });
            if (typeof signature !== "string")
                throw new Error(`${signCommand} returned a non-string signature`);
            const decoded = canonicalBase64Bytes(signature, 64);
            if (decoded === null)
                throw new Error("invalid canonical Ed25519 signature");
            return decoded;
        },
    };
}
export async function createTauriNativeCarrierSigner(invoke, opts) {
    const publicKeyCommand = opts.publicKeyCommand ?? "lattice_ensure_carrier_key";
    const publicKey = await invoke(publicKeyCommand, { keyId: opts.keyId });
    if (typeof publicKey !== "string")
        throw new Error(`${publicKeyCommand} returned a non-string public key`);
    const signerOpts = {
        keyId: opts.keyId,
        publicKey,
    };
    if (opts.signCommand !== undefined)
        signerOpts.signCommand = opts.signCommand;
    return createTauriCarrierSigner(invoke, signerOpts);
}
function storageKey(namespace, key) {
    return namespace === undefined || namespace === "" ? key : `${namespace}:${key}`;
}
function bytesToBase64(bytes) {
    if (typeof Buffer !== "undefined")
        return Buffer.from(bytes).toString("base64");
    const btoaFn = globalThis.btoa;
    if (!btoaFn)
        throw new Error("base64 encoding unavailable");
    return btoaFn(String.fromCharCode(...bytes));
}
