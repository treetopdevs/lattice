import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectCarrierWebSocket,
  type CarrierOpFrame,
  type CarrierVerifier,
  type CarrierWebSocketClient,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
  TOWNSHIP_TRACE_CARRIER_FEED_DOM_ERROR,
  TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX,
  TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED,
} from "../src/native_workflow";
import {
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";
import {
  freeTcpPort,
  runBeamSupport,
  spawnStableCarrierServer,
  stableCarrierUrl,
  type StableCarrierServerProcess,
} from "./support/beam_peer";

interface StableProjection {
  opIds: string[];
  readModel: { threads: { posts: string[] } };
  causalReplay: unknown;
}

interface StableFeedOracle {
  replica: string;
  relayRealm: string;
  relayPubkey: string;
  baseOpIds: string[];
  base: StableProjection;
  expectedPost: CarrierOpFrame;
  expectedRestartPost: CarrierOpFrame;
  authorityInvalidOp: CarrierOpFrame;
  afterPost: StableProjection;
  afterRestartPost: StableProjection;
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedBytesJson: string;
  privateSeedHex: string;
  sign(bytes: Uint8Array): Uint8Array;
}

interface FeedDomPayload {
  phase: string | null;
  generation: string | null;
  opCount: string | null;
  postCount: string | null;
  matterOpCount: string | null;
  matterPostCount: string | null;
  postDigests: string[];
}

interface FeedDomEntry {
  index: number;
  payload: FeedDomPayload;
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

console.log("\n> Packaged Tauri reactive carrier feed");

if (process.platform !== "darwin") {
  console.log("- Packaged reactive carrier feed smoke is macOS-only; skipped on this OS");
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-carrier-feed-"));
const tracePath = join(tempRoot, "trace.log");
const kvPath = join(tempRoot, "township-native-kv.json");
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";
const serverRealm = "town-node";
const serverSeed = "township-packaged-carrier-feed-server";
const observerRealm = "instrument";
const observerSeed = "township-packaged-carrier-feed-observer";
const relaySeed = "township-g1:resident";
const observerIdentity = seededEd25519Identity(observerSeed);
const relayIdentity = seededEd25519Identity(relaySeed);
const sessionVerifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};

let server: StableCarrierServerProcess | null = null;
let relay: CarrierWebSocketClient | null = null;
let app: ManagedProcess | null = null;

try {
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_relay_fixture.exs",
    [tempRoot],
    "FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as StableFeedOracle;
  assert.deepEqual(oracle.base.opIds, oracle.baseOpIds);
  assert.equal(oracle.relayRealm, "resident");
  assert.equal(oracle.relayPubkey, relayIdentity.publicKeyBase64);

  const port = await freeTcpPort();
  const spawnServer = () =>
    spawnStableCarrierServer({
      port,
      serverRealm,
      identitySeed: serverSeed,
      trustedPeerRealm: observerRealm,
      trustedPeerPubkey: observerIdentity.publicKeyBase64,
      relayRealm: oracle.relayRealm,
      relayPubkey: oracle.relayPubkey,
      sourcePath,
    });
  server = await spawnServer();

  const pairing: TownshipCarrierPeerConfig = {
    url: stableCarrierUrl(port),
    localRealm: observerRealm,
    expectedPeerRealm: server.realm,
    expectedPeerPubkey: server.publicKeyBase64,
    replica: oracle.replica,
    keyId: TOWNSHIP_NATIVE_KEY_ID,
    submission: "push",
  };
  writeNativeKv(
    new Map([[storageKey(TOWNSHIP_CARRIER_PAIRING_KEY), JSON.stringify(pairing)]]),
  );

  await buildDevTraceApp();
  assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
  await quitTownshipApp();

  app = spawnManaged(
    "open",
    [
      "-n",
      "-W",
      "--env",
      `TOWNSHIP_DEV_TRACE_FILE=${tracePath}`,
      "--env",
      `TOWNSHIP_NATIVE_KV_FILE=${kvPath}`,
      "--env",
      `TOWNSHIP_DEV_CARRIER_KEY_ID=${TOWNSHIP_NATIVE_KEY_ID}`,
      "--env",
      `TOWNSHIP_DEV_CARRIER_KEY_SEED=${observerSeed}`,
      appBundlePath,
    ],
    shellRoot,
  );

  await waitForTraceLine("dev-trace-runtime-ready", 60_000);
  const baseTrace = await waitForFeedProjection(oracle.base, "fresh", -1, "Sim base projection", 60_000);
  assertPersistedProjection(pairing, oracle.base, observerIdentity.publicKeyBase64);
  assertNoAutomaticSync();

  relay = await connectRelay(server, oracle);
  assert.deepEqual(await relay.relay(oracle.expectedPost), {
    accepted: [oracle.expectedPost.id],
    quarantined: [],
    rejected: [],
    pending: [],
  });
  const afterPostTrace = await waitForFeedProjection(
    oracle.afterPost,
    "fresh",
    baseTrace.index,
    "first relayed post",
    30_000,
  );
  assertPersistedProjection(pairing, oracle.afterPost, observerIdentity.publicKeyBase64);
  assertNoAutomaticSync();

  relay.close();
  relay = null;
  await server.kill();
  server = null;
  const reconnectingTrace = await waitForFeedProjection(
    oracle.afterPost,
    "reconnecting",
    afterPostTrace.index,
    "retained reconnecting projection",
    30_000,
  );

  server = await spawnServer();
  const restartedFreshTrace = await waitForFeedProjection(
    oracle.afterPost,
    "fresh",
    reconnectingTrace.index,
    "fresh projection after same-path restart",
    30_000,
  );

  relay = await connectRelay(server, oracle);
  assert.deepEqual(await relay.relay(oracle.expectedRestartPost), {
    accepted: [oracle.expectedRestartPost.id],
    quarantined: [],
    rejected: [],
    pending: [],
  });
  await waitForFeedProjection(
    oracle.afterRestartPost,
    "fresh",
    restartedFreshTrace.index,
    "second relayed post after restart",
    30_000,
  );
  assertPersistedProjection(pairing, oracle.afterRestartPost, observerIdentity.publicKeyBase64);
  assertNoAutomaticSync();

  const secretNeedles = [
    observerSeed,
    observerIdentity.privateSeedBase64,
    observerIdentity.privateSeedBytesJson,
    observerIdentity.privateSeedHex,
  ];
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(readKvValues(), secretNeedles));
  assert.doesNotThrow(() =>
    assertTownshipKvStoresNoSecrets([["dev_trace", readTrace()]], secretNeedles),
  );

  await quitTownshipApp();
  await app.stop();
  app = null;
  const feedTraceCountAfterQuit = feedDomEntries().length;
  assert.deepEqual(await relay.relay(oracle.authorityInvalidOp), {
    accepted: [oracle.authorityInvalidOp.id],
    quarantined: [],
    rejected: [],
    pending: [],
  });
  await delay(750);
  assert.equal(feedDomEntries().length, feedTraceCountAfterQuit);

  relay.close();
  relay = null;
  await server.stop();
  server = null;
} finally {
  await quitTownshipApp();
  await app?.stop();
  relay?.close();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Packaged Tauri reactive carrier feed smoke passed");

async function buildDevTraceApp(): Promise<void> {
  await run(
    "tauri",
    ["build", "--features", "township-dev-trace", "--bundles", "app"],
    shellRoot,
    {
      VITE_TOWNSHIP_DEV_TRACE: "1",
      VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "0",
      VITE_TOWNSHIP_PACKAGED_ONBOARDING_HANDOFF: "",
      VITE_TOWNSHIP_PACKAGED_ONBOARDING_LOCAL_REALM: "",
      VITE_TOWNSHIP_PACKAGED_ONBOARDING_POST_TEXT: "",
    },
  );
}

async function connectRelay(
  peer: StableCarrierServerProcess,
  oracle: StableFeedOracle,
): Promise<CarrierWebSocketClient> {
  return connectCarrierWebSocket({
    url: stableCarrierUrl(peer.port),
    localRealm: oracle.relayRealm,
    replica: oracle.replica,
    signer: relayIdentity,
    expectedPeerRealm: peer.realm,
    expectedPeerPubkey: Buffer.from(peer.publicKeyBase64, "base64"),
    verifier: sessionVerifier,
  });
}

async function waitForFeedProjection(
  expected: StableProjection,
  phase: string,
  afterIndex: number,
  label: string,
  timeoutMs: number,
): Promise<FeedDomEntry> {
  let match: FeedDomEntry | undefined;
  try {
    await waitFor(
      () => {
        match = feedDomEntries().find(
          (entry) =>
            entry.index > afterIndex &&
            entry.payload.phase === phase &&
            feedPayloadMatches(entry.payload, expected),
        );
        return match !== undefined;
      },
      label,
      timeoutMs,
    );
  } catch (error) {
    const observed = feedDomEntries().filter((entry) => entry.payload.phase === phase).at(-1)?.payload;
    throw new Error(`${errorMessage(error)}\n${feedDigestMismatch(observed, expected)}`);
  }
  return match as FeedDomEntry;
}

function feedPayloadMatches(payload: FeedDomPayload, expected: StableProjection): boolean {
  const opCount = String(expected.opIds.length);
  const postCount = String(expected.readModel.threads.posts.length);
  const expectedPostDigests = tracePostDigests(expected.readModel.threads.posts);
  return (
    payload.generation === opCount &&
    payload.opCount === opCount &&
    payload.postCount === postCount &&
    payload.matterOpCount === opCount &&
    payload.matterPostCount === postCount &&
    !("posts" in payload) &&
    JSON.stringify(payload.postDigests) === JSON.stringify(expectedPostDigests)
  );
}

function feedDigestMismatch(
  payload: FeedDomPayload | undefined,
  expected: StableProjection,
): string {
  const expectedDigests = tracePostDigests(expected.readModel.threads.posts);
  const observedDigests = payload?.postDigests ?? [];
  const mismatchIndex = expectedDigests.findIndex((digest, index) => observedDigests[index] !== digest);
  return [
    `expected post digests: ${expectedDigests.length}`,
    `observed post digests: ${observedDigests.length}`,
    `first digest mismatch: ${mismatchIndex}`,
  ].join("\n");
}

function tracePostDigests(posts: string[]): string[] {
  return posts.map((post) => createHash("sha256").update(post.trim(), "utf8").digest("hex"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function feedDomEntries(): FeedDomEntry[] {
  return traceLines().flatMap((line, index) => {
    if (!line.startsWith(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX)) return [];
    const encoded = line.slice(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX.length);
    try {
      const payload = JSON.parse(encoded) as FeedDomPayload;
      return [{ index, payload }];
    } catch {
      return [];
    }
  });
}

function assertPersistedProjection(
  pairing: TownshipCarrierPeerConfig,
  expected: StableProjection,
  observerPubkey: string,
): void {
  const values = readKvValues();
  assert.deepEqual(
    JSON.parse(requiredValue(values, storageKey(TOWNSHIP_CARRIER_PAIRING_KEY))),
    pairing,
  );
  assert.deepEqual(storedIds(values, TOWNSHIP_LOCAL_OP_LOG_KEY), [...expected.opIds].sort());
  const delegationFrames = storedFrames(values, TOWNSHIP_DELEGATION_FRAMES_KEY);
  assert.deepEqual(
    delegationFrames.map((frame) => frame.id).sort(),
    [...expected.opIds].sort(),
  );
  assert.equal(
    delegationFrames.some((frame) => frame.author === observerPubkey),
    false,
    "read-only observer must not author a persisted operation",
  );
  const outbox = values.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY));
  if (outbox !== undefined) assert.deepEqual(JSON.parse(outbox), []);
}

function assertNoAutomaticSync(): void {
  assert.equal(traceLines().includes(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), false);
}

function writeNativeKv(values: Map<string, string>): void {
  writeFileSync(kvPath, JSON.stringify(Object.fromEntries(values), null, 2), "utf8");
}

function readKvValues(): Map<string, string> {
  assert.ok(existsSync(kvPath), `expected isolated native KV file at ${kvPath}`);
  return new Map(
    Object.entries(JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, string>),
  );
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  assert.notEqual(value, undefined, `missing native KV value ${key}`);
  return value as string;
}

function storedFrames(values: Map<string, string>, key: string): CarrierOpFrame[] {
  return JSON.parse(requiredValue(values, storageKey(key))) as CarrierOpFrame[];
}

function storedIds(values: Map<string, string>, key: string): string[] {
  return (JSON.parse(requiredValue(values, storageKey(key))) as { id: string }[])
    .map((entry) => entry.id)
    .sort();
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

async function waitForTraceLine(line: string, timeoutMs: number): Promise<void> {
  await waitFor(() => traceLines().includes(line), `trace ${line}`, timeoutMs);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (traceLines().includes(TOWNSHIP_TRACE_CARRIER_FEED_DOM_ERROR)) {
      throw new Error("packaged app failed to hash the rendered Township feed DOM");
    }
    if (await predicate()) return;
    if (app?.child.exitCode !== null) break;
    await delay(100);
  }
  throw new Error(
    [
      `timed out waiting for ${label}`,
      `feed traces: ${JSON.stringify(feedDomEntries().slice(-8))}`,
      `trace:\n${readTrace() || "<empty>"}`,
      `KV keys: ${JSON.stringify([...readKvValues().keys()].sort())}`,
      `app exit: ${String(app?.child.exitCode)}`,
      `app output:\n${app?.lines.join("") || "<empty>"}`,
      `carrier output:\n${server?.output.join("") || "<empty>"}`,
    ].join("\n\n"),
  );
}

function readTrace(): string {
  if (!existsSync(tracePath)) return "";
  return readFileSync(tracePath, "utf8").trim();
}

function traceLines(): string[] {
  return readTrace().split(/\r?\n/).filter(Boolean);
}

function spawnManaged(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): ManagedProcess {
  const child = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PATH: pinnedToolPath(), ...env },
  });
  const lines: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => lines.push(chunk.toString()));
  return {
    child,
    lines,
    async stop() {
      await stopProcess(child);
    },
  };
}

async function run(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<void> {
  const managed = spawnManaged(command, args, cwd, env);
  const code = await waitForExit(managed.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${managed.lines.join("")}`);
}

async function quitTownshipApp(): Promise<void> {
  const managed = spawnManaged("osascript", ["-e", `quit app id "${appIdentifier}"`], shellRoot);
  if (!(await exitsWithin(managed.child, 2_000))) managed.child.kill("SIGKILL");
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await exitsWithin(child, 2_000)) && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exitsWithin(child, 2_000);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
}

async function exitsWithin(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = new Uint8Array(Buffer.from(publicKeyDer).subarray(12));
  return {
    publicKey,
    publicKeyBase64: Buffer.from(publicKey).toString("base64"),
    privateSeedBase64: privateSeed.toString("base64"),
    privateSeedBytesJson: JSON.stringify([...privateSeed]),
    privateSeedHex: privateSeed.toString("hex"),
    sign(bytes: Uint8Array): Uint8Array {
      return new Uint8Array(edSign(null, Buffer.from(bytes), privateKey));
    },
  };
}

function publicKeyObject(pubkey: Uint8Array) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pubkey)]),
    format: "der",
    type: "spki",
  });
}

function pinnedToolPath(): string {
  const home = process.env.HOME ?? "";
  return [
    join(home, ".asdf", "installs", "erlang", "28.3.1", "bin"),
    join(home, ".asdf", "installs", "erlang", "28.3.1", "erts-16.2", "bin"),
    join(home, ".asdf", "installs", "elixir", "1.19.5-otp-28", "bin"),
    "/opt/homebrew/opt/rustup/bin",
    join(shellRoot, "node_modules", ".bin"),
    join(home, ".asdf", "shims"),
    "/opt/homebrew/bin",
    process.env.PATH ?? "",
  ].join(":");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
