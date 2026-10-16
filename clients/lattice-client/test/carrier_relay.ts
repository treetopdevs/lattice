import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CarrierWebSocketClient,
  type CarrierOpFrame,
  type CarrierPushReport,
} from "../src/index";

interface CarrierVector {
  clientDivergedCarrierOps: CarrierOpFrame[];
}

const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(
  readFileSync(join(here, "vectors", "township_carrier_w1.json"), "utf8"),
) as CarrierVector;
const frame = vector.clientDivergedCarrierOps.at(-1);
if (!frame) throw new Error("missing carrier relay frame");

class ScriptedCarrierWebSocket {
  readonly sent: unknown[] = [];
  private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

  constructor(private readonly response: unknown) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as unknown);
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(this.response) }));
  }

  close(): void {
    this.emit("close");
  }

  addEventListener(type: "open", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void, options?: { once?: boolean }): void;
  addEventListener(type: "close", listener: () => void, options?: { once?: boolean }): void;
  addEventListener(type: string, listener: unknown): void {
    if (typeof listener !== "function") throw new Error("listener must be a function");
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener as (event?: unknown) => void);
    this.listeners.set(type, listeners);
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

console.log("\n▸ TypeScript one-op carrier relay");

const accepted: CarrierPushReport = {
  accepted: [frame.id],
  quarantined: [],
  rejected: [],
  pending: [],
};
const relaySocket = new ScriptedCarrierWebSocket({ type: "relay_result", ...accepted });
const relayClient = new CarrierWebSocketClient(relaySocket);

assert.deepEqual(await relayClient.relay(frame), accepted);
assert.deepEqual(relaySocket.sent, [{ type: "relay", op: frame }]);

const malformedClient = new CarrierWebSocketClient(
  new ScriptedCarrierWebSocket({
    type: "relay_result",
    accepted: "not-a-list",
    quarantined: [],
    rejected: [],
    pending: [],
  }),
);
await assert.rejects(() => malformedClient.relay(frame), /malformed carrier accepted list/);

const wrongTagClient = new CarrierWebSocketClient(
  new ScriptedCarrierWebSocket({ type: "push_result", ...accepted }),
);
await assert.rejects(() => wrongTagClient.relay(frame), /malformed carrier relay response/);

const refusedClient = new CarrierWebSocketClient(
  new ScriptedCarrierWebSocket({ type: "error", reason: "read_only" }),
);
await assert.rejects(() => refusedClient.relay(frame), /carrier peer error: read_only/);

// Plan 190: report reasons are the closed `WIRE_REPORT_REASONS` set on push and relay results.
const reasoned: CarrierPushReport = {
  accepted: [],
  quarantined: [[frame.id, "bad_signature"], [frame.id, "already_quarantined"]],
  rejected: [[frame.id, "wrong_replica"]],
  pending: [],
};
assert.deepEqual(
  await new CarrierWebSocketClient(new ScriptedCarrierWebSocket({ type: "relay_result", ...reasoned })).relay(frame),
  reasoned,
);
assert.deepEqual(
  await new CarrierWebSocketClient(new ScriptedCarrierWebSocket({ type: "push_result", ...reasoned })).push([frame]),
  reasoned,
);
for (const field of ["quarantined", "rejected"] as const) {
  // An authority verdict is an op-level quarantine reason, never a report reason.
  const offListReport = { ...accepted, [field]: [[frame.id, "invalid_transfer"]] };
  await assert.rejects(
    () => new CarrierWebSocketClient(new ScriptedCarrierWebSocket({ type: "relay_result", ...offListReport })).relay(frame),
    new RegExp(`malformed carrier ${field} pairs`),
  );
  await assert.rejects(
    () => new CarrierWebSocketClient(new ScriptedCarrierWebSocket({ type: "push_result", ...offListReport })).push([frame]),
    new RegExp(`malformed carrier ${field} pairs`),
  );
}
// State reports keep their own reason domain.
const stateReport = {
  type: "state_result",
  state_b64: "",
  op_ids: [frame.id],
  frontier: [frame.id],
  structural_quarantine: [],
  authority_quarantine: [[frame.id, "not_holder"], [frame.id, "revoked_capability"]],
  log_size: 1,
};
assert.deepEqual(
  (await new CarrierWebSocketClient(new ScriptedCarrierWebSocket(stateReport)).stateReport()).authority_quarantine,
  [[frame.id, "not_holder"], [frame.id, "revoked_capability"]],
);

const pushed: CarrierPushReport = {
  accepted: [frame.id],
  quarantined: [],
  rejected: [],
  pending: [],
};
const pushSocket = new ScriptedCarrierWebSocket({ type: "push_result", ...pushed });
const pushClient = new CarrierWebSocketClient(pushSocket);
assert.deepEqual(await pushClient.push([frame]), pushed);
assert.deepEqual(pushSocket.sent, [{ type: "push", ops: [frame] }]);

console.log("\x1b[32m✓ TypeScript carrier relay checks passed\x1b[0m");
