import { createHash, createPrivateKey, createPublicKey, sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { authorAndPersistTownshipCommand, authorTownshipCommand, authorTownshipCommandFromLog, carrierDelegationsFromFrames, carrierOpsToSemanticOps, createJsonCarrierFrameStore, createJsonLocalOpLogStore, selectTownshipCapId, townshipCapTerm, townshipCommandBody, } from "../src/index";
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
class MemoryKeyValueStore {
    values = new Map();
    getItem(key) {
        return this.values.get(key) ?? null;
    }
    setItem(key, value) {
        this.values.set(key, value);
    }
}
console.log(`\n▸ ${vector.scenario} Township command authoring`);
check("set_title body", townshipCommandBody({ command: "set_title", text: "Road diet" }), commandBody("set_title", "Road diet"));
check("set_summary body", townshipCommandBody({ command: "set_summary", text: "Needs traffic study" }), commandBody("set_summary", "Needs traffic study"));
check("post body", townshipCommandBody({ command: "post", text: "resident: posted while offline" }), commandBody("post", "resident: posted while offline"));
check("admit body", townshipCommandBody({ command: "admit", member: "resident" }), commandBody("admit", "resident"));
check("remove_member body", townshipCommandBody({ command: "remove_member", member: "resident" }), commandBody("remove_member", "resident"));
check("close_matter body", townshipCommandBody({ command: "close_matter" }), commandBody("close_matter"));
check("reopen_matter body", townshipCommandBody({ command: "reopen_matter" }), commandBody("reopen_matter"));
const capId = "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0";
check("delegation cap term", townshipCapTerm(capId), ["bin", textBase64(capId)]);
check("missing cap term", townshipCapTerm(null), ["nil"]);
const residentAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
const clerkAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:clerk`);
const delegations = carrierDelegationsFromFrames(vector.clientDivergedCarrierOps);
check("carrier delegation ids from frames", delegations.map((delegation) => delegation.id), [
    "ZOb-qhDcOoM0yStgMMBlYY_IHIw6eX1BcvFx5hb_Hs8",
    capId,
]);
check("resident post cap id", selectTownshipCapId({ command: "post", text: "resident: posted while offline" }, delegations, residentAuthor.publicKeyBase64), capId);
check("resident close_matter cap id", selectTownshipCapId({ command: "close_matter" }, delegations, residentAuthor.publicKeyBase64), null);
check("clerk close_matter cap id", selectTownshipCapId({ command: "close_matter" }, delegations, clerkAuthor.publicKeyBase64), "ZOb-qhDcOoM0yStgMMBlYY_IHIw6eX1BcvFx5hb_Hs8");
const postFixture = vector.clientDivergedCarrierOps.find((frame) => frame.author === residentAuthor.publicKeyBase64 && frame.id === "xmret5C7xMai04EQDm1cEX1dDjeBqxPM7-TcDN8cfhI");
if (!postFixture)
    throw new Error("missing resident post fixture frame");
const residentPostCommand = { command: "post", text: "resident: posted while offline" };
const authoredPostFrame = await authorTownshipCommand({
    replica: postFixture.replica,
    deps: postFixture.deps,
    command: residentPostCommand,
    capId,
    signer: residentAuthor,
});
check("authored resident post frame", authoredPostFrame, postFixture);
const localOpsBeforePost = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id), vector.realmByPubkey);
const authoredPostFrameFromLog = await authorTownshipCommandFromLog({
    replica: postFixture.replica,
    localOps: localOpsBeforePost,
    command: residentPostCommand,
    capId,
    signer: residentAuthor,
});
check("authored resident post frame from local log", authoredPostFrameFromLog, postFixture);
const persistedStore = createJsonLocalOpLogStore(new MemoryKeyValueStore(), "township:resident");
await persistedStore.save(localOpsBeforePost);
check("persisted local log roundtrip", await persistedStore.load(), localOpsBeforePost);
const authoredPostFrameFromPersistedLog = await authorTownshipCommandFromLog({
    replica: postFixture.replica,
    localOps: await persistedStore.load(),
    command: residentPostCommand,
    capId,
    signer: residentAuthor,
});
check("authored resident post frame from persisted local log", authoredPostFrameFromPersistedLog, postFixture);
const carrierFrameStore = createJsonCarrierFrameStore(new MemoryKeyValueStore(), "township:resident:frames");
await carrierFrameStore.save(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id));
await carrierFrameStore.append(authoredPostFrameFromPersistedLog);
await carrierFrameStore.append(authoredPostFrameFromPersistedLog);
check("persisted carrier frame outbox is idempotent", await carrierFrameStore.load(), vector.clientDivergedCarrierOps);
const workflowLocalLog = createJsonLocalOpLogStore(new MemoryKeyValueStore(), "township:workflow:ops");
await workflowLocalLog.save(localOpsBeforePost);
const workflowFrameStore = createJsonCarrierFrameStore(new MemoryKeyValueStore(), "township:workflow:frames");
await workflowFrameStore.save(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id));
const workflowPost = await authorAndPersistTownshipCommand({
    replica: postFixture.replica,
    command: residentPostCommand,
    signer: residentAuthor,
    localLog: workflowLocalLog,
    carrierFrames: workflowFrameStore,
    realmByPubkey: vector.realmByPubkey,
});
check("author-and-persist cap id", workflowPost.capId, capId);
check("author-and-persist frame", workflowPost.frame, postFixture);
check("author-and-persist op id", workflowPost.op.id, postFixture.id);
check("author-and-persist local log ids", (await workflowLocalLog.load()).map((op) => op.id), vector.clientDivergedCarrierOps.map((frame) => frame.id));
check("author-and-persist frame outbox", await workflowFrameStore.load(), vector.clientDivergedCarrierOps);
let rejectedMissingCap = false;
try {
    await authorAndPersistTownshipCommand({
        replica: postFixture.replica,
        command: { command: "close_matter" },
        signer: residentAuthor,
        localLog: workflowLocalLog,
        carrierFrames: workflowFrameStore,
        realmByPubkey: vector.realmByPubkey,
    });
}
catch (error) {
    rejectedMissingCap = error instanceof Error && error.message === "no local delegation authorizes close_matter";
}
check("author-and-persist rejects missing cap", rejectedMissingCap, true);
await persistedStore.append(carrierOpsToSemanticOps([postFixture], vector.realmByPubkey)[0]);
await persistedStore.append(carrierOpsToSemanticOps([postFixture], vector.realmByPubkey)[0]);
check("persisted local log append is idempotent", (await persistedStore.load()).map((op) => op.id), vector.clientDivergedCarrierOps.map((frame) => frame.id));
console.log(`\n${failures === 0 ? "\x1b[32m✓ Township authoring checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
function commandBody(command, arg) {
    const args = arg === undefined ? [] : [["bin", textBase64(arg)]];
    return ["tuple", [["atom", command], ["list", args]]];
}
function textBase64(value) {
    return Buffer.from(value, "utf8").toString("base64");
}
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
        publicKeyBase64: Buffer.from(publicKey).toString("base64"),
        sign(bytes) {
            return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
        },
    };
}
