import assert from "node:assert/strict";
import {
  createTownshipNativeStorage,
  createTownshipNativeWorkflow,
  loadTownshipNativeStatus,
  probeTownshipNativeWorkflow,
  TOWNSHIP_CARRIER_OUTBOX_KEY,
  TOWNSHIP_LOCAL_OP_LOG_KEY,
  TOWNSHIP_NATIVE_KEY_ID,
  TOWNSHIP_STORAGE_NAMESPACE,
  traceTownshipDevEvent,
} from "../src/native_workflow";
import type { TauriInvoke } from "@treetopdevs/lattice-client";

interface InvokeCall {
  command: string;
  args: Record<string, unknown>;
}

console.log("\n▸ Township Vue native invoke workflow");

const publicKeyBase64 = bytesBase64(new Uint8Array(32).fill(7));
const signatureBase64 = bytesBase64(new Uint8Array(64).fill(9));
const values = new Map<string, string>();
const calls: InvokeCall[] = [];

const invoke: TauriInvoke = async <T = unknown>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => {
  calls.push({ command, args });

  let result: unknown;
  switch (command) {
    case "lattice_ensure_carrier_key":
      assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
      result = publicKeyBase64;
      break;
    case "lattice_kv_set":
      values.set(String(args.key), String(args.value));
      result = null;
      break;
    case "lattice_kv_get":
      result = values.get(String(args.key)) ?? null;
      break;
    case "lattice_sign_carrier":
      assert.equal(args.keyId, TOWNSHIP_NATIVE_KEY_ID);
      result = signatureBase64;
      break;
    case "lattice_trace_dev_event":
      result = null;
      break;
    default:
      throw new Error(`unexpected command ${command}`);
  }

  return result as T;
};

const workflow = await createTownshipNativeWorkflow({ invoke });
await workflow.localLog.save([]);
await workflow.carrierFrames.save([]);

assert.equal(values.get(`${TOWNSHIP_STORAGE_NAMESPACE}:${TOWNSHIP_LOCAL_OP_LOG_KEY}`), "[]");
assert.equal(values.get(`${TOWNSHIP_STORAGE_NAMESPACE}:${TOWNSHIP_CARRIER_OUTBOX_KEY}`), "[]");

const pairingStorage = createTownshipNativeStorage({ invoke, storageNamespace: "township:pairing-test" });
await pairingStorage.setItem("carrier_peer_config", "{\"url\":\"wss://carrier.example\"}");
assert.equal(
  values.get("township:pairing-test:carrier_peer_config"),
  "{\"url\":\"wss://carrier.example\"}",
);

const probe = await probeTownshipNativeWorkflow({ invoke });
await traceTownshipDevEvent("deep-link:township://pairing", { invoke });

assert.equal(probe.ready, true);
assert.equal(probe.keyId, TOWNSHIP_NATIVE_KEY_ID);
assert.equal(probe.storageNamespace, TOWNSHIP_STORAGE_NAMESPACE);
assert.equal(probe.publicKeyBase64, publicKeyBase64);
assert.equal(probe.storageEcho, "native invoke ready");
assert.equal(probe.signatureBytes, 64);

assert.deepEqual(
  calls.map((call) => call.command),
  [
    "lattice_ensure_carrier_key",
    "lattice_kv_set",
    "lattice_kv_set",
    "lattice_kv_set",
    "lattice_ensure_carrier_key",
    "lattice_kv_set",
    "lattice_kv_get",
    "lattice_sign_carrier",
    "lattice_trace_dev_event",
  ],
);
assert.equal(calls[5]?.args.key, `${TOWNSHIP_STORAGE_NAMESPACE}:native_probe`);
assert.equal(calls[5]?.args.value, "native invoke ready");
assert.equal(calls[7]?.args.bytes, bytesBase64(new TextEncoder().encode("township-native-probe")));
assert.equal(calls[8]?.args.event, "deep-link:township://pairing");

let transientTraceAttempts = 0;
await traceTownshipDevEvent("township-native-hydration-settled", {
  async invoke(command: string, args: Record<string, unknown>): Promise<unknown> {
    assert.equal(command, "lattice_trace_dev_event");
    assert.equal(args.event, "township-native-hydration-settled");
    transientTraceAttempts += 1;
    if (transientTraceAttempts === 1) throw new Error("transient trace write failure");
    return null;
  },
});
assert.equal(transientTraceAttempts, 2);

let persistentTraceAttempts = 0;
await assert.rejects(
  traceTownshipDevEvent("township-native-hydration-settled", {
    async invoke(): Promise<never> {
      persistentTraceAttempts += 1;
      throw new Error("persistent trace write failure");
    },
  }),
  /persistent trace write failure/,
);
assert.equal(persistentTraceAttempts, 3);

const unavailable = await loadTownshipNativeStatus({
  async invoke(command: string): Promise<never> {
    throw new Error(`no native runtime for ${command}`);
  },
});

assert.equal(unavailable.ready, false);
assert.equal(unavailable.keyId, TOWNSHIP_NATIVE_KEY_ID);
assert.equal(unavailable.storageNamespace, TOWNSHIP_STORAGE_NAMESPACE);
assert.match(unavailable.error, /no native runtime/);

console.log("\x1b[32m✓ native invoke workflow checks passed\x1b[0m");

function bytesBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
