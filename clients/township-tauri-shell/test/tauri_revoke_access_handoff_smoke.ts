import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX,
  TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED,
} from "../src/native_workflow";
import {
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";
import {
  parseTownshipActionIntentDeepLink,
  type TownshipPostActionIntent,
  type TownshipRevokeActionIntent,
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
import {
  createPackagedActionHandoffHarness,
  delay,
  escapeRegex,
  mixBin,
  pinnedToolPath,
  readKvValues,
  readTrace,
  seededEd25519Identity,
  sortedEntries,
  storageKey,
  storedFrames,
  storedIds,
  traceLineCount,
  traceLines,
  writeNativeKv,
  type ManagedProcess,
} from "./support/packaged_action_handoff";

interface RevocationProjection {
  opIds: string[];
  readModel: {
    threads: { title: string; summary: string; posts: string[]; "clerk_locked?": boolean };
    members: { current: string[]; denied: unknown[] };
    roles: { quarantine: string[]; reasons: Record<string, string> };
  };
  causalReplay: { nodes: Array<{ id: string }>; [key: string]: unknown };
}

interface RevocationHandoffOracle {
  replica: string;
  issuerRealm: string;
  issuerPubkey: string;
  recipientRealm: string;
  recipientPubkey: string;
  sourceAuthorPubkeys: string[];
  sourceFrontier: string[];
  source: RevocationProjection;
  grant: { delegationId: string; frame: CarrierOpFrame };
  preRevokeUse: { text: string; frame: CarrierOpFrame };
  revoke: { frame: CarrierOpFrame; after: RevocationProjection };
  recipientPull: { after: RevocationProjection };
  revokedUse: {
    text: string;
    reason: "revoked_capability";
    frame: CarrierOpFrame;
    after: RevocationProjection;
  };
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

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const repoRoot = resolve(shellRoot, "../..");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appExecutablePath = join(appBundlePath, "Contents", "MacOS", "township-tauri-shell");
const appIdentifier = "dev.treetop.lattice.township";
const issuerSeed = "township-g1:clerk";
const recipientSeed = "township-g1:revocation-recipient";
const observerRealm = "instrument";
const observerSeed = "township-packaged-revocation-observer";
const serverRealm = "town-node";
const serverSeed = "township-packaged-revocation-server";
const revokeUseControlUrl = "township://dev/action-revoke/use";
const revokeSignControlUrl = "township://dev/action-revoke/sign";
const postUseControlUrl = "township://dev/action-post/use";
const postSignControlUrl = "township://dev/action-post/sign";
const syncControlUrl = "township://dev/carrier/sync";

console.log("\n▸ Packaged Tauri revocation handoff through stable relay");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Packaged revocation smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-revocation-"));
const issuerTracePath = join(tempRoot, "issuer-trace.log");
const recipientTracePath = join(tempRoot, "recipient-trace.log");
const issuerKvPath = join(tempRoot, "issuer-kv.json");
const recipientKvPath = join(tempRoot, "recipient-kv.json");
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const issuerIdentity = seededEd25519Identity(issuerSeed);
const recipientIdentity = seededEd25519Identity(recipientSeed);
const observerIdentity = seededEd25519Identity(observerSeed);
let activeTracePath = issuerTracePath;
let server: StableCarrierServerProcess | null = null;
let liveServer: TownshipActionLiveProjectionProcess | null = null;
let browser: Browser | null = null;
let page: Page | null = null;
let app: ManagedProcess | null = null;
const toolPath = pinnedToolPath(shellRoot);
const harness = createPackagedActionHandoffHarness({
  shellRoot,
  appBundlePath,
  appIdentifier,
  tracePath: issuerTracePath,
  kvPath: issuerKvPath,
  toolPath,
  diagnostics: () =>
    [
      `trace:\n${readTrace(activeTracePath) || "<empty>"}`,
      `app output:\n${app?.lines.join("") || "<empty>"}`,
      `stable carrier output:\n${server?.output.join("") || "<empty>"}`,
      `LiveView output:\n${liveServer?.output.join("") || "<empty>"}`,
    ].join("\n\n"),
});
const {
  assertAppBundleRegistersTownshipScheme,
  assertLaunchServicesRoutesTownshipSchemeToBundle,
  deliverDeepLink,
  quitTownshipApp,
  registerLaunchServicesHandler,
  run,
  spawnManaged,
  waitFor,
  waitForAttribute,
} = harness;

try {
  await prepareBeamAndAssets();
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_revocation_handoff_fixture.exs",
    [tempRoot],
    "REVOCATION_FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as RevocationHandoffOracle;
  assert.equal(oracle.issuerPubkey, issuerIdentity.publicKeyBase64);
  assert.equal(oracle.recipientPubkey, recipientIdentity.publicKeyBase64);

  assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
  assert.ok(existsSync(appExecutablePath), `expected app executable at ${appExecutablePath}`);
  const packageHash = fileSha256(appExecutablePath);
  assertAppBundleRegistersTownshipScheme();
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
  await waitForLiveViewProjection(page, oracle.source);
  assert.match(await verifyStableRelay(server, oracle, "revocation_pre"), /VERIFY_READY revocation_pre/);

  harness.writeNativeKv(
    new Map([
      [storageKey(TOWNSHIP_CARRIER_PAIRING_KEY), JSON.stringify(pairingFor(server, oracle, oracle.issuerRealm))],
    ]),
  );
  app = launchApp(issuerKvPath, issuerTracePath, issuerSeed);
  await waitForAppReady(oracle.source, issuerKvPath, issuerTracePath);

  const handoff = await prepareRevokeHandoff(page, oracle);
  const sourceBefore = Buffer.from(readFileSync(sourcePath));
  const valuesBeforeIngress = readKvValues(issuerKvPath);
  const kvBeforeIngress = sortedEntries(valuesBeforeIngress);
  const delegationsBefore = storedFrames(valuesBeforeIngress, TOWNSHIP_DELEGATION_FRAMES_KEY);
  const signerCountBefore = traceLineCount(issuerTracePath, "lattice_sign_carrier");
  const syncCountBefore = traceLineCount(issuerTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED);
  const useCountBefore = traceLineCount(issuerTracePath, "action-revoke-dev-use:accepted");
  const signCountBefore = traceLineCount(issuerTracePath, "action-revoke-dev-sign:signed");
  const traceStart = traceLines(issuerTracePath).length;

  await deliverDeepLink(handoff.url);
  await waitForTraceLine(issuerTracePath, `action-intent:staged:${handoff.id}`, 20_000);
  await delay(500);
  assert.deepEqual(sortedEntries(readKvValues(issuerKvPath)), kvBeforeIngress);
  assertSourceUnchanged(sourceBefore, "ingress");
  assert.equal(traceLineCount(issuerTracePath, "lattice_sign_carrier"), signerCountBefore);
  assert.equal(traceLineCount(issuerTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);
  assertNoIngressSideEffects(traceLines(issuerTracePath).slice(traceStart));

  await deliverDeepLink(revokeUseControlUrl);
  await waitFor(
    () => traceLineCount(issuerTracePath, "action-revoke-dev-use:accepted") > useCountBefore,
    "revocation Use completion",
    10_000,
  );
  assert.deepEqual(sortedEntries(readKvValues(issuerKvPath)), kvBeforeIngress);
  assertSourceUnchanged(sourceBefore, "Use");
  assert.equal(traceLineCount(issuerTracePath, "lattice_sign_carrier"), signerCountBefore);
  assert.equal(traceLineCount(issuerTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);

  await deliverDeepLink(revokeSignControlUrl);
  await waitFor(
    () => traceLineCount(issuerTracePath, "action-revoke-dev-sign:signed") > signCountBefore,
    "revocation Sign completion",
    20_000,
  );
  await waitForOutboxFrame(issuerKvPath, oracle.revoke.frame, 20_000);
  await waitForStoredIds(issuerKvPath, TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.revoke.after.opIds, 20_000);
  assertSourceUnchanged(sourceBefore, "Sign");
  assert.equal(traceLineCount(issuerTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);
  assert.equal(traceLineCount(issuerTracePath, "lattice_sign_carrier"), signerCountBefore + 1);
  assert.deepEqual(storedFrames(readKvValues(issuerKvPath), TOWNSHIP_DELEGATION_FRAMES_KEY), delegationsBefore);
  assertTraceRedacted(issuerTracePath, [handoff.url, oracle.grant.delegationId]);

  const generation = await carrierFeedGeneration(page);
  await syncPending(
    issuerKvPath,
    issuerTracePath,
    oracle.revoke.frame,
    oracle.revoke.after,
    "action-revoke-dev-sync:synced",
  );
  await waitForLiveViewPush(page, oracle.revoke.after, generation);
  await waitForAppProjection(oracle.revoke.after, issuerTracePath, 30_000);
  assert.match(
    await verifyStableRelay(server, oracle, "revocation_revoke"),
    /VERIFY_READY revocation_revoke/,
  );

  const issuerKvAfterSync = sortedEntries(readKvValues(issuerKvPath));
  await quitTownshipApp();
  await app.stop();
  app = null;

  writeNativeKv(
    recipientKvPath,
    new Map([
      [storageKey(TOWNSHIP_CARRIER_PAIRING_KEY), JSON.stringify(pairingFor(server, oracle, oracle.recipientRealm))],
    ]),
  );
  activeTracePath = recipientTracePath;
  app = launchApp(recipientKvPath, recipientTracePath, recipientSeed);
  await waitForAppReady(oracle.recipientPull.after, recipientKvPath, recipientTracePath);

  const recipientValuesBeforeRefusal = readKvValues(recipientKvPath);
  const recipientKvBeforeRefusal = sortedEntries(recipientValuesBeforeRefusal);
  const recipientDelegationsBefore = storedFrames(
    recipientValuesBeforeRefusal,
    TOWNSHIP_DELEGATION_FRAMES_KEY,
  );
  assert.ok(recipientDelegationsBefore.some((frame) => frame.id === oracle.grant.frame.id));
  assert.ok(recipientDelegationsBefore.some((frame) => frame.id === oracle.revoke.frame.id));
  const recipientSourceBeforeRefusal = Buffer.from(readFileSync(sourcePath));
  const recipientSignerCount = traceLineCount(recipientTracePath, "lattice_sign_carrier");
  const recipientWriteCount = traceLineCount(recipientTracePath, "lattice_kv_set");
  const recipientReadCount = traceLineCount(recipientTracePath, "lattice_kv_get");
  const recipientSyncCount = traceLineCount(recipientTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED);
  const recipientUseCount = traceLineCount(recipientTracePath, "action-revoke-dev-use:accepted");
  const recipientFailedCount = traceLineCount(recipientTracePath, "action-revoke-dev-sign:failed");

  await deliverDeepLink(handoff.url);
  await waitForTraceLine(recipientTracePath, `action-intent:staged:${handoff.id}`, 20_000);
  await deliverDeepLink(revokeUseControlUrl);
  await waitFor(
    () => traceLineCount(recipientTracePath, "action-revoke-dev-use:accepted") > recipientUseCount,
    "recipient revocation Use completion",
    10_000,
  );
  await deliverDeepLink(revokeSignControlUrl);
  await waitFor(
    () => traceLineCount(recipientTracePath, "action-revoke-dev-sign:failed") > recipientFailedCount,
    "recipient non-issuer Sign refusal",
    20_000,
  );

  assert.ok(traceLineCount(recipientTracePath, "lattice_kv_get") > recipientReadCount);
  assert.equal(traceLineCount(recipientTracePath, "lattice_sign_carrier"), recipientSignerCount);
  assert.equal(traceLineCount(recipientTracePath, "lattice_kv_set"), recipientWriteCount);
  assert.equal(traceLineCount(recipientTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), recipientSyncCount);
  assert.deepEqual(sortedEntries(readKvValues(recipientKvPath)), recipientKvBeforeRefusal);
  assert.deepEqual(
    storedFrames(readKvValues(recipientKvPath), TOWNSHIP_DELEGATION_FRAMES_KEY),
    recipientDelegationsBefore,
  );
  assert.deepEqual(storedFrames(readKvValues(recipientKvPath), TOWNSHIP_CARRIER_OUTBOX_KEY), []);
  assertSourceUnchanged(recipientSourceBeforeRefusal, "recipient non-issuer refusal");
  assert.deepEqual(sortedEntries(readKvValues(issuerKvPath)), issuerKvAfterSync);

  const postHandoff = await preparePostHandoff(page, oracle);
  const recipientSourceBeforePost = Buffer.from(readFileSync(sourcePath));
  const recipientValuesBeforePost = readKvValues(recipientKvPath);
  const recipientKvBeforePost = sortedEntries(recipientValuesBeforePost);
  const recipientDelegationsBeforePost = storedFrames(
    recipientValuesBeforePost,
    TOWNSHIP_DELEGATION_FRAMES_KEY,
  );
  const postSignerCount = traceLineCount(recipientTracePath, "lattice_sign_carrier");
  const postSyncCount = traceLineCount(recipientTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED);
  const postUseCount = traceLineCount(recipientTracePath, "action-post-dev-use:accepted");
  const postSignCount = traceLineCount(recipientTracePath, "action-post-dev-sign:signed");

  await deliverDeepLink(postHandoff.url);
  await waitForTraceLine(recipientTracePath, `action-intent:staged:${postHandoff.id}`, 20_000);
  await delay(500);
  assert.deepEqual(sortedEntries(readKvValues(recipientKvPath)), recipientKvBeforePost);
  assertSourceUnchanged(recipientSourceBeforePost, "recipient post ingress");
  assert.equal(traceLineCount(recipientTracePath, "lattice_sign_carrier"), postSignerCount);
  assert.equal(traceLineCount(recipientTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), postSyncCount);

  await deliverDeepLink(postUseControlUrl);
  await waitFor(
    () => traceLineCount(recipientTracePath, "action-post-dev-use:accepted") > postUseCount,
    "revoked-capability post Use completion",
    10_000,
  );
  assert.deepEqual(sortedEntries(readKvValues(recipientKvPath)), recipientKvBeforePost);
  assertSourceUnchanged(recipientSourceBeforePost, "recipient post Use");
  assert.equal(traceLineCount(recipientTracePath, "lattice_sign_carrier"), postSignerCount);
  assert.equal(traceLineCount(recipientTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), postSyncCount);

  await deliverDeepLink(postSignControlUrl);
  await waitFor(
    () => traceLineCount(recipientTracePath, "action-post-dev-sign:signed") > postSignCount,
    "revoked-capability post Sign completion",
    20_000,
  );
  await waitForOutboxFrame(recipientKvPath, oracle.revokedUse.frame, 20_000);
  await waitForStoredIds(
    recipientKvPath,
    TOWNSHIP_LOCAL_OP_LOG_KEY,
    oracle.revokedUse.after.opIds,
    20_000,
  );
  assertSourceUnchanged(recipientSourceBeforePost, "recipient post Sign");
  assert.equal(traceLineCount(recipientTracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), postSyncCount);
  assert.equal(traceLineCount(recipientTracePath, "lattice_sign_carrier"), postSignerCount + 1);
  assert.deepEqual(
    storedFrames(readKvValues(recipientKvPath), TOWNSHIP_DELEGATION_FRAMES_KEY),
    recipientDelegationsBeforePost,
  );
  assertTraceRedacted(recipientTracePath, [postHandoff.url, oracle.revokedUse.text]);

  const finalGeneration = await carrierFeedGeneration(page);
  await syncPending(
    recipientKvPath,
    recipientTracePath,
    oracle.revokedUse.frame,
    oracle.revokedUse.after,
    "action-post-dev-sync:synced",
  );
  await waitForLiveViewPush(page, oracle.revokedUse.after, finalGeneration);
  await waitForAppProjection(oracle.revokedUse.after, recipientTracePath, 30_000);
  assert.equal(await page.locator("#roles-panel [data-reason='revoked_capability']").count(), 1);
  assert.match(
    await verifyStableRelay(server, oracle, "revocation_final"),
    /VERIFY_READY revocation_final/,
  );
  assert.deepEqual(sortedEntries(readKvValues(issuerKvPath)), issuerKvAfterSync);

  assert.equal(fileSha256(appExecutablePath), packageHash);
  assertNoSecrets(oracle, [handoff.url, postHandoff.url]);
} finally {
  await quitTownshipApp();
  await app?.stop();
  await browser?.close();
  await liveServer?.stop();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Packaged Tauri revocation handoff smoke passed\x1b[0m");

async function prepareRevokeHandoff(
  target: Page,
  oracle: RevocationHandoffOracle,
): Promise<{ url: string; id: string }> {
  const handoff = target.locator("#participant-revoke-handoff");
  const previousUrl = (await handoff.count()) > 0 ? await handoff.getAttribute("href") : null;
  await target.locator("#participant-revoke-form input[type='text']").fill(oracle.grant.delegationId);
  await target.locator("#participant-revoke-form button[type='submit']").click();
  await waitFor(async () => {
    if ((await handoff.count()) === 0) return false;
    const nextUrl = await handoff.getAttribute("href");
    return nextUrl !== null && nextUrl !== previousUrl;
  }, "revocation handoff replacement", 10_000);

  const url = await handoff.getAttribute("href");
  assert.ok(url, "expected revocation handoff");
  const parsed = parseTownshipActionIntentDeepLink(url);
  if (!parsed.ok) throw new Error(`generated revocation intent was rejected: ${parsed.reason}`);
  assert.equal(parsed.intent.v, 6);
  const intent = parsed.intent as TownshipRevokeActionIntent;
  assert.equal(intent.replica, oracle.replica);
  assert.equal(intent.authority.delegation, oracle.grant.delegationId);
  return { url, id: intent.id };
}

async function preparePostHandoff(
  target: Page,
  oracle: RevocationHandoffOracle,
): Promise<{ url: string; id: string }> {
  const handoff = target.locator("#participant-post-handoff");
  const previousUrl = (await handoff.count()) > 0 ? await handoff.getAttribute("href") : null;
  await target.locator("#participant-post-form textarea").fill(oracle.revokedUse.text);
  await target.locator("#participant-post-form button[type='submit']").click();
  await waitFor(async () => {
    if ((await handoff.count()) === 0) return false;
    const nextUrl = await handoff.getAttribute("href");
    return nextUrl !== null && nextUrl !== previousUrl;
  }, "revoked-capability post handoff replacement", 10_000);

  const url = await handoff.getAttribute("href");
  assert.ok(url, "expected revoked-capability post handoff");
  const parsed = parseTownshipActionIntentDeepLink(url);
  if (!parsed.ok) throw new Error(`generated post intent was rejected: ${parsed.reason}`);
  assert.equal(parsed.intent.v, 1);
  const intent = parsed.intent as TownshipPostActionIntent;
  assert.equal(intent.replica, oracle.replica);
  assert.deepEqual(intent.command, { command: "post", text: oracle.revokedUse.text });
  return { url, id: intent.id };
}

async function verifyStableRelay(
  stableServer: StableCarrierServerProcess,
  oracle: RevocationHandoffOracle,
  mode: "revocation_pre" | "revocation_revoke" | "revocation_final",
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

async function waitForAppReady(
  expected: RevocationProjection,
  kvPath: string,
  tracePath: string,
): Promise<void> {
  await waitForTraceLine(tracePath, "deep-link-listener-mounted", 60_000);
  await waitForTraceLine(tracePath, "dev-trace-runtime-ready", 60_000);
  await waitForTraceLine(tracePath, "township-native-hydration-settled", 60_000);
  await waitForStoredIds(kvPath, TOWNSHIP_LOCAL_OP_LOG_KEY, expected.opIds, 60_000);
  await waitForStoredIds(kvPath, TOWNSHIP_DELEGATION_FRAMES_KEY, expected.opIds, 60_000);
  await waitFor(() => {
    try {
      return storedFrames(readKvValues(kvPath), TOWNSHIP_CARRIER_OUTBOX_KEY).length === 0;
    } catch {
      return false;
    }
  }, "packaged app startup outbox drain", 60_000);
  await waitForAppProjection(expected, tracePath, 30_000);
}

async function syncPending(
  kvPath: string,
  tracePath: string,
  expectedFrame: CarrierOpFrame,
  after: RevocationProjection,
  expectedTrace: string,
): Promise<void> {
  assert.deepEqual(storedFrames(readKvValues(kvPath), TOWNSHIP_CARRIER_OUTBOX_KEY), [expectedFrame]);
  const syncCount = traceLineCount(tracePath, expectedTrace);
  await deliverDeepLink(syncControlUrl);
  await waitFor(
    () => traceLineCount(tracePath, expectedTrace) > syncCount,
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
}

async function waitForLiveViewPush(
  target: Page,
  expected: RevocationProjection,
  baselineGeneration: number,
): Promise<void> {
  await waitFor(async () => {
    const status = target.locator("#source-status[data-source='carrier']");
    const trigger = await status.getAttribute("data-refresh-trigger");
    const generationText = await status.getAttribute("data-feed-generation");
    if (trigger !== "server_push" || generationText === null) return false;
    const generation = Number(generationText);
    return Number.isSafeInteger(generation) && generation > baselineGeneration;
  }, "LiveView revocation server-push generation", 20_000);
  await waitForLiveViewProjection(target, expected);
}

async function waitForLiveViewProjection(target: Page, expected: RevocationProjection): Promise<void> {
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
  await waitFor(async () => {
    const posts = (await target.locator("#threads-panel [data-post] > span:last-child").allTextContents()).map(
      (post) => post.trim(),
    );
    return JSON.stringify(posts) === JSON.stringify(expected.readModel.threads.posts);
  }, "LiveView posts", 20_000);
  await waitFor(async () => {
    const actual = await liveViewCausalReplay(target);
    return JSON.stringify(actual) === JSON.stringify(expected.causalReplay);
  }, "LiveView revocation causal replay", 20_000);
}

async function liveViewCausalReplay(target: Page): Promise<unknown> {
  const encoded = await target.locator("#causal-replay-island").getAttribute("data-replay");
  assert.ok(encoded);
  return JSON.parse(encoded);
}

async function waitForAppProjection(
  expected: RevocationProjection,
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
  }, "packaged app revocation projection", timeoutMs);
}

function latestFeedDomTrace(path: string): FeedDomTrace | null {
  const line = traceLines(path).findLast((entry) =>
    entry.startsWith(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX),
  );
  if (!line) return null;
  return JSON.parse(line.slice(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX.length)) as FeedDomTrace;
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

function pairingFor(
  stableServer: StableCarrierServerProcess,
  oracle: RevocationHandoffOracle,
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

async function prepareBeamAndAssets(): Promise<void> {
  await run(mixBin(), ["compile"], repoRoot, { MIX_ENV: "test", PATH: toolPath });
  await run(mixBin(), ["assets.build"], join(repoRoot, "apps", "township_web"), {
    MIX_ENV: "test",
    PATH: toolPath,
  });
}

function assertSourceUnchanged(expected: Buffer, stage: string): void {
  assert.equal(Buffer.from(readFileSync(sourcePath)).equals(expected), true, `stable source changed during ${stage}`);
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

function assertNoSecrets(oracle: RevocationHandoffOracle, actionUrls: readonly string[]): void {
  const serverIdentity = seededEd25519Identity(serverSeed);
  const identities = [
    [issuerSeed, issuerIdentity],
    [recipientSeed, recipientIdentity],
    [observerSeed, observerIdentity],
    [serverSeed, serverIdentity],
  ] as const;
  const privateNeedles = identities.flatMap(([seed, identity]) => [
    seed,
    identity.privateSeedBase64,
    identity.privateSeedBytesJson,
    identity.privateSeedHex,
  ]);
  for (const path of [issuerKvPath, recipientKvPath]) {
    const values = readKvValues(path);
    assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(values, privateNeedles));
    for (const url of actionUrls) {
      assert.doesNotMatch(JSON.stringify(Object.fromEntries(values)), new RegExp(escapeRegex(url)));
    }
  }
  const traceNeedles = [
    ...privateNeedles,
    oracle.grant.delegationId,
    ...actionUrls,
    ...oracle.source.readModel.threads.posts,
  ];
  for (const path of [issuerTracePath, recipientTracePath]) {
    const trace = readTrace(path);
    assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["dev_trace", trace]], privateNeedles));
    for (const value of traceNeedles) assert.doesNotMatch(trace, new RegExp(escapeRegex(value)));
  }

  for (const output of [server?.output.join("") ?? "", liveServer?.output.join("") ?? ""]) {
    for (const value of privateNeedles) assert.doesNotMatch(output, new RegExp(escapeRegex(value)));
  }
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value.trim(), "utf8").digest("hex");
}

async function waitForTraceLine(path: string, line: string, timeoutMs: number): Promise<void> {
  await waitFor(() => traceLines(path).includes(line), `trace ${line}`, timeoutMs);
}
