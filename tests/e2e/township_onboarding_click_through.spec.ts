import assert from "node:assert/strict";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import {
  connectCarrierWebSocket,
  type CarrierVerifier,
} from "../../clients/lattice-client/src/index";
import {
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
} from "../../clients/township-tauri-shell/src/native_workflow";
import {
  exportTownshipCarrierPairingHandoff,
  TOWNSHIP_CARRIER_PAIRING_KEY,
  type TownshipCarrierPeerConfig,
} from "../../clients/township-tauri-shell/src/township_carrier_peer";
import { assertTownshipKvStoresNoSecrets } from "../../clients/township-tauri-shell/src/storage_contract";
import {
  peerUrl,
  spawnTownshipPeer,
  type TownshipPeerProcess,
} from "../../clients/township-tauri-shell/test/support/beam_peer";

interface CarrierVector {
  scenario: string;
  replica: string;
  realmByPubkey: Record<string, string>;
  client: { realm: string; sessionSeed: string };
  peer: { realm: string; sessionPubkey: string };
}

interface NativeIdentity {
  publicKey: Uint8Array;
  publicKeyBase64: string;
  privateSeedBase64: string;
  privateSeedBytesJson: string;
  privateSeedHex: string;
  sign(bytes: Uint8Array): Uint8Array;
}

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

interface StaticAppServer {
  server: Server;
  url: string;
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const shellRoot = join(repoRoot, "clients", "township-tauri-shell");
const distRoot = join(shellRoot, "dist");
const vector = JSON.parse(
  readFileSync(join(repoRoot, "clients", "lattice-client", "test", "vectors", "township_carrier_w1.json"), "utf8"),
) as CarrierVector;
const residentDeviceSeed = `${vector.client.sessionSeed}:${vector.client.realm}`;
const identity = seededEd25519Identity(residentDeviceSeed);
const verifier: CarrierVerifier = {
  verify(pubkey, bytes, signature) {
    return edVerify(null, Buffer.from(bytes), publicKeyObject(pubkey), Buffer.from(signature));
  },
};
const carrierSessionTranscriptPrefix = Buffer.from([
  0x89,
  0x52,
  ...Buffer.from("carrier-session-v2", "utf8"),
]);

let appServer: StaticAppServer;

test.describe.configure({ timeout: 120_000 });

test.beforeAll(async () => {
  appServer = await startStaticAppServer(distRoot);
});

test.afterAll(async () => {
  await closeServer(appServer.server);
});

test("resident controls refresh pulled caps and converge through the native seam", async ({ page }) => {
  test.setTimeout(120_000);
  assert.equal(vector.realmByPubkey[identity.publicKeyBase64], vector.client.realm);

  const kv = new Map<string, string>();
  const calls: InvokeCall[] = [];
  let peer: TownshipPeerProcess | null = null;

  try {
    peer = await spawnTownshipPeer({
      peerRealm: vector.peer.realm,
      trustedPeerRealm: vector.client.realm,
      trustedPeerPubkey: identity.publicKeyBase64,
      scenario: "LatticeNodeSpike.TownshipOnboardingScenario",
    });
    assert.equal(peer.publicKeyBase64, vector.peer.sessionPubkey);

    await installTauriIpc(page, kv, calls, identity);
    await page.goto(appServer.url);

    const nativeStrip = page.locator(".native-strip");
    await expect(nativeStrip).toContainText("Ready", { timeout: 15_000 });

    const postAction = page.locator(".action-list li").filter({
      has: page.getByText("Post", { exact: true }),
    });
    await expect(postAction).toContainText("No local cap");

    const pairing: TownshipCarrierPeerConfig = {
      url: peerUrl(peer.port),
      localRealm: vector.client.realm,
      expectedPeerRealm: vector.peer.realm,
      expectedPeerPubkey: peer.publicKeyBase64,
      replica: vector.replica,
      keyId: TOWNSHIP_NATIVE_KEY_ID,
    };
    await page.getByRole("textbox", { name: "Pairing handoff" }).fill(
      exportTownshipCarrierPairingHandoff(pairing),
    );
    await page.getByRole("button", { name: "Load handoff" }).click();
    await page.getByRole("textbox", { name: "Local realm" }).fill(vector.client.realm);

    const confirmation = page.getByRole("checkbox", { name: "Confirm carrier pairing save" });
    await expect(confirmation).toBeVisible();
    await page.getByRole("button", { name: "Save pairing" }).click();
    await expect(page.getByText("Confirm this imported carrier pairing before saving.", { exact: true })).toBeVisible();
    assert.equal(kv.has(storageKey(TOWNSHIP_CARRIER_PAIRING_KEY)), false);

    await confirmation.check();
    await page.getByRole("button", { name: "Save pairing" }).click();
    await expect(page.getByText("Pairing config saved for future sync.", { exact: true })).toBeVisible();
    assert.deepEqual(JSON.parse(requiredValue(kv, storageKey(TOWNSHIP_CARRIER_PAIRING_KEY))), pairing);

    await expect(postAction).toContainText("No local cap");
    await page.getByRole("button", { name: "Sync outbox" }).click();
    const syncMessage = page.locator("#carrier-sync-status");
    await expect(syncMessage).toHaveText(/Pushed 0, pulled [1-9]\d*, accepted 0\./, { timeout: 20_000 });

    // RED on Plan 120: sync persisted the cap, but the rendered availability snapshot stayed stale.
    await expect(postAction).toContainText("Available");

    const closeAction = page.locator(".action-list li").filter({
      has: page.getByText("Close matter", { exact: true }),
    });
    await expect(closeAction).toContainText("No local cap");

    const preservedDraft = "resident draft stays local";
    await page.getByRole("textbox", { name: "Township post update" }).fill(preservedDraft);
    const closeActionUrl = townshipStatusActionUrl(vector.replica, "close_matter");
    const kvBeforeCloseIntent = [...kv.entries()];
    const nonSessionSignsBeforeCloseIntent = nonSessionSignCount(calls);
    const kvSetsBeforeCloseIntent = commandCount(calls, "lattice_kv_set");
    const callsBeforeCloseIntent = calls.length;

    await deliverTauriDeepLink(page, calls, closeActionUrl);

    const closeIncoming = page.locator("#participant-action-request");
    await expect(closeIncoming).toContainText("Close matter request");
    await expect(closeIncoming.locator(".incoming-action-text")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Township post update" })).toHaveValue(preservedDraft);
    assert.deepEqual([...kv.entries()], kvBeforeCloseIntent, "status ingress must not change native KV state");
    assert.equal(nonSessionSignCount(calls), nonSessionSignsBeforeCloseIntent);
    assert.equal(commandCount(calls, "lattice_kv_set"), kvSetsBeforeCloseIntent);

    const closeIngressTraces = calls
      .slice(callsBeforeCloseIntent)
      .filter(({ command }) => command === "lattice_trace_dev_event")
      .map(({ args }) => String(args.event));
    assert.ok(closeIngressTraces.some((event) => event.includes("action-intent:staged")));
    assert.doesNotMatch(closeIngressTraces.join("\n"), /close_matter|replica:matter|township:\/\/action/);

    await closeIncoming.getByRole("button", { name: "Use request" }).click();
    await expect(closeIncoming).toHaveCount(0);

    const acceptedClose = page.locator("#participant-status-request");
    await expect(acceptedClose).toContainText("Close matter request");
    await expect(acceptedClose.getByRole("button", { name: "Sign close" })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Township post update" })).toHaveValue(preservedDraft);
    assert.deepEqual([...kv.entries()], kvBeforeCloseIntent, "using a no-cap request must remain local state only");
    assert.equal(nonSessionSignCount(calls), nonSessionSignsBeforeCloseIntent);
    assert.equal(commandCount(calls, "lattice_kv_set"), kvSetsBeforeCloseIntent);
    assert.deepEqual(JSON.parse(requiredValue(kv, storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY))), []);

    await acceptedClose.getByRole("button", { name: "Dismiss request" }).click();
    await expect(acceptedClose).toHaveCount(0);
    await page.getByRole("textbox", { name: "Township post update" }).fill("");

    const postText = "resident: prepared in the instrument";
    const actionUrl = townshipPostActionUrl(vector.replica, postText);
    const kvBeforeIntent = [...kv.entries()];
    const nonSessionSignsBeforeIntent = nonSessionSignCount(calls);
    const callsBeforeIntent = calls.length;

    await deliverTauriDeepLink(page, calls, actionUrl);

    const incoming = page.locator("#participant-action-request");
    await expect(incoming).toContainText("Post request");
    await expect(incoming).toContainText(postText);
    await expect(page.getByRole("textbox", { name: "Township post update" })).toHaveValue("");
    assert.deepEqual([...kv.entries()], kvBeforeIntent, "action ingress must not change native KV state");
    assert.equal(
      nonSessionSignCount(calls),
      nonSessionSignsBeforeIntent,
      "action ingress must not sign a non-session payload",
    );
    const actionIngressTraces = calls
      .slice(callsBeforeIntent)
      .filter(({ command }) => command === "lattice_trace_dev_event")
      .map(({ args }) => String(args.event));
    assert.ok(actionIngressTraces.some((event) => event.includes("action-intent:staged")));
    assert.doesNotMatch(actionIngressTraces.join("\n"), /resident: prepared|replica:matter|township:\/\/action/);

    await page.getByRole("button", { name: "Use request" }).click();
    await expect(incoming).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Township post update" })).toHaveValue(postText);
    assert.deepEqual([...kv.entries()], kvBeforeIntent, "accepting a request must remain draft-only");
    assert.equal(nonSessionSignCount(calls), nonSessionSignsBeforeIntent);

    await page.getByRole("button", { name: "Post update" }).click();
    const postPanel = page.locator(".compose-panel").filter({
      has: page.getByText("Post update", { exact: true }),
    });
    await expect(postPanel.locator(".post-actions .post-message")).toContainText("Saved signed frame", {
      timeout: 10_000,
    });
    assert.equal(nonSessionSignCount(calls), nonSessionSignsBeforeIntent + 1);

    await page.getByRole("button", { name: "Sync outbox" }).click();
    await expect(syncMessage).toHaveText(/Pushed 1, pulled \d+, accepted 1\./, { timeout: 20_000 });

    assert.deepEqual(JSON.parse(requiredValue(kv, storageKey(TOWNSHIP_CARRIER_OUTBOX_KEY))), []);
    assert.doesNotThrow(() =>
      assertTownshipKvStoresNoSecrets(kv, [
        residentDeviceSeed,
        identity.privateSeedBase64,
        identity.privateSeedBytesJson,
        identity.privateSeedHex,
      ]),
    );

    const reportConnection = await connectCarrierWebSocket({
      url: peerUrl(peer.port),
      localRealm: vector.client.realm,
      replica: vector.replica,
      signer: identity,
      expectedPeerRealm: vector.peer.realm,
      expectedPeerPubkey: Buffer.from(peer.publicKeyBase64, "base64"),
      verifier,
    });
    const report = await reportConnection.stateReport();
    assert.ok(Array.isArray(report.state?.posts));
    assert.ok(report.state.posts.includes(postText));
    assert.deepEqual(report.authority_quarantine, []);
    await reportConnection.shutdown();
    await peer.awaitExit();
  } finally {
    peer?.kill();
  }
});

async function installTauriIpc(
  page: Page,
  kv: Map<string, string>,
  calls: InvokeCall[],
  signer: NativeIdentity,
): Promise<void> {
  await page.exposeFunction(
    "__townshipTestInvoke",
    async (command: string, args: Record<string, unknown> = {}): Promise<unknown> => {
      calls.push({ command, args });

      switch (command) {
        case "lattice_kv_get":
          return kv.get(requiredString(args, "key")) ?? null;
        case "lattice_kv_set":
          kv.set(requiredString(args, "key"), requiredString(args, "value"));
          return null;
        case "lattice_ensure_carrier_key":
          assert.equal(requiredString(args, "keyId"), TOWNSHIP_NATIVE_KEY_ID);
          return signer.publicKeyBase64;
        case "lattice_sign_carrier":
          assert.equal(requiredString(args, "keyId"), TOWNSHIP_NATIVE_KEY_ID);
          return Buffer.from(signer.sign(Buffer.from(requiredString(args, "bytes"), "base64"))).toString("base64");
        case "lattice_android_current_pairing_handoff_b64":
        case "plugin:deep-link|get_current":
          return null;
        case "plugin:event|listen":
          return args.handler;
        case "plugin:event|unlisten":
        case "lattice_log_probe":
        case "lattice_trace_dev_event":
          return null;
        default:
          throw new Error(`unhandled Tauri test command ${command}`);
      }
    },
  );

  await page.addInitScript(() => {
    const scope = globalThis as typeof globalThis & Record<string, any>;
    const callbacks = new Map<number, (data: unknown) => unknown>();

    scope.isTauri = true;
    scope.__TAURI_INTERNALS__ = {
      callbacks,
      invoke(command: string, args: Record<string, unknown> = {}) {
        return scope.__townshipTestInvoke(command, args);
      },
      transformCallback(callback: (data: unknown) => unknown, once = false) {
        const id = crypto.getRandomValues(new Uint32Array(1))[0];
        callbacks.set(id, (data) => {
          if (once) callbacks.delete(id);
          return callback?.(data);
        });
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      runCallback(id: number, data: unknown) {
        callbacks.get(id)?.(data);
      },
    };
    scope.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener(_event: string, id: number) {
        callbacks.delete(id);
      },
    };
  });
}

async function deliverTauriDeepLink(page: Page, calls: InvokeCall[], url: string): Promise<void> {
  await expect
    .poll(
      () =>
        calls.filter(
          ({ command, args }) => command === "plugin:event|listen" && args.event === "deep-link://new-url",
        ).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  const handlerIds = calls
    .filter(({ command, args }) => command === "plugin:event|listen" && args.event === "deep-link://new-url")
    .map(({ args }) => Number(args.handler));

  await page.evaluate(
    ({ ids, deepLink }) => {
      const scope = globalThis as typeof globalThis & Record<string, any>;
      for (const id of ids) {
        scope.__TAURI_INTERNALS__.runCallback(id, {
          event: "deep-link://new-url",
          id,
          payload: [deepLink],
        });
      }
    },
    { ids: handlerIds, deepLink: url },
  );
}

function townshipPostActionUrl(replica: string, text: string): string {
  const payload = {
    v: 1,
    id: "89abcdef0123456789abcdef01234567",
    replica,
    command: { command: "post", text },
  };
  return `township://action?intent=${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function townshipStatusActionUrl(
  replica: string,
  command: "close_matter" | "reopen_matter",
): string {
  const payload = {
    v: 2,
    id: "fedcba9876543210fedcba9876543210",
    replica,
    command: { command },
  };
  return `township://action?intent=${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

async function startStaticAppServer(root: string): Promise<StaticAppServer> {
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = resolve(root, normalize(relativePath));
    if (!filePath.startsWith(`${resolve(root)}/`) || !statIsFile(filePath)) {
      response.writeHead(404).end("not found");
      return;
    }

    response.setHeader("content-type", contentType(filePath));
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("static app server did not expose a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function statIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "text/html; charset=utf-8";
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
    server.closeAllConnections();
  });
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`missing string argument ${key}`);
  return value;
}

function nonSessionSignCount(calls: InvokeCall[]): number {
  return calls.filter(({ command, args }) => {
    if (command !== "lattice_sign_carrier") return false;
    const signedBytes = Buffer.from(requiredString(args, "bytes"), "base64");
    return !signedBytes.subarray(0, carrierSessionTranscriptPrefix.length).equals(carrierSessionTranscriptPrefix);
  }).length;
}

function commandCount(calls: InvokeCall[], command: string): number {
  return calls.filter((call) => call.command === command).length;
}

function requiredValue(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  assert.notEqual(value, undefined, `missing native KV value ${key}`);
  return value as string;
}

function storageKey(key: string): string {
  return `${TOWNSHIP_STORAGE_NAMESPACE}:${key}`;
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
