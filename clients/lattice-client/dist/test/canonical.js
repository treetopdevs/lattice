import { readFileSync } from "node:fs";
import { createPublicKey, verify as edVerify } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytesForCarrierOp, canonicalHash, verifyCarrierOp } from "../src/index";
const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(readFileSync(join(here, "vectors", "township_carrier_w1.json"), "utf8"));
let failures = 0;
function check(name, got, want) {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok)
        failures++;
    const tag = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(`  ${tag} ${name}`);
    if (!ok) {
        console.log(`       got : ${JSON.stringify(got)}`);
        console.log(`       want: ${JSON.stringify(want)}`);
    }
}
console.log(`\n▸ ${vector.scenario} canonical op bytes`);
const expectedById = new Map(vector.canonicalOps.map((entry) => [entry.id, entry]));
const verifier = { verify: verifyEd25519 };
check("canonical vector covers every carrier op", expectedById.size, vector.oracleCarrierOps.length);
for (const frame of vector.oracleCarrierOps) {
    const expected = expectedById.get(frame.id);
    if (!expected) {
        failures++;
        console.log(`  \x1b[31mFAIL\x1b[0m missing canonical bytes for ${frame.id}`);
        continue;
    }
    const bytes = canonicalBytesForCarrierOp(frame);
    check(`${frame.id}.suite`, expected.suite, "lattice-cbor-v1");
    check(`${frame.id}.bytes`, bytesToHex(bytes), expected.bytesHex);
    check(`${frame.id}.hash`, await canonicalHash(bytes), expected.hash);
    check(`${frame.id}.signature`, await verifyCarrierOp(frame, verifier), {
        hash: true,
        signature: true,
        valid: true,
    });
}
const [firstFrame] = vector.oracleCarrierOps;
if (firstFrame) {
    check("tampered signature fails verification", await verifyCarrierOp({ ...firstFrame, sig: tamperBase64(firstFrame.sig) }, verifier), { hash: true, signature: false, valid: false });
    check("tampered body fails verification", await verifyCarrierOp({ ...firstFrame, body: ["tuple", [["atom", "post"], ["list", [["bin", "dGFtcGVyZWQ="]]]]] }, verifier), { hash: false, signature: false, valid: false });
}
console.log(`\n${failures === 0 ? "\x1b[32m✓ canonical checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
function bytesToHex(bytes) {
    return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function tamperBase64(encoded) {
    const bytes = Buffer.from(encoded, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    return bytes.toString("base64");
}
async function verifyEd25519(author, bytes, signature) {
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = createPublicKey({
        key: Buffer.concat([spkiPrefix, Buffer.from(author, "base64")]),
        format: "der",
        type: "spki",
    });
    return edVerify(null, Buffer.from(bytes), publicKey, Buffer.from(signature));
}
