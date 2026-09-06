import assert from "node:assert/strict";
import "./carrier_pagination";
import { CarrierWebSocketClient, connectCarrierWebSocket } from "../src/index";
const serverNonce = Buffer.alloc(32, 7).toString("base64url");
class ManualCarrierWebSocket {
    sent = [];
    closed = false;
    sendFailure = null;
    listeners = new Map();
    send(data) {
        if (this.sendFailure) {
            const error = this.sendFailure;
            this.sendFailure = null;
            throw error;
        }
        this.sent.push(JSON.parse(data));
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.emit("close");
    }
    addEventListener(type, listener) {
        if (typeof listener !== "function")
            throw new Error("listener must be a function");
        const listeners = this.listeners.get(type) ?? [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }
    receive(envelope) {
        this.emit("message", { data: JSON.stringify(envelope) });
    }
    receiveRaw(data) {
        this.emit("message", { data });
    }
    open() {
        this.emit("open");
    }
    failNextSend(error) {
        this.sendFailure = error;
    }
    emit(type, event) {
        for (const listener of this.listeners.get(type) ?? [])
            listener(event);
    }
}
class BadHelloWebSocket extends ManualCarrierWebSocket {
    static instance = null;
    static lastInstance() {
        return BadHelloWebSocket.instance;
    }
    constructor(_url) {
        super();
        BadHelloWebSocket.instance = this;
        queueMicrotask(() => {
            this.open();
            this.receive({
                type: "carrier_nonce",
                nonce: serverNonce,
                wire_version: 1,
                session_version: 2,
            });
        });
    }
    send(data) {
        super.send(data);
        queueMicrotask(() => this.receive({
            type: "carrier_hello",
            realm: "town-node",
            pubkey: Buffer.alloc(32, 2).toString("base64"),
            signature: Buffer.alloc(64).toString("base64"),
        }));
    }
}
function nonceOnlyWebSocket(envelope) {
    let instance = null;
    return class extends ManualCarrierWebSocket {
        static lastInstance() {
            return instance;
        }
        constructor(_url) {
            super();
            instance = this;
            queueMicrotask(() => {
                this.open();
                this.receive(envelope);
            });
        }
    };
}
const BadWireNonceWebSocket = nonceOnlyWebSocket({
    type: "carrier_nonce",
    nonce: serverNonce,
    wire_version: 0,
    session_version: 2,
});
const BadSessionNonceWebSocket = nonceOnlyWebSocket({
    type: "carrier_nonce",
    nonce: serverNonce,
    wire_version: 1,
    session_version: 1,
});
console.log("\n▸ TypeScript carrier availability feed");
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    socket.receive({
        type: "ops_available",
        generation: 2,
        frontier: ["op-2"],
        frontier_truncated: false,
    });
    assert.equal(socket.closed, true, "an unreserved notification must fail the socket closed");
    await assert.rejects(() => client.advertise(), /carrier websocket closed/);
    assert.deepEqual(socket.sent, []);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const advertised = client.advertise();
    socket.receive({
        type: "ops_available",
        generation: 2,
        frontier: ["op-2"],
        frontier_truncated: false,
    });
    await assert.rejects(advertised, /unexpected carrier notification/);
    assert.equal(socket.closed, true);
    assert.deepEqual(socket.sent, [{ type: "frontier" }]);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    socket.receive({ type: "frontier_result", ids: [] });
    assert.equal(socket.closed, true, "an unsolicited response must fail the socket closed");
    await assert.rejects(() => client.advertise(), /carrier websocket closed/);
    assert.deepEqual(socket.sent, []);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const advertised = client.advertise();
    const concurrentStatus = client.status();
    assert.deepEqual(socket.sent, [{ type: "frontier" }], "only one atomic request may be sent");
    socket.receive({ type: "frontier_result", ids: ["op-1"] });
    assert.deepEqual(await advertised, ["op-1"]);
    await assert.rejects(concurrentStatus, /carrier request already in flight/);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    socket.failNextSend(new Error("scripted send failure"));
    await assert.rejects(() => client.advertise(), /scripted send failure/);
    const status = client.status();
    socket.receive({ type: "status_result", phase: "ready" });
    assert.equal(await withTimeout(status, 100), "ready");
    assert.deepEqual(socket.sent, [{ type: "status" }]);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscribing = client.subscribeAvailability();
    assert.deepEqual(socket.sent, [{ type: "subscribe" }]);
    socket.receive({
        type: "ops_available",
        generation: 2,
        frontier: ["op-2"],
        frontier_truncated: false,
    });
    socket.receive({
        type: "subscribe_result",
        generation: 1,
        frontier: ["op-1"],
        frontier_truncated: false,
    });
    const subscription = await subscribing;
    assert.deepEqual(subscription.baseline, {
        generation: 1,
        frontier: ["op-1"],
        frontierTruncated: false,
    });
    assert.deepEqual(await subscription.next(), {
        generation: 2,
        frontier: ["op-2"],
        frontierTruncated: false,
    });
    assert.equal(socket.closed, false);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscribing = client.subscribeAvailability();
    socket.receive({
        type: "subscribe_result",
        generation: 1,
        frontier: ["op-1"],
        frontier_truncated: false,
    });
    const subscription = await subscribing;
    const next = subscription.next();
    socket.close();
    await assert.rejects(withTimeout(next, 100), /carrier websocket closed/);
    await assert.rejects(subscription.next(), /carrier websocket closed/);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const advertised = client.advertise();
    assert.doesNotThrow(() => socket.receiveRaw("{"));
    await assert.rejects(advertised, /malformed carrier envelope/);
    assert.equal(socket.closed, true);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscribing = client.subscribeAvailability();
    socket.receive({
        type: "subscribe_result",
        generation: 1,
        frontier: ["op-1"],
        frontier_truncated: false,
    });
    const subscription = await subscribing;
    const next = subscription.next();
    const advertised = client.advertise();
    socket.receive({
        type: "ops_available",
        generation: "two",
        frontier: ["op-2"],
        frontier_truncated: false,
    });
    await assert.rejects(advertised, /malformed carrier ops_available generation/);
    await assert.rejects(next, /malformed carrier ops_available generation/);
    assert.equal(socket.closed, true);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscribing = client.subscribeAvailability();
    socket.receive({
        type: "subscribe_result",
        generation: "one",
        frontier: ["op-1"],
        frontier_truncated: false,
    });
    await assert.rejects(subscribing, /malformed carrier subscribe_result generation/);
    assert.equal(socket.closed, true, "a malformed subscription baseline must fail closed");
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscription = await establishSubscription(client, socket, 1);
    for (const generation of [2, 3, 3, 4]) {
        socket.receive({
            type: "ops_available",
            generation,
            frontier: [`op-${generation}`],
            frontier_truncated: false,
        });
    }
    assert.deepEqual(await subscription.next(), {
        generation: 4,
        frontier: ["op-4"],
        frontierTruncated: false,
    });
    const next = subscription.next();
    socket.receive({
        type: "ops_available",
        generation: 3,
        frontier: ["op-3"],
        frontier_truncated: false,
    });
    await assert.rejects(next, /carrier availability generation regressed/);
    assert.equal(socket.closed, true);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscription = await establishSubscription(client, socket, 1);
    const first = subscription.next();
    await assert.rejects(subscription.next(), /carrier availability receive already in flight/);
    await assert.rejects(client.subscribeAvailability(), /carrier availability subscription already active/);
    socket.receive({
        type: "ops_available",
        generation: 2,
        frontier: ["op-2"],
        frontier_truncated: false,
    });
    assert.equal((await first).generation, 2);
    client.close();
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscription = await establishSubscription(client, socket, 1);
    const next = subscription.next();
    const unsubscribed = subscription.unsubscribe();
    assert.deepEqual(socket.sent, [{ type: "subscribe" }, { type: "unsubscribe" }]);
    socket.receive({
        type: "ops_available",
        generation: 2,
        frontier: ["op-2"],
        frontier_truncated: false,
    });
    assert.equal((await next).generation, 2);
    socket.receive({ type: "unsubscribe_result" });
    await unsubscribed;
    await subscription.unsubscribe();
    await assert.rejects(subscription.next(), /carrier availability subscription closed/);
    assert.deepEqual(socket.sent, [{ type: "subscribe" }, { type: "unsubscribe" }]);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscription = await establishSubscription(client, socket, 1);
    const next = subscription.next();
    const unsubscribed = subscription.unsubscribe();
    socket.receive({ type: "frontier_result", ids: [] });
    await assert.rejects(unsubscribed, /malformed carrier unsubscribe response/);
    assert.equal(socket.closed, true, "a malformed unsubscribe reply must fail closed");
    await assert.rejects(next, /malformed carrier unsubscribe response/);
    await assert.rejects(subscription.next(), /malformed carrier unsubscribe response/);
}
{
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscription = await establishSubscription(client, socket, 1);
    const next = subscription.next();
    const advertised = client.advertise();
    let advertisedSettled = false;
    void advertised.then(() => {
        advertisedSettled = true;
    }, () => {
        advertisedSettled = true;
    });
    socket.receive({
        type: "ops_available",
        generation: 2,
        frontier: ["op-2"],
        frontier_truncated: false,
    });
    assert.equal((await next).generation, 2);
    await Promise.resolve();
    assert.equal(advertisedSettled, false, "a valid hint must not settle the pending request");
    socket.receive({ type: "frontier_result", ids: ["op-1", "op-2"] });
    assert.deepEqual(await advertised, ["op-1", "op-2"]);
    client.close();
}
for (const [envelope, error] of [
    [
        {
            type: "ops_available",
            generation: 2,
            frontier: Array.from({ length: 65 }, (_, index) => `op-${index}`),
            frontier_truncated: true,
        },
        /malformed carrier ops_available frontier/,
    ],
    [
        {
            type: "ops_available",
            generation: 2,
            frontier: [1],
            frontier_truncated: false,
        },
        /malformed carrier ops_available frontier/,
    ],
    [
        {
            type: "ops_available",
            generation: 2,
            frontier: ["op-2"],
            frontier_truncated: "no",
        },
        /malformed carrier ops_available frontier_truncated/,
    ],
]) {
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscription = await establishSubscription(client, socket, 1);
    const next = subscription.next();
    socket.receive(envelope);
    await assert.rejects(next, error);
    assert.equal(socket.closed, true);
}
for (const [envelope, error] of [
    [
        {
            type: "subscribe_result",
            generation: 1,
            frontier: Array.from({ length: 65 }, (_, index) => `op-${index}`),
            frontier_truncated: true,
        },
        /malformed carrier subscribe_result frontier/,
    ],
    [
        {
            type: "subscribe_result",
            generation: 1,
            frontier: ["op-1"],
            frontier_truncated: "no",
        },
        /malformed carrier subscribe_result frontier_truncated/,
    ],
]) {
    const socket = new ManualCarrierWebSocket();
    const client = new CarrierWebSocketClient(socket);
    const subscribing = client.subscribeAvailability();
    socket.receive(envelope);
    await assert.rejects(subscribing, error);
    assert.equal(socket.closed, true);
}
{
    BadHelloWebSocket.instance = null;
    await assert.rejects(() => connectCarrierWebSocket({
        url: "ws://carrier.test/carrier",
        localRealm: "resident",
        replica: "replica:test",
        signer: {
            publicKey: new Uint8Array(32).fill(1),
            sign: () => new Uint8Array(64),
        },
        expectedPeerRealm: "town-node",
        expectedPeerPubkey: new Uint8Array(32).fill(2),
        verifier: { verify: () => false },
        webSocket: BadHelloWebSocket,
    }), /carrier hello bad signature/);
    const socket = BadHelloWebSocket.lastInstance();
    assert.ok(socket);
    assert.equal(socket.closed, true, "a failed carrier handshake must close its socket");
    assert.deepEqual(socket.sent, [
        {
            type: "carrier_challenge",
            local_realm: "resident",
            replica: "replica:test",
            nonce: socket.sent[0].nonce,
            server_nonce: serverNonce,
            wire_version: 1,
            session_version: 2,
            pubkey: Buffer.alloc(32, 1).toString("base64"),
            signature: Buffer.alloc(64).toString("base64"),
        },
    ]);
}
for (const [WebSocketImpl, error] of [
    [BadWireNonceWebSocket, /unsupported carrier operation wire version/],
    [BadSessionNonceWebSocket, /unsupported carrier session version/],
]) {
    await assert.rejects(() => connectCarrierWebSocket({
        url: "ws://carrier.test/carrier",
        localRealm: "resident",
        replica: "replica:test",
        signer: {
            publicKey: new Uint8Array(32).fill(1),
            sign: () => new Uint8Array(64),
        },
        expectedPeerRealm: "town-node",
        expectedPeerPubkey: new Uint8Array(32).fill(2),
        verifier: { verify: () => true },
        webSocket: WebSocketImpl,
    }), error);
    const socket = WebSocketImpl.lastInstance();
    assert.ok(socket);
    assert.equal(socket.closed, true, "a rejected carrier nonce must close its socket");
    assert.deepEqual(socket.sent, []);
}
console.log("\x1b[32m✓ TypeScript carrier availability feed checks passed\x1b[0m");
async function establishSubscription(client, socket, generation) {
    const subscribing = client.subscribeAvailability();
    socket.receive({
        type: "subscribe_result",
        generation,
        frontier: [`op-${generation}`],
        frontier_truncated: false,
    });
    return subscribing;
}
function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
        promise.then((value) => {
            clearTimeout(timeout);
            resolve(value);
        }, (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });
}
