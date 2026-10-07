import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  decodeTreehouseAcceptance,
  decodeTreehouseOffer,
  encodeTreehouseAcceptance,
} from "@treetopdevs/lattice-client";
import { createTreehouseRelayConnector } from "../src/treehouse_relay_client";
import { syncTreehouse } from "../src/treehouse_sync";
import { parseState } from "../src/treehouse_state";
import type { PreviewNative, PreviewState, RelayRoute } from "../src/treehouse_state";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { createAxDriver, nodesInclude } from "./support/packaged_ax";
import type { AxDriver, AxNode, TransferMethod } from "./support/packaged_ax";
import { assertPackagedBundleVariant } from "./support/packaged_bundle_variant";
import {
  assertPrivateChain,
  createRelayObserver,
  fileSha256,
  freeTcpPort,
  makeGateRoot,
  runBeamSupport,
  spawnPilotManifestServer,
  writePilotManifest,
} from "./support/relay_peer";
import type { PilotRelay } from "./support/relay_peer";
import { assertNoSecrets, assertScannerDetects } from "./support/secret_scan";
import { SeededNative } from "./support/seeded_native";

// Plan 181 S5c1. The packaged two-instance macOS harness: two launches of one dev-trace Treehouse bundle,
// each with a directory-isolated store and a seeded in-memory test key (not Keychain custody), driven only
// through the real accessibility tree (press, paste and read, by pid), against one `pilot_node.exs` fixture
// relay that this script spawns (loopback, macOS directory-sync approximation, hand-written manifest). The
// oracle replays the observed scenario through `Lattice.Sim` and compares op ids, frames, state and verdicts.
//
// What this does not do: it never reads app storage to decide what to press (SQLite is read-only evidence),
// it never touches ~/Library/Application Support/dev.treetop.lattice.treehouse (the ordinary app's data),
// and its relay stop and kill paths are test-only with no controlled-stop semantics. No durable-ack claim
// is made on macOS. The first thing it proves, before anything else, is the artifact transfer (G-AX).

console.log("\n▸ Treehouse packaged R13-lite enrollment: two dev-trace instances against Lattice.Sim");

const shell = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(shell, "../..");
const bundle = process.env.TREEHOUSE_APP_BUNDLE ?? join(shell, "src-tauri/target/release/bundle/macos/Treehouse.app");
const binary = join(bundle, "Contents/MacOS/treehouse-tauri-shell");
const realData = join(homedir(), "Library/Application Support/dev.treetop.lattice.treehouse");
const TRANSFER: TransferMethod = "paste";

const SEED = "r13-lite-packaged";
const TEXTS: Record<string, string> = {
  joiner_general: "Hello from the joiner pkg",
  founder_reply: "Welcome aboard pkg",
  offline_joiner: "Posted while the relay was down pkg",
};
const LABELS = ["space", "general"] as const;
type Label = (typeof LABELS)[number];
const RELAY_REALMS: Record<Label, string[]> = { space: ["founder"], general: ["founder", "joiner"] };
const TRUNCATED_HANDOFF = `township-pairing:v1:${Buffer.from(
  JSON.stringify({ url: "ws://127.0.0.1:1", replica: "township" }),
).toString("base64url")}`;
// The shell's own refusal copy (EnrollmentPanel.vue). The wrong-input negatives pin it by text.
const REFUSED = {
  wrong_product: "That text is not a Treehouse artifact. Nothing was changed.",
  invalid_acceptance: "That acceptance is not valid for this invitation.",
  relay_already_configured: "Different relay routes are already saved. Saved routes are never replaced.",
};
const DISCLOSURE_HEAD = "The relay operator, and anyone with its host, backups or admitted peers, can read this group's plaintext log";

const privSeed = (realm: string) => createHash("sha256").update(`${SEED}:${realm}`).digest();
const pub64 = (realm: string) => Buffer.from(ed25519.getPublicKey(privSeed(realm))).toString("base64");
const sorted = (ids: Iterable<string>) => [...ids].sort();
const delay = (ms: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
const flipByte = (b64: string) => {
  const bytes = Buffer.from(b64, "base64");
  bytes[0]! ^= 1;
  return bytes.toString("base64");
};
async function poll(what: string, check: () => boolean | Promise<boolean>, ms = 60_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(250);
  }
}
const step = (n: number, text: string) => console.log(`STEP ${n}: ${text}`);

// ---- app instances -----------------------------------------------------------------------------------

interface App {
  name: "founder" | "joiner";
  dataDir: string;
  traceFile: string;
  database: string;
  child: ChildProcess | null;
  output: string[];
  ax: AxDriver | null;
  syncPresses: number;
  launches: number;
}

const root = makeGateRoot("r13-lite-packaged");
const evidence = process.env.TREEHOUSE_EVIDENCE_DIR ? resolve(process.env.TREEHOUSE_EVIDENCE_DIR) : join(root, "evidence");
mkdirSync(evidence, { recursive: true });
const helper = join(root, "accessibility");

function newApp(name: App["name"]): App {
  const dataDir = join(root, `data-${name}`);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    name,
    dataDir,
    traceFile: join(root, `trace-${name}.log`),
    database: join(dataDir, "treehouse-v1.sqlite3"),
    child: null,
    output: [],
    ax: null,
    syncPresses: 0,
    launches: 0,
  };
}

function launch(app: App) {
  assert(app.child === null || app.child.exitCode !== null || app.child.signalCode !== null, `${app.name} is already running`);
  // The seam variables are the only thing that keeps this launch off the ordinary app's data directory and
  // Keychain alias, so they are always set together. Nothing else is inherited from them.
  const child = spawn(binary, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      TREEHOUSE_DEV_DATA_DIR: app.dataDir,
      TREEHOUSE_DEV_CARRIER_SEED: privSeed(app.name).toString("hex"),
      TREEHOUSE_DEV_TRACE_FILE: app.traceFile,
    },
  });
  child.stdout!.on("data", (chunk) => app.output.push(String(chunk)));
  child.stderr!.on("data", (chunk) => app.output.push(String(chunk)));
  app.child = child;
  app.launches++;
  app.ax = createAxDriver({
    transfer: TRANSFER,
    attempts: 150,
    exec: (args, input) =>
      execFileSync(helper, [String(child.pid), ...args], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        ...(input === undefined ? {} : { input }),
      }),
  });
}

async function stop(app: App) {
  const child = app.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  await exited;
  clearTimeout(timer);
}

async function waitUi(app: App, text: string, attempts = 150) {
  try {
    await app.ax!.waitFor(text, (nodes) => nodesInclude(nodes, text), attempts);
  } catch (error) {
    const nodes = await app.ax!.dump();
    const hint =
      nodes.length === 0
        ? " (the app exposes no accessibility nodes: the console session may be locked, or this terminal lacks the Accessibility permission)"
        : "";
    throw new Error(`${error instanceof Error ? error.message : String(error)}${hint}`);
  }
}
const waitText = (app: App, text: string, attempts = 150) => waitUi(app, text, attempts);

// ---- read-only store evidence ------------------------------------------------------------------------

function rows(app: App): { key: string; value: string }[] {
  if (!existsSync(app.database)) return [];
  for (let attempt = 0; ; attempt++) {
    try {
      return JSON.parse(
        execFileSync("sqlite3", ["-readonly", "-json", app.database, "SELECT key,value FROM kv ORDER BY key;"], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        }) || "[]",
      );
    } catch (error) {
      if (attempt >= 4) throw error;
    }
  }
}
const recordOf = (app: App) => rows(app).find((row) => row.key === "treehouse:preview:history")?.value ?? null;
const stateOf = (app: App): PreviewState => parseState(recordOf(app));
const profileOf = (app: App, replica: string) => stateOf(app).profiles.find((p) => p.replica === replica);
const pendingOf = (app: App, replica: string) => {
  const profile = profileOf(app, replica);
  return profile ? profile.outbox.filter((id) => !profile.acked.includes(id)) : [];
};

async function readOnlyWorkflow(record: string): Promise<TreehouseWorkflow> {
  const state = parseState(record);
  const refuse = async (): Promise<never> => {
    throw new Error("read-only");
  };
  const reader: PreviewNative = {
    open: async () => ({ record, publicKey: state.publicKey, keyStatus: "available" }),
    initialize: refuse,
    commit: refuse,
    sign: refuse,
    saveDraft: refuse,
    loadDraft: async () => null,
  };
  const wf = new TreehouseWorkflow(reader);
  await wf.open();
  return wf;
}

/** The ordinary app's data directory is fingerprinted, never read or written: this run must leave it as found. */
function fingerprint(path: string): string | null {
  if (!existsSync(path)) return null;
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const info = statSync(full);
      if (info.isDirectory()) walk(full);
      else lines.push(`${full.slice(path.length)} ${info.size} ${info.mtimeMs}`);
    }
  };
  walk(path);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

// ---- the run -----------------------------------------------------------------------------------------

const realBefore = fingerprint(realData);
const founder = newApp("founder");
const joiner = newApp("joiner");
const apps = [founder, joiner];
const trace: { namespace: string; realms: string[]; logs: object[]; events: object[] } = {
  namespace: SEED,
  realms: ["founder", "joiner"],
  logs: [],
  events: [],
};
const event = (value: object) => trace.events.push(value);
let relay: PilotRelay | null = null;
let failed = false;

try {
  // ---- 1. preflight ---------------------------------------------------------------------------------
  step(1, "preflight");
  assert.equal(process.platform, "darwin", "the packaged enrollment harness runs on macOS");
  assertPrivateChain(root);
  assertPrivateChain(founder.dataDir);
  assertPrivateChain(joiner.dataDir);
  if (process.env.TREEHOUSE_PACKAGED_BUILD === "1") {
    rmSync(bundle, { recursive: true, force: true });
    execFileSync("npm", ["run", "tauri:build:dev-trace"], { cwd: shell, stdio: "inherit" });
  }
  assert(existsSync(binary), `no packaged bundle at ${bundle}; build it first with: npm run tauri:build:dev-trace`);
  assertPackagedBundleVariant(bundle, "dev_trace");
  execFileSync("swiftc", [join(shell, "test/support/packaged_accessibility.swift"), "-o", helper]);
  assertScannerDetects(privSeed("founder").toString("hex"));
  console.log("PASS the bundle classifies as the dev-trace variant, the scratch chain is private, the helper is built");

  // ---- 2. founder: transfer preflight (G-AX), create the group and a Thread -------------------------
  step(2, "founder launch, G-AX transfer preflight, group and Thread");
  launch(founder);
  await waitUi(founder, "Create local group");
  await founder.ax!.transferPreflight("Paste offer");
  console.log(`PASS G-AX: 20 byte-exact 8 KiB round trips by ${founder.ax!.transfer}`);
  if (process.env.TREEHOUSE_PACKAGED_PREFLIGHT_ONLY === "1") {
    console.log("PREFLIGHT_ONLY: stopping after the transfer check");
    process.exitCode = 0;
    throw Object.assign(new Error("preflight only"), { preflightOnly: true });
  }
  await founder.ax!.put("Group name", "Canopy");
  await founder.ax!.press("Create local group");
  await waitUi(founder, "Thread title");
  await founder.ax!.put("Thread title", "General");
  await founder.ax!.press("Create thread");
  await waitUi(founder, "Write a post");
  await poll("the founder Space and Thread in the store", () => stateOf(founder).profiles.length === 2);
  const space = stateOf(founder).profiles.find((p) => p.product === "Treehouse.Space")!;
  const thread = stateOf(founder).profiles.find((p) => p.product === "Treehouse.Thread")!;
  const replicas: Record<Label, string> = { space: space.replica, general: thread.replica };
  for (const label of LABELS)
    trace.logs.push({ label, product: label === "space" ? "Treehouse.Space" : "Treehouse.Thread", replica: replicas[label] });
  event({ type: "found", log: "space" });
  event({ type: "command", log: "space", realm: "founder", command: "create_space", args: ["Canopy"] });
  event({ type: "found", log: "general" });
  event({ type: "command", log: "general", realm: "founder", command: "create_thread", args: ["General"] });
  event({
    type: "command",
    log: "space",
    realm: "founder",
    command: "create_thread",
    args: [{ replicaOf: "general" }, "General"],
  });
  console.log("PASS the founder created a real Space and Thread through the UI before any relay exists");

  // ---- 3. hand-written manifest, empty logs, relay boot ---------------------------------------------
  step(3, "hand-written manifest and relay boot (admission pre-seeded, not enrolled)");
  const ports: Record<Label, number> = { space: await freeTcpPort(), general: await freeTcpPort() };
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
  const relayPids = [relay.pid];
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
  const observer = createRelayObserver(observerSeed, { space: routes[0]!, general: routes[1]! });
  const idsOf = (app: App, label: Label) => sorted((profileOf(app, replicas[label])?.frames ?? []).map((f) => f.id));
  const settled = (app: App, label: Label) => {
    const profile = profileOf(app, replicas[label]);
    return (
      profile !== undefined &&
      JSON.stringify(sorted(profile.acked)) === JSON.stringify(sorted(profile.frames.map((f) => f.id))) &&
      pendingOf(app, replicas[label]).length === 0
    );
  };
  /**
   * The relay and every named app hold exactly the same ids, with `acked` equal to the retained set and
   * nothing pending. Only then is a sync point recorded for the oracle, so every authoring step that follows
   * has a deterministic dependency frontier.
   */
  async function converged(labels: readonly Label[], who: readonly App[], ms = 120_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      let why = "";
      for (const label of labels) {
        const onRelay = await observer.ids(label);
        for (const app of who) {
          const mine = idsOf(app, label);
          if (JSON.stringify(mine) !== JSON.stringify(onRelay))
            why = `${label}: relay ${onRelay.length}, ${app.name} ${mine.length}`;
          else if (!settled(app, label)) why = `${label}: ${app.name} has unacknowledged operations`;
        }
      }
      if (why === "") break;
      if (Date.now() > deadline) throw new Error(`did not converge: ${why}`);
      await delay(300);
    }
    event({ type: "sync", logs: [...labels] });
  }
  const pressSync = async (app: App) => {
    app.syncPresses++;
    await app.ax!.press("Sync");
  };
  const unchanged = async (app: App, refusal: string, action: () => Promise<void>) => {
    const before = recordOf(app);
    await action();
    await waitText(app, refusal);
    assert.equal(recordOf(app), before, `the refusal "${refusal}" left the saved record untouched`);
  };
  const routeList = (list: RelayRoute[]) => JSON.stringify({ localRealm: "founder", routes: list });

  // ---- 4. founder: route list and first Sync --------------------------------------------------------
  step(4, "founder route list and first Sync");
  await founder.ax!.put("Paste route list", routeList(routes));
  await founder.ax!.press("Configure routes");
  await waitText(founder, "Saved relay routes");
  await pressSync(founder);
  await converged(LABELS, [founder]);
  for (const label of LABELS) assert.deepEqual(await observer.ids(label), idsOf(founder, label), `${label}: relay holds the founder ids`);
  console.log("PASS the first Sync relayed the genesis into the empty relay logs and the observer pull equals the founder store");

  // ---- 5. founder negatives -------------------------------------------------------------------------
  step(5, "founder negatives: wrong artifact, replaced route list, wrong pinned key");
  await unchanged(founder, REFUSED.wrong_product, async () => {
    await founder.ax!.put("Paste join request", TRUNCATED_HANDOFF);
    await founder.ax!.put("Joiner realm", "joiner");
    await founder.ax!.press("Issue invitation");
  });
  const swapped = routes.map((route, i) => (i === 0 ? { ...route, expectedPeerPubkey: relayPub("general") } : route));
  await unchanged(founder, REFUSED.relay_already_configured, async () => {
    await founder.ax!.put("Paste route list", routeList(swapped));
    await founder.ax!.press("Configure routes");
  });
  {
    // The app cannot hold a wrong key (saved routes are never replaced), so the hello refusal is proven over
    // the real socket with the founder's own record: a clone whose Space route pins the wrong key is refused
    // at the hello and changes nothing durable. This is the headless workflow, not the packaged UI.
    const record = parseState(recordOf(founder));
    record.relay!.routes[0]!.expectedPeerPubkey = relayPub("general");
    const clone = new SeededNative(privSeed("founder"));
    clone.record = JSON.stringify(record);
    const wf = new TreehouseWorkflow(clone);
    await wf.open();
    const before = clone.record;
    const acked = wf.state.profiles.map((p) => p.acked.length);
    const result = await syncTreehouse(wf, { connect: createTreehouseRelayConnector({ workflow: wf }).connect, sleep: async () => {} });
    const refused = result.routes.find((r) => r.replica === replicas.space)!;
    assert(!refused.ok && /carrier hello/.test(refused.error), "a wrong pinned key is refused at the hello");
    assert.equal(clone.record, before, "a refused route changes nothing durable");
    assert.deepEqual(wf.state.profiles.map((p) => p.acked.length), acked, "acked is unchanged");
  }
  console.log("PASS a non-Treehouse artifact and a replaced route list are refused unchanged; a wrong pinned key is refused at the hello");

  // ---- 6. joiner: join request and its negative -----------------------------------------------------
  step(6, "joiner launch, join request, negative");
  launch(joiner);
  await waitUi(joiner, "Join a group");
  await joiner.ax!.press("Join a group");
  const joinRequest = await joiner.ax!.readWhenPresent("Join request");
  await unchanged(joiner, REFUSED.wrong_product, async () => {
    await joiner.ax!.put("Paste offer", joinRequest);
    await joiner.ax!.press("Use offer");
  });
  console.log("PASS the joiner created its join request; a join request pasted as an offer is refused unchanged");

  // ---- 7. founder: issue the invitation -------------------------------------------------------------
  step(7, "founder issues the invitation and Syncs");
  await converged(["space", "general"], [founder]);
  await founder.ax!.put("Paste join request", joinRequest);
  await founder.ax!.put("Joiner realm", "joiner");
  await founder.ax!.press("Issue invitation");
  const offer = await founder.ax!.readWhenPresent("Offer");
  const offered = decodeTreehouseOffer(offer);
  assert.equal(offered.routes.length, 2);
  assert.equal(offered.localRealm, "joiner");
  event({ type: "invite", ref: "invite", log: "space", realm: "founder", recipient: "joiner", threads: ["general"] });
  await pressSync(founder);
  await converged(["space", "general"], [founder]);
  assert((await observer.ids("space")).includes(offered.invitationId), "the invitation is durable on the relay");
  console.log("PASS the invitation was issued over the Thread scope and relayed");

  // ---- 8. joiner: Use, confirm, Sync, replay, accept ------------------------------------------------
  step(8, "joiner Use offer, confirm, Sync, idempotent replay, accept");
  await joiner.ax!.put("Paste offer", offer);
  await joiner.ax!.press("Use offer");
  await waitText(joiner, "Review this offer");
  await waitText(joiner, DISCLOSURE_HEAD);
  for (const route of routes) {
    await waitText(joiner, route.expectedPeerRealm);
    await waitText(joiner, route.expectedPeerPubkey);
  }
  await joiner.ax!.press("Confirm routes");
  await waitText(joiner, "Saved relay routes");
  await pressSync(joiner);
  await converged(["space", "general"], [founder, joiner]);
  for (const label of LABELS) assert.equal(profileOf(joiner, replicas[label])!.outbox.length, 0, "the joiner authored nothing yet");
  {
    const before = recordOf(joiner);
    await joiner.ax!.press("Use offer");
    await poll("the replayed offer review", () => joiner.ax!.isEnabled("Confirm routes").catch(() => false));
    await joiner.ax!.press("Confirm routes");
    await delay(1000);
    assert.equal(recordOf(joiner), before, "replaying the same offer changes nothing durable");
  }
  await joiner.ax!.press("Accept invitation");
  const acceptanceText = await joiner.ax!.readWhenPresent("Acceptance");
  const acceptance = decodeTreehouseAcceptance(acceptanceText);
  // No grant has been authored yet: the joiner can type a draft but its Post control stays disabled.
  await joiner.ax!.put("Write a post", TEXTS.joiner_general!);
  assert.equal(await joiner.ax!.isEnabled("Post"), false, "Post is disabled before any grant exists");
  const flipped = encodeTreehouseAcceptance({ ...acceptance, acceptance: flipByte(acceptance.acceptance) });
  await unchanged(founder, REFUSED.invalid_acceptance, async () => {
    await founder.ax!.put("Paste acceptance", flipped);
    await founder.ax!.press("Admit and grant");
  });
  console.log("PASS offer review shows the disclosure and pinned realm and key; replay is idempotent; a flipped acceptance is refused");

  // ---- 9. founder: admit and grant ------------------------------------------------------------------
  step(9, "founder admits and grants, then Syncs");
  await converged(["space", "general"], [founder, joiner]);
  await founder.ax!.put("Paste acceptance", acceptanceText);
  await founder.ax!.press("Admit and grant");
  await waitText(founder, "Admitted and granted 1 thread");
  event({ type: "admit", log: "space", realm: "founder", recipient: "joiner", signer: "joiner", invite: "invite" });
  event({ type: "grant", log: "general", issuer: "founder", audience: "joiner", ops: ["post", "author_edit", "author_tombstone"] });
  await pressSync(founder);

  // ---- 10. joiner: Sync, grant visible, Post, Sync --------------------------------------------------
  step(10, "joiner Sync, grant visible, Post, Sync");
  await pressSync(joiner);
  await poll("the Post control to enable under the grant", () => joiner.ax!.isEnabled("Post").catch(() => false));
  await converged(["space", "general"], [founder, joiner]);
  await joiner.ax!.press("Post");
  event({ type: "command", log: "general", realm: "joiner", command: "post", args: [{ textKey: "joiner_general" }] });
  await waitText(joiner, TEXTS.joiner_general!);
  await poll("the joiner post in its outbox", () => pendingOf(joiner, replicas.general).length === 1);
  const joinerPost = pendingOf(joiner, replicas.general)[0]!;
  await pressSync(joiner);

  // ---- 11. live feed, founder -----------------------------------------------------------------------
  step(11, "founder receives the post through the availability hint (no Sync pressed)");
  const founderPresses = founder.syncPresses;
  await poll("the founder to receive the joiner post by hint", () => idsOf(founder, "general").includes(joinerPost), 30_000);
  await waitText(founder, TEXTS.joiner_general!, 150);
  assert.equal(founder.syncPresses, founderPresses, "the founder pressed no Sync: the hint triggered the pull");
  await converged(["general"], [founder, joiner]);
  await founder.ax!.put("Write a post", TEXTS.founder_reply!);
  await founder.ax!.press("Post");
  event({ type: "command", log: "general", realm: "founder", command: "post", args: [{ textKey: "founder_reply" }] });
  await waitText(founder, TEXTS.founder_reply!);
  await poll("the founder reply in its outbox", () => pendingOf(founder, replicas.general).length === 1);
  const founderReply = pendingOf(founder, replicas.general)[0]!;
  await pressSync(founder);

  // ---- 12. live feed, joiner ------------------------------------------------------------------------
  step(12, "joiner receives the reply through the availability hint (no Sync pressed)");
  const joinerPresses = joiner.syncPresses;
  await poll("the joiner to receive the founder reply by hint", () => idsOf(joiner, "general").includes(founderReply), 30_000);
  await waitText(joiner, TEXTS.founder_reply!, 150);
  assert.equal(joiner.syncPresses, joinerPresses, "the joiner pressed no Sync: the hint triggered the pull");
  await converged(LABELS, [founder, joiner]);
  console.log("PASS both posts arrived through the live subscription with no Sync pressed by the receiving app");

  // ---- 13. restart and heal -------------------------------------------------------------------------
  step(13, "restart: both apps stop, the relay is killed, the joiner posts offline, the relay returns");
  const snapshot = {
    relayIds: { space: await observer.ids("space"), general: await observer.ids("general") },
    relayHashes: { space: fileSha256(join(root, "space.log")), general: fileSha256(join(root, "general.log")) },
    founderIds: { space: idsOf(founder, "space"), general: idsOf(founder, "general") },
    joinerIds: { space: idsOf(joiner, "space"), general: idsOf(joiner, "general") },
    founderRecord: recordOf(founder),
    joinerRecord: recordOf(joiner),
    appPids: { founder: founder.child!.pid, joiner: joiner.child!.pid },
    relayPid: relay.pid,
  };
  await stop(founder);
  await stop(joiner);
  await relay.kill();
  event({ type: "partition" });

  launch(joiner);
  await waitText(joiner, TEXTS.founder_reply!);
  assert.notEqual(joiner.child!.pid, snapshot.appPids.joiner, "the joiner is a new process");
  for (const label of LABELS) assert.deepEqual(idsOf(joiner, label), snapshot.joinerIds[label], `${label}: joiner restart recovery without the network`);
  assert.equal(recordOf(joiner), snapshot.joinerRecord, "opening wrote nothing: the saved record is byte-identical");
  await joiner.ax!.put("Write a post", TEXTS.offline_joiner!);
  await joiner.ax!.press("Post");
  event({ type: "command", log: "general", realm: "joiner", command: "post", args: [{ textKey: "offline_joiner" }] });
  await waitText(joiner, TEXTS.offline_joiner!);
  await poll("the offline joiner post pending", () => pendingOf(joiner, replicas.general).length === 1);
  const offlineJoiner = pendingOf(joiner, replicas.general)[0]!;

  relay = await spawnPilotManifestServer(manifestPath);
  relayPids.push(relay.pid);
  assert.notEqual(relay.pid, snapshot.relayPid, "the relay is a new process");
  for (const label of LABELS) {
    assert.equal(relay.instances[label]!.port, ports[label], "the same port is reused");
    assert.deepEqual(await observer.ids(label), snapshot.relayIds[label], `${label}: the restarted relay serves the same ids`);
  }
  const relayBytesUnchanged = LABELS.every((label) => fileSha256(join(root, `${label}.log`)) === snapshot.relayHashes[label]);
  event({ type: "heal" });

  launch(founder);
  await waitText(founder, TEXTS.joiner_general!);
  assert.notEqual(founder.child!.pid, snapshot.appPids.founder, "the founder is a new process");
  for (const label of LABELS) assert.deepEqual(idsOf(founder, label), snapshot.founderIds[label], `${label}: founder restart recovery without the network`);
  assert.equal(recordOf(founder), snapshot.founderRecord, "opening wrote nothing: the saved record is byte-identical");

  await pressSync(joiner);
  await poll("the offline post on the relay", async () => (await observer.ids("general")).includes(offlineJoiner));
  await pressSync(founder);
  await converged(LABELS, [founder, joiner]);
  assert(idsOf(founder, "general").includes(offlineJoiner), "the offline post drained to the founder");
  console.log("PASS restart recovery before any Sync, an offline post pending then draining, convergence after the relay returned");

  // ---- 14. evidence, oracle, hygiene ----------------------------------------------------------------
  step(14, "oracle and hygiene");
  const observerFrames: Record<string, unknown> = {};
  for (const label of LABELS) observerFrames[label] = await observer.frames(label);
  await stop(founder);
  await stop(joiner);
  const labelOf = new Map(LABELS.map((label) => [replicas[label], label]));
  const store = async (app: App) => {
    const wf = await readOnlyWorkflow(recordOf(app)!);
    return {
      profiles: wf.state.profiles.map((p) => ({
        label: labelOf.get(p.replica)!,
        replica: p.replica,
        frames: p.frames,
        outbox: p.outbox,
        acked: p.acked,
        reasons: Object.fromEntries(wf.views.get(p.replica)!.quarantineReasons),
      })),
    };
  };
  const stores = { founder: await store(founder), joiner: await store(joiner) };
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
    logs: { label: string; ops: number; ids: string[] }[];
    reasons: Record<string, Record<string, string>>;
  };
  assert.equal(summary.ok, true);
  assert.deepEqual(Object.keys(summary.controls).sort(), ["drop_id", "flip_byte", "perturb_dep", "skip_grant"]);
  assert(Object.values(summary.controls).every((rejected) => rejected), "every negative control makes the oracle fail");
  assert.deepEqual(summary.reasons.general, {}, "no operation is quarantined in the packaged scenario");
  assert.deepEqual(summary.reasons.space, {});
  assert.match(out, /ORACLE_OK/);
  console.log("PASS the Sim replay equals the relay logs, both SQLite stores and a fresh observer pull; negative controls fail");

  // Seeds and keys are absent everywhere; post text is absent from every uploaded or traced surface.
  const seedNeedles = ["founder", "joiner", "observer"].flatMap((realm) => {
    const seed = privSeed(realm);
    return [seed.toString("hex"), seed.toString("base64"), seed.toString("base64url")];
  });
  for (const label of LABELS) seedNeedles.push(relaySeed(label).toString("hex"), relaySeed(label).toString("base64"));
  const encodedText = (text: string) => Buffer.from(text).toString("base64");
  const textNeedles = Object.values(TEXTS).flatMap((text) => [text, encodedText(text), encodedText(text).replace(/=+$/, "")]);
  for (const app of apps) {
    for (const row of rows(app)) assertNoSecrets(`${app.name} store ${row.key.slice(0, 24)}`, row.value, seedNeedles);
    assertNoSecrets(`${app.name} dev trace`, readFileSync(app.traceFile, "utf8"), [...seedNeedles, ...textNeedles]);
    const lines = readFileSync(app.traceFile, "utf8").split("\n").filter(Boolean);
    assert(lines.every((line) => /^treehouse_[a-z_]+$/.test(line)), "the dev trace holds command names only");
    assert.equal(lines.filter((line) => line === "treehouse_initialize_identity").length, 1, `${app.name}: identity created once, explicitly`);
    assert(lines.includes("treehouse_sign_carrier"), `${app.name}: operations were signed by the native command`);
  }
  for (const label of LABELS) assertNoSecrets(`${label} relay log`, readFileSync(relayLogs[label]!, "latin1"), seedNeedles);
  assertNoSecrets("trace.json", readFileSync(join(root, "trace.json"), "utf8"), [...seedNeedles, ...textNeedles]);
  assertNoSecrets("oracle_out.json", readFileSync(join(root, "oracle_out.json"), "utf8"), [...seedNeedles, ...textNeedles]);
  assert(readFileSync(relayLogs.general!, "latin1").includes(TEXTS.joiner_general!), "post text is in the plaintext relay log, readable by its host");
  assert.equal(fingerprint(realData), realBefore, "the ordinary app's data directory is exactly as this run found it");

  // ---- public evidence only: ids, verdicts and counts ----------------------------------------------
  writeFileSync(join(evidence, "oracle_out.json"), readFileSync(join(root, "oracle_out.json")));
  const result = {
    status: "PASS",
    gate: "packaged-enrollment",
    variant: "dev_trace",
    transfer: TRANSFER,
    binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(),
    sourceState: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: repoRoot }),
    relayPids,
    relayLogBytesUnchangedOnRestart: relayBytesUnchanged,
    launches: { founder: founder.launches, joiner: joiner.launches },
    explicitSyncPresses: { founder: founder.syncPresses, joiner: joiner.syncPresses },
    logs: summary.logs.map((log) => ({ label: log.label, ops: log.ops })),
    controls: summary.controls,
    authorship: "only the founder and joiner transport keys authored operations",
  };
  writeFileSync(join(evidence, "result.json"), JSON.stringify(result, null, 2));
  assertNoSecrets("result.json", JSON.stringify(result), [...seedNeedles, ...textNeedles]);
  console.log(
    "PASS packaged enrollment: invite, join, post, converge, restart, converge on the dev-trace variant against the fixture relay, equal to Lattice.Sim",
  );
} catch (error) {
  if (!(error as { preflightOnly?: boolean }).preflightOnly) {
    failed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nFAIL ${message}`);
    if (message.startsWith("G-AX"))
      console.error(
        "G-AX decision gate: the paste transfer failed on this machine. Key-event typing was already rejected, so the plan's named fallback (a dev-trace loopback mailbox) applies, with its own claim wording.",
      );
    // Control labels and states only, never values: the dump can hold artifacts and post text.
    for (const app of apps) {
      if (!app.ax || !app.child || app.child.exitCode !== null) continue;
      try {
        const nodes = await app.ax.dump();
        const lines = nodes
          .filter((n: AxNode) => n.title || n.description)
          .map((n: AxNode) => {
            const name = n.title || n.description;
            return `${n.role}\t${Object.values(TEXTS).some((text) => name.includes(text)) ? "[redacted]" : name}\tenabled=${n.enabled}`;
          });
        writeFileSync(join(evidence, `failed-ui-${app.name}.txt`), `${lines.join("\n")}\n`);
      } catch {
        // The app may already be gone; the failure above is the evidence.
      }
    }
    for (const app of apps) {
      writeFileSync(join(root, `app-${app.name}.log`), app.output.join(""));
      const tail = app.output.join("").split("\n").slice(-12).join("\n").trim();
      if (tail) console.error(`--- ${app.name} output (tail) ---\n${tail}`);
    }
    if (relay) console.error(`--- relay output (tail) ---\n${relay.output.join("").split("\n").slice(-12).join("\n")}`);
  }
} finally {
  for (const app of apps) await stop(app);
  await relay?.kill().catch(() => undefined);
  if (fingerprint(realData) !== realBefore) {
    console.error("FAIL the ordinary app's data directory changed during this run");
    failed = true;
  }
  // GATE_KEEP=1, or an evidence directory inside the scratch root, leaves the scratch root for debugging.
  if (!process.env.GATE_KEEP && !evidence.startsWith(`${root}/`)) rmSync(root, { recursive: true, force: true });
  else console.log(`scratch root kept at ${root}`);
}
if (failed) process.exit(1);
