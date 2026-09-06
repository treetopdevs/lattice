import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, verifyCarrierOp } from "../src/codec";
import type { CarrierOpSigner } from "../src/codec";
import { carrierOpsToSemanticOps } from "../src/carrier";
import type { CarrierOpFrame, CarrierTerm } from "../src/carrier";
import { bindTownshipReplica, townshipCapTerm } from "../src/township";
import { continuationProfileId, continuationProfileToCarrierTerm } from "../src/continuation";
import type { ContinuationProfile } from "../src/continuation";
import { catalogBootstrapToCarrierTerm } from "../src/treehouse_catalog_codec";
import type { CatalogBootstrap } from "../src/treehouse_catalog_codec";
import { observeTreehouse, treehouseCommandDecoders } from "../src/treehouse";

const atom = (name: string): CarrierTerm => ["atom", name];
const tuple = (...values: CarrierTerm[]): CarrierTerm => ["tuple", values];
const nil: CarrierTerm = ["nil"];
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const id = (label: string) => createHash("sha256").update(`r11a-beam-${label}`).digest("base64url");
const signer = (label: string): CarrierOpSigner => {
  const seed = createHash("sha256").update(`r11a-history-${label}`).digest();
  return { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
};

// Same deterministic public history as Treehouse.CatalogVectors.bootstrap_history/0.
async function fixture() {
  const root = signer("root"), catalog = signer("catalog"), service = signer("service"), nominee = signer("nominee");
  const witnesses = [signer("w1"), signer("w2"), signer("w3")].sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  const replica = await bindTownshipReplica(`replica:treehouse:space:${id("history-space")}#authority:bounded-continuation-v1`, root.publicKey);
  const delegation = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: root.publicKey,
    ops: ["create_space", "create_thread", "catalog_bootstrap_v1", "replace_catalog_v1"], roles: ["admin", "moderator"], live: true });
  const genesis = await authorCarrierOp({ replica, signer: root, deps: [], kind: "authority", cap: nil,
    body: tuple(atom("genesis"), ["delegation", delegation], ["map", []]) });
  const creation = await authorCarrierOp({ replica, signer: root, deps: [genesis.id], kind: "command", cap: townshipCapTerm(delegation.id),
    body: tuple(atom("create_space"), ["list", [["bin", b64(new TextEncoder().encode("Canopy"))]]]) });
  const profile: ContinuationProfile = { mode: "bounded_continuation", version: 1, product: "treehouse", kind: "space", role: "admin",
    nominee: b64(nominee.publicKey), witnesses: witnesses.map((w) => b64(w.publicKey)), threshold: 2, maxLeaseEpochs: 7 };
  const empty = await authorCarrierDelegation({ replica, signer: root, audiencePubkey: root.publicKey, ops: [], roles: [], live: false });
  const pin = await authorCarrierOp({ replica, signer: root, deps: [creation.id], kind: "authority", cap: nil,
    body: tuple(atom("genesis"), ["delegation", empty], ["map", [[atom("__continuation__"), continuationProfileToCarrierTerm(profile)!]]]) });
  const record: CatalogBootstrap = { version: 1, product: "treehouse", space: replica, spaceRoot: b64(root.publicKey),
    profileGenesis: pin.id, profileId: continuationProfileId(profile)!, replacementRule: "bounded_space_admin_v1",
    catalogKey: b64(catalog.publicKey), serviceId: id("history-service"), serviceKey: b64(service.publicKey),
    origin: "wss://history-relay.invalid", nonce: id("history-bootstrap") };
  const bootstrap = await authorCarrierOp({ replica, signer: root, deps: [pin.id], kind: "command", cap: townshipCapTerm(delegation.id),
    body: tuple(atom("catalog_bootstrap_v1"), ["list", [catalogBootstrapToCarrierTerm(record)!]]) });
  return { root, catalog, service, nominee, replica, delegation, genesis, creation, profile, pin, record, bootstrap,
    before: [genesis, creation, pin], frames: [genesis, creation, pin, bootstrap] };
}

async function authenticated(frames: CarrierOpFrame[]) {
  for (const frame of frames) {
    const checked = await verifyCarrierOp(frame, { verify: async (pub, bytes, sig) => ed25519.verify(sig, bytes, Buffer.from(pub, "base64"), { zip215: false }) });
    assert.equal(checked.valid, true, `authentic fixture ${frame.id}`);
  }
  return carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Space"));
}

test("signed root catalog bootstrap matches the BEAM admin marker without adding materialized fields", async () => {
  const f = await fixture();
  const ops = await authenticated(f.frames);
  const result = observeTreehouse("Treehouse.Space", ops);
  assert.equal(result.quarantineReasons.get(f.bootstrap.id), undefined);
  assert.equal(result.state.admin_actions, "catalog_bootstrap_v1");
  assert.equal(result.state.name, "Canopy");
  assert.equal(Object.hasOwn(result.state, "catalog_controls"), false);
  assert.equal(result.operationCount, 4);
  assert.deepEqual(ops.find((op) => op.id === f.bootstrap.id)!.commandArgs, [f.record]);
});
