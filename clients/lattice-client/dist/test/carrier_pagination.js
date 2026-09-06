import assert from "node:assert/strict";
import { CarrierWebSocketClient } from "../src/index";
class ScriptedPageSocket {
    respond;
    sent = [];
    listeners = new Map();
    constructor(respond) {
        this.respond = respond;
    }
    send(data) {
        const request = JSON.parse(data);
        this.sent.push(request);
        queueMicrotask(() => this.emit("message", {
            data: JSON.stringify(this.respond(request, this.sent.length - 1)),
        }));
    }
    close() { this.emit("close"); }
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
const id = (index) => String(index).padStart(43, "0");
const snapshot = "a".repeat(64);
const haveDigest = "b".repeat(64);
const cursor = (offset) => ({
    version: 1, offset, after: id(offset), snapshot, have: haveDigest,
});
const socket = new ScriptedPageSocket((_request, index) => index === 0
    ? { type: "ops", ops: [{ id: id(1) }], next_cursor: cursor(1) }
    : { type: "ops", ops: [{ id: id(2) }] });
const client = new CarrierWebSocketClient(socket);
assert.deepEqual(await client.pull([]), [{ id: id(1) }, { id: id(2) }]);
assert.deepEqual(socket.sent, [
    { type: "pull", have: [] },
    { type: "pull", have: [], cursor: cursor(1) },
]);
client.close();
console.log("PASS carrier pagination consumes every page before success");
{
    const { have: _have, ...frontierCursor } = cursor(1);
    const socket = new ScriptedPageSocket((_request, index) => index === 0
        ? { type: "frontier_result", ids: [id(1)], next_cursor: frontierCursor }
        : { type: "frontier_result", ids: [id(2)] });
    const client = new CarrierWebSocketClient(socket);
    assert.deepEqual(await client.advertise(), [id(1), id(2)]);
    assert.deepEqual(socket.sent[1], { type: "frontier", cursor: frontierCursor });
    client.close();
}
for (const [name, reply, expected] of [
    ["empty continuation", { type: "ops", ops: [], next_cursor: cursor(1) }, /made no progress/],
    ["wrong offset", { type: "ops", ops: [{ id: id(1) }], next_cursor: cursor(2) }, /made no progress/],
    ["wrong last ID", { type: "ops", ops: [{ id: id(2) }], next_cursor: cursor(1) }, /made no progress/],
    ["null cursor", { type: "ops", ops: [{ id: id(1) }], next_cursor: null }, /malformed.*cursor/],
    ["extra cursor field", { type: "ops", ops: [{ id: id(1) }], next_cursor: { ...cursor(1), extra: true } }, /malformed.*cursor/],
    ["wrong cursor type", { type: "ops", ops: [{ id: id(1) }], next_cursor: { ...cursor(1), offset: "1" } }, /malformed.*cursor/],
    ["oversized cursor", { type: "ops", ops: [{ id: id(1) }], next_cursor: { ...cursor(1), snapshot: "s".repeat(513) } }, /malformed.*cursor/],
]) {
    const socket = new ScriptedPageSocket(() => reply);
    const client = new CarrierWebSocketClient(socket);
    await assert.rejects(client.pull([]), expected, name);
    assert.equal(socket.sent.length, 1, name);
    client.close();
}
for (const [name, second, expected] of [
    ["duplicate terminal page", { type: "ops", ops: [{ id: id(1) }] }, /made no progress/],
    ["changed snapshot", { type: "ops", ops: [{ id: id(2) }], next_cursor: { ...cursor(2), snapshot: "c".repeat(64) } }, /snapshot changed/],
    ["changed filter", { type: "ops", ops: [{ id: id(2) }], next_cursor: { ...cursor(2), have: "c".repeat(64) } }, /snapshot changed/],
    ["server snapshot refusal", { type: "error", reason: "stale_cursor" }, /peer error: stale_cursor/],
]) {
    const socket = new ScriptedPageSocket((_request, index) => index === 0
        ? { type: "ops", ops: [{ id: id(1) }], next_cursor: cursor(1) }
        : index === 1 ? second : { type: "ops", ops: [{ id: id(3) }] });
    const client = new CarrierWebSocketClient(socket);
    await assert.rejects(client.pull([]), expected, name);
    assert.deepEqual(await client.pull([]), [{ id: id(3) }], `${name} discards partial results`);
    assert.deepEqual(socket.sent[2], { type: "pull", have: [] });
    client.close();
}
{
    const socket = new ScriptedPageSocket((_request, index) => ({
        type: "ops", ops: [{ id: id(index + 1) }], next_cursor: cursor(index + 1),
    }));
    const client = new CarrierWebSocketClient(socket);
    await assert.rejects(client.pull([]), /pagination page limit exceeded/);
    assert.equal(socket.sent.length, 1_024);
    client.close();
}
{
    const socket = new ScriptedPageSocket(() => ({ type: "ops", ops: [] }));
    const client = new CarrierWebSocketClient(socket);
    assert.deepEqual(await client.pull(Array.from({ length: 2_000 }, (_value, index) => id(index))), []);
    assert.deepEqual(socket.sent[0], { type: "pull", have: [] });
    client.close();
}
{
    const socket = new ScriptedPageSocket(() => ({
        type: "ops", ops: [{ id: id(1), body: "x".repeat(64_000) }],
    }));
    const client = new CarrierWebSocketClient(socket);
    await assert.rejects(client.pull([]), /page exceeds frame budget/);
    client.close();
}
{
    const socket = new ScriptedPageSocket((request) => request.type === "pull"
        ? { type: "ops", ops: [{ id: "legacy-id" }] }
        : { type: "frontier_result", ids: ["z", "a"] });
    const client = new CarrierWebSocketClient(socket);
    assert.deepEqual(await client.pull([]), [{ id: "legacy-id" }]);
    assert.deepEqual(await client.advertise(), ["z", "a"]);
    client.close();
}
console.log("PASS carrier pagination bounds cursors, progress, requests, failures and legacy peers");
