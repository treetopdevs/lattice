import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, canonicalBytesForCarrierOp } from "../../src/codec";
import type { CarrierOpSigner } from "../../src/codec";
import type { CarrierTerm } from "../../src/carrier";
import { bindTownshipReplica, townshipCapTerm } from "../../src/township";
import { authorTreehouseCommand } from "../../src/treehouse";
import { continuationProfileId, continuationProfileToCarrierTerm } from "../../src/continuation";
import type { ContinuationProfile } from "../../src/continuation";
import { canonicalBytesForTransportCatalog, canonicalBytesForCatalogRotation, canonicalBytesForCatalogRotationPossession,
  catalogEnvelopeToCarrierTerm, catalogRotationEnvelopeToCarrierTerm, catalogInventoryId, transportCatalogId, catalogRotationId } from "../../src/treehouse_catalog_codec";
import type { CatalogBootstrap, CatalogEntry, TransportCatalog, CatalogRotation, CatalogCutoff } from "../../src/treehouse_catalog_codec";
import { deriveTreehouseCatalogCutoff } from "../../src/treehouse_catalog_cutoff";

export const fixtureId = (label: string) => createHash("sha256").update(`r11a-trust-ts:${label}`).digest("base64url");
export const fixtureSigner = (label: string): CarrierOpSigner => {
  const seed = createHash("sha256").update(`r11a-trust-ts:${label}`).digest();
  return { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const atom = (name: string): CarrierTerm => ["atom", name];
const tuple = (...items: CarrierTerm[]): CarrierTerm => ["tuple", items];

export async function signedCatalog(catalog: TransportCatalog, signer: CarrierOpSigner): Promise<string> {
  const signature = b64(await signer.sign(canonicalBytesForTransportCatalog(catalog)));
  return JSON.stringify(catalogEnvelopeToCarrierTerm({ catalog, signature }));
}
export async function signedRotation(rotation: CatalogRotation, old: CarrierOpSigner, next: CarrierOpSigner): Promise<string> {
  return JSON.stringify(catalogRotationEnvelopeToCarrierTerm({ rotation,
    oldSignature: b64(await old.sign(canonicalBytesForCatalogRotation(rotation))),
    newSignature: b64(await next.sign(canonicalBytesForCatalogRotationPossession(rotation))) }));
}

/** Independently signed synthetic histories, including distinct Space and child roots. */
export async function trustFixture(threadCount = 1) {
  const root = fixtureSigner("space-root"), catalogSigner = fixtureSigner("catalog"), serviceSigner = fixtureSigner("service");
  const nextCatalogSigner = fixtureSigner("catalog-next"), nominee = fixtureSigner("nominee");
  const witnesses = ["w1", "w2", "w3"].map(fixtureSigner).sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  async function identity(kind: "space" | "thread", label: string, signer: CarrierOpSigner) {
    const replica = await bindTownshipReplica(`replica:treehouse:${kind}:${fixtureId(label)}#authority:bounded-continuation-v1`, signer.publicKey);
    const delegation = await authorCarrierDelegation({ replica, signer, audiencePubkey: signer.publicKey, live: true,
      roles: kind === "space" ? ["admin", "moderator"] : ["moderator"],
      ops: kind === "space" ? ["create_space", "create_thread", "catalog_bootstrap_v1", "replace_catalog_v1"] : ["create_thread", "post", "archive_thread"] });
    const genesis = await authorCarrierOp({ replica, signer, deps: [], kind: "authority", cap: ["nil"],
      body: tuple(atom("genesis"), ["delegation", delegation], ["map", []]) });
    const creation = await authorTreehouseCommand({ product: kind === "space" ? "Treehouse.Space" : "Treehouse.Thread", replica,
      signer, deps: [genesis.id], capId: delegation.id,
      command: kind === "space" ? { command: "create_space", name: "Retained canopy" } : { command: "create_thread", title: label } });
    const profile: ContinuationProfile = { mode: "bounded_continuation", version: 1, product: "treehouse", kind,
      role: kind === "space" ? "admin" : "moderator", nominee: b64(nominee.publicKey),
      witnesses: witnesses.map((w) => b64(w.publicKey)), threshold: 2, maxLeaseEpochs: 7 };
    const empty = await authorCarrierDelegation({ replica, signer, audiencePubkey: signer.publicKey, ops: [], roles: [], live: false });
    const pin = await authorCarrierOp({ replica, signer, deps: [creation.id], kind: "authority", cap: ["nil"],
      body: tuple(atom("genesis"), ["delegation", empty], ["map", [[atom("__continuation__"), continuationProfileToCarrierTerm(profile)!]]]) });
    return { replica, signer, delegation, genesis, creation, pin, profile, frames: [genesis, creation, pin] };
  }
  const space = await identity("space", "space", root);
  const bootstrapRecord: CatalogBootstrap = { version: 1, product: "treehouse", space: space.replica, spaceRoot: b64(root.publicKey),
    profileGenesis: space.pin.id, profileId: continuationProfileId(space.profile)!, replacementRule: "bounded_space_admin_v1",
    catalogKey: b64(catalogSigner.publicKey), serviceId: fixtureId("service"), serviceKey: b64(serviceSigner.publicKey),
    origin: "wss://trust-relay.invalid", nonce: fixtureId("bootstrap") };
  const bootstrap = await authorTreehouseCommand({ product: "Treehouse.Space", replica: space.replica, signer: root,
    deps: [space.pin.id], capId: space.delegation.id, command: { command: "catalog_bootstrap_v1", record: bootstrapRecord } });
  space.frames.push(bootstrap);
  const threads = [];
  for (let i = 0; i < threadCount; i++) {
    const thread = await identity("thread", `thread-${i}`, fixtureSigner(`thread-root-${i}`));
    const reference = await authorTreehouseCommand({ product: "Treehouse.Space", replica: space.replica, signer: root,
      deps: [space.frames.at(-1)!.id], capId: space.delegation.id,
      command: { command: "create_thread", threadReplica: thread.replica, title: `Thread ${i}` } });
    space.frames.push(reference);
    threads.push({ ...thread, reference });
  }
  const entry = (kind: "space" | "thread", item: typeof space, reference: string): CatalogEntry => ({ product: "treehouse", kind,
    schema: kind === "space" ? "treehouse_space_v1" : "treehouse_thread_v1", replica: item.replica,
    root: b64(item.signer.publicKey), genesis: item.genesis.id, creation: item.creation.id, reference,
    route: `/r/${fixtureId(item.replica)}`, serviceId: bootstrapRecord.serviceId, serviceKey: bootstrapRecord.serviceKey });
  const entries = [entry("space", space, bootstrap.id), ...threads.map((t) => entry("thread", t, t.reference.id))]
    .sort((a, b) => Buffer.compare(Buffer.from(a.replica), Buffer.from(b.replica)));
  const catalog: TransportCatalog = { version: 1, product: "treehouse", space: space.replica, bootstrap: bootstrap.id,
    binding: bootstrap.id, revision: 0, previous: null, entries };
  const histories = [space, ...threads].map((item) => ({ replica: item.replica, frames: item.frames, rejected: [] }));
  const cutoffProofs: {cutoff: CatalogCutoff; history: typeof histories[number]}[] = [];
  for (const history of histories) {
    const observed = await deriveTreehouseCatalogCutoff(history);
    assert.equal(observed.ok, true);
    if (observed.ok) cutoffProofs.push({ cutoff: observed.cutoff, history });
  }
  cutoffProofs.sort((a, b) => Buffer.compare(Buffer.from(a.cutoff.replica), Buffer.from(b.cutoff.replica)));
  const rotation: CatalogRotation = { version: 1, product: "treehouse", space: space.replica, bootstrap: bootstrap.id,
    parent: bootstrap.id, priorCatalog: transportCatalogId(catalog), generation: 1,
    newCatalogKey: b64(nextCatalogSigner.publicKey), nonce: fixtureId("rotation"),
    inventoryDigest: catalogInventoryId(entries), cutoffs: cutoffProofs.map((p) => p.cutoff) };
  const catalogJson = await signedCatalog(catalog, catalogSigner), rotationJson = await signedRotation(rotation, catalogSigner, nextCatalogSigner);
  return { space, threads, root, catalogSigner, nextCatalogSigner, serviceSigner, bootstrapRecord, bootstrap,
    review: { version: 1 as const, product: "treehouse" as const, space: space.replica, spaceRoot: bootstrapRecord.spaceRoot,
      bootstrapId: bootstrap.id, observedBootstrapIds: [bootstrap.id], disposition: "pin_exact_observed_bootstrap" as const },
    histories, cutoffProofs, catalog, catalogJson, rotation, rotationJson };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--out" || !args[1])) throw new Error("usage: export_treehouse_catalog_trust.ts [--out <path>]");
  const output = args[1] === undefined ? fileURLToPath(new URL("../vectors/catalog/ts_trust.json", import.meta.url)) : resolve(args[1]);
  const f = await trustFixture();
  const { catalogRotationEnvelopeFromCarrierTerm } = await import("../../src/treehouse_catalog_codec");
  const rotationEnvelope = catalogRotationEnvelopeFromCarrierTerm(JSON.parse(f.rotationJson))!;
  const vector = { version: 1, review: f.review, histories: f.histories, cutoffProofs: f.cutoffProofs,
    catalogJson: f.catalogJson, rotationJson: f.rotationJson,
    expected: { catalogId: transportCatalogId(f.catalog), rotationId: catalogRotationId(rotationEnvelope),
      catalogBytes: b64(canonicalBytesForTransportCatalog(f.catalog)), rotationBytes: b64(canonicalBytesForCatalogRotation(f.rotation)),
      possessionBytes: b64(canonicalBytesForCatalogRotationPossession(f.rotation)),
      payloads: f.histories.flatMap((h) => h.frames.map((frame) => ({ replica: h.replica, id: frame.id, bytes: b64(canonicalBytesForCarrierOp(frame)) }))) } };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(vector, null, 2)}\n`);
  console.log(`Exported independently signed Space and Thread catalog history to ${output}`);
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
