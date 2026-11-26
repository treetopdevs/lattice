import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.5 editMessage. The reference is lattice-client's judge: the edit's target is read back from the
// signed frame, and the winning text from the timeline the judge's reducer produced. Modules load inside
// each test so a missing command fails its own named test.

test("edit replaces text; a second edit targets the latest edit in the lineage", async () => {
  const { openPhone, heldFrame, decoded } = await import("../support/command_session");
  const phone = await openPhone({ as: (g) => g.members[0]! });
  try {
    const thread = phone.group.thread.replica;
    const posted = await phone.session.postMessage(thread, "first draft");
    assert.ok(posted.ok);
    const root = posted.value.id;

    const first = await phone.session.editMessage(thread, { root, latest: root }, "second draft");
    assert.ok(first.ok, `first edit refused: ${JSON.stringify(first)}`);
    assert.deepEqual(decoded(heldFrame(phone, first.value.id)), { command: "author_edit", args: [root, root, "second draft"] });
    let message = phone.session.read().timelines[thread]!.messages.find((m) => m.id === root)!;
    assert.equal(message.text, "second draft");
    assert.equal(message.edited, true);
    assert.deepEqual(message.ref, { root, latest: first.value.id });

    // The caller's ref is stale (still names the root as latest); the command targets the held lineage's latest.
    const second = await phone.session.editMessage(thread, { root, latest: root }, "final");
    assert.ok(second.ok, `second edit refused: ${JSON.stringify(second)}`);
    assert.deepEqual(decoded(heldFrame(phone, second.value.id)), { command: "author_edit", args: [root, first.value.id, "final"] });
    message = phone.session.read().timelines[thread]!.messages.find((m) => m.id === root)!;
    assert.equal(message.text, "final");
    assert.deepEqual(message.ref, { root, latest: second.value.id });
    assert.equal(phone.session.read().audit.replicas.find((r) => r.replica === thread)!.quarantined.length, 0, "the judge counts both edits");
  } finally {
    await phone.close();
  }
});

test("edit by a non-author is refused wrong author and writes nothing", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 2 });
  const [alice, bob] = group.members as [typeof group.members[0], typeof group.members[0]];
  const post = await alice!.post(group.thread.frames, "alice's words");
  const phone = await openPhone({ group, as: () => bob! });
  try {
    await phone.deliver(group.thread.replica, [post]);
    const before = phone.threadProfile();
    const signsBefore = phone.signs.count;
    const edited = await phone.session.editMessage(group.thread.replica, { root: post.id, latest: post.id }, "bob's words");
    assert.deepEqual(edited, { ok: false, reason: "wrong author" });
    assert.equal(phone.signs.count, signsBefore + 1, "refused by the pre-judge, after authoring");
    assert.deepEqual(phone.threadProfile(), before, "nothing was written");
  } finally {
    await phone.close();
  }
});

test("edit text is checked before signing", async () => {
  const { openPhone } = await import("../support/command_session");
  const phone = await openPhone({ as: (g) => g.members[0]! });
  try {
    const thread = phone.group.thread.replica;
    const posted = await phone.session.postMessage(thread, "hello");
    assert.ok(posted.ok);
    const ref = { root: posted.value.id, latest: posted.value.id };
    const signs = phone.signs.count;
    assert.deepEqual(await phone.session.editMessage(thread, ref, "   "), { ok: false, reason: "empty_text" });
    assert.deepEqual(await phone.session.editMessage(thread, ref, "x".repeat(4_001)), { ok: false, reason: "text_too_long" });
    assert.deepEqual(await phone.session.editMessage(thread, ref, "bad \ud800"), { ok: false, reason: "malformed_text" });
    assert.equal(phone.signs.count, signs, "nothing was signed");
  } finally {
    await phone.close();
  }
});
