import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "@playwright/test";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalBytesForWitnessedSuccessionArtifactId,
  type CarrierOpFrame,
  type WitnessedSuccessionClaimEvidence,
} from "@treetopdevs/lattice-client";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND,
  TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX,
  TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX,
  TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED,
} from "../src/native_workflow";
import {
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
} from "../src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../src/storage_contract";
import {
  TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY,
  TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX,
  TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
} from "../src/township_actions";
import {
  parseTownshipActionIntentDeepLink,
  type TownshipWitnessSuccessionActionIntent,
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
import { discoverGovernanceTestPresencePublicKey } from "./support/governance_preflight";
import {
  assertPackagedBundleVariant,
  TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER,
} from "./support/packaged_bundle_variant";
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
  storedIds,
  traceLineCount,
  traceLines,
  type ManagedProcess,
} from "./support/packaged_action_handoff";

interface WitnessCeremonyOracle {
  replica: string;
  realmByPubkey: Record<string, string>;
  oracleCarrierOps: CarrierOpFrame[];
  appWitnessPubkey: string;
  controlWitnessPubkey: string;
  sourceAuthorPubkeys: string[];
  claim: WitnessedSuccessionClaimEvidence;
  claimPayloadSha256: string;
  source: { sha256: string; opIds: string[]; frontier: string[] };
  projection: {
    role: "clerk";
    holderPubkey: string;
    holderEpochOperationId: string;
    successorPubkey: string;
    policyGenesisOperationId: string;
    policyId: string;
    rootPubkey: string;
    quarantineReasons: Record<string, string>;
    recovery: { mode: "witnessed"; version: 1; witnesses: string[]; threshold: 2 };
  };
}

interface RestoredWitnessOracle {
  replica: string;
  source: WitnessCeremonyOracle["source"];
  projection: WitnessCeremonyOracle["projection"];
}

interface FeedDomTrace {
  phase: string | null;
  opCount: string | null;
}

/**
 * GREEN App.vue must emit this byte-free DOM evidence when the v7
 * IntentReviewPanel renders the derived witness review: the staged intent id
 * plus one sha256 hex digest per rendered detail line, in render order.
 */
interface WitnessReviewDomTrace {
  intentId: string | null;
  detailDigests: string[];
}

/**
 * GREEN App.vue must emit this byte-free DOM evidence whenever the stored
 * witness-artifact confirmation/export UI renders (including after a cold
 * relaunch that revalidates through loadTownshipWitnessArtifacts): the
 * rendered artifact id, the stored-artifact count, and one sha256 hex digest
 * per human-readable confirmation line (warning line last), in render order.
 */
interface WitnessArtifactDomTrace {
  artifactId: string | null;
  storedCount: number | null;
  confirmationDigests: string[];
}

interface StoredWitnessArtifactWrapper {
  v: number;
  artifactId: string;
  claim: WitnessedSuccessionClaimEvidence;
  witness: string;
  signature: string;
}

interface StoredWitnessArtifactIndex {
  v: number;
  entries: Array<{ artifactId: string }>;
}

const here = dirname(fileURLToPath(import.meta.url));
const shellRoot = resolve(here, "..");
const repoRoot = resolve(shellRoot, "../..");
const appBundlePath = join(shellRoot, "src-tauri", "target", "release", "bundle", "macos", "Township.app");
const appExecutablePath = join(appBundlePath, "Contents", "MacOS", "township-tauri-shell");
const appIdentifier = "dev.treetop.lattice.township";
// The packaged app runs as the fixture clerk: Lattice.Identity.from_seed/2 and
// seededEd25519Identity share the sha256(seed) Ed25519 convention.
const appRealm = "clerk";
const appSeed = "township-witness-artifact:fixture:clerk";
const observerRealm = "instrument";
const observerSeed = "township-packaged-witness-observer";
const serverRealm = "town-node";
const serverSeed = "township-packaged-witness-server";
const witnessUseControlUrl = "township://dev/action-witness/use";
const witnessSignControlUrl = "township://dev/action-witness/sign";
const witnessUseAcceptedTrace = "action-witness-dev-use:accepted";
const witnessSignSignedTrace = "action-witness-dev-sign:signed";
// GREEN export outcome trace: byte-free, emitted only after the export sink
// (system clipboard) holds the exact stored artifact JSON. The suffix names
// which sink ran (webview clipboard API vs the constrained native command),
// so a CI log shows which clipboard path this run actually exercised.
const witnessExportSucceededTracePrefix = "witness-artifact-export:succeeded:";
const witnessExportSinks = ["webview", "native"] as const;
const witnessReviewDomPrefix = "witness-review-dom:";
const witnessArtifactDomPrefix = "witness-artifact-dom:";
const exportShortcutKeydownTrace = `${TOWNSHIP_TRACE_DEV_SHORTCUT_KEYDOWN_PREFIX}e`;
const clipboardSentinel = "township-witness-export-clipboard-sentinel";

console.log("\n▸ Packaged Tauri witness ceremony through stable relay");

if (process.platform !== "darwin") {
  console.log("\x1b[33m- Packaged witness ceremony smoke is macOS-only; skipped on this OS\x1b[0m");
  process.exit(0);
}

const tempRoot = mkdtempSync(join(tmpdir(), "township-packaged-witness-"));
const tracePath = join(tempRoot, "trace.log");
const kvPath = join(tempRoot, "kv.json");
const sourcePath = join(tempRoot, "matter.log");
const oraclePath = join(tempRoot, "oracle.json");
const restoredOraclePath = join(tempRoot, "restored-oracle.json");
const exportedArtifactPath = join(tempRoot, "exported-artifact.json");
const appIdentity = seededEd25519Identity(appSeed);
const observerIdentity = seededEd25519Identity(observerSeed);
const serverIdentity = seededEd25519Identity(serverSeed);
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
  tracePath,
  kvPath,
  toolPath,
  diagnostics: () =>
    [
      `trace:\n${readTrace(tracePath) || "<empty>"}`,
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
  runCapture,
  spawnManaged,
  waitFor,
  waitForAttribute,
} = harness;

try {
  // Phase 1 — consume and classify the separately built paired-feature bundle.
  // This smoke is intentionally no-build; Seam 11 owns package/workflow wiring.
  assertPackagedBundleVariant(appBundlePath, "test_presence");

  // Phase 2 — discover the governance witness key through the test-only provider.
  const governanceWitnessKey = await discoverGovernanceTestPresencePublicKey({ shellRoot });
  assertCanonicalBase64PublicKey(governanceWitnessKey);
  assert.equal(
    governanceWitnessKey,
    Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(0xa5))).toString("base64"),
    "the discovered key must match an independent Ed25519 derivation of the deterministic test-presence seed",
  );

  // Phase 3 — BEAM witness fixture: one clerk-authored genesis pinning the
  // threshold-two witnessed recovery policy that names the discovered key.
  await prepareBeamAndAssets();
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_witness_artifact_fixture.exs",
    [tempRoot, governanceWitnessKey],
    "WITNESS_FIXTURE_READY",
  );
  const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as WitnessCeremonyOracle;
  assert.equal(oracle.appWitnessPubkey, governanceWitnessKey);
  assert.equal(oracle.projection.holderPubkey, appIdentity.publicKeyBase64);
  assert.equal(oracle.realmByPubkey[appIdentity.publicKeyBase64], appRealm);
  assert.equal(oracle.claim.role, "clerk");
  assert.equal(oracle.projection.recovery.threshold, 2);
  const expectedArtifactId = recomputedArtifactId(oracle.claim, governanceWitnessKey);
  const expectedIdentityDetails = [
    `Replica: ${oracle.claim.replica}`,
    `Role: ${oracle.claim.role}`,
    `Holder: ${oracle.claim.holder}`,
    `Holder epoch: ${oracle.claim.holderEpoch}`,
    `Successor: ${oracle.claim.successor}`,
    `Policy ID: ${oracle.claim.policyId}`,
    `Winning policy genesis operation ID: ${oracle.projection.policyGenesisOperationId}`,
    `Witness key: ${governanceWitnessKey}`,
    `Threshold: ${oracle.projection.recovery.threshold}`,
  ];
  const expectedReviewDetails = [
    ...expectedIdentityDetails,
    `Verified frontier: ${oracle.source.frontier.join(", ")}`,
  ];
  const expectedConfirmationLines = [
    ...expectedIdentityDetails,
    TOWNSHIP_WITNESS_INDEFINITE_VALIDITY_WARNING,
  ];

  assert.ok(existsSync(appBundlePath), `expected bundled app at ${appBundlePath}`);
  assert.ok(existsSync(appExecutablePath), `expected app executable at ${appExecutablePath}`);
  const packageHash = fileSha256(appExecutablePath);
  assertAppBundleRegistersTownshipScheme();
  await registerLaunchServicesHandler();
  await assertLaunchServicesRoutesTownshipSchemeToBundle();
  await quitTownshipApp();

  // Phase 4 — stable relay server + carrier-backed LiveView handoff.
  const carrierPort = await freeTcpPort();
  const webPort = await freeTcpPort();
  server = await spawnStableCarrierServer({
    port: carrierPort,
    serverRealm,
    identitySeed: serverSeed,
    trustedPeerRealm: observerRealm,
    trustedPeerPubkey: observerIdentity.publicKeyBase64,
    relayPeers: [{ realm: appRealm, pubkey: appIdentity.publicKeyBase64 }],
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
  await waitForAttribute(
    page,
    "#op-dag-panel .dag-counts",
    "data-op-count",
    String(oracle.source.opIds.length),
    20_000,
  );

  const handoff = await prepareWitnessHandoff(page, oracle);

  // Phase 5 — launch the packaged app against seeded pairing; pull-only startup.
  harness.writeNativeKv(
    new Map([[storageKey(TOWNSHIP_CARRIER_PAIRING_KEY), JSON.stringify(pairingFor(server, oracle))]]),
  );
  app = launchApp(kvPath, tracePath, appSeed);
  await waitForTraceLine("deep-link-listener-mounted", 60_000);
  await waitForTraceLine("dev-trace-runtime-ready", 60_000);
  await waitForTraceLine("township-native-hydration-settled", 60_000);
  await harness.waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.source.opIds, 60_000);
  await waitFor(() => {
    const trace = latestFeedDomTrace();
    return trace?.phase === "fresh" && trace.opCount === String(oracle.source.opIds.length);
  }, "packaged app fresh witness-source projection", 60_000);

  // Phase 6 — deliver the v7 handoff; ingress must stage only.
  const sourceBefore = Buffer.from(readFileSync(sourcePath));
  const valuesBaseline = readKvValues(kvPath);
  const kvBaseline = sortedEntries(valuesBaseline);
  const opLogBaseline = storedIds(valuesBaseline, TOWNSHIP_LOCAL_OP_LOG_KEY);
  const carrierSignCountBefore = traceLineCount(tracePath, "lattice_sign_carrier");
  const syncCountBefore = traceLineCount(tracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED);
  const kvSetCountBefore = traceLineCount(tracePath, "lattice_kv_set");
  const useCountBefore = traceLineCount(tracePath, witnessUseAcceptedTrace);
  const traceStart = traceLines(tracePath).length;

  await deliverDeepLink(handoff.url);
  await waitForTraceLine(`action-intent:staged:${handoff.id}`, 20_000);
  await delay(500);
  assert.deepEqual(sortedEntries(readKvValues(kvPath)), kvBaseline);
  assertSourceUnchanged(sourceBefore, "ingress");
  assert.equal(traceLineCount(tracePath, "lattice_sign_carrier"), carrierSignCountBefore);
  assert.equal(traceLineCount(tracePath, "lattice_kv_set"), kvSetCountBefore);
  assert.equal(traceLineCount(tracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);
  assertNoIngressSideEffects(traceLines(tracePath).slice(traceStart));

  // Phase 7 — Use accepts today; the derived review details are the first
  // GREEN expectation and must fail against today's stubbed witness slot.
  await deliverDeepLink(witnessUseControlUrl);
  await waitFor(
    () => traceLineCount(tracePath, witnessUseAcceptedTrace) > useCountBefore,
    "witness Use completion",
    10_000,
  );
  await delay(500);
  assert.deepEqual(sortedEntries(readKvValues(kvPath)), kvBaseline);
  assertSourceUnchanged(sourceBefore, "Use");
  assert.equal(traceLineCount(tracePath, "lattice_sign_carrier"), carrierSignCountBefore);
  assert.equal(traceLineCount(tracePath, "lattice_kv_set"), kvSetCountBefore);
  assert.equal(traceLineCount(tracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);
  assert.equal(traceLineCount(tracePath, TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND), 0);

  const expectedReviewDigests = expectedReviewDetails.map(digestText);
  await waitFor(() => {
    const trace = latestWitnessReviewDomTrace();
    return (
      trace?.intentId === handoff.id &&
      JSON.stringify(trace.detailDigests) === JSON.stringify(expectedReviewDigests)
    );
  }, "v7 IntentReviewPanel derived witness review details", 30_000);

  // Phase 8 — Sign produces exactly one presence-gated governance signature
  // and persists exactly one artifact plus its index entry.
  const signCountBefore = traceLineCount(tracePath, witnessSignSignedTrace);
  await deliverDeepLink(witnessSignControlUrl);
  await waitFor(
    () => traceLineCount(tracePath, witnessSignSignedTrace) > signCountBefore,
    "witness Sign completion",
    20_000,
  );
  assert.equal(traceLineCount(tracePath, TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND), 1);
  assert.equal(traceLineCount(tracePath, TOWNSHIP_BUNDLE_TEST_PRESENCE_MARKER), 1);

  const artifactStorageKey = storageKey(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${expectedArtifactId}`);
  const indexStorageKey = storageKey(TOWNSHIP_WITNESS_ARTIFACT_INDEX_KEY);
  await waitFor(() => readKvValues(kvPath).has(artifactStorageKey), "persisted witness artifact", 20_000);
  const valuesAfterSign = readKvValues(kvPath);
  const artifactJson = valuesAfterSign.get(artifactStorageKey);
  assert.ok(artifactJson, `expected witness artifact at ${artifactStorageKey}`);
  const artifact = JSON.parse(artifactJson) as StoredWitnessArtifactWrapper;
  assert.equal(artifact.v, 1);
  assert.equal(artifact.artifactId, expectedArtifactId);
  assert.deepEqual(artifact.claim, oracle.claim);
  assert.equal(artifact.witness, governanceWitnessKey);
  assertCanonicalBase64Signature(artifact.signature);
  const indexJson = valuesAfterSign.get(indexStorageKey);
  assert.ok(indexJson, `expected witness artifact index at ${indexStorageKey}`);
  const index = JSON.parse(indexJson) as StoredWitnessArtifactIndex;
  assert.equal(index.v, 1);
  assert.equal(index.entries.length, 1);
  assert.equal(index.entries[0]?.artifactId, expectedArtifactId);

  // Phase 9 — signing is artifact-only: no authored op, no outbox, no relay.
  assert.deepEqual(storedIds(valuesAfterSign, TOWNSHIP_LOCAL_OP_LOG_KEY), opLogBaseline);
  assert.deepEqual(kvWithoutKeys(valuesAfterSign, [artifactStorageKey, indexStorageKey]), kvBaseline);
  assertOutboxEmptyOrAbsent(valuesAfterSign, "Sign");
  assertSourceUnchanged(sourceBefore, "Sign");
  assert.equal(traceLineCount(tracePath, "lattice_sign_carrier"), carrierSignCountBefore);
  assert.equal(traceLineCount(tracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBefore);
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_witness_artifact_fixture_verify.exs",
    [sourcePath, restoredOraclePath],
    "WITNESS_FIXTURE_VERIFIED",
  );
  const restored = JSON.parse(readFileSync(restoredOraclePath, "utf8")) as RestoredWitnessOracle;
  assert.deepEqual(
    { replica: oracle.replica, source: oracle.source, projection: oracle.projection },
    restored,
    "the stable source must still restore to the fixture oracle after the ceremony",
  );

  // Phase 10 — relaunch on the same KV: the stored artifact must rehydrate
  // into a revalidated confirmation/export UI, not just survive as KV bytes.
  const deepLinkMountedCountBeforeRelaunch = traceLineCount(tracePath, "deep-link-listener-mounted");
  const hydrationCountBeforeRelaunch = traceLineCount(tracePath, "township-native-hydration-settled");
  await quitTownshipApp();
  await app.stop();
  app = launchApp(kvPath, tracePath, appSeed);
  await waitFor(
    () => traceLineCount(tracePath, "deep-link-listener-mounted") > deepLinkMountedCountBeforeRelaunch,
    "relaunched deep-link listener",
    60_000,
  );
  await waitFor(
    () => traceLineCount(tracePath, "township-native-hydration-settled") > hydrationCountBeforeRelaunch,
    "relaunched native hydration",
    60_000,
  );
  const expectedConfirmationDigests = expectedConfirmationLines.map(digestText);
  await waitFor(() => {
    const trace = latestWitnessArtifactDomTrace();
    return (
      trace?.artifactId === expectedArtifactId &&
      trace.storedCount === 1 &&
      JSON.stringify(trace.confirmationDigests) === JSON.stringify(expectedConfirmationDigests)
    );
  }, "relaunched stored witness-artifact confirmation UI", 60_000);
  await harness.waitForStoredIds(TOWNSHIP_LOCAL_OP_LOG_KEY, oracle.source.opIds, 60_000);
  await waitFor(() => {
    const trace = latestFeedDomTrace();
    return trace?.phase === "fresh" && trace.opCount === String(oracle.source.opIds.length);
  }, "relaunched packaged app fresh witness-source projection", 60_000);
  const valuesAfterRelaunch = readKvValues(kvPath);
  assert.deepEqual(storedIds(valuesAfterRelaunch, TOWNSHIP_LOCAL_OP_LOG_KEY), opLogBaseline);
  assert.deepEqual(
    kvWithoutKeys(valuesAfterRelaunch, [artifactStorageKey, indexStorageKey]),
    kvBaseline,
  );
  assertOutboxEmptyOrAbsent(valuesAfterRelaunch, "relaunch");
  assertSourceUnchanged(sourceBefore, "relaunch");
  const kvAfterRelaunch = sortedEntries(valuesAfterRelaunch);

  // Phase 11 — Cmd+Shift+E dev shortcut drives the same trusted export
  // handler as the visible control; export must not consult the carrier.
  const sourceBeforeExport = Buffer.from(readFileSync(sourcePath));
  const syncCountBeforeExport = traceLineCount(tracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED);
  const carrierSignCountBeforeExport = traceLineCount(tracePath, "lattice_sign_carrier");
  await writeClipboard(clipboardSentinel);
  assert.equal(await readClipboard(), clipboardSentinel);
  await sendExportShortcut();
  await waitFor(
    () =>
      traceLines(tracePath).some((line) => line.startsWith(witnessExportSucceededTracePrefix)),
    `trace ${witnessExportSucceededTracePrefix}<sink>`,
    30_000,
  );
  const witnessExportSink = traceLines(tracePath)
    .find((line) => line.startsWith(witnessExportSucceededTracePrefix))
    ?.slice(witnessExportSucceededTracePrefix.length);
  assert.ok(
    witnessExportSinks.includes(witnessExportSink as (typeof witnessExportSinks)[number]),
    `witness export sink must be one of ${witnessExportSinks.join("/")}, got ${witnessExportSink}`,
  );
  console.log(`  witness export clipboard sink: ${witnessExportSink}`);
  assert.deepEqual(sortedEntries(readKvValues(kvPath)), kvAfterRelaunch);
  assertSourceUnchanged(sourceBeforeExport, "export");
  assert.equal(traceLineCount(tracePath, TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED), syncCountBeforeExport);
  assert.equal(traceLineCount(tracePath, "lattice_sign_carrier"), carrierSignCountBeforeExport);

  // Phase 12 — the clipboard sink must hold the exact stored artifact bytes,
  // and the independent BEAM oracle must verify them as one subthreshold
  // witness signature over the fixture claim and policy.
  const exportedBytes = await readClipboard();
  assert.notEqual(exportedBytes, clipboardSentinel, "export must replace the clipboard sentinel");
  assert.equal(exportedBytes, artifactJson, "exported bytes must equal the stored artifact JSON");
  writeFileSync(exportedArtifactPath, exportedBytes, "utf8");
  await runBeamSupport(
    "clients/township-tauri-shell/test/support/stable_witness_artifact_export_verify.exs",
    [exportedArtifactPath, oraclePath],
    "WITNESS_EXPORT_VERIFIED",
  );

  // Phase 13 — secret and byte hygiene.
  assert.equal(fileSha256(appExecutablePath), packageHash);
  assertNoSecrets(oracle, handoff.url, artifact, valuesAfterSign);
} finally {
  await quitTownshipApp();
  await app?.stop();
  await browser?.close();
  await liveServer?.stop();
  await server?.kill();
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log("\x1b[32m✓ Packaged Tauri witness ceremony smoke passed\x1b[0m");

async function prepareWitnessHandoff(
  target: Page,
  oracle: WitnessCeremonyOracle,
): Promise<{ url: string; id: string }> {
  const handoff = target.locator("#participant-witness-succession-handoff");
  const previousUrl = (await handoff.count()) > 0 ? await handoff.getAttribute("href") : null;
  await target.locator("#participant-witness-succession-form select").selectOption("clerk");
  await target.locator("#participant-witness-succession-form button[type='submit']").click();
  await waitFor(async () => {
    if ((await handoff.count()) === 0) return false;
    const nextUrl = await handoff.getAttribute("href");
    return nextUrl !== null && nextUrl !== previousUrl;
  }, "witness succession handoff replacement", 10_000);

  const url = await handoff.getAttribute("href");
  assert.ok(url, "expected witness succession handoff");
  const parsed = parseTownshipActionIntentDeepLink(url);
  if (!parsed.ok) throw new Error(`generated witness intent was rejected: ${parsed.reason}`);
  assert.equal(parsed.intent.v, 7);
  const intent = parsed.intent as TownshipWitnessSuccessionActionIntent;
  assert.equal(intent.replica, oracle.replica);
  assert.equal(intent.authority.action, "witness_succession");
  assert.equal(intent.authority.role, "clerk");
  return { url, id: intent.id };
}

function pairingFor(
  stableServer: StableCarrierServerProcess,
  oracle: WitnessCeremonyOracle,
): TownshipCarrierPeerConfig {
  return {
    url: stableCarrierUrl(stableServer.port),
    localRealm: appRealm,
    expectedPeerRealm: stableServer.realm,
    expectedPeerPubkey: stableServer.publicKeyBase64,
    replica: oracle.replica,
    keyId: TOWNSHIP_NATIVE_KEY_ID,
    submission: "relay",
  };
}

function launchApp(kvFile: string, traceFile: string, identitySeed: string): ManagedProcess {
  return spawnManaged(
    "open",
    [
      "-n",
      "-W",
      "--env",
      `TOWNSHIP_DEV_TRACE_FILE=${traceFile}`,
      "--env",
      `TOWNSHIP_NATIVE_KV_FILE=${kvFile}`,
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

async function sendExportShortcut(): Promise<void> {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const keydownCount = traceLineCount(tracePath, exportShortcutKeydownTrace);
    await run("osascript", ["-e", `tell application id "${appIdentifier}" to activate`]);
    await delay(500);
    await run("osascript", [
      "-e",
      'tell application "System Events" to keystroke "e" using {command down, shift down}',
    ]);
    try {
      await waitFor(
        () => traceLineCount(tracePath, exportShortcutKeydownTrace) > keydownCount,
        "export shortcut keydown delivery",
        5_000,
      );
      return;
    } catch (error) {
      if (attempt === attempts) throw error;
    }
  }
}

async function writeClipboard(text: string): Promise<void> {
  const managed = spawnManaged("pbcopy", []);
  managed.child.stdin.write(text);
  managed.child.stdin.end();
  const code = await new Promise<number | null>((resolveExit) =>
    managed.child.once("exit", (exitCode) => resolveExit(exitCode)),
  );
  if (code !== 0) throw new Error(`pbcopy exited with ${code}:\n${managed.lines.join("")}`);
}

async function readClipboard(): Promise<string> {
  return runCapture("pbpaste", []);
}

function recomputedArtifactId(claim: WitnessedSuccessionClaimEvidence, witness: string): string {
  return createHash("sha256")
    .update(canonicalBytesForWitnessedSuccessionArtifactId(claim, witness))
    .digest()
    .toString("base64url");
}

function latestFeedDomTrace(): FeedDomTrace | null {
  return latestPrefixedTrace<FeedDomTrace>(TOWNSHIP_TRACE_CARRIER_FEED_DOM_PREFIX);
}

function latestWitnessReviewDomTrace(): WitnessReviewDomTrace | null {
  return latestPrefixedTrace<WitnessReviewDomTrace>(witnessReviewDomPrefix);
}

function latestWitnessArtifactDomTrace(): WitnessArtifactDomTrace | null {
  return latestPrefixedTrace<WitnessArtifactDomTrace>(witnessArtifactDomPrefix);
}

function latestPrefixedTrace<T>(prefix: string): T | null {
  const line = traceLines(tracePath).findLast((entry) => entry.startsWith(prefix));
  if (!line) return null;
  try {
    return JSON.parse(line.slice(prefix.length)) as T;
  } catch {
    return null;
  }
}

function kvWithoutKeys(
  values: ReadonlyMap<string, string>,
  excluded: readonly string[],
): [string, string][] {
  return sortedEntries(values).filter(([key]) => !excluded.includes(key));
}

function assertOutboxEmptyOrAbsent(values: ReadonlyMap<string, string>, stage: string): void {
  const raw = values.get(storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY));
  if (raw === undefined) return;
  assert.deepEqual(JSON.parse(raw), [], `outbox gained frames during ${stage}`);
}

function assertSourceUnchanged(expected: Buffer, stage: string): void {
  assert.equal(
    Buffer.from(readFileSync(sourcePath)).equals(expected),
    true,
    `stable source changed during ${stage}`,
  );
}

function assertNoIngressSideEffects(lines: string[]): void {
  assert.ok(lines.some((line) => /^action-intent:staged:[0-9a-f]{32}$/.test(line)));
  assert.ok(!lines.includes("lattice_sign_carrier"));
  assert.ok(!lines.includes("lattice_kv_set"));
  assert.ok(!lines.includes(TOWNSHIP_TRACE_SYNC_OUTBOX_STARTED));
  assert.ok(!lines.includes(TOWNSHIP_SIGN_GOVERNANCE_WITNESS_COMMAND));
}

function assertNoSecrets(
  oracle: WitnessCeremonyOracle,
  handoffUrl: string,
  artifact: StoredWitnessArtifactWrapper,
  kvValues: ReadonlyMap<string, string>,
): void {
  const identities = [
    [appSeed, appIdentity],
    [observerSeed, observerIdentity],
    [serverSeed, serverIdentity],
  ] as const;
  const privateNeedles = identities.flatMap(([seed, identity]) => [
    seed,
    identity.privateSeedBase64,
    identity.privateSeedBytesJson,
    identity.privateSeedHex,
  ]);
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(kvValues, privateNeedles));
  assert.doesNotMatch(
    JSON.stringify(Object.fromEntries(kvValues)),
    new RegExp(escapeRegex(handoffUrl)),
  );

  const serializedKvNeedles = [
    TOWNSHIP_LOCAL_OP_LOG_KEY,
    TOWNSHIP_DELEGATION_FRAMES_KEY,
    TOWNSHIP_CARRIER_OUTBOX_KEY,
  ].flatMap((key) => {
    const value = kvValues.get(storageKey(key));
    return value === undefined || value === "[]" ? [] : [value];
  });
  const artifactJson = kvValues.get(
    storageKey(`${TOWNSHIP_WITNESS_ARTIFACT_KEY_PREFIX}${artifact.artifactId}`),
  );
  assert.ok(artifactJson);
  const traceNeedles = [
    ...privateNeedles,
    handoffUrl,
    artifactJson,
    artifact.signature,
    oracle.appWitnessPubkey,
    oracle.controlWitnessPubkey,
    oracle.projection.holderPubkey,
    oracle.projection.successorPubkey,
    ...serializedKvNeedles,
  ];
  const trace = readTrace(tracePath);
  assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets([["dev_trace", trace]], privateNeedles));
  for (const value of traceNeedles) {
    assert.doesNotMatch(trace, new RegExp(escapeRegex(value)));
  }

  for (const output of [server?.output.join("") ?? "", liveServer?.output.join("") ?? ""]) {
    for (const value of privateNeedles) assert.doesNotMatch(output, new RegExp(escapeRegex(value)));
  }
}

function assertCanonicalBase64PublicKey(value: string): void {
  const bytes = Buffer.from(value, "base64");
  assert.equal(bytes.byteLength, 32, "expected a 32-byte Ed25519 public key");
  assert.equal(bytes.toString("base64"), value, "expected canonical padded base64");
}

function assertCanonicalBase64Signature(value: string): void {
  const bytes = Buffer.from(value, "base64");
  assert.equal(bytes.byteLength, 64, "expected a 64-byte Ed25519 signature");
  assert.equal(bytes.toString("base64"), value, "expected canonical padded base64");
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestText(value: string): string {
  return createHash("sha256").update(value.trim(), "utf8").digest("hex");
}

async function waitForTraceLine(line: string, timeoutMs: number): Promise<void> {
  await waitFor(() => traceLines(tracePath).includes(line), `trace ${line}`, timeoutMs);
}
