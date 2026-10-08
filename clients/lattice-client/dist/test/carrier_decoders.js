import assert from "node:assert/strict";
import { createHash, createPublicKey, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorTownshipGenesis, authorTreehouseCommand, carrierDelegationsFromFrames, carrierOpsToSemanticOps, syncCarrierOnce, treehouseCommandDecoders, } from "../src/index";
console.log("\n▸ Injectable command decoders in carrier sync");
const seed = createHash("sha256").update("treehouse-ts:carrier-decoders").digest();
const signer = { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
const genesis = await authorTownshipGenesis({ replica: "treehouse:ts:carrier-decoders", signer,
    ops: ["create_space", "create_thread", "issue_invitation", "revoke_invitation", "admit_member", "remove_member"],
    roles: ["admin", "moderator"] });
const replica = genesis.replica;
const capId = carrierDelegationsFromFrames([genesis])[0].id;
const created = await authorTreehouseCommand({ product: "Treehouse.Space", replica, deps: [genesis.id], signer, capId,
    command: { command: "create_thread", title: "One", threadReplica: "thread:one" } });
const frames = [genesis, created];
const emptyReport = () => ({ accepted: [], pending: [], quarantined: [], rejected: [] });
class FixtureClient {
    advertised;
    pulled;
    relayedIds = [];
    constructor(advertised, pulled) {
        this.advertised = advertised;
        this.pulled = pulled;
    }
    async advertise() { return [...this.advertised]; }
    async pull() { return [...this.pulled]; }
    async push() { throw new Error("generic push fallback called"); }
    async relay(op) {
        this.relayedIds.push(op.id);
        return { ...emptyReport(), accepted: [op.id] };
    }
}
const verifier = { verify: async (author, bytes, signature) => {
        const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(author, "base64")]);
        return edVerify(null, Buffer.from(bytes), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(signature));
    } };
const options = { verifier, expectedReplica: replica };
const decoders = treehouseCommandDecoders("Treehouse.Space");
const decoded = await syncCarrierOnce(new FixtureClient([], frames), [], [], {}, { ...options, commandDecoders: decoders });
const direct = carrierOpsToSemanticOps(frames, {}, decoders);
assert.deepEqual(decoded.pulledOps, direct);
const decodedCreate = decoded.pulledOps[1];
assert.equal(decodedCreate.command, "create_thread");
assert.equal(decodedCreate.decodedProduct, "Treehouse.Space");
assert.equal(decodedCreate.effects?.some((effect) => effect.field === "threads"), true);
console.log("PASS pulled Treehouse frames decode to Treehouse effects with the decoders option");
const neutral = await syncCarrierOnce(new FixtureClient([], frames), [], [], {}, options);
assert.deepEqual(neutral.pulledOps, carrierOpsToSemanticOps(frames, {}));
assert.equal(neutral.pulledOps[1].decodedProduct, undefined);
assert.equal(neutral.pulledOps[1].effects?.some((effect) => effect.field === "threads") ?? false, false);
assert.deepEqual(neutral.pulledOps.map((op) => op.id), decoded.pulledOps.map((op) => op.id));
console.log("PASS without decoders the same frames keep the neutral shape and identical ids");
// The candidate loop must agree with the pulled-ops path: a Treehouse-only command that the
// default table cannot decode is still recognised by id whether or not decoders are supplied.
for (const commandDecoders of [undefined, decoders]) {
    const client = new FixtureClient([created.id], []);
    const synced = await syncCarrierOnce(client, [], [created], {}, {
        ...options, submission: "relay", ...(commandDecoders === undefined ? {} : { commandDecoders }),
    });
    assert.deepEqual(client.relayedIds, []);
    assert.deepEqual(synced.peerReportedFrameIds, [created.id]);
}
const unknown = new FixtureClient([], []);
const submitted = await syncCarrierOnce(unknown, [], [created], {}, { ...options, submission: "relay", commandDecoders: decoders });
assert.deepEqual(unknown.relayedIds, [created.id]);
assert.deepEqual(submitted.peerReportedFrameIds, [created.id]);
console.log("PASS candidate loop agrees with the pulled path under both decoder settings");
const township = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors", "township_carrier_w1.json"), "utf8"));
const townshipDefault = await syncCarrierOnce(new FixtureClient([], township.clientDivergedCarrierOps), [], [], township.realmByPubkey, { verifier, expectedReplica: township.replica });
assert.deepEqual(townshipDefault.pulledOps, carrierOpsToSemanticOps(township.clientDivergedCarrierOps, township.realmByPubkey));
assert.equal(townshipDefault.pulledOps.every((op) => op.decodedProduct === undefined), true);
console.log("PASS Township sync without decoders is unchanged");
