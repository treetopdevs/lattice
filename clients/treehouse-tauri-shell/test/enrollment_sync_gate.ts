import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorTreehouseCommand,
  connectCarrierWebSocket,
  decodeCarrierOpFrame,
  decodeTreehouseAcceptance,
  decodeTreehouseOffer,
  encodeTreehouseAcceptance,
  encodeTreehouseOffer,
  verifyCarrierOp,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame, CarrierWebSocketClient } from "@treetopdevs/lattice-client";
import { createTreehouseFeedController } from "../src/treehouse_feed";
import type { TreehouseFeedController, TreehouseFeedState } from "../src/treehouse_feed";
import { createTreehouseRelayConnector, treehouseCarrierSigner } from "../src/treehouse_relay_client";
import { syncTreehouse, syncTreehouseRoute } from "../src/treehouse_sync";
import type { RouteOutcome } from "../src/treehouse_sync";
import { parseState } from "../src/treehouse_state";
import type { RelayRoute } from "../src/treehouse_state";
import { TreehouseWorkflow, fromBase64 } from "../src/treehouse_workflow";
import { freeTcpPort, makeGateRoot, runBeamSupport, spawnPilotManifestServer, writePilotManifest } from "./support/relay_peer";
import type { PilotRelay } from "./support/relay_peer";
import { assertNoSecrets, assertScannerDetects } from "./support/secret_scan";
import { SeededNative } from "./support/seeded_native";

// Plan 181 slice 4. A headless real-socket gate: two in-memory-native Treehouse clients (named test
// double, seeded test keys) run invite, join, grant, post, converge, restart and heal against one
// manifest-booted `pilot_node.exs` relay over real WebSockets. The oracle then replays the same
// scenario through `Lattice.Sim` and compares op ids, frames, state and quarantine verdicts. This is the
// Linux durability gate; the harness stop and kill paths are test-only and claim no controlled stop.

console.log("\n▸ Treehouse enrollment sync gate: real sockets against Lattice.Sim");

const SEED = "r13-lite-gate";
const TEXTS: Record<string, string> = {
  joiner_general: "Hello from the joiner gate",
  joiner_questions: "Is this relay readable gate",
  forged: "A grantless attempt gate",
  founder_reply: "Welcome aboard gate",
  offline_joiner: "Posted while the relay was down gate",
  offline_founder: "Founder note while the relay was down gate",
};
const LABELS = ["space", "general", "questions"] as const;
type Label = (typeof LABELS)[number];
const RELAY_REALMS: Record<Label, string[]> = {
  space: ["founder"],
  general: ["founder", "joiner"],
  questions: ["founder", "joiner"],
};
const TRUNCATED_HANDOFF = `township-pairing:v1:${Buffer.from(
  JSON.stringify({ url: "ws://127.0.0.1:1", replica: "township" }),
).toString("base64url")}`;

const privSeed = (realm: string) => createHash("sha256").update(`${SEED}:${realm}`).digest();
const pub64 = (realm: string) => Buffer.from(ed25519.getPublicKey(privSeed(realm))).toString("base64");
const flipByte = (b64: string) => {
  const bytes = Buffer.from(b64, "base64");
  bytes[0]! ^= 1;
  return bytes.toString("base64");
};
const sorted = (ids: Iterable<string>) => [...ids].sort();
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(what: string, check: () => boolean | Promise<boolean>, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Party {
  name: "founder" | "joiner";
  native: SeededNative;
  wf: TreehouseWorkflow;
  explicitSyncs: number;
}
async function boot(native: SeededNative): Promise<TreehouseWorkflow> {
  const wf = new TreehouseWorkflow(native);
  await wf.open();
  return wf;
}
const party = async (name: Party["name"]): Promise<Party> => {
  const native = new SeededNative(privSeed(name));
  return { name, native, wf: await boot(native), explicitSyncs: 0 };
};
const connectorOf = (p: Party) => createTreehouseRelayConnector({ workflow: p.wf });
const profileOf = (p: Party, replica: string) => p.wf.state.profiles.find((x) => x.replica === replica);
const unchanged = async (p: { native: SeededNative }, run: () => Promise<unknown>, pattern: RegExp) => {
  const before = p.native.record;
  await assert.rejects(run(), pattern);
  assert.equal(p.native.record, before, `refusal ${pattern} leaves the saved record untouched`);
};

// ---- scratch root, relay, trace ---------------------------------------------------------------------

const root = makeGateRoot("r13-lite-gate");
const trace: { namespace: string; realms: string[]; logs: object[]; events: object[] } = {
  namespace: SEED,
  realms: ["founder", "joiner"],
  logs: [],
  events: [],
};
const event = (value: object) => trace.events.push(value);
let relay: PilotRelay | null = null;
let feed: TreehouseFeedController | null = null;

try {
  const founder = await party("founder");
  const joiner = await party("joiner");
  assert.equal(founder.native.creates, 0, "empty boot mints no key");

  // ---- 1. founder creates the group and two Threads locally ---------------------------------------
  await founder.wf.createSpace("Canopy");
  await founder.wf.createThread("General");
  await founder.wf.createThread("Questions");
  const space = founder.wf.state.profiles.find((p) => p.product === "Treehouse.Space")!;
  const threads = founder.wf.state.profiles.filter((p) => p.product === "Treehouse.Thread");
  assert.equal(threads.length, 2);
  const replicas: Record<Label, string> = {
    space: space.replica,
    general: threads[0]!.replica,
    questions: threads[1]!.replica,
  };
  const labelOf = new Map(LABELS.map((label) => [replicas[label], label]));
  for (const label of LABELS)
    trace.logs.push({
      label,
      product: label === "space" ? "Treehouse.Space" : "Treehouse.Thread",
      replica: replicas[label],
    });
  event({ type: "found", log: "space" });
  event({ type: "command", log: "space", realm: "founder", command: "create_space", args: ["Canopy"] });
  for (const [label, title] of [["general", "General"], ["questions", "Questions"]] as const) {
    event({ type: "found", log: label });
    event({ type: "command", log: label, realm: "founder", command: "create_thread", args: [title] });
    event({
      type: "command",
      log: "space",
      realm: "founder",
      command: "create_thread",
      args: [{ replicaOf: label }, title],
    });
  }
  console.log("PASS founder holds a real Space and two Threads before any relay exists");

  // ---- 2. hand-written manifest, empty logs, relay boot -------------------------------------------
  const ports = { space: await freeTcpPort(), general: await freeTcpPort(), questions: await freeTcpPort() };
  const relaySeed = (label: Label) => createHash("sha256").update(`${SEED}:relay:${label}`).digest();
  const relayPub = (label: Label) => Buffer.from(ed25519.getPublicKey(relaySeed(label))).toString("base64");
  const observerSeed = privSeed("observer");
  const observerPub = Buffer.from(ed25519.getPublicKey(observerSeed)).toString("base64");
  await runBeamSupport(
    "clients/treehouse-tauri-shell/test/support/treehouse_enrollment_fixture.exs",
    [root, ...LABELS.map((label) => `${label}=${replicas[label]}`)],
    "FIXTURE_READY",
  );
  const manifestPath = writePilotManifest({
    dir: root,
    trustedPeers: [
      { realm: "founder", pubkey: pub64("founder") },
      { realm: "joiner", pubkey: pub64("joiner") },
      { realm: "observer", pubkey: observerPub },
    ],
    instances: LABELS.map((label) => ({
      name: label,
      port: ports[label],
      seedHex: relaySeed(label).toString("hex"),
      logFile: join(root, `${label}.log`),
      relayRealms: RELAY_REALMS[label],
    })),
  });
  relay = await spawnPilotManifestServer(manifestPath);
  const routeFor = (label: Label): RelayRoute => {
    assert.equal(relay!.instances[label]!.pubkey, relayPub(label), "the relay holds the seeded transport key");
    return {
      replica: replicas[label],
      url: `ws://127.0.0.1:${ports[label]}/carrier`,
      expectedPeerRealm: `relay-${label}`,
      expectedPeerPubkey: relayPub(label),
    };
  };
  const routes = LABELS.map(routeFor);

  // ---- observer: read-only advertise and pull over the same real sockets --------------------------
  const observerVerifier = { verify: (pubkey: Uint8Array, bytes: Uint8Array, sig: Uint8Array) => ed25519.verify(sig, bytes, pubkey, { zip215: false }) };
  const frameVerifier = {
    verify: async (pub: string, bytes: Uint8Array, sig: Uint8Array) => ed25519.verify(sig, bytes, fromBase64(pub), { zip215: false }),
  };
  const observe = async <T>(label: Label, use: (client: CarrierWebSocketClient) => Promise<T>): Promise<T> => {
    const route = routeFor(label);
    const client = await connectCarrierWebSocket({
      url: route.url,
      localRealm: "observer",
      replica: route.replica,
      signer: { publicKey: ed25519.getPublicKey(observerSeed), sign: (bytes) => ed25519.sign(bytes, observerSeed) },
      expectedPeerRealm: route.expectedPeerRealm,
      expectedPeerPubkey: fromBase64(route.expectedPeerPubkey),
      verifier: observerVerifier,
    });
    try {
      return await use(client);
    } finally {
      client.close();
    }
  };
  const relayIds = (label: Label) => observe(label, async (client) => sorted(await client.advertise()));
  const relayFrames = (label: Label) =>
    observe(label, async (client) => {
      const frames = (await client.pull([])).map(decodeCarrierOpFrame);
      for (const frame of frames) assert((await verifyCarrierOp(frame, frameVerifier)).valid, "observer pull verifies");
      return frames;
    });
  const idsOf = (p: Party, label: Label) => sorted((profileOf(p, replicas[label])?.frames ?? []).map((f) => f.id));
  const syncedStore = (p: Party, label: Label) => {
    const profile = profileOf(p, replicas[label]);
    assert(profile, `${p.name} holds ${label}`);
    assert.deepEqual(sorted(profile.acked), sorted(profile.frames.map((f) => f.id)), `${p.name}/${label}: acked equals retained`);
    assert.deepEqual(profile.outbox.filter((id) => !profile.acked.includes(id)), [], `${p.name}/${label}: nothing pending`);
  };
  /** Both clients and the relay hold exactly the same ids for every named log; only then is a sync point recorded. */
  async function converged(labels: readonly Label[]) {
    for (const label of labels) {
      const deadline = Date.now() + 30_000;
      for (;;) {
        const onRelay = await relayIds(label);
        const mine = [idsOf(founder, label), idsOf(joiner, label)];
        if (mine.every((ids) => JSON.stringify(ids) === JSON.stringify(onRelay))) break;
        if (Date.now() > deadline)
          throw new Error(`${label} did not converge: relay ${onRelay.length}, founder ${mine[0]!.length}, joiner ${mine[1]!.length}`);
        await delay(150);
      }
      syncedStore(founder, label);
      syncedStore(joiner, label);
    }
    event({ type: "sync", logs: [...labels] });
  }
  const outcomes = (result: { routes: RouteOutcome[] }) => {
    for (const route of result.routes) assert(route.ok, `route sync failed: ${route.ok ? "" : route.error}`);
  };
  const syncAll = async (p: Party) => {
    p.explicitSyncs++;
    outcomes(await syncTreehouse(p.wf, { connect: connectorOf(p).connect }));
  };
  const syncRoutes = async (p: Party, labels: readonly Label[]) => {
    p.explicitSyncs++;
    for (const label of labels) {
      const route = p.wf.state.relay!.routes.find((r) => r.replica === replicas[label])!;
      await syncTreehouseRoute(p.wf, route, { connect: connectorOf(p).connect });
    }
  };

  // ---- 3. founder: route list, first Sync relays the genesis into the empty logs ------------------
  const routeList = JSON.stringify({ localRealm: "founder", routes });
  await founder.wf.configureRoutes(routeList);
  await syncAll(founder);
  for (const label of LABELS) {
    assert.deepEqual(await relayIds(label), idsOf(founder, label), `${label}: relay holds the founder ids`);
    syncedStore(founder, label);
  }
  const relayHeld = await relayFrames("space");
  assert.equal(relayHeld.length, 4, "the Space genesis, its name and two Thread references reached the relay log");
  console.log("PASS founder route list and first Sync deliver the genesis into the empty relay logs");

  // ---- 4. joiner: join request, wrong-input negatives ---------------------------------------------
  const joinRequest = await joiner.wf.beginJoin();
  assert.equal(joiner.native.creates, 1);
  await unchanged(joiner, () => joiner.wf.useOffer(joinRequest), /wrong_product/);
  await unchanged(joiner, () => joiner.wf.useOffer(TRUNCATED_HANDOFF), /wrong_product/);
  await unchanged(founder, () => founder.wf.issueInvitation(TRUNCATED_HANDOFF, "joiner"), /wrong_product/);
  await unchanged(founder, () => founder.wf.issueInvitation(joinRequest, ""), /invalid_local_realm/);
  console.log("PASS join request; a join request or a Township handoff pasted as an offer is refused unchanged");

  // ---- 5. founder: issue the invitation, Sync -----------------------------------------------------
  const offer = await founder.wf.issueInvitation(joinRequest, "joiner");
  const offered = decodeTreehouseOffer(offer);
  assert.equal(offered.routes.length, 3);
  assert.equal(offered.localRealm, "joiner");
  event({
    type: "invite",
    ref: "invite",
    log: "space",
    realm: "founder",
    recipient: "joiner",
    threads: ["general", "questions"],
  });
  assert.equal(await founder.wf.issueInvitation(joinRequest, "joiner"), offer, "reissue reuses the invitation");
  await syncAll(founder);
  assert(
    (await relayIds("space")).includes(offered.invitationId),
    "the invitation is durable on the relay Space route",
  );
  console.log("PASS invitation issued over the full Thread scope and relayed");

  // ---- 6. joiner: Use, confirm, Sync, offer replay is idempotent ----------------------------------
  const review = await joiner.wf.useOffer(offer);
  assert.equal(review.invitationVerified, false);
  for (const label of LABELS) {
    const pinned = review.routes.find((r) => r.replica === replicas[label])!;
    assert.deepEqual(pinned, routeFor(label), "the reviewed route is exactly the pinned server realm and key");
  }
  const beforeConfirm = joiner.native.record;
  await joiner.wf.confirmOffer();
  assert.notEqual(joiner.native.record, beforeConfirm);
  await syncAll(joiner);
  await converged(LABELS);
  for (const label of LABELS) assert.equal(profileOf(joiner, replicas[label])!.outbox.length, 0, "the joiner authored nothing yet");
  const afterJoin = joiner.native.record;
  assert.equal((await joiner.wf.useOffer(offer)).invitationVerified, true, "once pulled, the invitation verifies");
  await joiner.wf.confirmOffer();
  assert.equal(joiner.native.record, afterJoin, "replaying the same offer is idempotent");
  console.log("PASS offer review, confirmation and first pull; replaying the offer changes nothing");

  // A route whose pinned key is wrong is refused at Sync, and nothing durable changes.
  {
    const record = parseState(founder.native.record);
    record.relay!.routes[0]!.expectedPeerPubkey = relayPub("general");
    const clone = new SeededNative(privSeed("founder"));
    clone.record = JSON.stringify(record);
    const wf = await boot(clone);
    const before = clone.record;
    const acked = wf.state.profiles.map((p) => p.acked.length);
    const result = await syncTreehouse(wf, { connect: createTreehouseRelayConnector({ workflow: wf }).connect });
    const spaceRoute = result.routes.find((r) => r.replica === replicas.space)!;
    assert(!spaceRoute.ok && /carrier hello/.test(spaceRoute.error), "a wrong pinned key is refused at the hello");
    assert.equal(clone.record, before, "a refused route changes nothing durable");
    assert.deepEqual(wf.state.profiles.map((p) => p.acked.length), acked, "acked is unchanged");
    await unchanged(founder, () => founder.wf.configureRoutes(JSON.stringify({ localRealm: "founder", routes: routes.map((r, i) => (i === 0 ? { ...r, expectedPeerPubkey: relayPub("general") } : r)) })), /relay_already_configured/);
  }
  console.log("PASS a route with a wrong pinned key is refused at the hello and acked is unchanged");

  // ---- 7. joiner accepts; founder negatives; admit and grant --------------------------------------
  const acceptanceText = await joiner.wf.acceptInvitation(offer);
  const acceptance = decodeTreehouseAcceptance(acceptanceText);
  const flipped = encodeTreehouseAcceptance({ ...acceptance, acceptance: flipByte(acceptance.acceptance) });
  await unchanged(founder, () => founder.wf.admitAndGrant(flipped), /invalid_acceptance/);
  await unchanged(founder, () => founder.wf.admitAndGrant(offer), /wrong_product/);
  await unchanged(founder, () => founder.wf.admitAndGrant(TRUNCATED_HANDOFF), /wrong_product/);
  await unchanged(joiner, () => joiner.wf.acceptInvitation(joinRequest), /wrong_product/);

  const admitted = await founder.wf.admitAndGrant(acceptanceText);
  assert(admitted.admit);
  assert.equal(admitted.grants.length, 2, "one exact-audience grant per Thread in scope");
  event({ type: "admit", log: "space", realm: "founder", recipient: "joiner", signer: "joiner", invite: "invite" });
  for (const label of ["general", "questions"] as const)
    event({
      type: "grant",
      log: label,
      issuer: "founder",
      audience: "joiner",
      ops: ["post", "author_edit", "author_tombstone"],
    });
  const afterAdmit = founder.native.record;
  assert.deepEqual(await founder.wf.admitAndGrant(acceptanceText), { admit: null, grants: [] });
  assert.equal(founder.native.record, afterAdmit, "a replayed admit authors and persists nothing");
  console.log("PASS acceptance negatives, then admit and grant in one commit with an idempotent replay");

  // ---- 8. the grant has not been relayed: the joiner cannot post, and a forged post quarantines ----
  await syncRoutes(founder, ["space"]);
  await syncAll(joiner);
  await converged(["space"]);
  assert.equal(joiner.wf.canAuthor(replicas.general, "post"), false, "no grant is visible to the joiner yet");
  await unchanged(joiner, () => joiner.wf.command(replicas.general, { command: "post", text: TEXTS.forged! }), /no_capability/);
  const joinerGeneral = profileOf(joiner, replicas.general)!;
  const referenced = new Set(joinerGeneral.frames.flatMap((f) => f.deps));
  const forged = await authorTreehouseCommand({
    product: "Treehouse.Thread",
    replica: replicas.general,
    deps: sorted(joinerGeneral.frames.filter((f) => !referenced.has(f.id)).map((f) => f.id)),
    capId: null,
    signer: treehouseCarrierSigner(joiner.wf),
    command: { command: "post", text: TEXTS.forged! },
  });
  {
    const route = routeFor("general");
    const client = await connectCarrierWebSocket({
      url: route.url,
      localRealm: "joiner",
      replica: route.replica,
      signer: treehouseCarrierSigner(joiner.wf),
      expectedPeerRealm: route.expectedPeerRealm,
      expectedPeerPubkey: fromBase64(route.expectedPeerPubkey),
      verifier: observerVerifier,
    });
    const report = await client.relay(forged);
    client.close();
    // The relay classifies structure only: a grantless post is delivered, and the verdict is computed from the log.
    assert.deepEqual(report, { accepted: [forged.id], quarantined: [], rejected: [], pending: [] });
  }
  event({
    type: "command",
    log: "general",
    realm: "joiner",
    command: "post",
    cap: "none",
    args: [{ textKey: "forged" }],
  });
  await syncAll(founder);
  await syncAll(joiner);
  await converged(["general", "questions"]);
  for (const p of [founder, joiner]) {
    const view = p.wf.views.get(replicas.general)!;
    assert.equal(view.quarantineReasons.get(forged.id), "no_capability", `${p.name} quarantines the forged post exactly`);
    assert.equal(view.posts.length, 0, "a quarantined post has no projected effect");
  }
  assert.equal(joiner.wf.canAuthor(replicas.general, "post"), true, "the grant arrived");
  assert.equal(joiner.wf.canAuthor(replicas.questions, "post"), true);
  console.log("PASS no grant, no post: local refusal, then a forged grantless post quarantines as no_capability everywhere");

  // ---- 9. joiner posts; the founder receives them through the subscription hint, no explicit Sync -
  let feedState: TreehouseFeedState | null = null;
  const founderConnector = connectorOf(founder);
  feed = createTreehouseFeedController({
    workflow: founder.wf,
    sync: { connect: founderConnector.connect },
    connect: founderConnector.connectFeed,
    onState: (state) => {
      feedState = state;
    },
    pollMs: 0,
    autosyncOnMount: true,
  });
  await feed.start();
  await waitFor("founder subscriptions live", () => feedState?.routes.length === 3 && feedState.routes.every((r) => r.connection === "live"));
  await converged(LABELS);

  const generalPost = await joiner.wf.command(replicas.general, { command: "post", text: TEXTS.joiner_general! });
  const questionPost = await joiner.wf.command(replicas.questions, { command: "post", text: TEXTS.joiner_questions! });
  event({ type: "command", log: "general", realm: "joiner", command: "post", args: [{ textKey: "joiner_general" }] });
  event({ type: "command", log: "questions", realm: "joiner", command: "post", args: [{ textKey: "joiner_questions" }] });
  assert.equal(profileOf(joiner, replicas.general)!.outbox.filter((id) => !profileOf(joiner, replicas.general)!.acked.includes(id)).length, 1);
  const explicitBefore = founder.explicitSyncs;
  await syncAll(joiner);
  await waitFor("the founder to receive the joiner posts by hint", () =>
    idsOf(founder, "general").includes(generalPost) && idsOf(founder, "questions").includes(questionPost),
  );
  assert.equal(founder.explicitSyncs, explicitBefore, "the founder pressed no Sync: the hint triggered the pull");
  await converged(["general", "questions"]);
  assert.equal(founder.wf.views.get(replicas.general)!.posts.at(-1)!.text, TEXTS.joiner_general);
  console.log("PASS member posts converge to the founder through the availability hint with polling off");

  // ---- 10. founder reply, explicit Sync ------------------------------------------------------------
  await founder.wf.command(replicas.general, { command: "post", text: TEXTS.founder_reply! });
  event({ type: "command", log: "general", realm: "founder", command: "post", args: [{ textKey: "founder_reply" }] });
  await feed.syncNow();
  await syncAll(joiner);
  await converged(["general"]);
  assert.equal(joiner.wf.views.get(replicas.general)!.posts.at(-1)!.text, TEXTS.founder_reply);
  console.log("PASS founder reply relays and the joiner pulls it");

  // ---- 11. restart and heal ------------------------------------------------------------------------
  await feed.stop();
  feed = null;
  await converged(LABELS);
  const snapshot = {
    relayIds: Object.fromEntries(await Promise.all(LABELS.map(async (label) => [label, await relayIds(label)] as const))),
    founderIds: Object.fromEntries(LABELS.map((label) => [label, idsOf(founder, label)])),
    joinerIds: Object.fromEntries(LABELS.map((label) => [label, idsOf(joiner, label)])),
    relayPid: relay.pid,
  };
  await relay.kill();
  event({ type: "partition" });

  // Both apps relaunch from their saved record with the relay down: history is intact before any Sync.
  joiner.wf = await boot(joiner.native);
  founder.wf = await boot(founder.native);
  for (const label of LABELS) {
    assert.deepEqual(idsOf(joiner, label), snapshot.joinerIds[label], `${label}: joiner restart recovery without the network`);
    assert.deepEqual(idsOf(founder, label), snapshot.founderIds[label], `${label}: founder restart recovery without the network`);
  }
  const offlineJoiner = await joiner.wf.command(replicas.general, { command: "post", text: TEXTS.offline_joiner! });
  const offlineFounder = await founder.wf.command(replicas.general, { command: "post", text: TEXTS.offline_founder! });
  event({ type: "command", log: "general", realm: "joiner", command: "post", args: [{ textKey: "offline_joiner" }] });
  event({ type: "command", log: "general", realm: "founder", command: "post", args: [{ textKey: "offline_founder" }] });
  {
    // A Sync with the relay down fails per route and leaves the saved record untouched.
    const before = joiner.native.record;
    const down = await syncTreehouse(joiner.wf, { connect: connectorOf(joiner).connect, sleep: async () => {} });
    assert(down.routes.every((r) => !r.ok), "every route fails while the relay is down");
    assert.equal(joiner.native.record, before);
    const profile = profileOf(joiner, replicas.general)!;
    assert.deepEqual(profile.outbox.filter((id) => !profile.acked.includes(id)), [offlineJoiner], "the offline post is pending");
  }
  relay = await spawnPilotManifestServer(manifestPath);
  assert.notEqual(relay.pid, snapshot.relayPid, "the relay is a new process");
  for (const label of LABELS) {
    assert.equal(relay.instances[label]!.port, ports[label], "the same port is reused");
    assert.deepEqual(await relayIds(label), snapshot.relayIds[label], `${label}: the restarted relay serves the same ids`);
  }
  event({ type: "heal" });
  await syncAll(joiner);
  await syncAll(founder);
  await syncAll(joiner);
  await converged(LABELS);
  assert(idsOf(founder, "general").includes(offlineJoiner) && idsOf(joiner, "general").includes(offlineFounder));
  console.log("PASS restart recovery, an offline post pending then draining, and concurrent offline posts heal");

  // ---- 12. evidence, oracle, hygiene --------------------------------------------------------------
  const observerFrames: Record<string, CarrierOpFrame[]> = {};
  for (const label of LABELS) observerFrames[label] = await relayFrames(label);
  const finalFounder = await boot(founder.native);
  const finalJoiner = await boot(joiner.native);
  const store = (wf: TreehouseWorkflow) => ({
    profiles: wf.state.profiles.map((p) => ({
      label: labelOf.get(p.replica)!,
      replica: p.replica,
      frames: p.frames,
      outbox: p.outbox,
      acked: p.acked,
      reasons: Object.fromEntries(wf.views.get(p.replica)!.quarantineReasons),
    })),
  });
  const stores = { founder: store(finalFounder), joiner: store(finalJoiner) };
  for (const s of Object.values(stores))
    for (const profile of s.profiles) {
      assert.deepEqual(sorted(profile.acked), sorted(profile.frames.map((f) => f.id)), "acked equals retained");
      assert.deepEqual(profile.outbox.filter((id) => !profile.acked.includes(id)), [], "pending is zero");
    }
  const relayLogs = Object.fromEntries(LABELS.map((label) => [label, join(root, `${label}.log`)]));
  // The relay is stopped cleanly so every log is on disk before the oracle reads it.
  await relay.stop();
  relay = null;

  const writeJson = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value, null, 2));
  writeJson("trace.json", trace);
  writeJson("texts.json", TEXTS);
  writeJson("observed.json", {
    relayLogs,
    relayPubs: LABELS.map(relayPub),
    observerPub,
    stores,
    observer: observerFrames,
  });
  const out = await runBeamSupport(
    "clients/treehouse-tauri-shell/test/support/treehouse_enrollment_oracle.exs",
    [root],
    "ORACLE_OK",
  );
  const summary = JSON.parse(readFileSync(join(root, "oracle_out.json"), "utf8")) as {
    ok: boolean;
    controls: Record<string, boolean>;
    logs: { label: string; ops: number }[];
    reasons: Record<string, Record<string, string>>;
  };
  assert.equal(summary.ok, true);
  assert.deepEqual(Object.keys(summary.controls).sort(), ["drop_id", "flip_byte", "perturb_dep", "skip_grant"]);
  assert(Object.values(summary.controls).every((rejected) => rejected), "every negative control makes the oracle fail");
  assert.deepEqual(Object.values(summary.reasons.general!), ["no_capability"]);
  assert.match(out, /ORACLE_OK/);
  console.log("PASS the Sim replay equals the relay logs, both stores and a fresh observer pull; negative controls fail");

  // Seeds and keys are absent everywhere; post text is absent from the trace and the oracle output.
  const seedNeedles = ["founder", "joiner", "observer"].flatMap((realm) => {
    const seed = privSeed(realm);
    return [seed.toString("hex"), seed.toString("base64"), seed.toString("base64url")];
  });
  for (const label of LABELS) seedNeedles.push(relaySeed(label).toString("hex"), relaySeed(label).toString("base64"));
  // Frames carry post text as a base64 binary term, so the needles cover the plain and encoded forms.
  const encodedText = (text: string) => Buffer.from(text).toString("base64");
  const textNeedles = Object.values(TEXTS).flatMap((text) => [text, encodedText(text), encodedText(text).replace(/=+$/, "")]);
  for (const name of ["founder", "joiner"] as const)
    assertNoSecrets(`${name} record`, (name === "founder" ? founder : joiner).native.record!, seedNeedles);
  for (const label of LABELS) assertNoSecrets(`${label} relay log`, readFileSync(relayLogs[label]!, "latin1"), seedNeedles);
  for (const name of ["trace.json", "oracle_out.json"]) {
    const text = readFileSync(join(root, name), "utf8");
    assertNoSecrets(name, text, [...seedNeedles, ...textNeedles]);
  }
  assert(
    founder.native.record!.includes(encodedText(TEXTS.joiner_general!)),
    "post text is intentionally present in the store",
  );
  // The relay log is an Erlang term file: the post text is plain bytes there, readable by whoever holds the host.
  assert(readFileSync(relayLogs.general!, "latin1").includes(TEXTS.joiner_general!), "and in the plaintext relay log");
  assertScannerDetects(seedNeedles[0]!);
  console.log("PASS secret hygiene: no seed or key anywhere, no post text in the trace or oracle output");
} finally {
  await feed?.stop().catch(() => undefined);
  await relay?.kill().catch(() => undefined);
  // GATE_KEEP=1 leaves the scratch root (trace, observed, relay logs) in place for debugging.
  if (!process.env.GATE_KEEP) rmSync(root, { recursive: true, force: true });
}
