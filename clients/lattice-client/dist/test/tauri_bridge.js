import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { authorAndPersistTownshipCommand, carrierOpsToSemanticOps, carrierTranscriptBytes, createJsonCarrierFrameStore, createJsonLocalOpLogStore, createTauriCarrierSigner, createTauriKeyValueStore, createTauriNativeCarrierSigner, signCarrierChallenge, } from "../src/index";
const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(readFileSync(join(here, "vectors", "township_carrier_w1.json"), "utf8"));
let failures = 0;
function check(name, got, want) {
    const ok = isDeepStrictEqual(got, want);
    if (!ok)
        failures++;
    const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${tag} ${name}`);
    if (!ok) {
        console.log(`       got : ${JSON.stringify(got)}`);
        console.log(`       want: ${JSON.stringify(want)}`);
    }
}
console.log(`\n▸ ${vector.scenario} Tauri bridge`);
const sessionIdentity = seededEd25519Identity(vector.client.sessionSeed);
const residentIdentity = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
const nativeKeys = new Map([
    ["session", sessionIdentity],
    ["resident", residentIdentity],
]);
const values = new Map();
const calls = [];
const invoke = async (command, args = {}) => {
    calls.push({ command, args });
    let result;
    switch (command) {
        case "lattice_kv_get": {
            result = values.get(String(args.key)) ?? null;
            break;
        }
        case "lattice_kv_set":
            values.set(String(args.key), String(args.value));
            result = null;
            break;
        case "lattice_ensure_carrier_key": {
            const key = nativeKeys.get(String(args.keyId));
            if (!key)
                throw new Error(`missing native key ${String(args.keyId)}`);
            result = key.publicKeyBase64;
            break;
        }
        case "lattice_sign_carrier": {
            const key = nativeKeys.get(String(args.keyId));
            if (!key)
                throw new Error(`missing native key ${String(args.keyId)}`);
            result = bytesBase64(key.sign(base64Bytes(String(args.bytes))));
            break;
        }
        default:
            throw new Error(`unexpected command ${command}`);
    }
    return result;
};
const challenge = {
    type: "carrier_challenge",
    local_realm: vector.client.realm,
    replica: vector.replica,
    nonce: "fixed-nonce",
    wire_version: 1,
};
const nativeSessionSigner = await createTauriNativeCarrierSigner(invoke, { keyId: "session" });
check("native signer public key", bytesBase64(nativeSessionSigner.publicKey), vector.client.sessionPubkey);
const nativeSigned = await signCarrierChallenge(challenge, nativeSessionSigner);
check("native signer challenge signature", nativeSigned.signature, "TS9+HPGiV88JMWJw0vm8euvAJEkmMLDxaKnTGz7wBX5vxLYi6wKRuFHLyHgxN3Igu2tFRjPaTIqq4p2RD5CDCg==");
const ensureCall = calls.find((call) => call.command === "lattice_ensure_carrier_key");
check("ensure key command key id", ensureCall?.args.keyId, "session");
const sessionSigner = createTauriCarrierSigner(invoke, {
    keyId: "session",
    publicKey: sessionIdentity.publicKeyBase64,
});
const signed = await signCarrierChallenge(challenge, sessionSigner);
check("async challenge signature", signed.signature, "TS9+HPGiV88JMWJw0vm8euvAJEkmMLDxaKnTGz7wBX5vxLYi6wKRuFHLyHgxN3Igu2tFRjPaTIqq4p2RD5CDCg==");
const signCall = calls.find((call) => call.command === "lattice_sign_carrier");
check("sign command key id", signCall?.args.keyId, "session");
check("sign command transcript bytes", signCall?.args.bytes, bytesBase64(carrierTranscriptBytes(challenge, vector.client.realm, sessionIdentity.publicKey)));
const keyValue = createTauriKeyValueStore(invoke, { namespace: "township:resident" });
await keyValue.setItem("probe", "value");
check("tauri key-value set", values.get("township:resident:probe"), "value");
check("tauri key-value get", await keyValue.getItem("probe"), "value");
const residentPostFixture = vector.clientDivergedCarrierOps.find((frame) => frame.author === residentIdentity.publicKeyBase64 && frame.id === "xmret5C7xMai04EQDm1cEX1dDjeBqxPM7-TcDN8cfhI");
if (!residentPostFixture)
    throw new Error("missing resident post fixture");
const localOpsBeforePost = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== residentPostFixture.id), vector.realmByPubkey);
const localLog = createJsonLocalOpLogStore(keyValue, "ops");
const carrierFrames = createJsonCarrierFrameStore(keyValue, "frames");
await localLog.save(localOpsBeforePost);
await carrierFrames.save(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== residentPostFixture.id));
const residentSigner = createTauriCarrierSigner(invoke, {
    keyId: "resident",
    publicKey: residentIdentity.publicKey,
});
const authored = await authorAndPersistTownshipCommand({
    replica: residentPostFixture.replica,
    command: { command: "post", text: "resident: posted while offline" },
    signer: residentSigner,
    localLog,
    carrierFrames,
    realmByPubkey: vector.realmByPubkey,
});
check("tauri workflow frame", authored.frame, residentPostFixture);
check("tauri workflow local op ids", (await localLog.load()).map((op) => op.id), vector.clientDivergedCarrierOps.map((frame) => frame.id));
check("tauri workflow frame outbox", await carrierFrames.load(), vector.clientDivergedCarrierOps);
console.log(`\n${failures === 0 ? "\x1b[32m✓ Tauri bridge checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
function seededEd25519Identity(seed) {
    const privateSeed = createHash("sha256").update(seed).digest();
    const privateKey = createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
        format: "der",
        type: "pkcs8",
    });
    const publicKeyDer = createPublicKey(privateKey).export({
        format: "der",
        type: "spki",
    });
    const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(12));
    return {
        publicKey,
        publicKeyBase64: bytesBase64(publicKey),
        sign(bytes) {
            return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
        },
    };
}
function base64Bytes(value) {
    return new Uint8Array(Buffer.from(value, "base64"));
}
function bytesBase64(bytes) {
    return Buffer.from(bytes).toString("base64");
}
