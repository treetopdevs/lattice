import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.5: the six pinned application denials and the pre-judge's no-write guarantee. References: the Sim
// vectors for the three denials they pin at full frontier (treehouse_thread_archive: archived thread, wrong
// author, quarantined target; treehouse_thread_conflicts quarantines nothing), and lattice-client's judge
// for the three no vector pins (missing target, wrong target kind, already tombstoned). The expected words
// are 03's, written out here as literals.

const WORDING: Record<string, string> = {
  application_target_not_visible: "missing or not-causal target",
  application_target_quarantined: "quarantined target",
  application_wrong_target: "wrong target kind or thread",
  application_wrong_author: "wrong author",
  application_already_tombstoned: "already tombstoned",
  application_archived_thread: "archived thread",
};

test("each of the six pinned application denials maps to its reason", async () => {
  const { refusalCopy } = await import("../../src/ui/strings");
  const { createTreehouseSession } = await import("../../src/session/session");
  const { MemoryReplicaStore, MemoryReplicaDisk } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { MemoryRelayLink } = await import("../../src/session/memory/relay_link");
  const { quarantineReason } = await import("../../src/session/outcomes");
  const { loadTreehouseVector } = await import("../support/vectors");
  const { openPhone } = await import("../support/command_session");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { postAt, revokeThreadGrant } = await import("../support/authoring");

  const seen = new Map<string, string>();

  // Sim half: the reasons Sim pinned, as the session's audit view surfaces them, mapped to 03's words.
  for (const name of ["treehouse_thread_conflicts", "treehouse_thread_archive"]) {
    const vector = loadTreehouseVector(name);
    const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
    await store.open();
    await store.adopt(vector.replica, "Treehouse.Thread");
    await store.mergeSync(vector.replica, vector.frames, []);
    // A lone Sim Thread has no Space, which verify-on-open rightly refuses; only this read skips it.
    const session = createTreehouseSession({
    local: await (await import("../../src/local/local_store")).openMemoryLocalStore(),
      custody: new MemoryKeyCustody(),
      store,
      clock: new ManualClock(2_000),
      link: () => new MemoryRelayLink(),
      verify: async () => ({ ok: true }),
    });
    await session.open();
    try {
      const audit = session.read().audit.replicas.find((r) => r.replica === vector.replica)!;
      const surfaced = Object.fromEntries(audit.quarantined.map((q) => [q.id, q.reason]));
      assert.deepEqual(surfaced, vector.expected.quarantined, `${name}: the app's quarantine set equals Sim's`);
      for (const [id, raw] of Object.entries(vector.expected.quarantined)) {
        if (!raw.startsWith("application_")) continue;
        assert.equal(quarantineReason(surfaced[id]!), WORDING[raw], `${name} ${id}`);
        seen.set(raw, "sim");
      }
    } finally {
      await session.close();
    }
  }
  assert.deepEqual([...seen.keys()].sort(), ["application_archived_thread", "application_target_quarantined", "application_wrong_author"]);

  // Judge half: author each denial through the commands and read the refusal.
  const group = await buildGroup({ members: 2 });
  const [alice, bob] = [group.members[0]!, group.members[1]!];
  const base = group.thread.frames;
  const at = heads(base);
  const revoke = await revokeThreadGrant(group, alice, base, at);
  const quarantinedPost = await postAt(alice, base, "concurrent with the revoke", at);
  const bobPost = await bob.post(base, "bob's");
  const phone = await openPhone({ group, as: () => bob });
  try {
    const thread = group.thread.replica;
    await phone.deliver(thread, [revoke, quarantinedPost]);
    const unknown = "A".repeat(43);
    const title = base[1]!.id; // the create_thread op: visible and honored, but not a post
    const own = await phone.session.postMessage(thread, "to delete");
    assert.ok(own.ok);
    const deleted = await phone.session.deleteMessage(thread, { root: own.value.id, latest: own.value.id });
    assert.ok(deleted.ok);
    const cases: [string, () => Promise<unknown>][] = [
      ["application_target_not_visible", () => phone.session.editMessage(thread, { root: unknown, latest: unknown }, "x")],
      ["application_target_quarantined", () => phone.session.editMessage(thread, { root: quarantinedPost.id, latest: quarantinedPost.id }, "x")],
      ["application_wrong_target", () => phone.session.editMessage(thread, { root: title, latest: title }, "x")],
      ["application_already_tombstoned", () => phone.session.editMessage(thread, { root: own.value.id, latest: own.value.id }, "x")],
    ];
    for (const [raw, outcome] of cases) {
      assert.deepEqual(await outcome(), { ok: false, reason: WORDING[raw] }, raw);
      seen.set(raw, seen.get(raw) ?? "judge");
    }
  } finally {
    await phone.close();
  }
  const alicePhone = await openPhone({ group, as: () => alice });
  try {
    await alicePhone.deliver(group.thread.replica, [bobPost]);
    assert.deepEqual(await alicePhone.session.editMessage(group.thread.replica, { root: bobPost.id, latest: bobPost.id }, "x"), {
      ok: false,
      reason: "wrong author",
    });
  } finally {
    await alicePhone.close();
  }

  assert.deepEqual([...seen.keys()].sort(), Object.keys(WORDING).sort(), "all six covered");
  for (const raw of Object.keys(WORDING)) {
    const copy = refusalCopy[WORDING[raw] as keyof typeof refusalCopy];
    assert.ok(typeof copy === "string" && copy.length > 0, `${raw} has one line of copy`);
  }
});

test("a command refused at pre-judge leaves the outbox unchanged", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 2 });
  const theirs = await group.members[0]!.post(group.thread.frames, "theirs");
  const phone = await openPhone({ group, as: (g) => g.members[1]! });
  try {
    const thread = group.thread.replica;
    await phone.deliver(thread, [theirs]);
    const queued = await phone.session.postMessage(thread, "queued, not yet synced");
    assert.ok(queued.ok);
    const before = phone.threadProfile();
    assert.deepEqual(before.outbox, [queued.value.id]);
    const signs = phone.signs.count;
    const refused = await phone.session.deleteMessage(thread, { root: theirs.id, latest: theirs.id });
    assert.deepEqual(refused, { ok: false, reason: "wrong author" });
    assert.equal(phone.signs.count, signs + 1, "the candidate was signed, then refused by the pre-judge");
    assert.deepEqual(phone.threadProfile(), before, "frames and outbox are unchanged");
    assert.deepEqual(phone.session.read().timelines[thread]!.messages.filter((m) => m.mine).map((m) => m.id), [queued.value.id]);
  } finally {
    await phone.close();
  }
});
