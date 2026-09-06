import test from "node:test";
import assert from "node:assert/strict";
import { createReplicaSession } from "../src/replica-session.mjs";

function fixture({ save = async () => {}, load = async () => null } = {}) {
  let stopped = false, commands = [];
  const session = createReplicaSession({
    createVM: () => ({
      boot: async () => ({ ok: true }), deinit: () => { stopped = true; },
      genserver: { call: async (ingress, command) => {
        assert.equal(ingress, "Elixir.LatticeBrowser.Bridge");
        commands.push(command.command);
        return { ok: true, data: { ok: true, view: { public_key: "public", notes: [], op_ids: [] }, capsule: { seed: "private" } } };
      } }
    }),
    openSocket: () => { throw new Error("must_not_open_socket"); },
    store: { load, save }
  });
  return { session, stopped: () => stopped, commands };
}

test("a local write resolves only after durable storage commit and exposes no seed", async () => {
  let release, writes = 0;
  const f = fixture({ save: async () => {
    if (++writes > 1) await new Promise(resolve => { release = resolve; });
  } });
  try {
    const result = await f.session.start();
    assert.equal(result.seed, undefined);
    let resolved = false;
    const writing = f.session.post("note").then(() => { resolved = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(resolved, false);
    release(); await writing;
    assert.equal(resolved, true);
  } finally { f.session.close(); }
});

test("storage write failure terminates the VM and refuses further operations", async () => {
  let writes = 0;
  const f = fixture({ save: async () => { if (++writes > 1) throw new Error("quota_exceeded"); } });
  await f.session.start();
  await assert.rejects(f.session.post("note"), /quota_exceeded/);
  assert.equal(f.stopped(), true);
  await assert.rejects(f.session.post("another"), /replica_closed/);
});

test("storage read error never silently replaces an existing identity", async () => {
  const f = fixture({ load: async () => { throw new Error("storage_unavailable"); } });
  await assert.rejects(f.session.start(), /storage_unavailable/);
  assert.deepEqual(f.commands, []);
  await assert.rejects(f.session.start(), /replica_closed/);
});

test("heartbeat does not kill a healthy VM when the bounded work queue is full", async () => {
  let release, writes = 0;
  const f = fixture({ save: async () => {
    if (++writes === 2) await new Promise(resolve => { release = resolve; });
  } });
  await f.session.start();
  const tasks = Array.from({ length: 16 }, () => f.session.post("queued"));
  try {
    await assert.rejects(f.session.post("over capacity"), /replica_busy/);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(f.stopped(), false);
    release();
    await Promise.all(tasks);
  } finally { f.session.close(); }
});
