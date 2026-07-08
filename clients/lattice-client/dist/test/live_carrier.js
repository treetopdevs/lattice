import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { authorAndPersistTownshipCommand, carrierDelegationsFromFrames, carrierOpsToSemanticOps, connectCarrierWebSocket, createJsonCarrierFrameStore, createJsonLocalOpLogStore, materialize, selectTownshipCapId, syncCarrierOnce, } from "../src/index";
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const vecDir = join(here, "vectors");
let failures = 0;
const eq = (a, b) => isDeepStrictEqual(a, b);
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
class MemoryKeyValueStore {
    values = new Map();
    getItem(key) {
        return this.values.get(key) ?? null;
    }
    setItem(key, value) {
        this.values.set(key, value);
    }
}
const vector = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(vecDir, "township_carrier_w1.json"), "utf8")));
console.log(`\n▸ ${vector.scenario} live carrier`);
const identity = seededEd25519Identity(vector.client.sessionSeed);
const verifier = {
    verify(pubkey, bytes, signature) {
        return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
    },
};
check("fixture public key", identity.publicKeyBase64, vector.client.sessionPubkey);
const residentAuthor = seededEd25519Identity(`${vector.client.sessionSeed}:${vector.client.realm}`);
check("resident author public key", residentAuthor.publicKeyBase64, pubkeyForRealm(vector.realmByPubkey, vector.client.realm));
const postFixture = vector.clientDivergedCarrierOps.find((frame) => frame.author === residentAuthor.publicKeyBase64 && commandName(frame) === "post");
if (!postFixture)
    throw new Error("missing resident post fixture frame");
const postCommand = { command: "post", text: "resident: posted while offline" };
const postCapId = selectTownshipCapId(postCommand, carrierDelegationsFromFrames(vector.clientDivergedCarrierOps), residentAuthor.publicKeyBase64);
check("resident post cap id", postCapId, "gN9aanNVZeHWsS1vU8KxjyqVrWdC0VwPIzilL_QX2n0");
const localOpsBeforePost = carrierOpsToSemanticOps(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id), vector.realmByPubkey);
const authoredLocalLog = createJsonLocalOpLogStore(new MemoryKeyValueStore(), "township:resident:ops");
await authoredLocalLog.save(localOpsBeforePost);
const authoredFrameStore = createJsonCarrierFrameStore(new MemoryKeyValueStore(), "township:resident:frames");
await authoredFrameStore.save(vector.clientDivergedCarrierOps.filter((frame) => frame.id !== postFixture.id));
const authoredPost = await authorAndPersistTownshipCommand({
    replica: postFixture.replica,
    command: postCommand,
    signer: residentAuthor,
    localLog: authoredLocalLog,
    carrierFrames: authoredFrameStore,
    realmByPubkey: vector.realmByPubkey,
});
check("author-and-persist cap id", authoredPost.capId, postCapId);
check("authored resident post frame", authoredPost.frame, postFixture);
const authoredClientFrames = await authoredFrameStore.load();
check("persisted authored frame outbox", authoredClientFrames, vector.clientDivergedCarrierOps);
const peer = await spawnTownshipPeer(vector);
try {
    let conn = await connectCarrierWebSocket({
        url: `ws://127.0.0.1:${peer.port}/carrier`,
        localRealm: vector.client.realm,
        replica: vector.replica,
        signer: identity,
        expectedPeerRealm: vector.peer.realm,
        expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
        verifier,
    });
    check("initial peer status", await conn.status(), "base");
    conn.close();
    conn = await reconnectWhenDiverged(peer.port, vector, identity, verifier);
    const clientDiverged = await authoredLocalLog.load();
    const synced = await syncCarrierOnce(conn, clientDiverged, authoredClientFrames, vector.realmByPubkey);
    check("pulled peer op count", synced.pulledOps.length, 5);
    check("push frame count", synced.pushedFrames.length, 2);
    check("push accepted count", synced.pushReport.accepted.length, 2);
    check("push quarantined", synced.pushReport.quarantined, []);
    const merged = synced.ops;
    const materialized = materialize(vector.schema, merged);
    for (const [field, want] of Object.entries(vector.expectAfterSync.state)) {
        check(`state.${field}`, materialized.state[field], want);
    }
    check("authority quarantine", materialized.quarantine.sort(), vector.expectAfterSync.authorityQuarantine.map(([id]) => id).sort());
    check("merged op ids", merged.map((op) => op.id).sort(), vector.expectAfterSync.opIds);
    const peerReport = await conn.stateReport();
    check("peer state bytes", peerReport.state_b64, vector.expectAfterSync.stateB64);
    check("peer op ids", peerReport.op_ids, vector.expectAfterSync.opIds);
    check("peer authority quarantine", peerReport.authority_quarantine, vector.expectAfterSync.authorityQuarantine);
    await conn.shutdown();
    await peer.awaitExit();
}
finally {
    peer.kill();
}
console.log(`\n${failures === 0 ? "\x1b[32m✓ live carrier checks passed\x1b[0m" : `\x1b[31m✗ ${failures} check(s) failed\x1b[0m`}`);
process.exit(failures === 0 ? 0 : 1);
async function reconnectWhenDiverged(port, vector, identity, verifier) {
    for (let i = 0; i < 50; i++) {
        const conn = await connectCarrierWebSocket({
            url: `ws://127.0.0.1:${port}/carrier`,
            localRealm: vector.client.realm,
            replica: vector.replica,
            signer: identity,
            expectedPeerRealm: vector.peer.realm,
            expectedPeerPubkey: Buffer.from(vector.peer.sessionPubkey, "base64"),
            verifier,
        });
        if ((await conn.status()) === "diverged")
            return conn;
        conn.close();
        await delay(20);
    }
    throw new Error("peer never diverged after socket close");
}
async function spawnTownshipPeer(vector) {
    const child = spawn(elixirBin(), [
        ...codePathArgs(),
        "apps/lattice_node_spike/priv/peer_node.exs",
        vector.peer.realm,
        vector.client.realm,
        vector.client.sessionPubkey,
        "LatticeNodeSpike.TownshipScenario",
    ], {
        cwd: repoRoot,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = [];
    child.stderr.on("data", (chunk) => lines.push(chunk.toString()));
    const port = await awaitReady(child, lines);
    return {
        port,
        awaitExit: () => awaitExit(child, lines),
        kill: () => {
            if (!child.killed && child.exitCode === null)
                child.kill("SIGKILL");
        },
    };
}
function awaitReady(child, lines) {
    return new Promise((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error(`peer OS process never became ready:\n${lines.join("")}`)), 60_000);
        child.stdout.on("data", (chunk) => {
            for (const line of chunk.toString().split(/\r?\n/)) {
                if (!line)
                    continue;
                lines.push(`${line}\n`);
                if (line.startsWith("PEER_READY ")) {
                    clearTimeout(timeout);
                    resolveReady(Number.parseInt(line.slice("PEER_READY ".length), 10));
                }
            }
        });
        child.on("exit", (code) => {
            clearTimeout(timeout);
            rejectReady(new Error(`peer OS process exited (${code}) before READY:\n${lines.join("")}`));
        });
    });
}
function awaitExit(child, lines) {
    return new Promise((resolveExit, rejectExit) => {
        const timeout = setTimeout(() => rejectExit(new Error(`peer OS process did not exit:\n${lines.join("")}`)), 10_000);
        child.on("exit", (code) => {
            clearTimeout(timeout);
            if (code === 0)
                resolveExit();
            else
                rejectExit(new Error(`peer OS process exited with ${code}:\n${lines.join("")}`));
        });
    });
}
function codePathArgs() {
    const libRoot = join(repoRoot, "_build/test/lib");
    if (!existsSync(libRoot))
        throw new Error(`missing BEAM test build at ${libRoot}; run mix test first`);
    return readdirSync(libRoot)
        .map((app) => join(libRoot, app, "ebin"))
        .filter(existsSync)
        .flatMap((path) => ["-pa", path]);
}
function elixirBin() {
    const asdf = join(process.env.HOME ?? "", ".asdf/shims/elixir");
    if (existsSync(asdf))
        return asdf;
    return "elixir";
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
function publicKeyObject(pubkey) {
    return createPublicKey({
        key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubkey)]),
        format: "der",
        type: "spki",
    });
}
function pubkeyForRealm(realmByPubkey, realm) {
    const entry = Object.entries(realmByPubkey).find(([, candidateRealm]) => candidateRealm === realm);
    if (!entry)
        throw new Error(`missing pubkey for realm ${realm}`);
    return entry[0];
}
function commandName(frame) {
    const { body } = frame;
    if (body[0] !== "tuple")
        return undefined;
    const [command] = body[1];
    if (!command || command[0] !== "atom")
        return undefined;
    return command[1];
}
function delay(ms) {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
