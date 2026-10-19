import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  prepareTreehouseBoundedSpaceCreation, prepareTreehouseSpaceCreation, treehouseSpaceFamily,
  treehouseContinuationPin, authorTreehouseContinuationPin, reviewTreehouseCatalogBindingPayload,
  authorTreehouseCatalogBootstrap, resolveContinuationProfileFromFrames, treehouseCatalogBootstrapsFromFrames,
} from "../src/index";
import { authorCarrierDelegation, authorCarrierOp, canonicalBytesForCarrierTerm } from "../src/codec";
import { carrierDelegationsFromFrames } from "../src/carrier";
import { continuationProfileToCarrierTerm } from "../src/continuation";
import { canonicalOrder, carrierOpsToSemanticOps, index } from "../src/index";
import { treehouseCommandDecoders } from "../src/treehouse";
import { authorTownshipGenesis, authorTownshipRevocation } from "../src/township";
import { catalogBootstrapToCarrierTerm } from "../src/treehouse_catalog_codec";
import type { CarrierOpFrame, CarrierOpSigner } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(readFileSync(join(here, "vectors/treehouse/bounded_space_binding_v1.json"), "utf8"));
const signerOf = (hex: string): CarrierOpSigner => {
  const seed = Buffer.from(hex, "hex");
  return { publicKey: ed25519.getPublicKey(seed), sign: (bytes) => ed25519.sign(bytes, seed) };
};
const s = vector.seeds;
const root = signerOf(s.root), nominee = signerOf(s.nominee), witnesses = [s.w1, s.w2, s.w3].map(signerOf);
const expectedFrames: CarrierOpFrame[] = vector.ops.map((op: { frame: CarrierOpFrame }) => op.frame);
// Elixir map pair order in the vector JSON is not canonical; id and signature cover the canonical bytes.
const sameFrame = (actual: CarrierOpFrame, expected: CarrierOpFrame) => {
  assert.equal(actual.id, expected.id);
  assert.equal(actual.sig, expected.sig);
  for (const key of ["v", "replica", "author", "deps", "kind", "cap"] as const) assert.deepEqual(actual[key], expected[key], key);
};
const ids = (frames: CarrierOpFrame[]) => frames.map((f) => f.id);

const rejects = (fn: () => Promise<unknown>, message: string) => assert.rejects(fn, (e: Error) => e.message === message, message);

// 1. Same seeds => identical frames and ids for all four ops.
const creation = await prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root });
assert.equal(creation.profile, "bounded_root_only");
assert.equal(creation.status, "uninitialized");
assert.equal(creation.replica, vector.replica);
creation.pending.forEach((f, i) => sameFrame(f, expectedFrames[i]!));
assert.deepEqual(creation.pending.slice(0, 2), expectedFrames.slice(0, 2));
const pin = await authorTreehouseContinuationPin({ frames: creation.pending, signer: root,
  nominee: nominee.publicKey, witnesses: witnesses.map((w) => w.publicKey),
  threshold: vector.profile.threshold, maxLeaseEpochs: vector.profile.max_lease_epochs });
sameFrame(pin, expectedFrames[2]!);
const withPin = [...creation.pending, pin];
const recordText = vector.record;
const bootstrapRecord = {
  version: 1 as const, product: "treehouse" as const, space: recordText.space, spaceRoot: recordText.space_root,
  profileGenesis: recordText.profile_genesis, profileId: recordText.profile_id, replacementRule: "bounded_space_admin_v1" as const,
  catalogKey: recordText.catalog_key, serviceId: recordText.service_id, serviceKey: recordText.service_key,
  origin: recordText.origin, nonce: recordText.nonce,
};
const bootstrap = await authorTreehouseCatalogBootstrap({ frames: withPin, signer: root, record: bootstrapRecord });
sameFrame(bootstrap, expectedFrames[3]!);
assert.deepEqual(ids([...withPin, bootstrap]), vector.ops.map((op: { id: string }) => op.id));
console.log("PASS bounded creation, pin and bootstrap frames equal the Elixir vector");

// 2. Family, creation refusals, retained-log semantics, legacy unchanged.
assert.equal(treehouseSpaceFamily(vector.replica), "bounded");
assert.equal(treehouseSpaceFamily("treehouse:ts:space"), "legacy");
assert.equal(treehouseSpaceFamily(vector.nonce_replica + "#authority:bounded-continuation-v2#root:x"), "unsupported");
assert.equal(treehouseSpaceFamily(vector.replica.replace("space:", "thread:")), "unsupported");
for (const bad of ["treehouse:ts:space", vector.nonce_replica + "#root:abc", vector.nonce_replica.slice(0, -1), vector.nonce_replica + "x",
  vector.nonce_replica.replace("space", "thread")]) {
  await rejects(() => prepareTreehouseBoundedSpaceCreation({ replica: bad, name: "x", signer: root }), "invalid_replica");
}
const half = await prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root, retained: [creation.pending[0]!] });
assert.equal(half.status, "incomplete");
assert.deepEqual(half.pending, [creation.pending[1]]);
const ready = await prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root, retained: creation.pending });
assert.equal(ready.status, "ready");
assert.deepEqual(ready.pending, []);
await rejects(() => prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: "Other", signer: root, retained: creation.pending }), "different_initialization");
await rejects(() => prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root,
  retained: [{ ...creation.pending[0]!, sig: Buffer.alloc(64).toString("base64") }] }), "invalid_retained_log");
await rejects(() => prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root, retained: [creation.pending[1]!] }), "invalid_retained_log");
await rejects(() => prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: nominee, retained: creation.pending }), "wrong_replica");
const legacy = await prepareTreehouseSpaceCreation({ replica: "treehouse:ts:legacy-bounded", name: "Old", signer: root });
assert.equal(legacy.profile, "legacy_root_only");
console.log("PASS family classification and creation refusals; legacy creation unchanged");

// 3. Pin observation and pin refusals.
assert.deepEqual(treehouseContinuationPin(creation.pending), { configured: false });
const observed = treehouseContinuationPin(withPin);
assert.equal(observed.configured, true);
if (observed.configured) {
  assert.equal(observed.profileGenesis, pin.id);
  assert.equal(observed.profileId, recordText.profile_id);
  assert.equal(observed.root, recordText.space_root);
  assert.equal(observed.profile.threshold, 2);
}
const resolved = await resolveContinuationProfileFromFrames({ replica: vector.replica, frames: withPin });
assert.equal(resolved.ok && resolved.profileGenesis, pin.id);
const pinInput = { frames: creation.pending, signer: root, nominee: nominee.publicKey,
  witnesses: witnesses.map((w) => w.publicKey), threshold: 2, maxLeaseEpochs: 7 };
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, frames: legacy.pending }), "not_bounded_space");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, frames: [creation.pending[0]!] }), "space_not_ready");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, signer: nominee }), "not_root");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, threshold: 4 }), "invalid_continuation_profile");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, maxLeaseEpochs: 0 }), "invalid_continuation_profile");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, nominee: root.publicKey }), "nominee_is_root");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, witnesses: [root.publicKey, witnesses[0]!.publicKey], threshold: 1 }), "witness_is_root");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, witnesses: [nominee.publicKey, witnesses[0]!.publicKey], threshold: 1 }), "witness_is_nominee");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, frames: [{ ...creation.pending[1]!, sig: Buffer.alloc(64).toString("base64") }] }), "invalid_verified_history");
await rejects(() => authorTreehouseContinuationPin({ ...pinInput, frames: withPin }), "continuation_already_pinned");
console.log("PASS pin observation and refusals");

// 4. Bootstrap authoring refusals.
const bootstrapInput = { frames: withPin, signer: root, record: bootstrapRecord };
await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, frames: legacy.pending }), "not_bounded_space");
await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, signer: nominee }), "not_root");
await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, frames: creation.pending }), "continuation_not_configured");
await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, record: { ...bootstrapRecord, origin: "not an origin" } }), "invalid_catalog_bootstrap");
await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, record: { ...bootstrapRecord, catalogKey: bootstrapRecord.serviceKey } }), "invalid_catalog_bootstrap");
for (const change of [{ space: "replica:other" }, { spaceRoot: Buffer.alloc(32, 1).toString("base64") },
  { profileGenesis: bootstrap.id }, { profileId: bootstrap.id }]) {
  await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, record: { ...bootstrapRecord, ...change } }), "binding_mismatch");
}
for (const change of [{ catalogKey: bootstrapRecord.spaceRoot }, { serviceKey: bootstrapRecord.spaceRoot }]) {
  await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, record: { ...bootstrapRecord, ...change } }), "binding_key_reuse");
}
await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, frames: [...withPin, bootstrap] }), "catalog_bootstrap_exists");
// The capability is chosen in canonical order, so a second root admin genesis cannot make the bytes depend on array order.
const extra = await authorTownshipGenesis({ replica: vector.replica, signer: root, ops: ["create_space"], roles: ["admin"], policies: {} });
const first = await authorTreehouseCatalogBootstrap({ ...bootstrapInput, frames: [...withPin, extra] });
const second = await authorTreehouseCatalogBootstrap({ ...bootstrapInput, frames: [extra, ...withPin].reverse() });
assert.equal(first.id, second.id);
assert.equal(first.sig, second.sig);
// PR review: a root admin genesis without catalog_bootstrap_v1 is never the cap, whatever its canonical position.
const spaceCommands = ["create_space", "create_thread", "issue_invitation", "revoke_invitation", "admit_member", "remove_member"];
let restrictedFirst = 0;
for (let n = 0; n < 32; n++) {
  const restricted = await authorTownshipGenesis({ replica: vector.replica, signer: root,
    ops: spaceCommands.filter((_, i) => (n >> (i % 5)) & 1 || i === 0), roles: ["admin"], policies: {}, live: n % 2 === 0 });
  const semantic = carrierOpsToSemanticOps([restricted, ...withPin], {}, treehouseCommandDecoders("Treehouse.Space"));
  if (canonicalOrder(semantic, index(semantic))[0] === restricted.id) restrictedFirst++;
  const chosen = await authorTreehouseCatalogBootstrap({ ...bootstrapInput, frames: [restricted, ...withPin] });
  assert.deepEqual(chosen.cap, bootstrap.cap);
}
assert.ok(restrictedFirst > 0, "some restricted genesis sorts ahead of the creation genesis");
// PR review: a retained mature history (pin, bootstrap) resumes; a competing root genesis still refuses.
for (const retained of [withPin, [...withPin, bootstrap]]) {
  const resumed = await prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root, retained });
  assert.equal(resumed.status, "ready");
  assert.deepEqual(resumed.pending, []);
}
const rival = await authorTownshipGenesis({ replica: vector.replica, signer: root, ops: ["create_space"], roles: ["admin"], policies: {} });
await rejects(() => prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root,
  retained: [...withPin, rival] }), "different_initialization");
// PR review: a revoked root capability yields no bootstrap; an op that would quarantine never leaves.
const revocation = await authorTownshipRevocation({ replica: vector.replica, deps: [pin.id], signer: root, delegationId: carrierDelegationsFromFrames([creation.pending[0]!])[0]!.id });
await rejects(() => authorTreehouseCatalogBootstrap({ ...bootstrapInput, frames: [...withPin, revocation] }), "bootstrap_not_honored");
// PR review: an empty root genesis with a Thread profile is still a competing initialization.
const emptyDelegation = await authorCarrierDelegation({ replica: vector.replica, audiencePubkey: root.publicKey, signer: root, live: false, ops: [], roles: [], parentId: null });
const threadProfile = { mode: "bounded_continuation", version: 1, product: "treehouse", kind: "thread", role: "moderator",
  nominee: Buffer.from(nominee.publicKey).toString("base64"),
  witnesses: witnesses.map((w) => Buffer.from(w.publicKey).toString("base64")).sort((a, b) => Buffer.compare(Buffer.from(a, "base64"), Buffer.from(b, "base64"))),
  threshold: 2, maxLeaseEpochs: 7 };
const oddPin = await authorCarrierOp({ replica: vector.replica, deps: [pin.id], kind: "authority", signer: root, cap: ["nil"],
  body: ["tuple", [["atom", "genesis"], ["delegation", emptyDelegation], ["map", [[["atom", "__continuation__"], continuationProfileToCarrierTerm(threadProfile)!]]]]] });
await rejects(() => prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root,
  retained: [...withPin, oddPin] }), "different_initialization");
// Duplicate retained frames are an invalid history, not a collapsed one.
await rejects(() => prepareTreehouseBoundedSpaceCreation({ replica: vector.nonce_replica, name: vector.name, signer: root,
  retained: [...creation.pending, creation.pending[0]!] }), "invalid_retained_log");
const honored = await treehouseCatalogBootstrapsFromFrames({ replica: vector.replica, frames: [...withPin, bootstrap] });
assert.equal(honored.ok && honored.bootstraps.length, 1);
assert.deepEqual(honored.ok && honored.bootstraps[0]!.record, bootstrapRecord);
assert.deepEqual(bootstrap.deps, [pin.id]);
console.log("PASS bootstrap authoring refusals and honored bootstrap");

// 5. Payload review.
const payload = {
  format: "lattice-catalog-bootstrap-payload-v1", record: vector.record,
  record_encoding: { base64_fields: ["space_root", "catalog_key", "service_key"], atom_fields: ["product", "replacement_rule"], note: "n" },
  canonical_base64: vector.canonical_base64, sha256: vector.canonical_sha256,
};
const review = (p: unknown, over: Partial<{ replica: string; frames: CarrierOpFrame[]; rootPublicKey: string }> = {}) =>
  reviewTreehouseCatalogBindingPayload({ payloadText: typeof p === "string" ? p : JSON.stringify(p), replica: vector.replica,
    frames: withPin, rootPublicKey: vector.record.space_root, ...over });
const accepted = await review(payload);
assert.equal(accepted.ok, true);
if (accepted.ok) {
  assert.deepEqual(accepted.record, bootstrapRecord);
  assert.equal(accepted.sha256, vector.canonical_sha256);
  assert.deepEqual(accepted.lines.map((l) => l.field), ["version", "product", "space", "space_root", "profile_genesis", "profile_id",
    "replacement_rule", "catalog_key", "service_id", "service_key", "origin", "nonce", "canonical sha256"]);
  assert.equal(accepted.lines.at(-1)!.value, vector.canonical_sha256);
  assert.equal(accepted.lines.find((l) => l.field === "space_root")!.value, vector.record.space_root);
}
const reason = async (p: unknown, over?: Parameters<typeof review>[1]) => { const r = await review(p, over); return r.ok ? "ok" : r.reason; };
assert.equal(await reason("not json"), "malformed_payload");
assert.equal(await reason([]), "malformed_payload");
assert.equal(await reason({ ...payload, format: "other" }), "malformed_payload");
assert.equal(await reason({ ...payload, extra: 1 }), "malformed_payload");
const { nonce: _n, ...missing } = vector.record;
assert.equal(await reason({ ...payload, record: missing }), "malformed_payload");
assert.equal(await reason({ ...payload, record: { ...vector.record, extra: "x" } }), "malformed_payload");
assert.equal(await reason({ ...payload, record: { ...vector.record, product: "other" } }), "malformed_payload");
assert.equal(await reason({ ...payload, record: { ...vector.record, replacement_rule: "x" } }), "malformed_payload");
assert.equal(await reason({ ...payload, record: { ...vector.record, version: 2 } }), "malformed_payload");
assert.equal(await reason({ ...payload, record: { ...vector.record, space_root: "AAAA" } }), "malformed_payload");
assert.equal(await reason({ ...payload, record: { ...vector.record, origin: "nope" } }), "malformed_payload");
for (const field of Object.keys(vector.record)) {
  if (field === "version" || field === "product" || field === "replacement_rule") continue;
  const value = vector.record[field] as string;
  const tampered = field === "origin" ? "wss://other.invalid" : field.endsWith("_key") || field === "space_root"
    ? Buffer.alloc(32, 7).toString("base64") : value.slice(0, -1) + (value.endsWith("A") ? "B" : "A");
  assert.equal(await reason({ ...payload, record: { ...vector.record, [field]: tampered } }), "payload_digest_mismatch", field);
}
assert.equal(await reason({ ...payload, sha256: "0".repeat(64) }), "payload_digest_mismatch");
assert.equal(await reason({ ...payload, canonical_base64: Buffer.from("x").toString("base64") }), "payload_digest_mismatch");
assert.equal(await reason(payload, { replica: "replica:other" }), "wrong_space");
assert.equal(await reason(payload, { rootPublicKey: Buffer.alloc(32, 1).toString("base64") }), "not_root");
assert.equal(await reason(payload, { frames: creation.pending }), "continuation_not_configured");
assert.equal(await reason(payload, { frames: [...withPin, bootstrap] }), "catalog_bootstrap_exists");
// Legacy Space: a payload naming it is refused before any pin is considered.
const legacyRecord = { ...bootstrapRecord, space: legacy.replica };
const legacyKey = Buffer.from(root.publicKey).toString("base64");
const legacyBytes = canonicalBytesForCarrierTerm(catalogBootstrapToCarrierTerm(legacyRecord)!);
const legacyPayload = { ...payload, canonical_base64: Buffer.from(legacyBytes).toString("base64"),
  sha256: createHash("sha256").update(legacyBytes).digest("hex"),
  record: { ...vector.record, space: legacy.replica, space_root: legacyKey } };
legacyRecord.spaceRoot = legacyKey;
const legacyBytes2 = canonicalBytesForCarrierTerm(catalogBootstrapToCarrierTerm(legacyRecord)!);
legacyPayload.canonical_base64 = Buffer.from(legacyBytes2).toString("base64");
legacyPayload.sha256 = createHash("sha256").update(legacyBytes2).digest("hex");
assert.equal(await reason(legacyPayload, { replica: legacy.replica, frames: legacy.pending, rootPublicKey: legacyKey }), "not_bounded_space");
{
  const reuse = { ...vector.record, catalog_key: vector.record.space_root };
  const bytes = canonicalBytesForCarrierTerm(catalogBootstrapToCarrierTerm({ ...bootstrapRecord, catalogKey: bootstrapRecord.spaceRoot })!);
  assert.equal(await reason({ ...payload, record: reuse, canonical_base64: Buffer.from(bytes).toString("base64"),
    sha256: createHash("sha256").update(bytes).digest("hex") }), "binding_key_reuse");
}
// A pin that names a different profile than the record refuses as binding_mismatch.
const other = await authorTreehouseContinuationPin({ ...pinInput, threshold: 3 });
const swapped = [creation.pending[0]!, creation.pending[1]!, other];
assert.equal(await reason(payload, { frames: swapped }), "binding_mismatch");
console.log("PASS payload review accepts the vector and refuses each tamper with its named reason");
