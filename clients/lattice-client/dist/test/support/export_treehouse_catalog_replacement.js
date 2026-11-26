// TS-authored `replace_catalog_v1` evidence for the BEAM reciprocal test (plan 316 PR 1).
// Writes only to the scratch path the caller passes; nothing is committed from here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, verifyCarrierOp } from "../../src/codec";
import { carrierOpsToSemanticOps } from "../../src/carrier";
import { bindTownshipReplica, townshipCapTerm } from "../../src/township";
import { continuationProfileId, continuationProfileToCarrierTerm } from "../../src/continuation";
import { observeTreehouse, treehouseCommandDecoders } from "../../src/treehouse";
import { deriveTreehouseCatalogCutoff } from "../../src/treehouse_catalog_cutoff";
import { compareUtf8 } from "../../src/op";
import { canonicalBytesForCatalogInventory, canonicalBytesForCatalogReplacementClaim, canonicalBytesForCatalogReplacementPossession, catalogBootstrapToCarrierTerm, catalogEntryToCarrierTerm, catalogInventoryId, catalogReplacementClaimToCarrierTerm, verifyCatalogReplacementPossession, } from "../../src/treehouse_catalog_codec";
const atom = (name) => ["atom", name];
const tuple = (...values) => ["tuple", values];
const nil = ["nil"];
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const text = (value) => ["bin", b64(new TextEncoder().encode(value))];
export function seededSigner(label) {
    const seed = createHash("sha256").update(label).digest();
    return { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
}
/** A TS-only bootstrap history; same construction as the bootstrap test fixture, other seeds. */
export async function replacementBaseFixture(prefix = "r316-ts-") {
    const id = (label) => createHash("sha256").update(`${prefix}${label}`).digest("base64url");
    const root = seededSigner(`${prefix}root`), nominee = seededSigner(`${prefix}nominee`);
    const witnesses = [1, 2, 3].map((n) => seededSigner(`${prefix}w${n}`)).sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
    const replica = await bindTownshipReplica(`replica:treehouse:space:${id("space")}#authority:bounded-continuation-v1`, root.publicKey);
    const delegation = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: root.publicKey,
        ops: ["create_space", "create_thread", "catalog_bootstrap_v1", "replace_catalog_v1"], roles: ["admin", "moderator"], live: true });
    const genesis = await authorCarrierOp({ replica, signer: root, deps: [], kind: "authority", cap: nil,
        body: tuple(atom("genesis"), ["delegation", delegation], ["map", []]) });
    const creation = await authorCarrierOp({ replica, signer: root, deps: [genesis.id], kind: "command", cap: townshipCapTerm(delegation.id),
        body: tuple(atom("create_space"), ["list", [text("Canopy")]]) });
    const profile = { mode: "bounded_continuation", version: 1, product: "treehouse", kind: "space", role: "admin",
        nominee: b64(nominee.publicKey), witnesses: witnesses.map((w) => b64(w.publicKey)), threshold: 2, maxLeaseEpochs: 7 };
    const empty = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: root.publicKey, ops: [], roles: [], live: false });
    const pin = await authorCarrierOp({ replica, signer: root, deps: [creation.id], kind: "authority", cap: nil,
        body: tuple(atom("genesis"), ["delegation", empty], ["map", [[atom("__continuation__"), continuationProfileToCarrierTerm(profile)]]]) });
    const record = { version: 1, product: "treehouse", space: replica, spaceRoot: b64(root.publicKey),
        profileGenesis: pin.id, profileId: continuationProfileId(profile), replacementRule: "bounded_space_admin_v1",
        catalogKey: b64(seededSigner(`${prefix}catalog`).publicKey), serviceId: id("service"), serviceKey: b64(seededSigner(`${prefix}service`).publicKey),
        origin: "wss://ts-relay.invalid", nonce: id("bootstrap-nonce") };
    const bootstrap = await authorCarrierOp({ replica, signer: root, deps: [pin.id], kind: "command", cap: townshipCapTerm(delegation.id),
        body: tuple(atom("catalog_bootstrap_v1"), ["list", [catalogBootstrapToCarrierTerm(record)]]) });
    return { root, nominee, replica, delegation, genesis, creation, pin, record, bootstrap, frames: [genesis, creation, pin, bootstrap] };
}
/** Retained bad-signature evidence, a beacon, then one valid root-authored replacement. */
export async function replacementHistory(base, prefix = "r316-ts-") {
    const id = (label) => createHash("sha256").update(`${prefix}${label}`).digest("base64url");
    const newCatalog = seededSigner(`${prefix}new-catalog`), newService = seededSigner(`${prefix}new-service`);
    const cap = townshipCapTerm(base.delegation.id);
    const genuine = await authorCarrierOp({ replica: base.replica, signer: base.root, deps: [base.bootstrap.id], kind: "command", cap,
        body: tuple(atom("create_space"), ["list", [text("Retained")]]) });
    const forged = { ...genuine, sig: b64(new Uint8Array(64)) };
    const beacon = await authorCarrierOp({ replica: base.replica, signer: base.root, deps: [genuine.id], kind: "authority", cap: nil,
        body: tuple(atom("beacon"), ["int", 1]) });
    const before = [...base.frames, genuine, beacon];
    const cutoff = await deriveTreehouseCatalogCutoff({ replica: base.replica, frames: before, rejected: [{ frame: forged, reason: "bad_signature" }] });
    assert.equal(cutoff.ok, true);
    if (!cutoff.ok)
        throw new Error("cutoff");
    const entries = [{ product: "treehouse", replica: base.replica, kind: "space", schema: "treehouse_space_v1",
            root: b64(base.root.publicKey), genesis: base.genesis.id, creation: base.creation.id, reference: base.bootstrap.id,
            route: `/r/${id("space-route")}`, serviceId: id("new-service"), serviceKey: b64(newService.publicKey) }];
    const claim = { version: 1, product: "treehouse", space: base.replica, bootstrap: base.bootstrap.id,
        profileGenesis: base.record.profileGenesis, profileId: base.record.profileId, parents: [base.bootstrap.id],
        priorCatalogs: [{ binding: base.bootstrap.id, catalog: null }], generation: 1, nonce: id("nonce"),
        newCatalogKey: b64(newCatalog.publicKey), newServiceId: id("new-service"), newServiceKey: b64(newService.publicKey),
        newOrigin: "wss://ts-replacement.invalid", inventoryDigest: catalogInventoryId(entries), cutoffs: [cutoff.cutoff],
        author: b64(base.root.publicKey), cap: base.delegation.id, holderEpoch: base.genesis.id, deps: [beacon.id], epoch: 1, epochBasis: [beacon.id] };
    const sign = (value) => [catalogReplacementClaimToCarrierTerm(value),
        ["bin", b64(newCatalog.sign(canonicalBytesForCatalogReplacementPossession("catalog", value)))],
        ["bin", b64(newService.sign(canonicalBytesForCatalogReplacementPossession("service", value)))]];
    const op = (args, overrides = {}) => authorCarrierOp({ replica: base.replica, signer: base.root, deps: [beacon.id], kind: "command", cap,
        body: tuple(atom("replace_catalog_v1"), ["list", args]), ...overrides });
    const args = sign(claim);
    const replacement = await op(args);
    const catalogPossession = args[1][1], servicePossession = args[2][1];
    assert.equal(verifyCatalogReplacementPossession(claim, catalogPossession, servicePossession), true);
    return { base, newCatalog, newService, genuine, forged, beacon, before, entries, claim, catalogPossession, servicePossession,
        cutoff, replacement, sign, op };
}
/** Stage A refusals over `before`, each with its own extra prefix frames. */
export async function stageACases(h) {
    const { base, claim } = h;
    const term = catalogReplacementClaimToCarrierTerm(claim);
    const cp = ["bin", h.catalogPossession], sp = ["bin", h.servicePossession];
    const unseen = createHash("sha256").update("r316-ts-unseen").digest("base64url");
    const badRecord = { ...base.record, spaceRoot: b64(base.nominee.publicKey) };
    const badBootstrap = await authorCarrierOp({ replica: base.replica, signer: base.root, deps: [base.pin.id], kind: "command",
        cap: townshipCapTerm(base.delegation.id), body: tuple(atom("catalog_bootstrap_v1"), ["list", [catalogBootstrapToCarrierTerm(badRecord)]]) });
    const quarantinedDeps = [h.beacon.id, badBootstrap.id].sort(compareUtf8);
    const quarantinedClaim = { ...claim, bootstrap: badBootstrap.id, deps: quarantinedDeps };
    return [
        { name: "malformed-claim-extra-field", prefix: [], frame: await h.op([["map", [...term[1], [atom("extra"), ["int", 1]]]], cp, sp]) },
        { name: "malformed-claim-nil", prefix: [], frame: await h.op([nil, cp, sp]) },
        { name: "wrong-author-field", prefix: [], frame: await h.op(h.sign({ ...claim, author: b64(base.nominee.publicKey) })) },
        { name: "wrong-cap-field", prefix: [], frame: await h.op(h.sign({ ...claim, cap: base.genesis.id })) },
        { name: "deps-differ-from-op", prefix: [], frame: await h.op(h.sign(claim), { deps: [base.bootstrap.id] }) },
        { name: "holder-epoch-not-visible", prefix: [], frame: await h.op(h.sign({ ...claim, holderEpoch: unseen })) },
        { name: "bootstrap-not-visible", prefix: [], frame: await h.op(h.sign({ ...claim, bootstrap: unseen })) },
        { name: "bootstrap-not-a-bootstrap-op", prefix: [], frame: await h.op(h.sign({ ...claim, bootstrap: base.creation.id })) },
        { name: "bootstrap-quarantined", prefix: [badBootstrap], frame: await h.op(h.sign(quarantinedClaim), { deps: quarantinedDeps }) },
        { name: "wrong-space", prefix: [], frame: await h.op(h.sign({ ...claim, space: "another-space" })) },
        { name: "bad-catalog-possession", prefix: [], frame: await h.op([term, sp, sp]) },
        { name: "bad-service-possession", prefix: [], frame: await h.op([term, cp, cp]) },
        { name: "non-binary-possession", prefix: [], frame: await h.op([term, atom("admin"), sp]) },
        // Wire uint64s above 2^53 - 1 reach the replacement decoder as opaque sentinels, never malformed_term.
        { name: "high-generation", prefix: [], frame: await h.op([withField(term, "generation", high), cp, sp]) },
        { name: "high-epoch", prefix: [], frame: await h.op([withField(term, "epoch", high), cp, sp]) },
        { name: "high-integer-possession", prefix: [], frame: await h.op([term, high, sp]) },
    ];
}
const high = ["int", "9007199254740992"];
function withField(term, field, value) {
    const pairs = term[1].map(([key, item]) => [key, JSON.stringify(key) === JSON.stringify(atom(field)) ? value : item]);
    assert.ok(pairs.some(([key]) => JSON.stringify(key) === JSON.stringify(atom(field))), field);
    return ["map", pairs];
}
export async function judge(frames) {
    for (const frame of frames) {
        const checked = await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, Buffer.from(pub, "base64"), { zip215: false }) });
        assert.equal(checked.valid, true, `authentic fixture ${frame.id}`);
    }
    const ops = carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
    return observeTreehouse("Treehouse.Space", ops).quarantineReasons;
}
async function main() {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--out" || !args[1])
        throw new Error("usage: export_treehouse_catalog_replacement.ts --out <scratch path>");
    const h = await replacementHistory(await replacementBaseFixture());
    const frames = [...h.before, h.replacement];
    assert.equal((await judge(frames)).size, 0, "valid TS replacement is Core-honored in TS");
    const stageA = [];
    for (const c of await stageACases(h)) {
        const reason = (await judge([...h.before, ...c.prefix, c.frame])).get(c.frame.id);
        assert.equal(reason, "application_invalid_catalog", c.name);
        stageA.push({ name: c.name, prefix: c.prefix, frame: c.frame, reason });
    }
    if (!h.cutoff.ok)
        throw new Error("cutoff");
    const vector = {
        version: 1,
        claim_term: catalogReplacementClaimToCarrierTerm(h.claim),
        claim_bytes: b64(canonicalBytesForCatalogReplacementClaim(h.claim)),
        catalog_key: b64(h.newCatalog.publicKey),
        service_key: b64(h.newService.publicKey),
        catalog_possession_bytes: b64(canonicalBytesForCatalogReplacementPossession("catalog", h.claim)),
        service_possession_bytes: b64(canonicalBytesForCatalogReplacementPossession("service", h.claim)),
        catalog_possession: h.catalogPossession,
        service_possession: h.servicePossession,
        inventory_term: ["list", h.entries.map((entry) => catalogEntryToCarrierTerm(entry))],
        inventory_bytes: b64(canonicalBytesForCatalogInventory(h.entries)),
        cutoff: { replica: h.base.replica, frames: h.before, rejected_frames: [{ frame: h.forged, reason: "bad_signature" }],
            frontier: h.cutoff.cutoff.frontier, log_digest: h.cutoff.cutoff.logDigest, canonical_bytes: b64(h.cutoff.canonicalBytes) },
        replica: h.base.replica,
        frames,
        binding_id: h.replacement.id,
        stage_a: stageA,
    };
    const output = resolve(args[1]);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(vector, null, 2)}\n`);
    console.log(`Exported TS-signed catalog replacement claim to ${output}`);
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    await main();
