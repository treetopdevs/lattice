import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  connectCarrierWebSocket,
  type CarrierOpFrame,
} from "../../clients/lattice-client/src/index";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_DELEGATION_FRAMES_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../../clients/township-tauri-shell/src/native_workflow";
import {
  TOWNSHIP_CARRIER_PAIRING_KEY,
  createWebCryptoCarrierVerifier,
  type TownshipCarrierPeerConfig,
} from "../../clients/township-tauri-shell/src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../../clients/township-tauri-shell/src/storage_contract";
import {
  freeTcpPort,
  runBeamSupport,
  spawnStableCarrierServer,
  spawnTownshipActionLiveProjection,
  stableCarrierUrl,
  type StableCarrierServerProcess,
  type TownshipActionLiveProjectionProcess,
} from "../../clients/township-tauri-shell/test/support/beam_peer";
import {
  deliverTauriDeepLink,
  installTauriIpc,
  requiredValue,
  seededEd25519Identity,
  socketCount,
  startStaticAppServer,
  type InvokeCall,
  type StaticAppServer,
} from "./support/township_tauri_runtime";

interface SimProjection {
  opIds: string[];
  readModel: {
    threads: { posts: string[] };
    roles: { quarantine: string[]; reasons: Record<string, string> };
  };
  causalReplay: {
    nodes: Array<{ id: string; status: string; reason: string | null }>;
    [key: string]: unknown;
  };
}

interface StableRelayOracle {
  replica: string;
  relayRealm: string;
  relayPubkey: string;
  baseOpIds: string[];
  expectedPost: CarrierOpFrame;
  authorityInvalidOp: CarrierOpFrame;
  afterPost: SimProjection;
  afterAuthorityInvalid: SimProjection;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const shellRoot = join(repoRoot, "clients", "township-tauri-shell");
const distRoot = join(shellRoot, "dist");
const postText = "resident: posted while offline";
const relaySeed = "township-g1:resident";
const observerRealm = "instrument";
const observerSeed = "township-action-handoff-observer";
const serverRealm = "town-node";
const serverSeed = "township-action-handoff-server";
const unsavedDraft = "resident: unsaved local draft";

test.describe.configure({ timeout: 180_000 });

test("real LiveView action crosses Tauri custody and converges through the stable relay", async ({ page, context }) => {
  test.setTimeout(180_000);
  const tempRoot = mkdtempSync(join(tmpdir(), "township-action-handoff-"));
  const sourcePath = join(tempRoot, "matter.log");
  const oraclePath = join(tempRoot, "oracle.json");
  const relayIdentity = seededEd25519Identity(relaySeed);
  const observerIdentity = seededEd25519Identity(observerSeed);
  const kv = new Map<string, string>();
  const calls: InvokeCall[] = [];
  const browserErrors: string[] = [];
  const browserConsole: string[] = [];
  let server: StableCarrierServerProcess | null = null;
  let liveServer: TownshipActionLiveProjectionProcess | null = null;
  let appServer: StaticAppServer | null = null;
  let appPage = null as Awaited<ReturnType<typeof context.newPage>> | null;

  page.on("console", (message) => {
    browserConsole.push(`live ${message.type()}: ${message.text()}`);
    if (message.type() === "error") browserErrors.push(`live console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`live page: ${error.message}`));

  try {
    await runBeamSupport(
      "clients/township-tauri-shell/test/support/stable_relay_fixture.exs",
      [tempRoot],
      "FIXTURE_READY",
    );
    const oracle = JSON.parse(readFileSync(oraclePath, "utf8")) as StableRelayOracle;
    assert.equal(oracle.relayRealm, "resident");
    assert.equal(oracle.relayPubkey, relayIdentity.publicKeyBase64);
    assert.deepEqual(oracle.expectedPost.body, [
      "tuple",
      [
        ["atom", "post"],
        ["list", [["bin", Buffer.from(postText, "utf8").toString("base64")]]],
      ],
    ]);

    const carrierPort = await freeTcpPort();
    const webPort = await freeTcpPort();
    const spawnServer = () =>
      spawnStableCarrierServer({
        port: carrierPort,
        serverRealm,
        identitySeed: serverSeed,
        trustedPeerRealm: observerRealm,
        trustedPeerPubkey: observerIdentity.publicKeyBase64,
        relayRealm: oracle.relayRealm,
        relayPubkey: oracle.relayPubkey,
        sourcePath,
      });
    server = await spawnServer();

    liveServer = await spawnTownshipActionLiveProjection({
      webPort,
      carrierPort,
      serverRealm,
      serverPubkey: server.publicKeyBase64,
      observerRealm,
      observerSeed,
      replica: oracle.replica,
    });
    const pairing: TownshipCarrierPeerConfig = {
      url: stableCarrierUrl(carrierPort),
      localRealm: oracle.relayRealm,
      expectedPeerRealm: server.realm,
      expectedPeerPubkey: server.publicKeyBase64,
      replica: oracle.replica,
      keyId: TOWNSHIP_NATIVE_KEY_ID,
      submission: "relay",
    };
    kv.set(storageKey(TOWNSHIP_CARRIER_PAIRING_KEY), JSON.stringify(pairing));

    appServer = await startStaticAppServer(distRoot);
    appPage = await context.newPage();
    appPage.on("console", (message) => {
      browserConsole.push(`app ${message.type()}: ${message.text()}`);
      if (message.type() === "error") browserErrors.push(`app console: ${message.text()}`);
    });
    appPage.on("pageerror", (error) => browserErrors.push(`app page: ${error.message}`));
    await installTauriIpc(appPage, kv, calls, relayIdentity);
    await appPage.goto(appServer.url, { waitUntil: "domcontentloaded" });
    await expect(appPage.locator(".native-strip")).toContainText("Ready", { timeout: 15_000 });

    const postAction = appPage.locator(".action-list li").filter({
      has: appPage.getByText("Post", { exact: true }),
    });
    const feedStatus = appPage.locator("#carrier-feed-status");
    await expect(feedStatus).toHaveAttribute("data-phase", "fresh", { timeout: 20_000 });
    await expect(feedStatus).toHaveAttribute("data-op-count", String(oracle.baseOpIds.length));
    await expect(postAction).toContainText("Available");
    assert.deepEqual(storedIds(kv, TOWNSHIP_LOCAL_OP_LOG_KEY), [...oracle.baseOpIds].sort());
    assert.deepEqual(storedFramesOrEmpty(kv, TOWNSHIP_CARRIER_OUTBOX_KEY), []);
    const syncMessage = appPage.locator("#carrier-sync-status");
    await appPage.getByRole("textbox", { name: "Township post update" }).fill(unsavedDraft);

    await page.goto(`http://localhost:${webPort}/township`, { waitUntil: "domcontentloaded" });
    const source = page.locator("#source-status[data-source='carrier']");
    await expect(source).toHaveAttribute("data-freshness", "fresh");
    await expect(page.locator("#participant-post-form")).toBeVisible();
    await page.getByRole("textbox", { name: "Resident update" }).fill(`  ${postText}  `);
    await page.getByRole("button", { name: "Prepare in app" }).click();
    await expect(page.locator("#participant-post-prepared")).toHaveText("Unsigned and unconfirmed");
    const actionUrl = await page.locator("#participant-post-handoff").getAttribute("href");
    assert.ok(actionUrl, "expected the action URL rendered by the real LiveView");
    assertLiveViewIntent(actionUrl, oracle.replica, postText);

    const kvBeforeIngress = [...kv.entries()];
    const signsBeforeIngress = commandCount(calls, "lattice_sign_carrier");
    const socketsBeforeIngress = await socketCount(appPage);
    const callsBeforeIngress = calls.length;
    await deliverTauriDeepLink(appPage, calls, actionUrl);

    const incoming = appPage.locator("#participant-action-request");
    await expect(incoming).toContainText(postText);
    await expect(appPage.getByRole("textbox", { name: "Township post update" })).toHaveValue(unsavedDraft);
    assert.deepEqual([...kv.entries()], kvBeforeIngress, "action ingress must not mutate native KV");
    assert.equal(commandCount(calls, "lattice_sign_carrier"), signsBeforeIngress, "action ingress must not sign");
    assert.equal(await socketCount(appPage), socketsBeforeIngress, "action ingress must not open a carrier socket");
    assertRedactedActionTraces(calls.slice(callsBeforeIngress), postText, oracle.replica, actionUrl);

    await appPage.getByRole("button", { name: "Use request" }).click();
    await expect(incoming).toHaveCount(0);
    await expect(appPage.getByRole("textbox", { name: "Township post update" })).toHaveValue(postText);
    assert.deepEqual([...kv.entries()], kvBeforeIngress, "accepting the request must remain draft-only");
    assert.equal(commandCount(calls, "lattice_sign_carrier"), signsBeforeIngress);
    assert.equal(await socketCount(appPage), socketsBeforeIngress);

    await appPage.getByRole("button", { name: "Post update" }).click();
    const postPanel = appPage.locator(".compose-panel").filter({
      has: appPage.getByText("Post update", { exact: true }),
    });
    await expect(postPanel.locator(".post-actions .post-message")).toContainText("Saved signed frame", {
      timeout: 10_000,
    });
    const authoredFrame = storedFrames(kv, TOWNSHIP_CARRIER_OUTBOX_KEY).find(
      (frame) => frame.id === oracle.expectedPost.id,
    );
    assert.deepEqual(authoredFrame, oracle.expectedPost, "the app must author the exact Sim operation");

    await appPage.getByRole("button", { name: "Sync outbox" }).click();
    await expect(syncMessage).toHaveText(/Pushed 1, pulled \d+, accepted 1\./, { timeout: 20_000 });
    assert.deepEqual(storedFrames(kv, TOWNSHIP_CARRIER_OUTBOX_KEY), []);
    assert.deepEqual(
      storedFrames(kv, TOWNSHIP_DELEGATION_FRAMES_KEY).find((frame) => frame.id === oracle.expectedPost.id),
      oracle.expectedPost,
    );
    assert.deepEqual(storedIds(kv, TOWNSHIP_LOCAL_OP_LOG_KEY), [...oracle.afterPost.opIds].sort());

    await expect(page.locator(`#op-dag-panel [data-op-count='${oracle.afterPost.opIds.length}']`)).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator("#threads-panel [data-post] > span:last-child")).toHaveText(
      oracle.afterPost.readModel.threads.posts,
    );
    await expect(page.locator("#causal-replay-island[data-vue-mounted='true']")).toHaveAttribute(
      "data-visible-count",
      String(oracle.afterPost.causalReplay.nodes.length),
    );
    await expect(page.locator("#op-dag-panel .dag-counts")).toHaveAttribute("data-quarantined-count", "0");
    assert.deepEqual(await browserReplay(page), oracle.afterPost.causalReplay);

    const deniedId = oracle.authorityInvalidOp.id;
    assert.ok(oracle.afterAuthorityInvalid.readModel.roles.quarantine.includes(deniedId));
    assert.equal(oracle.afterAuthorityInvalid.readModel.roles.reasons[deniedId], "no_capability");

    const relayConnection = await connectCarrierWebSocket({
      url: stableCarrierUrl(server.port),
      localRealm: oracle.relayRealm,
      replica: oracle.replica,
      signer: relayIdentity,
      expectedPeerRealm: server.realm,
      expectedPeerPubkey: Buffer.from(server.publicKeyBase64, "base64"),
      verifier: createWebCryptoCarrierVerifier(),
    });
    try {
      assert.deepEqual(await relayConnection.relay(oracle.authorityInvalidOp), {
        accepted: [deniedId],
        quarantined: [],
        rejected: [],
        pending: [],
      });
    } finally {
      relayConnection.close();
    }

    await expect(page.locator("#op-dag-panel .dag-counts")).toHaveAttribute(
      "data-op-count",
      String(oracle.afterAuthorityInvalid.opIds.length),
      { timeout: 20_000 },
    );
    await expect(page.locator("#op-dag-panel .dag-counts")).toHaveAttribute("data-quarantined-count", "1");
    await expect(page.locator("#roles-panel .audit-event[data-reason='no_capability'] code")).toHaveText(
      deniedId.slice(0, 12),
    );
    assert.deepEqual(await browserReplay(page), oracle.afterAuthorityInvalid.causalReplay);

    const secretNeedles = [
      relaySeed,
      relayIdentity.privateSeedBase64,
      relayIdentity.privateSeedBytesJson,
      relayIdentity.privateSeedHex,
    ];
    assert.doesNotThrow(() => assertTownshipKvStoresNoSecrets(kv, secretNeedles));
    const liveOutput = liveServer.output.join("");
    const browserOutput = browserConsole.join("\n");
    for (const secret of secretNeedles) {
      assert.doesNotMatch(liveOutput, new RegExp(escapeRegex(secret)));
      assert.doesNotMatch(browserOutput, new RegExp(escapeRegex(secret)));
    }
    assert.doesNotMatch(liveOutput, new RegExp(escapeRegex(actionUrl)));
    assert.doesNotMatch(liveOutput, new RegExp(escapeRegex(postText)));
    assert.doesNotMatch(browserOutput, new RegExp(escapeRegex(actionUrl)));
    assert.doesNotMatch(browserOutput, new RegExp(escapeRegex(postText)));

    const retainedFeedOpCount = String(oracle.afterAuthorityInvalid.opIds.length);
    await expect(feedStatus).toHaveAttribute("data-phase", "fresh", { timeout: 20_000 });
    await expect(feedStatus).toHaveAttribute("data-op-count", retainedFeedOpCount);
    const outageStartedAt = Date.now();
    await server.kill();
    server = null;
    await expect(source).toHaveAttribute("data-freshness", "stale", { timeout: 20_000 });
    await expect(feedStatus).toHaveAttribute("data-phase", "reconnecting", { timeout: 20_000 });
    await expect(feedStatus).toHaveAttribute("data-op-count", retainedFeedOpCount);
    server = await spawnServer();
    await expect(source).toHaveAttribute("data-freshness", "fresh", { timeout: 20_000 });
    await expect(feedStatus).toHaveAttribute("data-phase", "fresh", { timeout: 20_000 });
    await expect(feedStatus).toHaveAttribute("data-op-count", retainedFeedOpCount);
    const outageDurationMs = Date.now() - outageStartedAt;
    await expect(page.locator("#threads-panel [data-post] > span:last-child")).toHaveText(
      oracle.afterAuthorityInvalid.readModel.threads.posts,
    );

    const verifyOutput = await runBeamSupport(
      "clients/township-tauri-shell/test/support/stable_relay_verify.exs",
      [
        String(server.port),
        server.realm,
        server.publicKeyBase64,
        observerRealm,
        observerSeed,
        oracle.replica,
        oraclePath,
        "authority",
      ],
      "VERIFY_READY authority",
    );
    assert.match(verifyOutput, /VERIFY_READY authority/);
    assert.deepEqual(await browserReplay(page), oracle.afterAuthorityInvalid.causalReplay);
    const expectedFeedRefusal =
      `app console: WebSocket connection to '${stableCarrierUrl(carrierPort)}' failed: ` +
      "Error in connection establishment: net::ERR_CONNECTION_REFUSED";
    const feedRefusals = browserErrors.filter((error) => error === expectedFeedRefusal);
    const maxFeedRefusals = maxExpectedReconnectRefusals(outageDurationMs);
    assert.ok(
      feedRefusals.length <= maxFeedRefusals,
      `expected at most ${maxFeedRefusals} feed refusals over ${outageDurationMs}ms, got ${feedRefusals.length}`,
    );
    assert.deepEqual(
      browserErrors.filter((error) => error !== expectedFeedRefusal),
      [],
    );
  } finally {
    if (appServer) {
      appServer.server.closeAllConnections();
      appServer.server.closeIdleConnections();
      appServer.server.close();
      appServer.server.unref();
    }
    await liveServer?.stop();
    await server?.kill();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function assertLiveViewIntent(url: string, replica: string, text: string): void {
  const parsed = new URL(url);
  assert.equal(parsed.protocol, "township:");
  assert.equal(parsed.hostname, "action");
  assert.deepEqual([...parsed.searchParams.keys()], ["intent"]);
  const encoded = parsed.searchParams.get("intent");
  assert.ok(encoded);
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload), ["v", "id", "replica", "command"]);
  assert.equal(payload.v, 1);
  assert.match(String(payload.id), /^[0-9a-f]{32}$/);
  assert.equal(payload.replica, replica);
  assert.deepEqual(payload.command, { command: "post", text });
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /cap|delegation|signature|pubkey|private|deps|frontier|local_realm/i);
}

function assertRedactedActionTraces(calls: InvokeCall[], text: string, replica: string, url: string): void {
  const traces = calls
    .filter(({ command }) => command === "lattice_trace_dev_event")
    .map(({ args }) => String(args.event));
  assert.ok(traces.some((event) => /^action-intent:staged:[0-9a-f]{32}$/.test(event)));
  assert.doesNotMatch(traces.join("\n"), new RegExp(escapeRegex(text)));
  assert.doesNotMatch(traces.join("\n"), new RegExp(escapeRegex(replica)));
  assert.doesNotMatch(traces.join("\n"), new RegExp(escapeRegex(url)));
}

async function browserReplay(page: Page): Promise<unknown> {
  await expect.poll(async () => page.locator("#causal-replay-island").getAttribute("data-replay")).not.toBeNull();
  const encoded = await page.locator("#causal-replay-island").getAttribute("data-replay");
  assert.ok(encoded);
  return JSON.parse(encoded);
}

function storedFrames(values: Map<string, string>, key: string): CarrierOpFrame[] {
  return JSON.parse(requiredValue(values, storageKey(key))) as CarrierOpFrame[];
}

function storedFramesOrEmpty(values: Map<string, string>, key: string): CarrierOpFrame[] {
  const raw = values.get(storageKey(key));
  return raw === undefined ? [] : (JSON.parse(raw) as CarrierOpFrame[]);
}

function storedIds(values: Map<string, string>, key: string): string[] {
  const raw = requiredValue(values, storageKey(key));
  return (JSON.parse(raw) as { id: string }[]).map((entry) => entry.id).sort();
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
}

function commandCount(calls: InvokeCall[], command: string): number {
  return calls.filter((call) => call.command === command).length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maxExpectedReconnectRefusals(outageDurationMs: number): number {
  const delays = [100, 250, 500, 1_000, 2_000, 5_000] as const;
  let elapsed = 0;
  let attempts = 0;

  while (true) {
    const delay = delays[Math.min(attempts, delays.length - 1)] ?? 5_000;
    if (elapsed + delay > outageDurationMs) return attempts;
    elapsed += delay;
    attempts += 1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
