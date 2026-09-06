import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { normalizeCatalogBootstrap } from "../src/treehouse_catalog_codec";

const digest = (name: string) => createHash("sha256").update(name).digest("base64url");
const key = (seed: number) => Buffer.from(ed25519.getPublicKey(Buffer.alloc(32, seed))).toString("base64");
const bootstrap = {
  version: 1, product: "treehouse", space: "treehouse:space:codec-fixture", spaceRoot: key(1),
  profileGenesis: digest("profile-genesis"), profileId: digest("profile"),
  replacementRule: "bounded_space_admin_v1", catalogKey: key(2), serviceId: digest("service"),
  serviceKey: key(3), origin: "wss://catalog.invalid", nonce: digest("bootstrap-nonce"),
};

test("a complete bootstrap preserves its exact reviewed keys and profile binding", () => {
  assert.deepEqual(normalizeCatalogBootstrap(bootstrap), bootstrap);
  assert.equal(normalizeCatalogBootstrap({ ...bootstrap, serviceKey: bootstrap.catalogKey }), null);
});
