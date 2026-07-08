import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, createHash, sign as edSign } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { carrierOpsToSemanticOps, carrierTranscriptHex, integrate, materialize, signCarrierChallenge, toRequest, toSend, } from "../src/index";
const here = dirname(fileURLToPath(import.meta.url));
const vecDir = join(here, "vectors");
let failures = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) {
    const ok = eq(got, want);
    if (!ok)
        failures++;
    const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${tag} ${name}`);
    if (!ok) {
        console.log(`       got : ${JSON.stringify(got)}`);
        console.log(`       want: ${JSON.stringify(want)}`);
    }
}
const vector = JSON.parse(readFileSync(join(vecDir, "township_carrier_w1.json"), "utf8"));
console.log(`\n▸ ${vector.scenario} carrier vector`);
const identity = seededEd25519Identity(vector.client.sessionSeed);
check("session public key", identity.publicKeyBase64, vector.client.sessionPubkey);
const challenge = {
    type: "carrier_challenge",
    local_realm: vector.client.realm,
    replica: "replica:matter:township-g1",
    nonce: "fixed-nonce",
    wire_version: 1,
};
check("carrier transcript", carrierTranscriptHex(challenge, vector.client.realm, identity.publicKey), "8752636172726965722d73657373696f6e2d7631487265736964656e74581a7265706c6963613a6d61747465723a746f776e736869702d67314b66697865642d6e6f6e636501487265736964656e74582065ed56fb80e79cae9aa096391a25280d5c99561ab9fcf08bed4c1000b5d440d9");
const signed = await signCarrierChallenge(challenge, identity);
check("carrier challenge signature", signed.signature, "RbRuwsxr3fAGolrYRigR4MKXJDYoWykgxEvrSsTIzqs0RVN7JRfcDiE6P5Jn4bNpjLi5bSquYLZrlAFa2a5iBg==");
const clientBase = carrierOpsToSemanticOps(vector.clientBaseCarrierOps, vector.realmByPubkey);
const clientDiverged = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps, vector.realmByPubkey);
const peerDiverged = carrierOpsToSemanticOps(vector.peerDivergedCarrierOps, vector.realmByPubkey);
check("base op count", clientBase.length, vector.clientBaseCarrierOps.length);
check("client sends two offline ops", toSend(clientDiverged, new Set(peerDiverged.map((o) => o.id))).length, 2);
check("client pulls five peer ops", toRequest(clientDiverged, peerDiverged.map((o) => o.id)).length, 5);
const pulled = peerDiverged.filter((op) => toRequest(clientDiverged, [op.id]).includes(op.id));
const merged = integrate(clientDiverged, pulled);
const materialized = materialize(vector.schema, merged);
for (const [field, want] of Object.entries(vector.expectAfterSync.state)) {
    check(`state.${field}`, materialized.state[field], want);
}
check("merged op ids", merged.map((o) => o.id).sort(), vector.expectAfterSync.opIds);
check("authority quarantine", materialized.quarantine.sort(), vector.expectAfterSync.authorityQuarantine.map(([id]) => id).sort());
console.log(`\n${failures === 0 ? "\x1b[32m✓ carrier checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
function seededEd25519Identity(seed) {
    const privateSeed = createHash("sha256").update(seed).digest();
    const pkcs8Prefix = Buffer.from("302e020100300506032b657004220420", "hex");
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const privateKey = createPrivateKey({
        key: Buffer.concat([pkcs8Prefix, privateSeed]),
        format: "der",
        type: "pkcs8",
    });
    const publicKeyDer = createPublicKey(privateKey).export({
        format: "der",
        type: "spki",
    });
    const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(spkiPrefix.length));
    return {
        publicKey,
        publicKeyBase64: Buffer.from(publicKey).toString("base64"),
        sign(bytes) {
            return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
        },
    };
}
