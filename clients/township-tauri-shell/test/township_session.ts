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

test("session sequences pairing load, sync, and health through injected adapters", async () => {
  const calls: string[] = [];
  const session = createTownshipSession({
    initialCarrierPeer: () => null,
    createNativeStorage: () => ({} as never),
    loadPairing: async () => {
      calls.push("load-pairing");
      return peer;
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

  await session.loadPairingConfig();
  await session.syncOutbox();
  await session.checkCarrierHealth();

  assert.deepEqual(calls, ["load-pairing", "sync:clerk", "health:clerk"]);
  assert.equal(session.carrierPeer.value?.expectedPeerRealm, "clerk");
  assert.deepEqual(session.syncStatus.value, {
    ok: false,
    reason: "sync_failed",
    message: "offline for contract test",
  });
  assert.deepEqual(session.healthStatus.value, {
    ok: true,
    phase: "base",
    peerRealm: "clerk",
  });
});
