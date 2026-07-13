import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { CarrierOpFrame, TauriInvoke } from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
  TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX,
  TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED,
} from "../src/native_workflow";
import {
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";
import { submitTownshipDelegation, submitTownshipPost } from "../src/township_actions";
import {
  parseTownshipActionIntentDeepLink,
  type TownshipGrantActionIntent,
  type TownshipPostActionIntent,
} from "../src/township_action_intent";
import {
  freeTcpPort,
  runBeamSupport,
  spawnStableCarrierServer,
  spawnTownshipActionLiveProjection,
  stableCarrierUrl,
  type StableCarrierServerProcess,
  type TownshipActionLiveProjectionProcess,
} from "./support/beam_peer";

interface GrantProjection {
  opIds: string[];
  readModel: {
    threads: { title: string; summary: string; posts: string[]; "clerk_locked?": boolean };
    members: { current: string[]; denied: unknown[] };
    roles: { quarantine: string[]; reasons: Record<string, string> };
  };
  causalReplay: { nodes: Array<{ id: string }>; [key: string]: unknown };
}

interface GrantHandoffOracle {
  replica: string;
  issuerRealm: string;
  issuerPubkey: string;
  recipientRealm: string;
  recipientPubkey: string;
  unsoundAudienceRealm: string;
  unsoundAudiencePubkey: string;
  baseAuthorPubkeys: string[];
  baseFrontier: string[];
  base: GrantProjection;
  soundGrant: {
    delegationId: string;
    parentDelegationId: string;
    frame: CarrierOpFrame;
    after: GrantProjection;
  };
  recipientUse: { text: string; frame: CarrierOpFrame; after: GrantProjection };
  unsoundGrant: {
    delegationId: string;
    parentDelegationId: string;
    reason: "not_attenuated";
    frame: CarrierOpFrame;
    after: GrantProjection;
  };
  unsoundUse: {
    reason: "invalid_capability";
    frame: CarrierOpFrame;
    after: GrantProjection;
  };
}

interface NativeIdentity {
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedBytesJson: string;
  privateSeedHex: string;
}

interface ManagedProcess {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stop(): Promise<void>;
}

interface FeedDomTrace {
  phase: string | null;
  opCount: string | null;
  matterOpCount: string | null;
  titleDigest: string | null;
  summaryDigest: string | null;
  postDigests: string[];
  memberDigests: string[];
  matterState: string | null;
}

interface ActionHandoff {
  url: string;
  id: string;
}

type GrantMode = "grant_base" | "grant_sound" | "grant_recipient_use" | "grant_unsound";

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const repoRoot = resolve(shellRoot, "../..");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appExecutablePath = join(appBundlePath, "Contents", "MacOS", "township-tauri-shell");
const appIdentifier = "dev.treetop.lattice.township";
const launchServicesRegister =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";
const issuerSeed = "township-g1:clerk";
const recipientSeed = "township-g1:grant-recipient";
const unsoundAudienceSeed = "township-g1:unsound-audience";
const observerRealm = "instrument";
const observerSeed = "township-packaged-grant-observer";
const serverRealm = "town-node";
const serverSeed = "township-packaged-grant-server";
const grantUseControlUrl = "township://dev/action-grant/use";
const grantSignControlUrl = "township://dev/action-grant/sign";
const postUseControlUrl = "township://dev/action-post/use";
const postSignControlUrl = "township://dev/action-post/sign";
const syncControlUrl = "township://dev/carrier/sync";

console.log("\n▸ Packaged Tauri delegation grant handoff through stable relay");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Packaged delegation-grant smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-grant-"));
const issuerTracePath = join(tempRoot, "issuer-trace.log");
const recipientTracePath = join(tempRoot, "recipient-trace.log");
const issuerKvPath = join(tempRoot, "issuer-kv.json");
const recipientKvPath = join(tempRoot, "recipient-kv.json");
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const issuerIdentity = seededEd25519Identity(issuerSeed);
const recipientIdentity = seededEd25519Identity(recipientSeed);
const unsoundAudienceIdentity = seededEd25519Identity(unsoundAudienceSeed);
const observerIdentity = seededEd25519Identity(observerSeed);
let activeTracePath = issuerTracePath;
let server: StableCarrierServerProcess | null = null;
let liveServer: TownshipActionLiveProjectionProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let app: ManagedProcess | null = null;

try {
  await prepareBeamAndAssets();
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_grant_handoff_fixture.exs",
    [tempRoot],
    "GRANT_FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as GrantHandoffOracle;
  assert.equal(oracle.issuerPubkey, issuerIdentity.publicKeyBase64);
  assert.equal(oracle.recipientPubkey, recipientIdentity.publicKeyBase64);
  assert.equal(oracle.unsoundAudiencePubkey, unsoundAudienceIdentity.publicKeyBase64);
  await assertNoParentControls(oracle);

  if (process.env.TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD !== "1") await buildDevTraceApp();
  assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
  assert.ok(existsSync(appExecutablePath), `expected app executable at ${appExecutablePath}`);
  const packageHash = fileSha256(appExecutablePath);
  assertAppBundleRegistersTownshipScheme(appBundlePath);
  await registerLaunchServicesHandler();
  await assertLaunchServicesRoutesTownshipSchemeToBundle();
  await quitTownshipApp();

  const carrierPort = await freeTcpPort();
  const webPort = await freeTcpPort();
  server = await spawnStableCarrierServer({
    port: carrierPort,
    serverRealm,
    identitySeed: serverSeed,
    trustedPeerRealm: observerRealm,
    trustedPeerPubkey: observerIdentity.publicKeyBase64,
    relayPeers: [
      { realm: oracle.issuerRealm, pubkey: oracle.issuerPubkey },
      { realm: oracle.recipientRealm, pubkey: oracle.recipientPubkey },
      { realm: oracle.unsoundAudienceRealm, pubkey: oracle.unsoundAudiencePubkey },
    ],
    sourcePath,
  });
  liveServer = await spawnTownshipActionLiveProjection({
    webPort,
    carrierPort,
    serverRealm,
    serverPubkey: server.publicKeyBase64,
    observerRealm,
    observerSeed,
    replica: oracle.replica,
  });

  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${webPort}/township`, { waitUntil: "domcontentloaded" });
  await waitForAttribute(page, "#source-status[data-source='carrier']", "data-freshness", "fresh", 20_000);
  await waitForLiveViewProjection(page, oracle.base);
  assert.match(await verifyStableRelay(server, oracle, "grant_base"), /VERIFY_READY grant_base/);

  writePairing(issuerKvPath, pairingFor(server, oracle, oracle.issuerRealm));
  activeTracePath = issuerTracePath;
  app = launchApp(issuerKvPath, issuerTracePath, issuerSeed);
  await waitForAppReady(oracle.base, issuerKvPath);

  const grantHandoff = await prepareGrantHandoff(page, oracle);
  const grantSourceBefore = Buffer.from(readFileSync(sourcePath));
  await driveIntentToPending({
    handoff: grantHandoff,
    kvPath: issuerKvPath,
    expectedFrame: oracle.soundGrant.frame,
    expectedLocal: oracle.soundGrant.after,
    useControlUrl: grantUseControlUrl,
    signControlUrl: grantSignControlUrl,
    useTrace: "action-grant-dev-use:accepted",
    signTrace: "action-grant-dev-sign:signed",
    secretValues: [grantHandoff.url, oracle.recipientPubkey],
    sourceBefore: grantSourceBefore,
  });
  assert.match(await verifyStableRelay(server, oracle, "grant_base"), /VERIFY_READY grant_base/);

  const grantGeneration = await carrierFeedGeneration(page);
  await syncPending(
    issuerKvPath,
    oracle.soundGrant.frame,
    oracle.soundGrant.after,
    "action-grant-dev-sync:synced",
  );
  await waitForLiveViewPush(page, oracle.soundGrant.after, grantGeneration);
  await waitForAppProjection(oracle.soundGrant.after, issuerTracePath, 30_000);
  assert.match(await verifyStableRelay(server, oracle, "grant_sound"), /VERIFY_READY grant_sound/);

  const issuerKvAfterSync = sortedEntries(readKvValues(issuerKvPath));
  await quitTownshipApp();
  await app.stop();
  app = null;
  assert.equal(fileSha256(appExecutablePath), packageHash);

  writePairing(recipientKvPath, pairingFor(server, oracle, oracle.recipientRealm));
  activeTracePath = recipientTracePath;
  app = launchApp(recipientKvPath, recipientTracePath, recipientSeed);
  await waitForAppReady(oracle.soundGrant.after, recipientKvPath);
  assert.ok(storedIds(readKvValues(recipientKvPath), TOWNSHIP_DELEGATION_FRAMES_KEY).includes(oracle.soundGrant.frame.id));

  const postHandoff = await preparePostHandoff(page, oracle);
  const postSourceBefore = Buffer.from(readFileSync(sourcePath));
  await driveIntentToPending({
    handoff: postHandoff,
    kvPath: recipientKvPath,
    expectedFrame: oracle.recipientUse.frame,
    expectedLocal: oracle.recipientUse.after,
    useControlUrl: postUseControlUrl,
    signControlUrl: postSignControlUrl,
    useTrace: "action-post-dev-use:accepted",
    signTrace: "action-post-dev-sign:signed",
    secretValues: [postHandoff.url, oracle.recipientUse.text],
    sourceBefore: postSourceBefore,
  });
  assert.match(await verifyStableRelay(server, oracle, "grant_sound"), /VERIFY_READY grant_sound/);

  const postGeneration = await carrierFeedGeneration(page);
  await syncPending(
    recipientKvPath,
    oracle.recipientUse.frame,
    oracle.recipientUse.after,
    "action-post-dev-sync:synced",
  );
  await waitForLiveViewPush(page, oracle.recipientUse.after, postGeneration);
  await waitForAppProjection(oracle.recipientUse.after, recipientTracePath, 30_000);
  assert.match(
    await verifyStableRelay(server, oracle, "grant_recipient_use"),
    /VERIFY_READY grant_recipient_use/,
  );

  const unsoundGeneration = await carrierFeedGeneration(page);
  assert.match(await relayUnsoundFrames(server, oracle), /GRANT_UNSOUND_RELAY_READY/);
  await waitForLiveViewPush(page, oracle.unsoundUse.after, unsoundGeneration);
  await waitForAppProjection(oracle.unsoundUse.after, recipientTracePath, 30_000);
  await waitForStoredIds(recipientKvPath, TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.unsoundUse.after.opIds, 30_000);
  assert.match(await verifyStableRelay(server, oracle, "grant_unsound"), /VERIFY_READY grant_unsound/);
  assert.equal(await page.locator("#roles-panel [data-reason='not_attenuated']").count(), 1);
  assert.equal(await page.locator("#roles-panel [data-reason='invalid_capability']").count(), 1);
  assert.equal(await page.locator("#op-dag-panel [data-op-node][data-status='quarantined']").count(), 2);

  assert.deepEqual(sortedEntries(readKvValues(issuerKvPath)), issuerKvAfterSync);
  assert.equal(fileSha256(appExecutablePath), packageHash);
  assertTraceAndStoresContainNoSecrets(oracle, [grantHandoff.url, postHandoff.url]);
} finally {
  await quitTownshipApp();
  await app?.stop();
  await browser?.close();
  await liveServer?.stop();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Packaged Tauri delegation grant handoff smoke passed\x1b[0m");

async function assertNoParentControls(oracle: GrantHandoffOracle): Promise<void> {
  const cases = [
    {
      label: "grant",
      submit: (invoke: TauriInvoke) =>
        submitTownshipDelegation({
          invoke,
          replica: oracle.replica,
          audiencePubkey: oracle.unsoundAudiencePubkey,
          ops: ["admit", "post", "set_summary", "set_title"],
          roles: [],
          live: false,
        }),
    },
    {
      label: "post",
      submit: (invoke: TauriInvoke) =>
        submitTownshipPost({
          invoke,
          replica: oracle.replica,
          text: oracle.recipientUse.text,
        }),
    },
  ] as const;

  for (const control of cases) {
    const values = new Map<string, string>([
      [storageKey(TOWNSHIP_LOCAL_OP_LOG_KEY), "[]"],
      [storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY), "[]"],
      [storageKey(TOWNSHIP_DELEGATION_FRAMES_KEY), "[]"],
    ]);
    const before = sortedEntries(values);
    const calls: string[] = [];
    const submitted = await control.submit(noParentInvoke(values, recipientIdentity, calls));

    assert.equal(submitted.ok, false, `${control.label} unexpectedly passed without a parent`);
    if (submitted.ok) throw new Error(`${control.label} unexpectedly passed without a parent`);
    assert.equal(submitted.reason, "missing_delegation");
    assert.deepEqual(sortedEntries(values), before);
    assert.equal(calls.filter((name) => name === "lattice_sign_carrier").length, 0);
    assert.equal(calls.filter((name) => name === "lattice_kv_set").length, 0);
    assert.ok(calls.includes("lattice_ensure_carrier_key"));
    assert.ok(calls.includes("lattice_kv_get"));
  }
}

function noParentInvoke(
  values: Map<string, string>,
  identity: NativeIdentity,
  calls: string[],
): TauriInvoke {
  return async <T = unknown>(
    command: string,
    args: Record<string, unknown> = {},
  ): Promise<T> => {
    calls.push(command);
    let result: unknown;
    switch (command) {
      case "lattice_ensure_carrier_key":
        assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
        result = identity.publicKeyBase64;
        break;
      case "lattice_kv_get":
        result = values.get(String(args.key)) ?? null;
        break;
      case "lattice_kv_set":
        values.set(String(args.key), String(args.value));
        result = null;
        break;
      case "lattice_sign_carrier":
        result = Array(64).fill(0);
        break;
      default:
        throw new Error(`unexpected no-parent native command ${command}`);
    }
    return result as T;
  };
}

async function prepareGrantHandoff(
  target: Page,
  oracle: GrantHandoffOracle,
): Promise<ActionHandoff> {
  const handoff = target.locator("#participant-grant-handoff");
  const previousUrl = (await handoff.count()) > 0 ? await handoff.getAttribute("href") : null;
  await target.locator("#participant-grant-form input[type='text']").fill(oracle.recipientPubkey);
  await target.locator("#participant-grant-form button[type='submit']").click();
  await waitFor(async () => {
    if ((await handoff.count()) === 0) return false;
    const nextUrl = await handoff.getAttribute("href");
    return nextUrl !== null && nextUrl !== previousUrl;
  }, "grant handoff replacement", 10_000);

  const url = await handoff.getAttribute("href");
  assert.ok(url, "expected grant handoff");
  const intent = parsedGrantIntent(url);
  assert.equal(intent.replica, oracle.replica);
  assert.equal(intent.authority.audience, oracle.recipientPubkey);
  assert.deepEqual(intent.authority.ops, ["admit", "post", "set_summary", "set_title"]);
  assert.deepEqual(intent.authority.roles, []);
  assert.equal(intent.authority.live, false);
  return { url, id: intent.id };
}

async function preparePostHandoff(
  target: Page,
  oracle: GrantHandoffOracle,
): Promise<ActionHandoff> {
  const handoff = target.locator("#participant-post-handoff");
  const previousUrl = (await handoff.count()) > 0 ? await handoff.getAttribute("href") : null;
  await target.locator("#participant-post-form textarea").fill(oracle.recipientUse.text);
  await target.locator("#participant-post-form button[type='submit']").click();
  await waitFor(async () => {
    if ((await handoff.count()) === 0) return false;
    const nextUrl = await handoff.getAttribute("href");
    return nextUrl !== null && nextUrl !== previousUrl;
  }, "post handoff replacement", 10_000);

  const url = await handoff.getAttribute("href");
  assert.ok(url, "expected post handoff");
  const intent = parsedPostIntent(url);
  assert.equal(intent.replica, oracle.replica);
  assert.deepEqual(intent.command, { command: "post", text: oracle.recipientUse.text });
  return { url, id: intent.id };
}

function parsedGrantIntent(url: string): TownshipGrantActionIntent {
  const parsed = parseTownshipActionIntentDeepLink(url);
  if (!parsed.ok) throw new Error(`generated grant intent was rejected: ${parsed.reason}`);
  assert.equal(parsed.intent.v, 5);
  return parsed.intent as TownshipGrantActionIntent;
}

function parsedPostIntent(url: string): TownshipPostActionIntent {
  const parsed = parseTownshipActionIntentDeepLink(url);
  if (!parsed.ok) throw new Error(`generated post intent was rejected: ${parsed.reason}`);
  assert.equal(parsed.intent.v, 1);
  return parsed.intent as TownshipPostActionIntent;
}

async function driveIntentToPending(options: {
  handoff: ActionHandoff;
  kvPath: string;
  expectedFrame: CarrierOpFrame;
  expectedLocal: GrantProjection;
  useControlUrl: string;
  signControlUrl: string;
  useTrace: string;
  signTrace: string;
  secretValues: string[];
  sourceBefore: Buffer;
}): Promise<void> {
  const {
    handoff,
    kvPath,
    expectedFrame,
    expectedLocal,
    useControlUrl,
    signControlUrl,
    useTrace,
    signTrace,
    secretValues,
    sourceBefore,
  } = options;
  const valuesBeforeIngress = readKvValues(kvPath);
  const kvBeforeIngress = sortedEntries(valuesBeforeIngress);
  const delegationsBefore = storedFrames(valuesBeforeIngress, TOWNSHIP_DELEGATION_FRAMES_KEY);
  const signerCountBefore = traceLineCount(activeTracePath, "lattice_sign_carrier");
  const syncCountBefore = traceLineCount(activeTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED);
  const useCountBefore = traceLineCount(activeTracePath, useTrace);
  const signCountBefore = traceLineCount(activeTracePath, signTrace);
  const traceStart = traceLines(activeTracePath).length;

  await deliverDeepLink(handoff.url);
  await waitForTraceLine(activeTracePath, `action-intent:staged:${handoff.id}`, 20_000);
  await delay(500);
  assert.deepEqual(sortedEntries(readKvValues(kvPath)), kvBeforeIngress);
  assertSourceUnchanged(sourceBefore, "ingress");
  assert.equal(traceLineCount(activeTracePath, "lattice_sign_carrier"), signerCountBefore);
  assert.equal(traceLineCount(activeTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);
  assertNoIngressSideEffects(traceLines(activeTracePath).slice(traceStart));

  await deliverDeepLink(useControlUrl);
  await waitFor(
    () => traceLineCount(activeTracePath, useTrace) > useCountBefore,
    `${useTrace} completion`,
    10_000,
  );
  assert.deepEqual(sortedEntries(readKvValues(kvPath)), kvBeforeIngress);
  assertSourceUnchanged(sourceBefore, "Use");
  assert.equal(traceLineCount(activeTracePath, "lattice_sign_carrier"), signerCountBefore);
  assert.equal(traceLineCount(activeTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);

  await deliverDeepLink(signControlUrl);
  await waitFor(
    () => traceLineCount(activeTracePath, signTrace) > signCountBefore,
    `${signTrace} completion`,
    20_000,
  );
  await waitForOutboxFrame(kvPath, expectedFrame, 20_000);
  await waitForStoredIds(kvPath, TOWNSHIP_LOCAL_OP_LOG_KEY, expectedLocal.opIds, 20_000);
  assertSourceUnchanged(sourceBefore, "Sign");
  assert.equal(traceLineCount(activeTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);
  const expectedSignatureCount = signTrace.startsWith("action-grant-") ? 2 : 1;
  assert.equal(
    traceLineCount(activeTracePath, "lattice_sign_carrier"),
    signerCountBefore + expectedSignatureCount,
  );

  const delegationsAfter = storedFrames(readKvValues(kvPath), TOWNSHIP_DELEGATION_FRAMES_KEY);
  if (signTrace.startsWith("action-grant-")) {
    assert.equal(delegationsAfter.length, delegationsBefore.length + 1);
    assert.deepEqual(
      delegationsAfter.find((frame) => frame.id === expectedFrame.id),
      expectedFrame,
    );
  } else {
    assert.deepEqual(delegationsAfter, delegationsBefore);
  }
  assertTraceRedacted(activeTracePath, secretValues);
}

async function syncPending(
  kvPath: string,
  expectedFrame: CarrierOpFrame,
  after: GrantProjection,
  expectedTrace: string,
): Promise<void> {
  assert.deepEqual(storedFrames(readKvValues(kvPath), TOWNSHIP_CARRIER_OUTBOX_KEY), [expectedFrame]);
  const syncCount = traceLineCount(activeTracePath, expectedTrace);
  await deliverDeepLink(syncControlUrl);
  await waitFor(
    () => traceLineCount(activeTracePath, expectedTrace) > syncCount,
    `${expectedTrace} completion`,
    30_000,
  );
  await waitForStoredIds(kvPath, TOWNSHIP_LOCAL_OP_LOG_KEY, after.opIds, 30_000);
  await waitFor(() => {
    try {
      return storedFrames(readKvValues(kvPath), TOWNSHIP_CARRIER_OUTBOX_KEY).length === 0;
    } catch {
      return false;
    }
  }, `${expectedFrame.id} outbox drain`, 30_000);
  assert.deepEqual(storedFrames(readKvValues(kvPath), TOWNSHIP_CARRIER_OUTBOX_KEY), []);
}

function assertSourceUnchanged(expected: Buffer, stage: string): void {
  const actual = Buffer.from(readFileSync(sourcePath));
  assert.equal(actual.equals(expected), true, `stable source changed during ${stage}`);
}

function assertNoIngressSideEffects(lines: string[]): void {
  assert.ok(lines.some((line) => /^action-intent:staged:[0-9a-f]{32}$/.test(line)));
  assert.ok(!lines.includes("lattice_sign_carrier"));
  assert.ok(!lines.includes("lattice_kv_set"));
  assert.ok(!lines.includes(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED));
}

function assertTraceRedacted(path: string, values: readonly string[]): void {
  const trace = readTrace(path);
  for (const value of values) assert.doesNotMatch(trace, new RegExp(escapeRegex(value)));
}

async function verifyStableRelay(
  stableServer: StableCarrierServerProcess,
  oracle: GrantHandoffOracle,
  mode: GrantMode,
): Promise<string> {
  return runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_relay_verify.exs",
    [
      String(stableServer.port),
      stableServer.realm,
      stableServer.publicKeyBase64,
      observerRealm,
      observerSeed,
      oracle.replica,
      oraclePath,
      mode,
    ],
    `VERIFY_READY ${mode}`,
  );
}

async function relayUnsoundFrames(
  stableServer: StableCarrierServerProcess,
  oracle: GrantHandoffOracle,
): Promise<string> {
  return runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_grant_handoff_relay.exs",
    [
      String(stableServer.port),
      stableServer.realm,
      stableServer.publicKeyBase64,
      oracle.recipientRealm,
      recipientSeed,
      oracle.unsoundAudienceRealm,
      unsoundAudienceSeed,
      oracle.replica,
      oraclePath,
    ],
    "GRANT_UNSOUND_RELAY_READY",
  );
}

async function waitForAppReady(expected: GrantProjection, kvPath: string): Promise<void> {
  await waitForTraceLine(activeTracePath, "deep-link-listener-mounted", 60_000);
  await waitForTraceLine(activeTracePath, "dev-trace-runtime-ready", 60_000);
  await waitForTraceLine(activeTracePath, "township-native-hydration-settled", 60_000);
  await waitForStoredIds(kvPath, TOWNSHIP_LOCAL_OP_LOG_KEY, expected.opIds, 60_000);
  await waitForStoredIds(kvPath, TOWNSHIP_DELEGATION_FRAMES_KEY, expected.opIds, 60_000);
  await waitFor(() => {
    try {
      return storedFrames(readKvValues(kvPath), TOWNSHIP_CARRIER_OUTBOX_KEY).length === 0;
    } catch {
      return false;
    }
  }, "packaged app startup outbox drain", 60_000);
  await waitForAppProjection(expected, activeTracePath, 30_000);
}

async function waitForLiveViewPush(
  target: Page,
  expected: GrantProjection,
  baselineGeneration: number,
): Promise<void> {
  await waitFor(async () => {
    const status = target.locator("#source-status[data-source='carrier']");
    const trigger = await status.getAttribute("data-refresh-trigger");
    const generationText = await status.getAttribute("data-feed-generation");
    if (trigger !== "server_push" || generationText === null) return false;
    const generation = Number(generationText);
    return Number.isSafeInteger(generation) && generation > baselineGeneration;
  }, "LiveView grant server-push generation", 20_000);
  await waitForLiveViewProjection(target, expected);
}

async function waitForLiveViewProjection(target: Page, expected: GrantProjection): Promise<void> {
  await waitForAttribute(
    target,
    "#op-dag-panel .dag-counts",
    "data-op-count",
    String(expected.opIds.length),
    20_000,
  );
  await waitFor(
    async () =>
      (await target.locator("#threads-panel .panel-header h2").textContent())?.trim() ===
      expected.readModel.threads.title,
    "LiveView title",
    20_000,
  );
  await waitFor(
    async () =>
      (await target.locator("#threads-panel .summary-field p").textContent())?.trim() ===
      expected.readModel.threads.summary,
    "LiveView summary",
    20_000,
  );
  await waitFor(async () => {
    const posts = (await target.locator("#threads-panel [data-post] > span:last-child").allTextContents()).map(
      (post) => post.trim(),
    );
    return JSON.stringify(posts) === JSON.stringify(expected.readModel.threads.posts);
  }, "LiveView posts", 20_000);
  await waitFor(async () => {
    const members = (await target.locator("#members-panel .member-list li").allTextContents())
      .map((member) => member.trim())
      .sort();
    return JSON.stringify(members) === JSON.stringify([...expected.readModel.members.current].sort());
  }, "LiveView members", 20_000);
  await waitFor(async () => {
    const actual = await liveViewCausalReplay(target);
    return JSON.stringify(actual) === JSON.stringify(expected.causalReplay);
  }, "LiveView grant causal replay", 20_000);
}

async function liveViewCausalReplay(target: Page): Promise<unknown> {
  const encoded = await target.locator("#causal-replay-island").getAttribute("data-replay");
  assert.ok(encoded);
  return JSON.parse(encoded);
}

async function waitForAppProjection(
  expected: GrantProjection,
  tracePath: string,
  timeoutMs: number,
): Promise<void> {
  const expectedTitleDigest = digestText(expected.readModel.threads.title);
  const expectedSummaryDigest = digestText(expected.readModel.threads.summary);
  const expectedPostDigests = expected.readModel.threads.posts.map(digestText);
  const expectedMemberDigests = expected.readModel.members.current.map(digestText).sort();
  const expectedMatterState = expected.readModel.threads["clerk_locked?"] ? "locked" : "open";
  await waitFor(() => {
    const trace = latestFeedDomTrace(tracePath);
    return (
      trace?.phase === "fresh" &&
      trace.opCount === String(expected.opIds.length) &&
      trace.matterOpCount === String(expected.opIds.length) &&
      trace.titleDigest === expectedTitleDigest &&
      trace.summaryDigest === expectedSummaryDigest &&
      trace.matterState === expectedMatterState &&
      JSON.stringify(trace.postDigests ?? []) === JSON.stringify(expectedPostDigests) &&
      JSON.stringify([...(trace.memberDigests ?? [])].sort()) === JSON.stringify(expectedMemberDigests)
    );
  }, "packaged app grant projection", timeoutMs);
}

function latestFeedDomTrace(path: string): FeedDomTrace | null {
  const line = traceLines(path).findLast((entry) =>
    entry.startsWith(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX),
  );
  if (!line) return null;
  return JSON.parse(line.slice(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX.length)) as FeedDomTrace;
}

function digestText(value: string): string {
  return createHash("sha256").update(value.trim(), "utf8").digest("hex");
}

async function carrierFeedGeneration(target: Page): Promise<number> {
  const text = await target
    .locator("#source-status[data-source='carrier']")
    .getAttribute("data-feed-generation");
  assert.ok(text);
  const generation = Number(text);
  assert.ok(Number.isSafeInteger(generation) && generation >= 0);
  return generation;
}

async function prepareBeamAndAssets(): Promise<void> {
  await run(mixBin(), ["compile"], repoRoot, { MIX_ENV: "test", PATH: pinnedToolPath() });
  await run(mixBin(), ["assets.build"], join(repoRoot, "apps", "township_web"), {
    MIX_ENV: "test",
    PATH: pinnedToolPath(),
  });
}

async function buildDevTraceApp(): Promise<void> {
  await run("tauri", ["build", "--features", "township-dev-trace", "--bundles", "app"], shellRoot, {
    VITE_TOWNSHIP_DEV_TRACE: "1",
    VITE_TOWNSHIP_AUTOSYNC_ON_MOUNT: "1",
  });
}

function pairingFor(
  stableServer: StableCarrierServerProcess,
  oracle: GrantHandoffOracle,
  localRealm: string,
): TownshipCarrierPeerConfig {
  return {
    url: stableCarrierUrl(stableServer.port),
    localRealm,
    expectedPeerRealm: stableServer.realm,
    expectedPeerPubkey: stableServer.publicKeyBase64,
    replica: oracle.replica,
    keyId: TOWNSHIP_NATIVE_KEY_ID,
    submission: "relay",
  };
}

function writePairing(path: string, pairing: TownshipCarrierPeerConfig): void {
  writeNativeKv(
    path,
    new Map([[storageKey(TOWNSHIP_CARRIER_PAIRING_KEY), JSON.stringify(pairing)]]),
  );
}

function launchApp(kvPath: string, tracePath: string, identitySeed: string): ManagedProcess {
  return spawnManaged(
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
      `TOWNSHIP_DEV_CARRIER_KEY_SEED=${identitySeed}`,
      appBundlePath,
    ],
    shellRoot,
  );
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeNativeKv(path: string, values: Map<string, string>): void {
  writeFileSync(path, JSON.stringify(Object.fromEntries(values), null, 2), "utf8");
}

function readKvValues(path: string): Map<string, string> {
  assert.ok(existsSync(path), `expected isolated native KV file at ${path}`);
  return new Map(Object.entries(JSON.parse(readFileSync(path, "utf8")) as Record<string, string>));
}

function storedFrames(values: Map<string, string>, key: string): CarrierOpFrame[] {
  return JSON.parse(requiredValue(values, storageKey(key))) as CarrierOpFrame[];
}

function storedIds(values: Map<string, string>, key: string): string[] {
  return (JSON.parse(requiredValue(values, storageKey(key))) as { id: string }[])
    .map((entry) => entry.id)
    .sort();
}

async function waitForOutboxFrame(
  kvPath: string,
  expected: CarrierOpFrame,
  timeoutMs: number,
): Promise<void> {
  await waitFor(() => {
    try {
      return storedFrames(readKvValues(kvPath), TOWNSHIP_CARRIER_OUTBOX_KEY).length === 1;
    } catch {
      return false;
    }
  }, `pending outbox frame ${expected.id}`, timeoutMs);
  assert.deepEqual(storedFrames(readKvValues(kvPath), TOWNSHIP_CARRIER_OUTBOX_KEY), [expected]);
}

async function waitForStoredIds(
  kvPath: string,
  key: string,
  expected: string[],
  timeoutMs: number,
): Promise<void> {
  const sortedExpected = [...expected].sort();
  await waitFor(() => {
    try {
      return JSON.stringify(storedIds(readKvValues(kvPath), key)) === JSON.stringify(sortedExpected);
    } catch {
      return false;
    }
  }, `${key} ids in ${kvPath}`, timeoutMs);
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  assert.notEqual(value, undefined, `missing native KV value ${key}`);
  return value as string;
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function sortedEntries(values: Map<string, string>): [string, string][] {
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function assertTraceAndStoresContainNoSecrets(
  oracle: GrantHandoffOracle,
  actionUrls: readonly string[],
): void {
  const serverIdentity = seededEd25519Identity(serverSeed);
  const identities = [
    [issuerSeed, issuerIdentity],
    [recipientSeed, recipientIdentity],
    [unsoundAudienceSeed, unsoundAudienceIdentity],
    [observerSeed, observerIdentity],
    [serverSeed, serverIdentity],
  ] as const;
  const privateNeedles = identities.flatMap(([seed, identity]) => [
    seed,
    identity.privateSeedBase64,
    identity.privateSeedBytesJson,
    identity.privateSeedHex,
  ]);
  const rawProceedings = [
    ...oracle.base.readModel.threads.posts,
    ...oracle.unsoundUse.after.readModel.threads.posts,
    oracle.recipientUse.text,
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  for (const path of [issuerKvPath, recipientKvPath]) {
    const values = readKvValues(path);
    assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(values, privateNeedles));
    for (const value of actionUrls) {
      assert.doesNotMatch(JSON.stringify(Object.fromEntries(values)), new RegExp(escapeRegex(value)));
    }
  }

  const traceNeedles = [
    ...privateNeedles,
    oracle.recipientPubkey,
    ...actionUrls,
    ...rawProceedings,
  ];
  for (const path of [issuerTracePath, recipientTracePath]) {
    const trace = readTrace(path);
    assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["dev_trace", trace]], privateNeedles));
    for (const value of traceNeedles) {
      assert.doesNotMatch(trace, new RegExp(escapeRegex(value)));
    }
  }

  for (const output of [server?.output.join("") ?? "", liveServer?.output.join("") ?? ""]) {
    for (const value of privateNeedles) {
      assert.doesNotMatch(output, new RegExp(escapeRegex(value)));
    }
  }
}

function assertAppBundleRegistersTownshipScheme(appPath: string): void {
  const infoPlist = join(appPath, "Contents", "Info.plist");
  assert.ok(existsSync(infoPlist), `expected Info.plist at ${infoPlist}`);
  const plist = readFileSync(infoPlist, "utf8");
  assert.match(plist, /CFBundleIdentifier/);
  assert.match(plist, new RegExp(appIdentifier.replaceAll(".", "\\.")));
  assert.match(plist, /CFBundleURLSchemes/);
  assert.match(plist, /township/);
}

async function registerLaunchServicesHandler(): Promise<void> {
  assert.ok(existsSync(launchServicesRegister));
  await run(launchServicesRegister, ["-f", appBundlePath], shellRoot);
}

async function assertLaunchServicesRoutesTownshipSchemeToBundle(): Promise<void> {
  const script = [
    "import AppKit",
    'if let url = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "township://action")!) {',
    "  print(url.path)",
    "}",
  ].join("\n");
  const resolvedPath = (await runCapture("swift", ["-e", script], shellRoot)).trim().replace(/\/+$/, "");
  assert.equal(resolvedPath, appBundlePath.replace(/\/+$/, ""));
}

async function deliverDeepLink(url: string): Promise<void> {
  await run("open", [url], shellRoot);
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

async function runCapture(command: string, args: string[], cwd: string): Promise<string> {
  const managed = spawnManaged(command, args, cwd);
  const code = await waitForExit(managed.child);
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${managed.lines.join("")}`);
  return managed.lines.join("");
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

async function exitsWithin(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
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

async function waitForTraceLine(path: string, line: string, timeoutMs: number): Promise<void> {
  await waitFor(() => traceLines(path).includes(line), `trace ${line}`, timeoutMs);
}

function readTrace(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8").trim();
}

function traceLines(path: string): string[] {
  return readTrace(path).split(/\r?\n/).filter(Boolean);
}

function traceLineCount(path: string, line: string): number {
  return traceLines(path).filter((entry) => entry === line).length;
}

async function waitForAttribute(
  target: Page,
  selector: string,
  name: string,
  expected: string,
  timeoutMs: number,
): Promise<void> {
  await waitFor(
    async () => (await target.locator(selector).getAttribute(name)) === expected,
    `${selector} ${name}`,
    timeoutMs,
  );
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(
    [
      `timed out waiting for ${label}`,
      `trace:\n${readTrace(activeTracePath) || "<empty>"}`,
      `app output:\n${app?.lines.join("") || "<empty>"}`,
      `stable carrier output:\n${server?.output.join("") || "<empty>"}`,
      `LiveView output:\n${liveServer?.output.join("") || "<empty>"}`,
    ].join("\n\n"),
  );
}

function seededEd25519Identity(seed: string): NativeIdentity {
  const privateSeed = createHash("sha256").update(seed).digest();
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), privateSeed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const publicKey = Buffer.from(publicKeyDer).subarray(12);
  return {
    publicKeyBase64: publicKey.toString("base64"),
    privateSeedBase64: privateSeed.toString("base64"),
    privateSeedBytesJson: JSON.stringify([...privateSeed]),
    privateSeedHex: privateSeed.toString("hex"),
  };
}

function mixBin(): string {
  const asdf = join(process.env.HOME ?? "", ".asdf", "shims", "mix");
  return existsSync(asdf) ? asdf : "mix";
}

function pinnedToolPath(): string {
  const home = process.env.HOME ?? "";
  return [
    join(home, ".asdf", "installs", "erlang", "28.3.1", "bin"),
    join(home, ".asdf", "installs", "erlang", "28.3.1", "erts-16.2", "bin"),
    join(home, ".asdf", "installs", "elixir", "1.19.5-otp-28", "bin"),
    join(home, ".asdf", "shims"),
    "/opt/homebrew/opt/rustup/bin",
    dirname(process.execPath),
    join(shellRoot, "node_modules", ".bin"),
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
  ]
    .filter((path) => path.length > 0 && existsSync(path))
    .join(":");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
