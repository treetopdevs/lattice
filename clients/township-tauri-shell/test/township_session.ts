import assert from "node:assert/strict";
import test from "node:test";

import { createTownshipSession } from "../src/township_session";

const peer = {
  url: "ws://127.0.0.1:43191/carrier",
  localRealm: "resident",
  expectedPeerRealm: "clerk",
  expectedPeerPubkey: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=",
  replica: "replica:matter:township-session",
  keyId: "township-session-resident",
};

test("session lifecycle sequences adapters and tears listeners down", async () => {
  const calls: string[] = [];
  let hydrate: (() => Promise<void>) | null = null;

  const session = createTownshipSession({
    initialCarrierPeer: () => null,
    createNativeStorage: () => ({} as never),
    runtimeIsTauri: () => false,
    createPairingDeepLinkSource: () => ({} as never),
    createPairingDeepLinkListener: async () => {
      calls.push("pairing-listener");
      return { stop: () => calls.push("stop-pairing-listener") } as never;
    },
    createCanonicalProbeDeepLinkListener: async () => {
      calls.push("canonical-listener");
      return { stop: () => calls.push("stop-canonical-listener") } as never;
    },
    scheduleHydration: (callback) => {
      calls.push("schedule-hydration");
      hydrate = callback;
      return () => calls.push("cancel-hydration");
    },
    loadPairing: async () => {
      calls.push("load-pairing");
      return peer;
    },
    loadNativeStatus: async () => {
      calls.push("load-native-status");
      return {
        ready: true,
        keyId: "township-session-resident",
        storageNamespace: "township:session",
        publicKey: peer.expectedPeerPubkey,
      };
    },
    loadActionAvailability: async () => {
      calls.push("load-action-availability");
      return {
        ready: false,
        reason: "native_unavailable",
        message: "contract fixture",
      };
    },
    syncOutbox: async (options) => {
      calls.push(`sync:${options.peer?.expectedPeerRealm ?? "none"}`);
      return { ok: false, reason: "sync_failed", message: "offline for contract test" };
    },
    checkHealth: async (options) => {
      calls.push(`health:${options.peer?.expectedPeerRealm ?? "none"}`);
      return { ok: true, phase: "base", peerRealm: "clerk" };
    },
  });

  assert.deepEqual(Object.keys(session), ["view", "command", "pairing", "connection", "lifecycle"]);

  await session.lifecycle.mount();
  await session.connection.syncOutbox();
  await session.connection.checkCarrierHealth();
  assert.ok(hydrate);
  await hydrate();
  session.lifecycle.unmount();

  assert.deepEqual(calls, [
    "pairing-listener",
    "canonical-listener",
    "load-pairing",
    "schedule-hydration",
    "sync:clerk",
    "health:clerk",
    "load-native-status",
    "load-action-availability",
    "stop-canonical-listener",
    "stop-pairing-listener",
  ]);
  assert.equal(session.connection.carrierPeer.value?.expectedPeerRealm, "clerk");
  assert.deepEqual(session.connection.syncStatus.value, {
    ok: false,
    reason: "sync_failed",
    message: "offline for contract test",
  });
  assert.deepEqual(session.connection.healthStatus.value, {
    ok: true,
    phase: "base",
    peerRealm: "clerk",
  });
});

test("unmount cancels pending hydration before it can mutate session state", async () => {
  const calls: string[] = [];
  let hydrate: (() => Promise<void>) | null = null;

  const session = createTownshipSession({
    initialCarrierPeer: () => null,
    createNativeStorage: () => ({} as never),
    runtimeIsTauri: () => false,
    createPairingDeepLinkSource: () => ({} as never),
    createPairingDeepLinkListener: async () => ({
      stop: () => calls.push("stop-pairing-listener"),
    }) as never,
    createCanonicalProbeDeepLinkListener: async () => ({
      stop: () => calls.push("stop-canonical-listener"),
    }) as never,
    scheduleHydration: (callback) => {
      hydrate = callback;
      return () => calls.push("cancel-hydration");
    },
    loadPairing: async () => null,
    loadNativeStatus: async () => {
      calls.push("load-native-status");
      return {
        ready: false,
        keyId: "township-session-resident",
        storageNamespace: "township:session",
        error: "not expected",
      };
    },
  });

  await session.lifecycle.mount();
  session.lifecycle.unmount();
  assert.ok(hydrate);
  await hydrate();

  assert.deepEqual(calls, [
    "cancel-hydration",
    "stop-canonical-listener",
    "stop-pairing-listener",
  ]);
});
