import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.5 archiveThread. After an honored archive_thread the judge refuses post, author edit and author
// delete (application_archived_thread) but still honors a moderator remove.

test("archive denies post, edit and delete afterwards with archived thread", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const memberPost = await member.post(group.thread.frames, "before the archive");
  const other = await member.post([...group.thread.frames, memberPost], "a second one");

  // A member cannot archive: the command needs the moderator role.
  const memberPhone = await openPhone({ group, as: () => member });
  try {
    await memberPhone.deliver(group.thread.replica, [memberPost, other]);
    assert.deepEqual(await memberPhone.session.archiveThread(group.thread.replica), { ok: false, reason: "no_capability" });
  } finally {
    await memberPhone.close();
  }

  const admin = await openPhone({ group, as: (g) => g.admin });
  let archive: string;
  try {
    await admin.deliver(group.thread.replica, [memberPost, other]);
    const archived = await admin.session.archiveThread(group.thread.replica);
    assert.ok(archived.ok, `archive refused: ${JSON.stringify(archived)}`);
    archive = archived.value.id;
    assert.equal(admin.session.read().timelines[group.thread.replica]!.archived, true);
    // The moderator can still remove after the archive.
    const removed = await admin.session.removeMessage(group.thread.replica, { root: other.id, latest: other.id });
    assert.ok(removed.ok, `remove after archive refused: ${JSON.stringify(removed)}`);
  } finally {
    await admin.close();
  }

  const archiveFrame = admin.threadProfile().frames.find((f) => f.id === archive)!;
  const phone = await openPhone({ group, as: () => member });
  try {
    const thread = group.thread.replica;
    await phone.deliver(thread, [memberPost, other, archiveFrame]);
    const before = phone.threadProfile();
    const ref = { root: memberPost.id, latest: memberPost.id };
    assert.deepEqual(await phone.session.postMessage(thread, "after"), { ok: false, reason: "archived thread" });
    assert.deepEqual(await phone.session.editMessage(thread, ref, "changed"), { ok: false, reason: "archived thread" });
    assert.deepEqual(await phone.session.deleteMessage(thread, ref), { ok: false, reason: "archived thread" });
    assert.deepEqual(phone.threadProfile(), before, "nothing was written");
  } finally {
    await phone.close();
  }
});
