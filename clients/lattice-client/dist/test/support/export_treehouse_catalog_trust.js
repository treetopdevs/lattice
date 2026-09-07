import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, canonicalBytesForCarrierOp } from "../../src/codec";
import { bindTownshipReplica, townshipCapTerm } from "../../src/township";
import { authorTreehouseCommand } from "../../src/treehouse";
import { continuationProfileId, continuationProfileToCarrierTerm } from "../../src/continuation";
import { canonicalBytesForTransportCatalog, canonicalBytesForCatalogRotation, canonicalBytesForCatalogRotationPossession, catalogEnvelopeToCarrierTerm, catalogRotationEnvelopeToCarrierTerm, catalogInventoryId, transportCatalogId, catalogRotationId } from "../../src/treehouse_catalog_codec";
import { deriveTreehouseCatalogCutoff } from "../../src/treehouse_catalog_cutoff";
import { prepareTreehouseCatalogInstallation, evaluateTreehouseCatalogTrust } from "../../src/treehouse_catalog_trust";
export const fixtureId = (label) => createHash("sha256").update(`r11a-trust-ts:${label}`).digest("base64url");
export const fixtureSigner = (label) => {
    const seed = createHash("sha256").update(`r11a-trust-ts:${label}`).digest();
    return { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
};
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const atom = (name) => ["atom", name];
const tuple = (...items) => ["tuple", items];
export async function signedCatalog(catalog, signer) {
    const signature = b64(await signer.sign(canonicalBytesForTransportCatalog(catalog)));
    return JSON.stringify(catalogEnvelopeToCarrierTerm({ catalog, signature }));
}
export async function signedRotation(rotation, old, next) {
    return JSON.stringify(catalogRotationEnvelopeToCarrierTerm({ rotation,
        oldSignature: b64(await old.sign(canonicalBytesForCatalogRotation(rotation))),
        newSignature: b64(await next.sign(canonicalBytesForCatalogRotationPossession(rotation))) }));
}
/** Independently signed synthetic histories, including distinct Space and child roots. */
export async function trustFixture(threadCount = 1) {
    const root = fixtureSigner("space-root"), catalogSigner = fixtureSigner("catalog"), serviceSigner = fixtureSigner("service");
    const nextCatalogSigner = fixtureSigner("catalog-next"), nominee = fixtureSigner("nominee");
    const witnesses = ["w1", "w2", "w3"].map(fixtureSigner).sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
    async function identity(kind, label, signer) {
        const replica = await bindTownshipReplica(`replica:treehouse:${kind}:${fixtureId(label)}#authority:bounded-continuation-v1`, signer.publicKey);
        const delegation = await authorCarrierDelegation({ replica, signer, audiencePubkey: signer.publicKey, live: true,
            roles: kind === "space" ? ["admin", "moderator"] : ["moderator"],
            ops: kind === "space" ? ["create_space", "create_thread", "catalog_bootstrap_v1", "replace_catalog_v1"] : ["create_thread", "post", "archive_thread"] });
        const genesis = await authorCarrierOp({ replica, signer, deps: [], kind: "authority", cap: ["nil"],
            body: tuple(atom("genesis"), ["delegation", delegation], ["map", []]) });
        const creation = await authorTreehouseCommand({ product: kind === "space" ? "Treehouse.Space" : "Treehouse.Thread", replica,
            signer, deps: [genesis.id], capId: delegation.id,
            command: kind === "space" ? { command: "create_space", name: "Retained canopy" } : { command: "create_thread", title: label } });
        const profile = { mode: "bounded_continuation", version: 1, product: "treehouse", kind,
            role: kind === "space" ? "admin" : "moderator", nominee: b64(nominee.publicKey),
            witnesses: witnesses.map((w) => b64(w.publicKey)), threshold: 2, maxLeaseEpochs: 7 };
        const empty = await authorCarrierDelegation({ replica, signer, audiencePubkey: signer.publicKey, ops: [], roles: [], live: false });
        const pin = await authorCarrierOp({ replica, signer, deps: [creation.id], kind: "authority", cap: ["nil"],
            body: tuple(atom("genesis"), ["delegation", empty], ["map", [[atom("__continuation__"), continuationProfileToCarrierTerm(profile)]]]) });
        return { replica, signer, delegation, genesis, creation, pin, profile, frames: [genesis, creation, pin] };
    }
    const space = await identity("space", "space", root);
    const bootstrapRecord = { version: 1, product: "treehouse", space: space.replica, spaceRoot: b64(root.publicKey),
        profileGenesis: space.pin.id, profileId: continuationProfileId(space.profile), replacementRule: "bounded_space_admin_v1",
        catalogKey: b64(catalogSigner.publicKey), serviceId: fixtureId("service"), serviceKey: b64(serviceSigner.publicKey),
        origin: "wss://trust-relay.invalid", nonce: fixtureId("bootstrap") };
    const bootstrap = await authorTreehouseCommand({ product: "Treehouse.Space", replica: space.replica, signer: root,
        deps: [space.pin.id], capId: space.delegation.id, command: { command: "catalog_bootstrap_v1", record: bootstrapRecord } });
    space.frames.push(bootstrap);
    const threads = [];
    for (let i = 0; i < threadCount; i++) {
        const thread = await identity("thread", `thread-${i}`, fixtureSigner(`thread-root-${i}`));
        const reference = await authorTreehouseCommand({ product: "Treehouse.Space", replica: space.replica, signer: root,
            deps: [space.frames.at(-1).id], capId: space.delegation.id,
            command: { command: "create_thread", threadReplica: thread.replica, title: `Thread ${i}` } });
        space.frames.push(reference);
        threads.push({ ...thread, reference });
    }
    const entry = (kind, item, reference) => ({ product: "treehouse", kind,
        schema: kind === "space" ? "treehouse_space_v1" : "treehouse_thread_v1", replica: item.replica,
        root: b64(item.signer.publicKey), genesis: item.genesis.id, creation: item.creation.id, reference,
        route: `/r/${fixtureId(item.replica)}`, serviceId: bootstrapRecord.serviceId, serviceKey: bootstrapRecord.serviceKey });
    const entries = [entry("space", space, bootstrap.id), ...threads.map((t) => entry("thread", t, t.reference.id))]
        .sort((a, b) => Buffer.compare(Buffer.from(a.replica), Buffer.from(b.replica)));
    const catalog = { version: 1, product: "treehouse", space: space.replica, bootstrap: bootstrap.id,
        binding: bootstrap.id, revision: 0, previous: null, entries };
    const histories = [space, ...threads].map((item) => ({ replica: item.replica, frames: item.frames, rejected: [] }));
    const cutoffProofs = [];
    for (const history of histories) {
        const observed = await deriveTreehouseCatalogCutoff(history);
        assert.equal(observed.ok, true);
        if (observed.ok)
            cutoffProofs.push({ cutoff: observed.cutoff, history });
    }
    cutoffProofs.sort((a, b) => Buffer.compare(Buffer.from(a.cutoff.replica), Buffer.from(b.cutoff.replica)));
    const rotation = { version: 1, product: "treehouse", space: space.replica, bootstrap: bootstrap.id,
        parent: bootstrap.id, priorCatalog: transportCatalogId(catalog), generation: 1,
        newCatalogKey: b64(nextCatalogSigner.publicKey), nonce: fixtureId("rotation"),
        inventoryDigest: catalogInventoryId(entries), cutoffs: cutoffProofs.map((p) => p.cutoff) };
    const catalogJson = await signedCatalog(catalog, catalogSigner), rotationJson = await signedRotation(rotation, catalogSigner, nextCatalogSigner);
    return { space, threads, root, catalogSigner, nextCatalogSigner, serviceSigner, bootstrapRecord, bootstrap,
        review: { version: 1, product: "treehouse", space: space.replica, spaceRoot: bootstrapRecord.spaceRoot,
            bootstrapId: bootstrap.id, observedBootstrapIds: [bootstrap.id], disposition: "pin_exact_observed_bootstrap" },
        histories, cutoffProofs, catalog, catalogJson, rotation, rotationJson };
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === "--verify-beam" && args[1]) {
        const vector = JSON.parse(await readFile(resolve(args[1]), "utf8"));
        assert.equal(vector.version, 1);
        const { catalogEnvelopeFromCarrierTerm, catalogRotationEnvelopeFromCarrierTerm } = await import("../../src/treehouse_catalog_codec");
        const catalog = catalogEnvelopeFromCarrierTerm(JSON.parse(vector.catalogJson));
        const rotation = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(vector.rotationJson));
        assert.ok(catalog && rotation);
        assert.equal(transportCatalogId(catalog.catalog), vector.expected.catalogId);
        assert.equal(catalogRotationId(rotation), vector.expected.rotationId);
        assert.equal(b64(canonicalBytesForTransportCatalog(catalog.catalog)), vector.expected.catalogBytes);
        assert.equal(b64(canonicalBytesForCatalogRotation(rotation.rotation)), vector.expected.rotationBytes);
        assert.equal(b64(canonicalBytesForCatalogRotationPossession(rotation.rotation)), vector.expected.possessionBytes);
        const actual = vector.histories.flatMap((h) => h.frames.map((frame) => ({ replica: h.replica, id: frame.id, bytes: b64(canonicalBytesForCarrierOp(frame)) })));
        const payloadOrder = (a, b) => Buffer.compare(Buffer.from(`${a.replica}:${a.id}`), Buffer.from(`${b.replica}:${b.id}`));
        assert.deepEqual(actual.sort(payloadOrder), [...vector.expected.payloads].sort(payloadOrder));
        for (const proof of vector.cutoffProofs) {
            const cutoff = await deriveTreehouseCatalogCutoff(proof.history);
            assert.equal(cutoff.ok, true);
            if (cutoff.ok)
                assert.deepEqual(cutoff.cutoff, proof.cutoff);
        }
        const expected = { trustRevision: 0, historyGeneration: 0 };
        const observations = [];
        for (const reverse of [false, true]) {
            const histories = structuredClone(vector.histories);
            if (reverse) {
                histories.reverse();
                for (const h of histories) {
                    h.frames.reverse();
                    h.rejected.reverse();
                }
            }
            const initial = await prepareTreehouseCatalogInstallation({ review: vector.review,
                history: histories.find((h) => h.replica === vector.review.space), store: { kind: "verified_fresh", expected } });
            assert.equal(initial.kind, "propose");
            const result = await evaluateTreehouseCatalogTrust({ installed: initial.next, expected,
                incoming: { catalogs: [vector.catalogJson], rotations: [], histories, cutoffProofs: [] } });
            assert.equal(result.kind, "propose");
            assert.equal(result.reason, null);
            assert.equal(result.next.accepted?.catalog, vector.expected.catalogId);
            assert.deepEqual(result.routes.map(({ replica, root, genesis, creation, reference, serviceId, serviceKey, path, schema, kind }) => ({ replica, root, genesis, creation, reference, serviceId, serviceKey, route: path, schema, kind, product: "treehouse" })), catalog.catalog.entries.map((entry) => ({ ...entry })));
            const rotated = await evaluateTreehouseCatalogTrust({ installed: result.next, expected,
                incoming: { catalogs: [vector.rotatedCatalogJson], rotations: [vector.rotationJson], histories: [], cutoffProofs: vector.cutoffProofs } });
            assert.equal(rotated.kind, "propose");
            assert.equal(rotated.reason, null);
            assert.equal(rotated.next.accepted?.generation, 1);
            assert.equal(rotated.next.accepted?.catalog, vector.expected.rotatedCatalogId ?? transportCatalogId(catalogEnvelopeFromCarrierTerm(JSON.parse(vector.rotatedCatalogJson)).catalog));
            observations.push({ initial: observation(result), rotated: observation(rotated) });
        }
        assert.deepEqual(observations[0], observations[1]);
        console.log("PASS BEAM→TS public prepare/catalog/rotation, signed bytes/IDs/payloads/cutoffs/routes and inverse input order");
        return;
    }
    if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out" || !args[1]))
        throw new Error("usage: export_treehouse_catalog_trust.ts [--out <path> | --verify-beam <path>]");
    const output = args[1] === undefined ? fileURLToPath(new URL("../vectors/catalog/ts_trust.json", import.meta.url)) : resolve(args[1]);
    const f = await trustFixture();
    const { catalogRotationEnvelopeFromCarrierTerm } = await import("../../src/treehouse_catalog_codec");
    const rotationEnvelope = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson));
    const expected = { trustRevision: 0, historyGeneration: 0 };
    const prepared = await prepareTreehouseCatalogInstallation({ review: f.review, history: f.histories[0], store: { kind: "verified_fresh", expected } });
    assert.equal(prepared.kind, "propose");
    const initial = await evaluateTreehouseCatalogTrust({ installed: prepared.next, expected,
        incoming: { catalogs: [f.catalogJson], rotations: [], histories: f.histories, cutoffProofs: [] } });
    assert.equal(initial.kind, "propose");
    assert.equal(initial.routes.length, 2);
    const rotatedCatalogJson = await signedCatalog({ ...f.catalog, binding: catalogRotationId(rotationEnvelope) }, f.nextCatalogSigner);
    const rotated = await evaluateTreehouseCatalogTrust({ installed: initial.next, expected,
        incoming: { catalogs: [rotatedCatalogJson], rotations: [f.rotationJson], histories: [], cutoffProofs: f.cutoffProofs } });
    assert.equal(rotated.kind, "propose");
    assert.equal(rotated.next.accepted?.generation, 1);
    const forkCatalogJson = await signedCatalog({ ...f.catalog, revision: 1, previous: transportCatalogId(f.catalog) }, f.catalogSigner);
    const fork = await evaluateTreehouseCatalogTrust({ installed: rotated.next, expected,
        incoming: { catalogs: [forkCatalogJson], rotations: [], histories: [], cutoffProofs: [] } });
    assert.equal(fork.kind, "retain_blocked");
    assert.equal(fork.reason, "catalog_fork");
    const vector = { version: 1, review: f.review, histories: f.histories, cutoffProofs: f.cutoffProofs,
        catalogJson: f.catalogJson, rotationJson: f.rotationJson, rotatedCatalogJson, forkCatalogJson,
        expected: { catalogId: transportCatalogId(f.catalog), rotationId: catalogRotationId(rotationEnvelope),
            catalogObservation: observation(initial), rotationObservation: observation(rotated), forkObservation: observation(fork),
            catalogBytes: b64(canonicalBytesForTransportCatalog(f.catalog)), rotationBytes: b64(canonicalBytesForCatalogRotation(f.rotation)),
            possessionBytes: b64(canonicalBytesForCatalogRotationPossession(f.rotation)),
            payloads: f.histories.flatMap((h) => h.frames.map((frame) => ({ replica: h.replica, id: frame.id, bytes: b64(canonicalBytesForCarrierOp(frame)) }))) } };
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(vector, null, 2)}\n`);
    console.log(`Exported independently signed Space and Thread catalog history to ${output}`);
}
function observation(decision) {
    if (decision.kind === "reject")
        return { kind: decision.kind, reason: decision.reason, detail: decision.detail };
    return { kind: decision.kind, reason: decision.reason, accepted: decision.next.accepted, blocked: decision.next.blocked,
        observed: decision.observed, replacementConfigured: decision.replacementConfigured, routes: decision.routes };
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
