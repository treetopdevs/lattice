import assert from "node:assert/strict";
import { test } from "node:test";

// M1a.5 removeMessage (moderator_tombstone). Holder-gated: a key needs a live delegation carrying the
// moderator role and must be the judge's current moderator holder. The role transfer is authored with
// lattice-client's own helper; the judge decides who holds it.

test("moderator remove needs the moderator holder", async () => {
  const { authorTreehouseRoleTransfer, carrierDelegationsFromFrames } = await import("@treetopdevs/lattice-client");
  const { openPhone, heldFrame, decoded } = await import("../support/command_session");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 2 });
  const [alice, bob] = [group.members[0]!, group.members[1]!];
  const post = await alice.post(group.thread.frames, "spam");
  const withPost = [...group.thread.frames, post];

  // A member without the moderator role cannot remove: no capability carries it.
  const bobPhone = await openPhone({ group, as: () => bob });
  try {
    await bobPhone.deliver(group.thread.replica, [post]);
    const before = bobPhone.threadProfile();
    const signs = bobPhone.signs.count;
    assert.deepEqual(await bobPhone.session.removeMessage(group.thread.replica, { root: post.id, latest: post.id }), {
      ok: false,
      reason: "no_capability",
    });
    assert.equal(bobPhone.signs.count, signs, "refused before signing");
    assert.deepEqual(bobPhone.threadProfile(), before);
  } finally {
    await bobPhone.close();
  }

  // The admin holds the Thread's moderator role from genesis: the remove counts.
  const adminPhone = await openPhone({ group, as: (g) => g.admin });
  try {
    await adminPhone.deliver(group.thread.replica, [post]);
    const removed = await adminPhone.session.removeMessage(group.thread.replica, { root: post.id, latest: post.id });
    assert.ok(removed.ok, `remove refused: ${JSON.stringify(removed)}`);
    assert.deepEqual(decoded(heldFrame(adminPhone, removed.value.id)), { command: "moderator_tombstone", args: [post.id, post.id] });
    assert.equal(adminPhone.session.read().timelines[group.thread.replica]!.messages.find((m) => m.id === post.id)!.removed, "by_moderator");
  } finally {
    await adminPhone.close();
  }

  // After the admin hands the moderator role to bob, the admin's genesis delegation is still live but the
  // admin is no longer the holder: the judge refuses it as not_holder, and bob can remove.
  const genesis = carrierDelegationsFromFrames([group.thread.frames[0]!])[0]!;
  const transfer = await authorTreehouseRoleTransfer({
    replica: group.thread.replica,
    deps: heads(withPost),
    signer: group.admin.signer,
    parent: genesis,
    recipient: bob.pubkey,
    action: "change_moderator",
  });
  const second = await alice.post([...withPost, transfer.frame], "more spam");
  const afterTransfer = [post, transfer.frame, second];

  const formerPhone = await openPhone({ group, as: (g) => g.admin });
  try {
    await formerPhone.deliver(group.thread.replica, afterTransfer);
    const before = formerPhone.threadProfile();
    assert.deepEqual(await formerPhone.session.removeMessage(group.thread.replica, { root: second.id, latest: second.id }), {
      ok: false,
      reason: "not_holder",
    });
    assert.deepEqual(formerPhone.threadProfile(), before, "nothing was written");
  } finally {
    await formerPhone.close();
  }

  const holderPhone = await openPhone({ group, as: () => bob });
  try {
    await holderPhone.deliver(group.thread.replica, afterTransfer);
    const removed = await holderPhone.session.removeMessage(group.thread.replica, { root: second.id, latest: second.id });
    assert.ok(removed.ok, `the new holder's remove was refused: ${JSON.stringify(removed)}`);
  } finally {
    await holderPhone.close();
  }
});
