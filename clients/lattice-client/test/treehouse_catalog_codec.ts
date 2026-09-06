import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519.js";
import { canonicalBytesForCarrierTerm } from "../src/codec";
import type { CarrierTerm } from "../src/carrier";
import * as catalogCodec from "../src/treehouse_catalog_codec";
import type {
  CatalogBootstrap, CatalogEntry, CatalogCutoff, TransportCatalog, CatalogRotation,
  CatalogEnvelope, CatalogRotationEnvelope,
} from "../src/treehouse_catalog_codec";

const digest = (name: string) => createHash("sha256").update(name).digest("base64url");
const key = (seed: number) => Buffer.from(ed25519.getPublicKey(Buffer.alloc(32, seed))).toString("base64");
const sign = (bytes: Uint8Array, seed: number) => Buffer.from(ed25519.sign(bytes, Buffer.alloc(32, seed))).toString("base64");
const bootstrap: CatalogBootstrap = {
  version: 1, product: "treehouse", space: "treehouse:space:codec-fixture", spaceRoot: key(1),
  profileGenesis: digest("profile-genesis"), profileId: digest("profile"),
  replacementRule: "bounded_space_admin_v1", catalogKey: key(2), serviceId: digest("service"),
  serviceKey: key(3), origin: "wss://catalog.invalid", nonce: digest("bootstrap-nonce"),
};
const spaceEntry: CatalogEntry = {
  product: "treehouse", replica: bootstrap.space, kind: "space", schema: "treehouse_space_v1",
  root: bootstrap.spaceRoot, genesis: digest("space-genesis"), creation: digest("space-creation"),
  reference: digest("bootstrap"), route: `/r/${digest("space-route")}`,
  serviceId: bootstrap.serviceId, serviceKey: bootstrap.serviceKey,
};
const threadEntry: CatalogEntry = {
  ...spaceEntry, replica: "treehouse:thread:codec-fixture", kind: "thread", schema: "treehouse_thread_v1",
  genesis: digest("thread-genesis"), creation: digest("thread-creation"), reference: digest("thread-reference"),
  route: `/r/${digest("thread-route")}`,
};
const catalog: TransportCatalog = {
  version: 1, product: "treehouse", space: bootstrap.space, bootstrap: spaceEntry.reference,
  binding: spaceEntry.reference, revision: 0, previous: null, entries: [spaceEntry, threadEntry],
};
const cutoff: CatalogCutoff = {
  replica: bootstrap.space, frontier: [digest("head-a"), digest("head-b")].sort(), logDigest: digest("retained-log"),
};
const rotation: CatalogRotation = {
  version: 1, product: "treehouse", space: bootstrap.space, bootstrap: catalog.bootstrap, parent: catalog.binding,
  priorCatalog: digest("prior-catalog"), generation: 1, newCatalogKey: key(4), nonce: digest("rotation-nonce"),
  inventoryDigest: digest("inventory"), cutoffs: [cutoff],
};
const envelope: CatalogEnvelope = { catalog, signature: sign(catalogCodec.canonicalBytesForTransportCatalog(catalog), 2) };
const rotationEnvelope: CatalogRotationEnvelope = {
  rotation, oldSignature: sign(catalogCodec.canonicalBytesForCatalogRotation(rotation), 2),
  newSignature: sign(catalogCodec.canonicalBytesForCatalogRotationPossession(rotation), 4),
};

test("a complete bootstrap preserves its exact reviewed keys and profile binding", () => {
  assert.deepEqual(catalogCodec.normalizeCatalogBootstrap(bootstrap), bootstrap);
  assert.equal(catalogCodec.normalizeCatalogBootstrap({ ...bootstrap, serviceKey: bootstrap.catalogKey }), null);
});

const shapes = [
  [bootstrap, catalogCodec.normalizeCatalogBootstrap, catalogCodec.catalogBootstrapToCarrierTerm, catalogCodec.catalogBootstrapFromCarrierTerm],
  [spaceEntry, catalogCodec.normalizeCatalogEntry, catalogCodec.catalogEntryToCarrierTerm, catalogCodec.catalogEntryFromCarrierTerm],
  [catalog, catalogCodec.normalizeTransportCatalog, catalogCodec.transportCatalogToCarrierTerm, catalogCodec.transportCatalogFromCarrierTerm],
  [envelope, catalogCodec.normalizeCatalogEnvelope, catalogCodec.catalogEnvelopeToCarrierTerm, catalogCodec.catalogEnvelopeFromCarrierTerm],
  [cutoff, catalogCodec.normalizeCatalogCutoff, catalogCodec.catalogCutoffToCarrierTerm, catalogCodec.catalogCutoffFromCarrierTerm],
  [rotation, catalogCodec.normalizeCatalogRotation, catalogCodec.catalogRotationToCarrierTerm, catalogCodec.catalogRotationFromCarrierTerm],
  [rotationEnvelope, catalogCodec.normalizeCatalogRotationEnvelope, catalogCodec.catalogRotationEnvelopeToCarrierTerm, catalogCodec.catalogRotationEnvelopeFromCarrierTerm],
] as const;

test("all seven public shapes round-trip exact fields and reject missing or extra typed and raw fields", () => {
  for (const [value, normalize, encode, decode] of shapes) {
    const before = structuredClone(value);
    assert.deepEqual(normalize(value), value);
    assert.deepEqual(decode(encode(value)), value);
    assert.deepEqual(value, before);
    for (const field of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[field];
      assert.equal(normalize(missing), null, field);
      assert.equal(encode(missing), null, field);
    }
    for (const extra of [{ ...value, unknown: true }, { ...value, [Symbol("extra")]: true }]) assert.equal(normalize(extra), null);
    for (const invalid of [null, undefined, [], new Map(), Object.create(value)]) assert.equal(normalize(invalid), null);
    const nullPrototype = Object.assign(Object.create(null), value);
    assert.deepEqual(normalize(nullPrototype), value);
    const term = encode(value)!;
    assert.equal(term[0], "map");
    if (term[0] !== "map") throw new Error("expected map");
    assert.deepEqual(decode(["map", [...term[1]].reverse()]), value, "canonical map order does not select a different record");
    for (const malformed of [
      ["map", term[1], "extra"], ["map", term[1].slice(1)], ["map", [...term[1], [["atom", "unknown"], ["nil"]]]],
      ["map", [term[1][0], term[1][0], ...term[1].slice(2)]],
      ["map", [[text("version"), ["int", 1]], ...term[1].slice(1)]],
      ["map", [[term[1][0]![0], term[1][0]![1], "extra"], ...term[1].slice(1)]],
      ["map", [undefined, ...term[1].slice(1)]], ["tuple", term[1]],
    ]) assert.equal(decode(malformed), null);
  }
});

test("closed literal versions, products, paired schemas and replacement rules refuse", () => {
  for (const mutation of [{ version: 2 }, { product: "township" }, { replacementRule: "root" }, { space: "" }]) {
    assert.equal(catalogCodec.normalizeCatalogBootstrap({ ...bootstrap, ...mutation }), null);
  }
  for (const mutation of [
    { product: "township" }, { kind: "space", schema: "treehouse_thread_v1" },
    { kind: "thread", schema: "treehouse_space_v1" }, { kind: "catalog" }, { schema: "treehouse_space_v2" },
  ]) assert.equal(catalogCodec.normalizeCatalogEntry({ ...spaceEntry, ...mutation }), null);
  for (const mutation of [{ version: 2 }, { product: "township" }, { space: "" }]) {
    assert.equal(catalogCodec.normalizeTransportCatalog({ ...catalog, ...mutation }), null);
    assert.equal(catalogCodec.normalizeCatalogRotation({ ...rotation, ...mutation }), null);
  }
});

test("typed and decoded keys, signatures and digest IDs require canonical bytes and exact sizes", () => {
  for (const field of ["spaceRoot", "catalogKey", "serviceKey"] as const) {
    for (const bad of [key(1).slice(0, -1), `${key(1)}\n`, Buffer.alloc(31).toString("base64"), Buffer.alloc(33).toString("base64"), 32]) {
      assert.equal(catalogCodec.normalizeCatalogBootstrap({ ...bootstrap, [field]: bad }), null);
    }
  }
  for (const field of ["profileGenesis", "profileId", "serviceId", "nonce"] as const) {
    for (const bad of ["", digest("x") + "=", digest("x").slice(0, -1) + "B", "a".repeat(42), "!".repeat(43), key(1)]) {
      assert.equal(catalogCodec.normalizeCatalogBootstrap({ ...bootstrap, [field]: bad }), null, field);
    }
  }
  for (const signature of [envelope.signature.slice(0, -1), `${envelope.signature}\n`, Buffer.alloc(63).toString("base64"), Buffer.alloc(65).toString("base64")]) {
    assert.equal(catalogCodec.normalizeCatalogEnvelope({ ...envelope, signature }), null);
  }
  const encoded = catalogCodec.catalogBootstrapToCarrierTerm(bootstrap)!;
  for (const [field, value] of [
    ["space_root", text(bootstrap.spaceRoot)], ["profile_id", ["bin", bootstrap.spaceRoot]],
    ["product", text("treehouse")], ["catalog_key", ["bin", bootstrap.catalogKey, "extra"]],
    ["profile_id", ["atom", bootstrap.profileId]],
  ] as const) assert.equal(catalogCodec.catalogBootstrapFromCarrierTerm(changeField(encoded, field, value)), null);
});

test("text preserves Unicode and BOM while refusing lossy surrogate or invalid UTF8 input", () => {
  for (const space of ["\ufeffspace", "space:é", "space:𐀀", 'space:"\\quoted', "space:\u0000"]) {
    const value = { ...bootstrap, space };
    assert.deepEqual(catalogCodec.catalogBootstrapFromCarrierTerm(catalogCodec.catalogBootstrapToCarrierTerm(value)), value);
  }
  for (const space of ["", "space:\ud800", "space:\udfff"]) assert.equal(catalogCodec.normalizeCatalogBootstrap({ ...bootstrap, space }), null);
  const term = catalogCodec.catalogBootstrapToCarrierTerm(bootstrap)!;
  for (const bytes of ["/w==", "wK8=", "7aCA"]) assert.equal(catalogCodec.catalogBootstrapFromCarrierTerm(changeField(term, "space", ["bin", bytes])), null);
});

test("canonical production origins and opaque route nonces have no URL normalization fallback", () => {
  for (const origin of ["wss://catalog.invalid", "wss://catalog", "wss://a-b.c9:1", "wss://a.invalid:65535"]) {
    assert.ok(catalogCodec.normalizeCatalogBootstrap({ ...bootstrap, origin }), origin);
  }
  for (const origin of [
    "ws://catalog.invalid", "WSS://catalog.invalid", "wss://Catalog.invalid", "wss://catalog.invalid/",
    "wss://catalog.invalid/path", "wss://catalog.invalid?x=1", "wss://catalog.invalid#x", "wss://user@catalog.invalid",
    "wss://catalog.invalid.", "wss://.catalog.invalid", "wss://catalog..invalid", "wss://-catalog.invalid",
    "wss://catalog-.invalid", "wss://catalog_invalid", "wss://é.invalid", "wss://catalog.invalid:443",
    "wss://catalog.invalid:0444", "wss://catalog.invalid:0", "wss://catalog.invalid:65536", "wss://catalog.invalid:",
    "wss://127.0.0.1", "wss://[::1]", "wss://2130706433", "wss://0x7f000001", "wss://127.1",
    "wss://0177.0.0.1", `wss://${"a".repeat(64)}.invalid`, "wss://catalog.invalid\n",
  ]) assert.equal(catalogCodec.normalizeCatalogBootstrap({ ...bootstrap, origin }), null, origin);
  for (const route of ["", "/r/x", `/r/${digest("route")}/`, `/r/${digest("route")}?x=1`, `/r/${digest("route")}=`, "/r/../x", `wss://catalog.invalid/r/${digest("route")}`]) {
    assert.equal(catalogCodec.normalizeCatalogEntry({ ...spaceEntry, route }), null, route);
  }
});

test("revision and rotation integers are portable and first-snapshot nil is exact", () => {
  for (const revision of [0, 1, Number.MAX_SAFE_INTEGER]) {
    const value = { ...catalog, revision, previous: revision === 0 ? null : digest("previous") };
    assert.deepEqual(catalogCodec.transportCatalogFromCarrierTerm(catalogCodec.transportCatalogToCarrierTerm(value)), value);
  }
  for (const number of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1", 1n]) {
    assert.equal(catalogCodec.normalizeTransportCatalog({ ...catalog, revision: number }), null);
    assert.equal(catalogCodec.normalizeCatalogRotation({ ...rotation, generation: number }), null);
  }
  assert.equal(catalogCodec.normalizeCatalogRotation({ ...rotation, generation: 0 }), null);
  assert.ok(catalogCodec.normalizeCatalogRotation({ ...rotation, generation: Number.MAX_SAFE_INTEGER }));
  assert.equal(catalogCodec.normalizeCatalogRotation({ ...rotation, priorCatalog: null }), null);
  assert.equal(catalogCodec.normalizeTransportCatalog({ ...catalog, revision: 1 }), null);
  assert.equal(catalogCodec.normalizeTransportCatalog({ ...catalog, previous: digest("previous") }), null);
  const term = catalogCodec.transportCatalogToCarrierTerm(catalog)!;
  for (const previous of [["atom", "nil"], ["nil", "extra"], null]) assert.equal(catalogCodec.transportCatalogFromCarrierTerm(changeField(term, "previous", previous)), null);
  const rotationTerm = catalogCodec.catalogRotationToCarrierTerm(rotation)!;
  assert.deepEqual(catalogCodec.catalogRotationFromCarrierTerm(changeField(rotationTerm, "generation", ["int", "1"])), rotation);
  for (const number of ["01", "1.0", "+1", " 1", "9007199254740992"]) {
    assert.equal(catalogCodec.catalogRotationFromCarrierTerm(changeField(rotationTerm, "generation", ["int", number])), null);
  }
});

test("catalog inventory retains sorted distinct full replica IDs, twelve Thread slots and one service identity", () => {
  const threads = Array.from({ length: 12 }, (_, index) => ({
    ...threadEntry, replica: `treehouse:thread:${String(index).padStart(2, "0")}`, route: `/r/${digest(`route-${index}`)}`,
  }));
  const full = { ...catalog, entries: [spaceEntry, ...threads] };
  assert.ok(catalogCodec.normalizeTransportCatalog(full));
  assert.equal(catalogCodec.normalizeTransportCatalog({ ...full, entries: [...full.entries, { ...threadEntry, replica: "zz", route: `/r/${digest("thirteenth")}` }] }), null);
  for (const entries of [
    [], [threadEntry], [spaceEntry, { ...threadEntry, kind: "space", schema: "treehouse_space_v1" }],
    [threadEntry, spaceEntry], [spaceEntry, spaceEntry], [spaceEntry, , threadEntry],
    [spaceEntry, { ...threadEntry, route: spaceEntry.route }],
    [spaceEntry, { ...threadEntry, serviceKey: key(7) }], [spaceEntry, { ...threadEntry, serviceId: digest("other-service") }],
  ]) assert.equal(catalogCodec.normalizeTransportCatalog({ ...catalog, entries }), null);
  const replicas = ["t:One", "t:One more", 't:quote"', "t:slash\\", "t:é", "t:\ue000", "t:𐀀"];
  const unicodeEntries = replicas.map((replica) => ({ ...threadEntry, replica, route: `/r/${digest(replica)}` }));
  const unicodeSpace = { ...spaceEntry, replica: "a:space" };
  const ordered = { ...catalog, space: unicodeSpace.replica, entries: [unicodeSpace, ...unicodeEntries] };
  assert.ok(catalogCodec.normalizeTransportCatalog(ordered));
  const utf16Sorted = [...ordered.entries].sort((a, b) => a.replica < b.replica ? -1 : 1);
  assert.equal(catalogCodec.normalizeTransportCatalog({ ...ordered, entries: utf16Sorted }), null);
  assert.deepEqual(ordered.entries.map((entry) => entry.replica), ["a:space", ...replicas], "validator does not mutate signed order");
});

test("catalog literal Space and bootstrap references cannot contradict its own entry", () => {
  assert.equal(catalogCodec.normalizeTransportCatalog({ ...catalog, space: "another-space" }), null);
  assert.equal(catalogCodec.normalizeTransportCatalog({ ...catalog, entries: [{ ...spaceEntry, reference: digest("another-bootstrap") }, threadEntry] }), null);
});

test("rotation cutoffs preserve exact sorted evidence with bounded replicas and no silent frontier sorting", () => {
  assert.ok(catalogCodec.normalizeCatalogCutoff({ ...cutoff, frontier: [] }), "empty frontier is judged against actual history by caller");
  for (const frontier of [[...cutoff.frontier].reverse(), [cutoff.frontier[0], cutoff.frontier[0]], [cutoff.frontier[0], , cutoff.frontier[1]], ["invalid"]]) {
    assert.equal(catalogCodec.normalizeCatalogCutoff({ ...cutoff, frontier }), null);
  }
  const many = Array.from({ length: 13 }, (_, index) => ({ ...cutoff, replica: `r:${String(index).padStart(2, "0")}` }));
  assert.ok(catalogCodec.normalizeCatalogRotation({ ...rotation, cutoffs: many }));
  for (const cutoffs of [[], [...many, { ...cutoff, replica: "z" }], [...many].reverse(), [cutoff, cutoff], [cutoff, , cutoff]]) {
    assert.equal(catalogCodec.normalizeCatalogRotation({ ...rotation, cutoffs }), null);
  }
  const unicode = ["r:One", "r:One more", "r:\ue000", "r:𐀀"].map((replica) => ({ ...cutoff, replica }));
  assert.ok(catalogCodec.normalizeCatalogRotation({ ...rotation, cutoffs: unicode }));
  assert.equal(catalogCodec.normalizeCatalogRotation({ ...rotation, cutoffs: [unicode[0], unicode[1], unicode[3], unicode[2]] }), null);
});

test("catalog signature uses only the caller's key and refuses tampering or an envelope-chosen signer", () => {
  assert.equal(catalogCodec.verifyCatalogEnvelope(envelope, key(2)), true);
  for (const suppliedKey of [key(3), key(2).slice(0, -1), null]) assert.equal(catalogCodec.verifyCatalogEnvelope(envelope, suppliedKey), false);
  for (const value of [
    { ...envelope, catalogKey: key(2) }, { ...envelope, signature: sign(catalogCodec.canonicalBytesForTransportCatalog(catalog), 3) },
    { ...envelope, signature: Buffer.alloc(64).toString("base64") },
    { ...envelope, catalog: { ...catalog, binding: digest("other-binding") } },
    { ...envelope, catalog: { ...catalog, entries: [spaceEntry, { ...threadEntry, route: `/r/${digest("redirect")}` }] } },
  ]) assert.equal(catalogCodec.verifyCatalogEnvelope(value, key(2)), false);
  const wrongDomain = canonicalBytesForCarrierTerm(["list", [text("lattice-treehouse-catalog-rotation-v1"), catalogCodec.transportCatalogToCarrierTerm(catalog)!]]);
  assert.equal(catalogCodec.verifyCatalogEnvelope({ catalog, signature: sign(wrongDomain, 2) }, key(2)), false);
  const raw = catalogCodec.catalogEnvelopeToCarrierTerm(envelope)!;
  const catalogTerm = catalogCodec.transportCatalogToCarrierTerm(catalog)!;
  assert.equal(catalogTerm[0], "map");
  if (catalogTerm[0] !== "map") throw new Error("expected map");
  const duplicate = ["map", [...catalogTerm[1], catalogTerm[1][0]]];
  assert.equal(catalogCodec.catalogEnvelopeFromCarrierTerm(changeField(raw, "catalog", duplicate)), null, "signed duplicate raw fields refuse before verification");
  const decoded = catalogCodec.catalogEnvelopeFromCarrierTerm(raw);
  assert.equal(catalogCodec.verifyCatalogEnvelope(decoded, key(2)), true);
});

test("planned rotation requires distinct old and new keys and both exact-purpose signatures", () => {
  assert.equal(catalogCodec.verifyCatalogRotationEnvelope(rotationEnvelope, key(2)), true);
  assert.equal(catalogCodec.verifyCatalogRotationEnvelope(rotationEnvelope, key(3)), false);
  for (const value of [
    { ...rotationEnvelope, oldSignature: rotationEnvelope.newSignature },
    { ...rotationEnvelope, newSignature: rotationEnvelope.oldSignature },
    { ...rotationEnvelope, oldSignature: Buffer.alloc(64).toString("base64") },
    { ...rotationEnvelope, newSignature: sign(catalogCodec.canonicalBytesForCatalogRotationPossession(rotation), 3) },
    { ...rotationEnvelope, serviceKey: key(3) },
  ]) assert.equal(catalogCodec.verifyCatalogRotationEnvelope(value, key(2)), false);
  const sameKey = { ...rotation, newCatalogKey: key(2) };
  assert.equal(catalogCodec.verifyCatalogRotationEnvelope({
    rotation: sameKey, oldSignature: sign(catalogCodec.canonicalBytesForCatalogRotation(sameKey), 2),
    newSignature: sign(catalogCodec.canonicalBytesForCatalogRotationPossession(sameKey), 2),
  }, key(2)), false);
  const wrongPurpose = canonicalBytesForCarrierTerm(["list", [text("lattice-treehouse-transport-possession-v1"), ["atom", "service"], catalogCodec.catalogRotationToCarrierTerm(rotation)!]]);
  assert.equal(catalogCodec.verifyCatalogRotationEnvelope({ ...rotationEnvelope, newSignature: sign(wrongPurpose, 4) }, key(2)), false);
  for (const mutation of [
    { parent: digest("another-parent") }, { priorCatalog: digest("another-catalog") }, { nonce: digest("new-nonce") },
    { inventoryDigest: digest("changed-inventory") }, { generation: 2 },
    { cutoffs: [{ ...cutoff, logDigest: digest("changed-log") }] }, { cutoffs: [{ ...cutoff, frontier: [digest("changed-head")] }] },
    { newCatalogKey: key(5) }, { space: "different-space" }, { bootstrap: digest("different-bootstrap") },
  ]) assert.equal(catalogCodec.verifyCatalogRotationEnvelope({ ...rotationEnvelope, rotation: { ...rotation, ...mutation } }, key(2)), false);
});

test("public bytes and IDs use exact domains, raw key binaries, atom fields and complete rotation envelopes", () => {
  const entryTerm: CarrierTerm = ["map", [
    [atom("product"), atom("treehouse")], [atom("replica"), text(spaceEntry.replica)], [atom("kind"), atom("space")],
    [atom("schema"), atom("treehouse_space_v1")], [atom("root"), ["bin", spaceEntry.root]],
    [atom("genesis"), text(spaceEntry.genesis)], [atom("creation"), text(spaceEntry.creation)],
    [atom("reference"), text(spaceEntry.reference)], [atom("route"), text(spaceEntry.route)],
    [atom("service_id"), text(spaceEntry.serviceId)], [atom("service_key"), ["bin", spaceEntry.serviceKey]],
  ]];
  assert.deepEqual(catalogCodec.catalogEntryToCarrierTerm(spaceEntry), entryTerm);
  const single = { ...catalog, entries: [spaceEntry] };
  const expected: CarrierTerm = ["map", [
    [atom("version"), ["int", 1]], [atom("product"), atom("treehouse")], [atom("space"), text(catalog.space)],
    [atom("bootstrap"), text(catalog.bootstrap)], [atom("binding"), text(catalog.binding)],
    [atom("revision"), ["int", 0]], [atom("previous"), ["nil"]], [atom("entries"), ["list", [entryTerm]]],
  ]];
  const bytes = canonicalBytesForCarrierTerm(["list", [text("lattice-treehouse-transport-catalog-v1"), expected]]);
  assert.deepEqual(catalogCodec.canonicalBytesForTransportCatalog(single), bytes);
  assert.equal(catalogCodec.transportCatalogId(single), createHash("sha256").update(bytes).digest("base64url"));
  const inventoryBytes = canonicalBytesForCarrierTerm(["list", [text("lattice-treehouse-route-inventory-v1"), ["list", [entryTerm]]]]);
  assert.deepEqual(catalogCodec.canonicalBytesForCatalogInventory([spaceEntry]), inventoryBytes);
  assert.equal(catalogCodec.catalogInventoryId([spaceEntry]), createHash("sha256").update(inventoryBytes).digest("base64url"));
  const completeRotation = catalogCodec.catalogRotationEnvelopeToCarrierTerm(rotationEnvelope)!;
  const bindingBytes = canonicalBytesForCarrierTerm(["list", [text("lattice-treehouse-catalog-rotation-v1"), completeRotation]]);
  assert.equal(catalogCodec.catalogRotationId(rotationEnvelope), createHash("sha256").update(bindingBytes).digest("base64url"));
  assert.notEqual(catalogCodec.catalogRotationId(rotationEnvelope), catalogCodec.catalogRotationId({ ...rotationEnvelope, newSignature: Buffer.alloc(64).toString("base64") }));
  assert.equal(catalogCodec.catalogServiceRealm(bootstrap.serviceId), `treehouse-service:${bootstrap.serviceId}`);
  for (const serviceId of ["", `${bootstrap.serviceId}=`, bootstrap.serviceId.slice(0, -1) + "B", key(3)]) {
    assert.throws(() => catalogCodec.catalogServiceRealm(serviceId), TypeError);
  }
  for (const fn of [
    catalogCodec.canonicalBytesForTransportCatalog, catalogCodec.transportCatalogId,
    catalogCodec.canonicalBytesForCatalogRotation, catalogCodec.canonicalBytesForCatalogRotationPossession,
    catalogCodec.catalogRotationId, catalogCodec.canonicalBytesForCatalogInventory, catalogCodec.catalogInventoryId,
  ]) assert.throws(() => fn({ malformed: true }), TypeError);
});

function atom(value: string): CarrierTerm { return ["atom", value]; }
function text(value: string): CarrierTerm { return ["bin", Buffer.from(value).toString("base64")]; }
function changeField(term: CarrierTerm, field: string, replacement: unknown): unknown {
  assert.equal(term[0], "map");
  if (term[0] !== "map") throw new Error("expected map");
  return ["map", term[1].map(([key, value]) => [key, key[0] === "atom" && key[1] === field ? replacement : value])];
}
