import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519.js";
import { authorCarrierDelegation, authorCarrierOp, verifyCarrierOp } from "../src/codec";
import type { CarrierOpSigner } from "../src/codec";
import { carrierDelegationsFromFrames, carrierOpsToSemanticOps } from "../src/carrier";
import type { CarrierOpFrame, CarrierTerm, DecodedTerm } from "../src/carrier";
import { authorTownshipGenesis, bindTownshipReplica, townshipCapTerm } from "../src/township";
import { continuationProfileId, continuationProfileToCarrierTerm } from "../src/continuation";
import type { ContinuationProfile } from "../src/continuation";
import { catalogBootstrapFromCarrierTerm, catalogBootstrapFromDecodedTerm, catalogBootstrapToCarrierTerm } from "../src/treehouse_catalog_codec";
import type { CatalogBootstrap } from "../src/treehouse_catalog_codec";
import { authorTreehouseCommand, authorTreehouseRoleTransfer, observeTreehouse, prepareTreehouseSpaceCreation, treehouseCommandDecoders } from "../src/treehouse";
import * as treehouse from "../src/treehouse";
import { continuationProfileBindingMatches } from "../src/authority";

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
async function fixture(replicaName = `replica:treehouse:space:${id("history-space")}#authority:bounded-continuation-v1`) {
  const root = signer("root"), catalog = signer("catalog"), service = signer("service"), nominee = signer("nominee");
  const witnesses = [signer("w1"), signer("w2"), signer("w3")].sort((a, b) => Buffer.compare(a.publicKey, b.publicKey));
  const replica = await bindTownshipReplica(replicaName, root.publicKey);
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
  assert.deepEqual(await authorTreehouseCommand({ product: "Treehouse.Space", replica: f.replica, deps: [f.pin.id], signer: f.root,
    capId: f.delegation.id, command: { command: "catalog_bootstrap_v1", record: f.record } }), f.bootstrap);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
function bootstrap(f: Fixture, record: CarrierTerm, overrides: Partial<Parameters<typeof authorCarrierOp>[0]> = {}) {
  return authorCarrierOp({ replica: f.replica, signer: f.root, deps: [f.pin.id], kind: "command", cap: townshipCapTerm(f.delegation.id),
    body: tuple(atom("catalog_bootstrap_v1"), ["list", [record]]), ...overrides });
}

test("actual signed callback refuses wrong root, Space, ancestral pin and profile bindings", async () => {
  const f = await fixture();
  for (const record of [{ ...f.record, spaceRoot: b64(f.nominee.publicKey) }, { ...f.record, space: "another-space" },
    { ...f.record, profileGenesis: f.genesis.id }, { ...f.record, profileId: f.genesis.id }]) {
    const bad = await bootstrap(f, catalogBootstrapToCarrierTerm(record)!);
    const result = observeTreehouse("Treehouse.Space", await authenticated([...f.before, bad]));
    assert.equal(result.quarantineReasons.get(bad.id), "application_invalid_catalog");
    assert.equal(result.state.admin_actions, "create_space");
  }
});

test("closed bootstrap shape failures remain signed application refusals", async () => {
  const f = await fixture();
  const raw = catalogBootstrapToCarrierTerm(f.record)! as ["map", [CarrierTerm, CarrierTerm][]];
  const change = (field: string, value: CarrierTerm): CarrierTerm => ["map", raw[1].map(([key, old]) => [key, key[0] === "atom" && key[1] === field ? value : old])];
  const invalid: CarrierTerm[] = [nil, ["list", []], ["map", raw[1].slice(1)], ["map", [...raw[1], [atom("extra"), nil]]],
    change("product", ["bin", b64(new TextEncoder().encode("treehouse"))]), change("version", ["int", 2]),
    change("space_root", atom("root")), change("space_root", ["bin", b64(new Uint8Array(31))]),
    change("nonce", ["list", []]), change("service_key", ["bin", b64(f.catalog.publicKey)])];
  for (const record of invalid) {
    const bad = await bootstrap(f, record);
    const result = observeTreehouse("Treehouse.Space", await authenticated([...f.before, bad]));
    assert.equal(result.quarantineReasons.get(bad.id), "application_invalid_catalog", JSON.stringify(record));
    assert.equal(result.state.admin_actions, "create_space");
  }
});

test("bootstrap retains malformed-arity, capability and actual admin refusal precedence", async () => {
  const f = await fixture();
  const raw = catalogBootstrapToCarrierTerm(f.record)!;
  for (const args of [[], [raw, raw]]) {
    const bad = await bootstrap(f, raw, { cap: nil, body: tuple(atom("catalog_bootstrap_v1"), ["list", args]) });
    assert.equal(observeTreehouse("Treehouse.Space", await authenticated([...f.before, bad])).quarantineReasons.get(bad.id), "bad_command_arity");
  }
  const noCap = await bootstrap(f, nil, { cap: nil });
  assert.equal(observeTreehouse("Treehouse.Space", await authenticated([...f.before, noCap])).quarantineReasons.get(noCap.id), "no_capability");
  const wrongAudience = await bootstrap(f, raw, { signer: f.nominee });
  assert.equal(observeTreehouse("Treehouse.Space", await authenticated([...f.before, wrongAudience])).quarantineReasons.get(wrongAudience.id), "capability_wrong_audience");
  const transfer = await authorTreehouseRoleTransfer({ replica: f.replica, deps: [f.pin.id], signer: f.root,
    parent: f.delegation, recipient: f.nominee.publicKey, action: "transfer_admin" });
  const staleRoot = await bootstrap(f, nil, { deps: [transfer.frame.id] });
  const newAdmin = await bootstrap(f, raw, { deps: [transfer.frame.id], signer: f.nominee, cap: townshipCapTerm(transfer.delegation.id) });
  const result = observeTreehouse("Treehouse.Space", await authenticated([...f.before, transfer.frame, staleRoot, newAdmin]));
  assert.equal(result.quarantineReasons.get(transfer.frame.id), undefined);
  assert.equal(result.quarantineReasons.get(staleRoot.id), "not_holder");
  assert.equal(result.quarantineReasons.get(newAdmin.id), "application_invalid_catalog");
  const replacement = await bootstrap(f, raw, { body: tuple(atom("replace_catalog_v1"), ["list", [raw]]) });
  assert.equal(observeTreehouse("Treehouse.Space", await authenticated([...f.before, replacement])).quarantineReasons.get(replacement.id), "unknown_command");
});

test("root-only preparation preserves original signed bytes and six-command capability ceiling", async () => {
  const root = signer("root"), replica = "treehouse:legacy-preview";
  const ops = ["create_space", "create_thread", "issue_invitation", "revoke_invitation", "admit_member", "remove_member"];
  const expected = await authorTownshipGenesis({ replica, signer: root, ops, roles: ["admin", "moderator"], policies: {} });
  const prepared = await prepareTreehouseSpaceCreation({ replica, signer: root, name: "Canopy" });
  assert.deepEqual(prepared.pending[0], expected);
  const d = carrierDelegationsFromFrames([expected])[0]!;
  assert.deepEqual(d.ops, [...ops].sort());
  const f = await fixture();
  const bad = await bootstrap(f, catalogBootstrapToCarrierTerm({ ...f.record, space: expected.replica })!,
    { replica: expected.replica, deps: [prepared.pending[1]!.id], cap: townshipCapTerm(d.id) });
  assert.equal(observeTreehouse("Treehouse.Space", await authenticated([...prepared.pending, bad])).quarantineReasons.get(bad.id), "operation_not_granted");
});

test("internal profile binding rejects incomplete, duplicate, cyclic and mismatched semantic inputs", async () => {
  const f = await fixture(), ops = await authenticated(f.before);
  const matches = (history: typeof ops, replica = f.replica, root = f.record.spaceRoot) => continuationProfileBindingMatches(replica, history, root, f.pin.id, f.record.profileId);
  assert.equal(matches(ops), true);
  assert.equal(matches([...ops].reverse()), true);
  for (const history of [ops.slice(1), [...ops, ops[0]!], ops.map((op, i) => i === 0 ? { ...op, deps: [f.pin.id] } : op),
    ops.map((op, i) => i === 0 ? { ...op, replica: "other" } : op)]) assert.equal(matches(history), false);
  assert.equal(matches(ops, f.replica, b64(f.nominee.publicKey)), false);
  assert.equal(matches(ops, "unknown-family"), false);
});

test("flat bootstrap adapter preserves raw codec meaning and rejects duplicate pairs and non-scalar sentinels", async () => {
  const f = await fixture();
  const raw = catalogBootstrapToCarrierTerm(f.record)! as ["map", [CarrierTerm, CarrierTerm][]];
  const leaf = (term: CarrierTerm): DecodedTerm => {
    if (term[0] === "atom") return { type: "atom", value: term[1] };
    if (term[0] === "int" && typeof term[1] === "number") return term[1];
    if (term[0] === "bin") { const bytes = Buffer.from(term[1], "base64"); return { type: "bin", bytes, text: new TextDecoder().decode(bytes) }; }
    throw new Error("fixture is not flat");
  };
  const decoded: DecodedTerm = { type: "map", pairs: raw[1].map(([key, value]) => [leaf(key), leaf(value)]) };
  assert.deepEqual(catalogBootstrapFromDecodedTerm(decoded), catalogBootstrapFromCarrierTerm(raw));
  assert.deepEqual(catalogBootstrapFromDecodedTerm({ ...decoded, pairs: [...decoded.pairs].reverse() }), f.record);
  assert.equal(catalogBootstrapFromDecodedTerm({ ...decoded, pairs: [...decoded.pairs, decoded.pairs[0]!] }), null);
  assert.equal(catalogBootstrapFromDecodedTerm({ ...decoded, pairs: decoded.pairs.map((pair, i) => i === 0 ? [...pair, null] : pair) } as DecodedTerm), null);
  for (const value of [null, { type: "list", values: [] }, { type: "invalid_reserved_metadata" }] as DecodedTerm[]) {
    assert.equal(catalogBootstrapFromDecodedTerm({ ...decoded, pairs: decoded.pairs.map(([key, old], i) => [key, i === 0 ? value : old]) }), null);
  }
  const wrongBytes = { ...decoded, pairs: decoded.pairs.map(([key, value]) => [key, value !== null && typeof value === "object" && value.type === "bin"
    ? { ...value, bytes: [...value.bytes] } : value]) };
  assert.equal(catalogBootstrapFromDecodedTerm(wrongBytes as DecodedTerm), null);
  const duplicate: CarrierTerm = ["map", [...raw[1], raw[1][0]!]];
  await assert.rejects(() => bootstrap(f, duplicate), /duplicate/i, "duplicate signed map cannot pass the existing canonical encoder");
  const altered = { ...f.bootstrap, body: tuple(atom("catalog_bootstrap_v1"), ["list", [duplicate]]) };
  assert.deepEqual(await treehouse.treehouseCatalogBootstrapsFromFrames({ replica: f.replica, frames: [...f.before, altered] }),
    { ok: false, reason: "invalid_verified_history" });
});

test("the callback binds the actual ancestral last valid profile rather than a stale or unseen pin", async () => {
  const f = await fixture();
  const otherProfile = { ...f.profile, maxLeaseEpochs: 6 };
  const empty = await authorCarrierDelegation({ replica: f.replica, signer: f.root, audiencePubkey: f.root.publicKey, ops: [], roles: [] });
  const later = await authorCarrierOp({ replica: f.replica, signer: f.root, deps: [f.pin.id], kind: "authority", cap: nil,
    body: tuple(atom("genesis"), ["delegation", empty], ["map", [[atom("__continuation__"), continuationProfileToCarrierTerm(otherProfile)!]]]) });
  const laterRecord = { ...f.record, profileGenesis: later.id, profileId: continuationProfileId(otherProfile)! };
  const claimedLater = await bootstrap(f, catalogBootstrapToCarrierTerm(laterRecord)!, { deps: [later.id] });
  const original = await bootstrap(f, catalogBootstrapToCarrierTerm(f.record)!, { deps: [later.id] });
  const unseen = await bootstrap(f, catalogBootstrapToCarrierTerm(f.record)!, { deps: [f.creation.id] });
  const result = observeTreehouse("Treehouse.Space", await authenticated([...f.before, later, claimedLater, original, unseen]));
  assert.equal(result.quarantineReasons.get(claimedLater.id), undefined);
  assert.equal(result.quarantineReasons.get(unseen.id), "application_invalid_catalog");
  assert.equal(result.quarantineReasons.get(original.id), "application_invalid_catalog");
});

test("valid outer signatures cannot authorize an unsupported family or impostor profile introduction", async () => {
  for (const name of [`replica:treehouse:space:${id("unbound-family")}`, `replica:treehouse:thread:${id("wrong-family")}#authority:bounded-continuation-v1`]) {
    const f = await fixture(name);
    const result = observeTreehouse("Treehouse.Space", await authenticated(f.frames));
    assert.equal(result.quarantineReasons.get(f.bootstrap.id), "application_invalid_catalog");
    assert.deepEqual(await treehouse.treehouseCatalogBootstrapsFromFrames({ replica: f.replica, frames: f.frames }),
      { ok: true, bootstraps: [], verifiedFrontier: [f.bootstrap.id] });
  }
  const f = await fixture();
  const empty = await authorCarrierDelegation({ replica: f.replica, signer: f.nominee, audiencePubkey: f.nominee.publicKey, ops: [], roles: [] });
  const pin = await authorCarrierOp({ replica: f.replica, signer: f.nominee, deps: [f.creation.id], kind: "authority", cap: nil,
    body: tuple(atom("genesis"), ["delegation", empty], ["map", [[atom("__continuation__"), continuationProfileToCarrierTerm(f.profile)!]]]) });
  const command = await bootstrap(f, catalogBootstrapToCarrierTerm({ ...f.record, profileGenesis: pin.id })!, { deps: [pin.id] });
  const frames = [f.genesis, f.creation, pin, command];
  const result = observeTreehouse("Treehouse.Space", await authenticated(frames));
  assert.equal(result.quarantineReasons.get(command.id), "application_invalid_catalog");
  assert.deepEqual(await treehouse.treehouseCatalogBootstrapsFromFrames({ replica: f.replica, frames }),
    { ok: true, bootstraps: [], verifiedFrontier: [command.id] });
});

test("verified bootstrap query refuses forged/partial history and retains all honored records deterministically", async () => {
  const query = treehouse.treehouseCatalogBootstrapsFromFrames;
  assert.equal(typeof query, "function");
  const f = await fixture();
  const secondRecord = { ...f.record, nonce: id("second-bootstrap") };
  const second = await bootstrap(f, catalogBootstrapToCarrierTerm(secondRecord)!, { deps: [f.bootstrap.id] });
  const invalid = await bootstrap(f, nil, { deps: [second.id] });
  const frames = [...f.frames, second, invalid];
  const expected = { ok: true, bootstraps: [{ id: f.bootstrap.id, record: f.record }, { id: second.id, record: secondRecord }], verifiedFrontier: [invalid.id] };
  assert.deepEqual(await query({ replica: f.replica, frames }), expected);
  assert.deepEqual(await query({ replica: f.replica, frames: [...frames].reverse() }), expected);
  const refused = { ok: false, reason: "invalid_verified_history" };
  for (const bad of [frames.slice(1), [...frames, frames[0]!], [{ ...frames[0]!, sig: b64(new Uint8Array(64)) }, ...frames.slice(1)],
    [{ ...frames[0]!, body: nil }, ...frames.slice(1)], [null]]) {
    assert.deepEqual(await query({ replica: f.replica, frames: bad }), refused);
  }
  assert.deepEqual(await query({ replica: "another-space", frames }), refused);
  const mutable = structuredClone(frames);
  const pending = query({ replica: f.replica, frames: mutable });
  mutable[0]!.sig = b64(new Uint8Array(64));
  assert.deepEqual(await pending, expected, "query owns a snapshot before asynchronous authentication");
});
