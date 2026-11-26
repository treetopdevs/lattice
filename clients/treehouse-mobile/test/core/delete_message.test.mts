import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.5 deleteMessage (author_tombstone). The reference is lattice-client's judge through the session's
// timeline and audit view; refusal reasons are 03's wording of the judge's pinned denials.

test("delete is irreversible: a later edit is refused already tombstoned", async () => {
  const { openPhone, heldFrame, decoded } = await import("../support/command_session");
  const phone = await openPhone({ as: (g) => g.members[0]! });
  try {
    const thread = phone.group.thread.replica;
    const posted = await phone.session.postMessage(thread, "regret");
    assert.ok(posted.ok);
    const root = posted.value.id;
    const edited = await phone.session.editMessage(thread, { root, latest: root }, "more regret");
    assert.ok(edited.ok);

    const deleted = await phone.session.deleteMessage(thread, { root, latest: root });
    assert.ok(deleted.ok, `delete refused: ${JSON.stringify(deleted)}`);
    // The tombstone targets the lineage's latest edit, read from the held frames, not the caller's ref.
    assert.deepEqual(decoded(heldFrame(phone, deleted.value.id)), { command: "author_tombstone", args: [root, edited.value.id] });
    const message = phone.session.read().timelines[thread]!.messages.find((m) => m.id === root)!;
    assert.equal(message.removed, "by_author");
    assert.equal(message.text, "");

    const before = phone.threadProfile();
    assert.deepEqual(await phone.session.editMessage(thread, { root, latest: edited.value.id }, "undo"), {
      ok: false,
      reason: "already tombstoned",
    });
    assert.deepEqual(await phone.session.deleteMessage(thread, { root, latest: root }), { ok: false, reason: "already tombstoned" });
    assert.deepEqual(phone.threadProfile(), before, "refusals wrote nothing");
  } finally {
    await phone.close();
  }
});

test("delete by a non-author is refused wrong author", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 2 });
  const post = await group.members[0]!.post(group.thread.frames, "mine");
  const phone = await openPhone({ group, as: (g) => g.members[1]! });
  try {
    await phone.deliver(group.thread.replica, [post]);
    const before = phone.threadProfile();
    assert.deepEqual(await phone.session.deleteMessage(group.thread.replica, { root: post.id, latest: post.id }), {
      ok: false,
      reason: "wrong author",
    });
    assert.deepEqual(phone.threadProfile(), before);
  } finally {
    await phone.close();
  }
});
