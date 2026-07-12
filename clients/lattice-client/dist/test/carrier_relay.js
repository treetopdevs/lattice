import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CarrierWebSocketClient, } from "../src/index";
const here = dirname(fileURLToPath(import.meta.url));
const vector = JSON.parse(readFileSync(join(here, "vectors", "township_carrier_w1.json"), "utf8"));
const frame = vector.clientDivergedCarrierOps.at(-1);
if (!frame)
    throw new Error("missing carrier relay frame");
class ScriptedCarrierWebSocket {
    response;
    sent = [];
    listeners = new Map();
    constructor(response) {
        this.response = response;
    }
    send(data) {
        this.sent.push(JSON.parse(data));
        queueMicrotask(() => this.emit("message", { data: JSON.stringify(this.response) }));
    }
    close() {
        this.emit("close");
    }
    addEventListener(type, listener) {
        if (typeof listener !== "function")
            throw new Error("listener must be a function");
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    emit(type, event) {
        for (const listener of this.listeners.get(type) ?? [])
            listener(event);
    }
}
console.log("\n▸ TypeScript one-op carrier relay");
const accepted = {
    accepted: [frame.id],
    quarantined: [],
    rejected: [],
    pending: [],
};
const relaySocket = new ScriptedCarrierWebSocket({ type: "relay_result", ...accepted });
const relayClient = new CarrierWebSocketClient(relaySocket);
assert.deepEqual(await relayClient.relay(frame), accepted);
assert.deepEqual(relaySocket.sent, [{ type: "relay", op: frame }]);
const malformedClient = new CarrierWebSocketClient(new ScriptedCarrierWebSocket({
    type: "relay_result",
    accepted: "not-a-list",
    quarantined: [],
    rejected: [],
    pending: [],
}));
await assert.rejects(() => malformedClient.relay(frame), /malformed carrier accepted list/);
const wrongTagClient = new CarrierWebSocketClient(new ScriptedCarrierWebSocket({ type: "push_result", ...accepted }));
await assert.rejects(() => wrongTagClient.relay(frame), /malformed carrier relay response/);
const refusedClient = new CarrierWebSocketClient(new ScriptedCarrierWebSocket({ type: "error", reason: "read_only" }));
await assert.rejects(() => refusedClient.relay(frame), /carrier peer error: read_only/);
const pushed = {
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
