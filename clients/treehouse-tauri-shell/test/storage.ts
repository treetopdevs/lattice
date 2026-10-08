import assert from "node:assert/strict";
import { emptyState, parseState, HISTORY_BYTES } from "../src/treehouse_state";
import { validRouteUrl } from "../src/treehouse_routes";
const good = emptyState();
assert.deepEqual(parseState(JSON.stringify(good)), good);
for (const change of [
  { version: 9 },
  { product: "township" },
  { revision: -1 },
  { revision: Number.MAX_SAFE_INTEGER + 1 },
  { unexpected: "data" },
  { active: "missing" },
  { clearedDrafts: { x: -1 } },
]) {
  assert.throws(
    () => parseState(JSON.stringify({ ...good, ...change })),
    /invalid_/,
  );
}
assert.throws(
  () => parseState(" ".repeat(HISTORY_BYTES + 1)),
  /preview_storage_limit/,
);
assert.throws(
  () =>
    parseState(
      JSON.stringify({
        ...good,
        profiles: [
          {
            product: "Treehouse.Thread",
            replica: "x",
            frames: [],
            outbox: [],
            acked: [],
          },
        ],
      }),
    ),
  /missing_public_identity/,
);
console.log("PASS closed product/version/shape/revision and aggregate limit");
const preceding = { ...good, version: 0 } as Record<string, unknown>;
delete preceding.clearedDrafts;
delete preceding.relay;
assert.deepEqual(
  parseState(JSON.stringify(preceding)),
  good,
  "closed N-1 envelope upgrades metadata while retaining public history",
);
assert.throws(
  () => parseState(JSON.stringify({ ...preceding, clearedDrafts: {} })),
  /invalid_/,
);

// ---- Plan 181 S2a: state v2, join intent, acked set, relay routes ----
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorCarrierDelegation,
  authorCarrierOp,
  authorTownshipRevocation,
  authorTreehouseCommand,
  carrierDelegationsFromFrames,
  townshipGenesisBody,
  townshipReplicaRootTag,
} from "@treetopdevs/lattice-client";
import {
  assertRetainedMonotonic,
  MAX_ROUTES,
} from "../src/treehouse_state";
import type { Draft, PreviewNative } from "../src/treehouse_state";
import { TreehouseWorkflow } from "../src/treehouse_workflow";

class MemoryNative implements PreviewNative {
  record: string | null = null;
  seed: Uint8Array | null = null;
  writes = 0;
  async open() {
    return {
      record: this.record,
      publicKey: this.seed
        ? Buffer.from(ed25519.getPublicKey(this.seed)).toString("base64")
        : null,
      keyStatus: (this.seed
        ? "available"
        : parseState(this.record).publicKey
          ? "missing"
          : "absent") as "available" | "missing" | "absent",
    };
  }
  async initialize() {
    this.seed ??= crypto.getRandomValues(new Uint8Array(32));
    return (await this.open()).publicKey!;
  }
  async commit(expected: number, next: string) {
    if (parseState(this.record).revision !== expected) return false;
    this.record = next;
    this.writes++;
    return true;
  }
  async loadDraft(): Promise<Draft | null> {
    return null;
  }
  async saveDraft(): Promise<Draft | null> {
    return null;
  }
  async sign(bytes: Uint8Array) {
    return ed25519.sign(bytes, this.seed!);
  }
}
const token = (c: string) => c.repeat(43);
const pk = (n: number) => Buffer.alloc(32, n).toString("base64");
const fakeFrame = (replica: string, id: string, deps: string[] = []) => ({
  v: 1,
  id,
  replica,
  author: pk(1),
  deps,
  kind: "authority",
  body: ["nil"],
  cap: ["nil"],
  sig: "x",
});
const spaceReplica = `replica:treehouse:space:${token("a")}#root:${token("b")}`;
const withProfile = (overrides: Record<string, unknown> = {}) => ({
  ...good,
  publicKey: pk(1),
  profiles: [
    {
      product: "Treehouse.Space",
      replica: spaceReplica,
      frames: [fakeFrame(spaceReplica, token("c"))],
      outbox: [token("c")],
      acked: [],
      ...overrides,
    },
  ],
  active: spaceReplica,
});
// Route 1 is the Space; the rest are Threads.
const route = (n: number) => ({
  replica: `replica:treehouse:${n === 1 ? "space" : "thread"}:${String.fromCharCode(97 + n).repeat(43)}#root:${"R".repeat(43)}`,
  url: "ws://127.0.0.1:8080",
  expectedPeerRealm: "server",
  expectedPeerPubkey: pk(n),
});

// The empty state is v2 with no relay.
assert.equal(good.version, 2);
assert.equal(good.relay, null);
assert.equal(MAX_ROUTES, 4);

// v1 and v0 records migrate forward in memory only: relay null, acked empty.
{
  const v1 = {
    ...withProfile(),
    version: 1,
    revision: 7,
    profiles: [
      {
        product: "Treehouse.Space",
        replica: spaceReplica,
        frames: [fakeFrame(spaceReplica, token("c"))],
        outbox: [token("c")],
      },
    ],
  } as Record<string, unknown>;
  delete v1.relay;
  const migrated = parseState(JSON.stringify(v1));
  assert.equal(migrated.version, 2);
  assert.equal(migrated.revision, 7);
  assert.equal(migrated.relay, null);
  assert.deepEqual(migrated.profiles[0]!.acked, []);
  assert.deepEqual(migrated.profiles[0]!.frames, [
    fakeFrame(spaceReplica, token("c")),
  ]);
  // A mixed shape is not a migration: v1 with v2 fields and v2 without them fail closed.
  assert.throws(
    () => parseState(JSON.stringify({ ...v1, relay: null })),
    /invalid_/,
  );
  const v2 = withProfile();
  delete (v2 as Record<string, unknown>).relay;
  assert.throws(() => parseState(JSON.stringify(v2)), /invalid_/);
  const noAcked = withProfile();
  delete (noAcked.profiles[0] as Record<string, unknown>).acked;
  assert.throws(() => parseState(JSON.stringify(noAcked)), /invalid_/);
}

// A v1-only reader fails closed on a v2 record (frozen copy of the v1 envelope gate).
{
  const v1Reader = (record: string) => {
    const value = JSON.parse(record);
    const expected = [
      "version",
      "product",
      "revision",
      "publicKey",
      "profiles",
      "active",
      "intent",
      "clearedDrafts",
    ];
    if (
      value.version !== 1 ||
      Object.keys(value).length !== expected.length ||
      !expected.every((k) => Object.hasOwn(value, k))
    )
      throw new Error("invalid_preview_record");
  };
  assert.throws(() => v1Reader(JSON.stringify(good)), /invalid_preview_record/);
}

// acked: unique, a subset of retained frame ids.
assert.equal(
  parseState(JSON.stringify(withProfile({ acked: [token("c")] }))).profiles[0]!
    .acked.length,
  1,
);
for (const acked of [[token("z")], [token("c"), token("c")], ["bad"]]) {
  assert.throws(
    () => parseState(JSON.stringify(withProfile({ acked }))),
    /invalid_local_profile/,
    JSON.stringify(acked),
  );
}

// acked, outbox and frames only grow.
{
  const old = parseState(JSON.stringify(withProfile({ acked: [token("c")] })));
  const same = structuredClone(old);
  assertRetainedMonotonic(old, same);
  const shrunk = structuredClone(old);
  shrunk.profiles[0]!.acked = [];
  assert.throws(() => assertRetainedMonotonic(old, shrunk), /retained_history_changed/);
  const lessOutbox = structuredClone(old);
  lessOutbox.profiles[0]!.outbox = [];
  assert.throws(
    () => assertRetainedMonotonic(old, lessOutbox),
    /retained_history_changed/,
  );
  const dropped = structuredClone(old);
  dropped.profiles = [];
  assert.throws(() => assertRetainedMonotonic(old, dropped), /retained_history_changed/);
}

// relay: closed shape, at most four routes, valid pinned keys, unique replicas.
{
  const relay = (routes: unknown[], extra: Record<string, unknown> = {}) => ({
    ...good,
    revision: 1,
    relay: { localRealm: "local", routes, ...extra },
  });
  const four = [1, 2, 3, 4].map(route);
  assert.equal(parseState(JSON.stringify(relay(four))).relay!.routes.length, 4);
  assert.throws(
    () =>
      parseState(
        JSON.stringify(relay([...four, route(5)])),
      ),
    /invalid_relay/,
  );
  for (const bad of [
    relay(four, { extra: 1 }),
    relay([{ ...four[0], extra: 1 }]),
    relay([{ ...four[0], expectedPeerPubkey: "short" }]),
    relay([{ ...four[0], url: "" }]),
    relay([{ ...four[0], expectedPeerRealm: "  " }]),
    relay([four[0], four[0]]),
    { ...relay(four), relay: { localRealm: "", routes: four } },
    // The semantic rules the route list was accepted under also hold when a record is loaded.
    relay([]),
    { ...relay(four), relay: { localRealm: " local", routes: four } },
    relay([{ ...four[0], replica: "r1" }]),
    relay([{ ...four[0], url: "http://127.0.0.1:8080" }]),
    relay([{ ...four[0], url: "ws://example.com:8080" }]),
    relay([{ ...four[0], url: " wss://example.com" }]),
    relay([{ ...four[0], expectedPeerRealm: "server " }]),
    // Exactly one Space route.
    relay([route(2), route(3)]),
    relay([four[0], { ...route(2), replica: four[0]!.replica.replace("bbbb", "zzzz") }]),
  ])
    assert.throws(() => parseState(JSON.stringify(bad)), /invalid_relay/);
}

// The shell's URL rule accepts and refuses the same set as the native store (native_commands.rs), so a
// route the native store persists always reloads.
for (const url of [
  "wss://relay.example.com:443/carrier",
  "ws://localhost:1",
  "ws://LocalHost:1",
  "ws://[::1]:9",
  "wss://[::A]",
  "wss://service.0xcorp",
  "wss://x:443",
  "wss://[2001:db8::1]:443",
  "wss://10.0.0.1",
  "wss://x:",
  "ws://[::1]:",
  "WSS://x",
])
  assert.equal(validRouteUrl(url), true, url);
for (const url of [
  "http://127.0.0.1:8080",
  "ws://example.com:8080",
  "wss://user@example.com",
  "wss://example.com/#frag",
  "ws://127.0.0.1:99999",
  "ws://127.0.0.1:8a",
  " wss://example.com",
  "wss://[not-an-ip]",
  "wss://[fe80::1%25en0]",
  "wss://1.2.3.999",
  "wss://ex\u00e4mple.com",
  "ws://[::2]:9",
  "ws://[0:0:0:0:0:0:0:1]:9",
  "ws://127.1",
  "wss://[::ffff:1.2.3.4]",
  "wss://010.0.0.1",
  "wss://ex%61mple.com",
  "wss://a.0x1f",
  "wss://x:000443",
  "wss://x:0443",
  "wss://x:0",
  "wss://example.com/\u00e9",
  "wss://example.com/\u0001",
])
  assert.equal(validRouteUrl(url), false, url);

// join intent: the fixed name constant only, no user text.
{
  const join = (name: string) => ({
    ...good,
    revision: 1,
    intent: { kind: "join", name, nonce: token("n") },
  });
  assert.equal(parseState(JSON.stringify(join("join"))).intent!.kind, "join");
  assert.throws(
    () => parseState(JSON.stringify(join("Alice"))),
    /invalid_creation_intent/,
  );
}

// Workflow-level: a v1 record opens byte-identical with no write; the next commit writes v2.
{
  const founder = new MemoryNative();
  const app = new TreehouseWorkflow(founder);
  await app.open();
  await app.createSpace("Canopy");
  const v2 = JSON.parse(founder.record!);
  assert.equal(v2.version, 2);
  assert.equal(v2.relay, null);
  assert.ok(v2.profiles.every((p: { acked: unknown[] }) => p.acked.length === 0));
  const v1 = structuredClone(v2);
  v1.version = 1;
  delete v1.relay;
  for (const p of v1.profiles) delete p.acked;
  const legacy = new MemoryNative();
  legacy.seed = founder.seed;
  legacy.record = JSON.stringify(v1);
  const before = legacy.record;
  const reopened = new TreehouseWorkflow(legacy);
  await reopened.open();
  assert.equal(legacy.writes, 0, "opening never writes");
  assert.equal(legacy.record, before, "a v1 record reopens byte-identical");
  assert.equal(reopened.state.version, 2);
  await reopened.createThread("Notes");
  assert.equal(JSON.parse(legacy.record!).version, 2);
  assert.equal(legacy.writes > 0, true);
}

// Foreign-root joiner profile: accepted only when the commitment matches the genesis author.
{
  const founder = new MemoryNative();
  const app = new TreehouseWorkflow(founder);
  await app.open();
  await app.createSpace("Canopy");
  const space = app.state.profiles[0]!;
  const joiner = new MemoryNative();
  await joiner.initialize();
  const joinerKey = (await joiner.open()).publicKey!;
  const foreign = (profile: unknown) =>
    JSON.stringify({
      ...good,
      revision: 1,
      publicKey: joinerKey,
      profiles: [profile],
      active: (profile as { replica: string }).replica,
    });
  joiner.record = foreign({
    ...space,
    outbox: [],
    acked: space.frames.map((f) => f.id),
  });
  const joined = new TreehouseWorkflow(joiner);
  await joined.open();
  assert.equal(joined.state.profiles[0]!.replica, space.replica);
  assert.deepEqual(joined.state.profiles[0]!.outbox, []);
  assert.equal(joiner.writes, 0);

  // A signed genesis whose #root: commitment names a different key is refused.
  const author = crypto.getRandomValues(new Uint8Array(32));
  const signer = {
    publicKey: ed25519.getPublicKey(author),
    sign: async (bytes: Uint8Array) => ed25519.sign(bytes, author),
  };
  const other = ed25519.getPublicKey(crypto.getRandomValues(new Uint8Array(32)));
  const replica = `replica:treehouse:space:${token("m")}#root:${await townshipReplicaRootTag(other)}`;
  const delegation = await authorCarrierDelegation({
    replica,
    audiencePubkey: signer.publicKey,
    parentId: null,
    live: true,
    signer,
    ops: ["create_space"],
    roles: ["admin"],
  });
  const genesis = await authorCarrierOp({
    replica,
    deps: [],
    kind: "authority",
    body: townshipGenesisBody(delegation, {}),
    cap: ["nil"],
    signer,
  });
  const named = await authorTreehouseCommand({
    product: "Treehouse.Space",
    replica,
    deps: [genesis.id],
    signer,
    capId: carrierDelegationsFromFrames([genesis])[0]!.id,
    command: { command: "create_space", name: "Impostor" },
  });
  joiner.record = foreign({
    product: "Treehouse.Space",
    replica,
    frames: [genesis, named],
    outbox: [],
    acked: [genesis.id, named.id],
  });
  await assert.rejects(
    new TreehouseWorkflow(joiner).open(),
    /wrong_profile_root/,
  );

  // An authentic competing genesis on the founder's replica, retained before the committed one, does
  // not displace it: the root is selected by the #root: commitment, and the competitor is quarantined.
  const competitorDelegation = await authorCarrierDelegation({
    replica: space.replica,
    audiencePubkey: signer.publicKey,
    parentId: null,
    live: true,
    signer,
    ops: ["create_space"],
    roles: ["admin"],
  });
  const competitor = await authorCarrierOp({
    replica: space.replica,
    deps: [],
    kind: "authority",
    body: townshipGenesisBody(competitorDelegation, {}),
    cap: ["nil"],
    signer,
  });
  joiner.record = foreign({
    ...space,
    frames: [competitor, ...space.frames],
    outbox: [],
    acked: [competitor.id, ...space.frames.map((f) => f.id)],
  });
  const contested = new TreehouseWorkflow(joiner);
  await contested.open();
  assert.equal(contested.state.profiles[0]!.replica, space.replica);
  // The founder shown is the committed genesis author, never the competitor served first.
  assert.equal(contested.founderKey(), app.state.publicKey);
  assert.notEqual(contested.founderKey(), competitor.author);
  assert.equal(app.founderKey(), app.state.publicKey);
  // Only the root holder may add a Thread; a joined member is never offered it.
  assert.equal(app.canCreateThread(), true);
  assert.equal(contested.canCreateThread(), false);
}
// A revoked root delegation is no longer offered: canAuthor stops advertising founder actions.
{
  const founder = new MemoryNative();
  const app = new TreehouseWorkflow(founder);
  await app.open();
  await app.createSpace("Canopy");
  const space = app.state.profiles[0]!;
  assert.equal(app.canAuthor(space.replica, "create_thread"), true);
  const root = carrierDelegationsFromFrames(space.frames).find((d) => d.parent_id === null)!;
  const referenced = new Set(space.frames.flatMap((f) => f.deps));
  const revoke = await authorTownshipRevocation({
    replica: space.replica,
    deps: space.frames.filter((f) => !referenced.has(f.id)).map((f) => f.id),
    signer: { publicKey: ed25519.getPublicKey(founder.seed!), sign: async (bytes) => ed25519.sign(bytes, founder.seed!) },
    delegationId: root.id,
  });
  const record = JSON.parse(founder.record!);
  record.profiles[0].frames.push(revoke);
  record.profiles[0].acked.push(revoke.id);
  founder.record = JSON.stringify(record);
  const reopened = new TreehouseWorkflow(founder);
  await reopened.open();
  assert.equal(reopened.canAuthor(space.replica, "create_thread"), false);
  assert.equal(reopened.canAuthor(space.replica, "issue_invitation"), false);
  assert.equal(reopened.canCreateThread(), false);
}
console.log(
  "PASS state v2: in-memory migration, join intent, acked set, relay routes, foreign-root joiner",
);
