import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  connectCarrierWebSocket,
  type CarrierOpFrame,
  type CarrierVerifier,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../src/native_workflow";
import {
  exportTownshipCarrierPairingHandoff,
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";
import { peerUrl, spawnTownshipPeer, type TownshipPeerProcess } from "./support/beam_peer";

interface CarrierVector {
  scenario: string;
  replica: string;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string; sessionPubkey: string };
  peer: { realm: string; sessionPubkey: string };
  clientDivergedCarrierOps: CarrierOpFrame[];
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedBytesJson: string;
  privateSeedHex: string;
  sign(bytes: Uint8Array): Uint8Array;
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const vector = JSON.parse(
  readFileSync(join(shellRoot, "..", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as CarrierVector;
const residentDeviceSeed = `${vector.client.sessionSeed}:${vector.client.realm}`;
const identity = seededEd25519Identity(residentDeviceSeed);
const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};
const expectedPost = vector.clientDivergedCarrierOps.find((frame) => frameCommandName(frame) === "post");
if (!expectedPost) throw new Error("missing Sim-generated resident post frame");

console.log(`\n▸ ${vector.scenario} packaged Tauri onboarding smoke`);

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Packaged Tauri onboarding smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

assert.equal(vector.realmByPubkey[identity.publicKeyBase64], vector.client.realm);

const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-onboarding-"));
const tracePath = join(tempRoot, "trace.log");
const kvPath = join(tempRoot, "township-native-kv.json");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appIdentifier = "dev.treetop.lattice.township";
let peer: TownshipPeerProcess | null = null;
let app: ManagedProcess | null = null;

try {
  peer = await spawnTownshipPeer({
    peerRealm: vector.peer.realm,
    trustedPeerRealm: vector.client.realm,
    trustedPeerPubkey: identity.publicKeyBase64,
    scenario: "LatticeNodeSpike.TownshipOnboardingScenario",
  });
  assert.equal(peer.publicKeyBase64, vector.peer.sessionPubkey);

  const pairing: TownshipCarrierPeerConfig = {
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: peer.publicKeyBase64,
    replica: vector.replica,
  };
  await buildDevTraceApp(exportTownshipCarrierPairingHandoff(pairing));
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
      `TOWNSHIP_DEV_CARRIER_KEY_SEED=${residentDeviceSeed}`,
      appBundlePath,
    ],
    shellRoot,
  );

  await waitForTraceLine("dev-trace-runtime-ready", 60_000);
  await waitForTraceLine(`township-onboarding-drained:${expectedPost.id}`, 90_000);
  assertTraceCountAtLeast("lattice_sign_carrier", 3);
  assert.equal(app.child.exitCode, null, `packaged app exited; output chars: ${app.lines.join("").length}`);

  const values = readKvValues(kvPath);
  assert.deepEqual(JSON.parse(requiredValue(values, storageKey(TOWNSHIP_CARRIER_PAIRING_KEY))), pairing);
  assert.deepEqual(storedIds(values, TOWNSHIP_LOCAL_OP_LOG_KEY), frameIds(vector.clientDivergedCarrierOps));
  assert.deepEqual(storedIds(values, TOWNSHIP_DELEGATION_FRAMES_KEY), frameIds(vector.clientDivergedCarrierOps));
  assert.deepEqual(storedIds(values, TOWNSHIP_CARRIER_OUTBOX_KEY), []);
  const secretNeedles = [
    residentDeviceSeed,
    identity.privateSeedBase64,
    identity.privateSeedBytesJson,
    identity.privateSeedHex,
  ];
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(values, secretNeedles));
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["dev_trace", readTrace()]], secretNeedles));

  const reportConnection = await connectToPeer(peer);
  const report = await reportConnection.stateReport();
  assert.deepEqual([...report.op_ids].sort(), frameIds(vector.clientDivergedCarrierOps));
  assert.ok(Array.isArray(report.state?.posts));
  assert.ok(report.state.posts.includes("resident: posted while offline"));
  assert.deepEqual(report.authority_quarantine, []);
  await reportConnection.shutdown();
  await peer.awaitExit();
} finally {
  peer?.kill();
  await quitTownshipApp();
  await app?.stop();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Township packaged Tauri onboarding smoke passed\x1b[0m");

function connectToPeer(peer: TownshipPeerProcess) {
  return connectCarrierWebSocket({
    url: peerUrl(peer.port),
    localRealm: vector.client.realm,
    replica: vector.replica,
    signer: identity,
    expectedPeerRealm: vector.peer.realm,
    expectedPeerPubkey: Buffer.from(peer.publicKeyBase64, "base64"),
    verifier,
  });
}

async function buildDevTraceApp(pairingHandoff: string): Promise<void> {
  await run("tauri", ["build", "--features", "township-dev-trace", "--bundles", "app"], shellRoot, {
    VITE_TOWNSHIP_DEV_TRACE: "1",
    VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "0",
    VITE_TOWNSHIP_PACKAGED_ONBOARDING_HANDOFF: pairingHandoff,
    VITE_TOWNSHIP_PACKAGED_ONBOARDING_LOCAL_REALM: vector.client.realm,
    VITE_TOWNSHIP_PACKAGED_ONBOARDING_POST_TEXT: "resident: posted while offline",
  });
}

function readKvValues(path: string): Map<string, string> {
  assert.ok(existsSync(path), `expected isolated native KV file at ${path}`);
  const values = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  return new Map(Object.entries(values));
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  assert.notEqual(value, undefined, `missing native KV value ${key}`);
  return value as string;
}

function storedIds(values: Map<string, string>, key: string): string[] {
  const raw = requiredValue(values, storageKey(key));
  return (JSON.parse(raw) as { id: string }[]).map((entry) => entry.id).sort();
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function frameIds(frames: readonly { id: string }[]): string[] {
  return frames.map((frame) => frame.id).sort();
}

function frameCommandName(frame: CarrierOpFrame): string | null {
  const body = frame.body;
  if (body?.[0] !== "tuple") return null;
  const command = body[1][0];
  return command?.[0] === "atom" ? command[1] : null;
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
    env: {
      ...process.env,
      PATH: `${join(process.env.HOME ?? "", ".asdf/shims")}:${process.env.PATH ?? ""}`,
      ...env,
    },
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

async function run(command: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<void> {
  const proc = spawnManaged(command, args, cwd, env);
  const code = await waitForExit(proc.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${proc.lines.join("")}`);
}

function readTrace(): string {
  if (!existsSync(tracePath)) return "<empty>";
  return readFileSync(tracePath, "utf8").trim() || "<empty>";
}

async function waitForTraceLine(line: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const traceLines = readTrace().split(/\r?\n/);
    if (traceLines.includes(line)) return;
    const onboardingFailure = traceLines.find((entry) => entry.startsWith("township-onboarding-failed:"));
    if (onboardingFailure) {
      throw new Error(
        [
          `packaged onboarding reported ${onboardingFailure}`,
          `native trace summary:\n${readTraceDiagnostics()}`,
          `native KV:\n${readKvDiagnostics()}`,
          `app output chars: ${app?.lines.join("").length ?? 0}`,
        ].join("\n\n"),
      );
    }
    if (app?.child.exitCode !== null) break;
    await delay(250);
  }

  throw new Error(
    [
      `timed out waiting for trace line ${line}`,
      `native trace summary:\n${readTraceDiagnostics()}`,
      `app output chars: ${app?.lines.join("").length ?? 0}`,
    ].join("\n\n"),
  );
}

function readTraceDiagnostics(): string {
  const counts = new Map<string, number>();
  for (const line of readTrace().split(/\r?\n/)) {
    const category =
      line.startsWith("lattice_") ||
      line.startsWith("township-onboarding-") ||
      line === "dev-trace-runtime-ready" ||
      line === "deep-link-listener-mounted" ||
      line === "township-native-hydration-settled"
        ? line
        : "other";
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return JSON.stringify(Object.fromEntries(counts));
}

function readKvDiagnostics(): string {
  if (!existsSync(kvPath)) return "<missing>";
  const values = JSON.parse(readFileSync(kvPath, "utf8")) as Record<string, string>;
  return JSON.stringify(
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { valueChars: value.length }])),
  );
}

function assertTraceCountAtLeast(command: string, expected: number): void {
  const count = readTrace().split(/\r?\n/).filter((line) => line === command).length;
  assert.ok(
    count >= expected,
    `expected at least ${expected} ${command} traces, saw ${count}\n${readTraceDiagnostics()}`,
  );
}

async function quitTownshipApp(): Promise<void> {
  const proc = spawnManaged("osascript", ["-e", `quit app id "${appIdentifier}"`], shellRoot);
  const code = await Promise.race([waitForExit(proc.child), delay(2_000).then(() => "timeout" as const)]);
  if (code === "timeout") {
    proc.child.kill("SIGKILL");
    await waitForExit(proc.child);
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit) => child.on("exit", (code) => resolveExit(code)));
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.killed || child.exitCode !== null) return;
  child.kill("SIGINT");
  const code = await Promise.race([waitForExit(child), delay(2_000).then(() => "timeout" as const)]);
  if (code === "timeout" && !child.killed && child.exitCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
}

function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = (createPublicKey as (key: unknown) => ReturnType<typeof createPublicKey>)(privateKey).export({
    format: "der",
    type: "spki",
  });
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

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
