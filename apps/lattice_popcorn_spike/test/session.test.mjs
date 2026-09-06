import test from "node:test";
import assert from "node:assert/strict";
import { createSession } from "../src/session.mjs";

function fixture({ failCall = false, failBoot = false } = {}) {
  const calls = [], frames = [];
  let stopped = 0, options;
  class Socket extends EventTarget {
    readyState = 0;
    bufferedAmount = 0;
    close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    send(text) { frames.push(JSON.parse(text)); }
  }
  const socket = new Socket();
  const vm = {
    boot: async () => ({ ok: !failBoot }), deinit: () => stopped++,
    genserver: { call: async (...args) => {
      calls.push(args);
      if (failCall) return { ok: false, error: { t: "timeout:call" } };
      return { ok: true, data: { ok: true, envelope: { type: args[1].command } } };
    } }
  };
  const session = createSession({
    createVM: opts => { options = opts; return vm; },
    openSocket: () => { setTimeout(() => { socket.readyState = 1; socket.dispatchEvent(new Event("open")); }, 0); return socket; },
    heartbeatMs: 100000
  });
  return { session, socket, calls, frames, stopped: () => stopped, fail: () => options.onError({ kind: "exit" }) };
}

test("all calls use one fixed ingress and the public facade has no generic VM access", async () => {
  const f = fixture();
  await f.session.connect();
  await f.session.invoke("cap", "hello");
  await f.session.disconnect();
  assert.deepEqual(Object.keys(f.session).sort(), ["connect", "disconnect", "invoke", "requestCapability", "status"]);
  assert(f.calls.every(([target]) => target === "Elixir.LatticeBrowser.Bridge"));
  assert.equal(f.stopped(), 1);
  assert.equal(f.socket.readyState, 3);
});

test("timeout fails closed without retrying potentially executed work", async () => {
  const f = fixture({ failCall: true });
  await assert.rejects(f.session.connect(), /timeout:call/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.frames.length, 0);
  assert.equal(f.socket.readyState, 3);
  assert.equal(f.stopped(), 1);
});

test("VM failure and socket loss both clean up once", async () => {
  for (const cause of [f => f.fail(), f => f.socket.close()]) {
    const f = fixture();
    await f.session.connect();
    cause(f);
    await assert.rejects(f.session.status(), /session_closed/);
    await f.session.disconnect();
    assert.equal(f.stopped(), 1);
    assert.equal(f.socket.readyState, 3);
  }
});

test("boot failure deinitializes and never opens a socket", async () => {
  const f = fixture({ failBoot: true });
  await assert.rejects(f.session.connect(), /vm_boot_failed/);
  assert.equal(f.socket.readyState, 0);
  assert.equal(f.stopped(), 1);
});

test("malformed and oversized incoming frames close the session", async () => {
  for (const data of ["{", "x".repeat(65537), JSON.stringify({ type: "presence", data: "😀".repeat(20000) }), new ArrayBuffer(2)]) {
    const f = fixture();
    await f.session.connect();
    f.socket.dispatchEvent(new MessageEvent("message", { data }));
    assert.equal(f.socket.readyState, 3);
    assert.equal(f.stopped(), 1);
  }
});
