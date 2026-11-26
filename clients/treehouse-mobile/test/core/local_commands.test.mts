import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.5 local commands: setPetname, saveDraft, markRead. Device-local only: no op is signed, nothing is
// written to the replica store, and the read models that read local facts update.

test("local commands sign nothing, write no frame and update the read models", async () => {
  const { openMemoryLocalStore, MemoryLocalDisk } = await import("../../src/local/local_store");
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const theirs = await group.admin.post(group.thread.frames, "welcome");
  const disk = new MemoryLocalDisk();
  const phone = await openPhone({ group, as: (g) => g.members[0]!, local: await openMemoryLocalStore(disk) });
  try {
    const thread = group.thread.replica;
    await phone.deliver(thread, [theirs]);
    const before = phone.threadProfile();
    const signs = phone.signs.count;
    assert.equal(phone.session.read().timelines[thread]!.unreadCount, 1);

    assert.deepEqual(await phone.session.setPetname(group.admin.pubkey, "  Ada  "), { ok: true, value: null });
    const admin = phone.session.read().roster.members.find((m) => m.pubkey === group.admin.pubkey)!;
    assert.equal(admin.petname, "Ada", "the roster shows the trimmed petname");

    assert.deepEqual(await phone.session.saveDraft(thread, { text: "half a thought" }), { ok: true, value: null });
    assert.deepEqual(disk.snapshot.drafts[thread], { text: "half a thought" });

    assert.deepEqual(await phone.session.markRead(thread, [theirs.id]), { ok: true, value: null });
    assert.equal(phone.session.read().timelines[thread]!.unreadCount, 0);

    assert.equal(phone.signs.count, signs, "no signature");
    assert.deepEqual(phone.threadProfile(), before, "no frame, no outbox entry");
  } finally {
    await phone.close();
  }
});

test("a local write that fails is refused storage_failed", async () => {
  const { createCachedLocalStore } = await import("../../src/local/local_store");
  const { openPhone } = await import("../support/command_session");
  const failing = createCachedLocalStore(
    { petnames: {}, drafts: {}, read: {}, settings: {} },
    {
      putPetname: async () => Promise.reject(new Error("disk full")),
      putDraft: async () => Promise.reject(new Error("disk full")),
      addRead: async () => Promise.reject(new Error("disk full")),
      putSetting: async () => Promise.reject(new Error("disk full")),
    },
  );
  const phone = await openPhone({ local: failing });
  try {
    assert.deepEqual(await phone.session.setPetname(phone.group.members[0]!.pubkey, "Bo"), { ok: false, reason: "storage_failed" });
    assert.deepEqual(await phone.session.saveDraft(phone.group.thread.replica, { text: "x" }), { ok: false, reason: "storage_failed" });
    assert.deepEqual(await phone.session.markRead(phone.group.thread.replica, ["id"]), { ok: false, reason: "storage_failed" });
  } finally {
    await phone.close();
  }
});
