import assert from "node:assert/strict";
import { test } from "node:test";

// M1b.3 Edit and delete (04 "Long-press sheet"). Which items the sheet offers comes from the Abilities read
// model (the judge's per-command answer: author_edit, author_tombstone, moderator_tombstone) and the message's
// own facts from ThreadTimeline (mine, standing, removed). The reference is the session over a Group built by
// lattice-client's helpers, so the judge, not the app, decides; src/ui/message_sheet.ts only combines them.

type Message = import("../../src/session/projections/thread_timeline").MessageView;

const itemsFor = async (phone: import("../support/command_session").CommandPhone, id: string) => {
  const { sheetFor } = await import("../../src/ui/message_sheet");
  const models = phone.session.read();
  const thread = phone.group.thread.replica;
  return sheetFor(models.timelines[thread] ?? null, models.abilities.replicas[thread], id)?.items ?? [];
};

test("the sheet offers Edit and Delete on my message, nothing on another member's, Remove to the moderator", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 2 });
  const [alice, bob] = [group.members[0]!, group.members[1]!];
  const theirs = await bob.post(group.thread.frames, "from bob");

  const alicePhone = await openPhone({ group, as: () => alice });
  try {
    await alicePhone.deliver(group.thread.replica, [theirs]);
    const mine = await alicePhone.session.postMessage(group.thread.replica, "from alice");
    assert.ok(mine.ok);
    assert.deepEqual(await itemsFor(alicePhone, mine.value.id), ["copy", "edit", "delete"]);
    assert.deepEqual(await itemsFor(alicePhone, theirs.id), ["copy"], "a member cannot change another member's message, only copy it");
    assert.deepEqual(await itemsFor(alicePhone, "no-such-id"), [], "an unknown message offers nothing");

    // Edited: still mine and honored, so both stay.
    const edited = await alicePhone.session.editMessage(group.thread.replica, { root: mine.value.id, latest: mine.value.id }, "from alice, again");
    assert.ok(edited.ok);
    assert.deepEqual(await itemsFor(alicePhone, mine.value.id), ["copy", "edit", "delete"]);

    // Deleted: a placeholder offers nothing (the judge would refuse already tombstoned).
    const deleted = await alicePhone.session.deleteMessage(group.thread.replica, { root: mine.value.id, latest: edited.value.id });
    assert.ok(deleted.ok);
    assert.deepEqual(await itemsFor(alicePhone, mine.value.id), []);
  } finally {
    await alicePhone.close();
  }

  // The admin holds the Thread's moderator role from genesis.
  const adminPhone = await openPhone({ group, as: (g) => g.admin });
  try {
    await adminPhone.deliver(group.thread.replica, [theirs]);
    assert.deepEqual(await itemsFor(adminPhone, theirs.id), ["copy", "remove"]);
  } finally {
    await adminPhone.close();
  }
});

test("an archived thread offers no Edit or Delete, and the moderator keeps Remove", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const memberPost = await member.post(group.thread.frames, "before the archive");

  const admin = await openPhone({ group, as: (g) => g.admin });
  let archiveFrame;
  try {
    await admin.deliver(group.thread.replica, [memberPost]);
    const archived = await admin.session.archiveThread(group.thread.replica);
    assert.ok(archived.ok);
    archiveFrame = admin.threadProfile().frames.find((f) => f.id === archived.value.id)!;
    assert.deepEqual(await itemsFor(admin, memberPost.id), ["copy", "remove"], "the judge still honors a moderator remove");
  } finally {
    await admin.close();
  }

  const phone = await openPhone({ group, as: () => member });
  try {
    await phone.deliver(group.thread.replica, [memberPost, archiveFrame]);
    assert.equal(phone.session.read().timelines[group.thread.replica]!.archived, true);
    assert.deepEqual(await itemsFor(phone, memberPost.id), ["copy"], "archived: my message can no longer be changed, only copied");
  } finally {
    await phone.close();
  }
});

test("a not-counted message of mine offers only Copy, no Edit or Delete, even when the commands are allowed", async () => {
  const { sheetItems } = await import("../../src/ui/message_sheet");
  const allowed = { allowed: true } as const;
  const abilities = { author_edit: allowed, author_tombstone: allowed, moderator_tombstone: allowed };
  const base: Message = {
    id: "m",
    ref: { root: "m", latest: "m" },
    author: "me",
    text: "hi",
    edited: false,
    removed: null,
    mine: true,
    delivery: "saved",
    standing: "honored",
    notCountedReason: null,
    firstSeenMs: null,
    unread: false,
    arrivedLate: false,
  };
  assert.deepEqual(sheetItems(base, abilities), ["copy", "edit", "delete"], "a moderator's own message is deleted, not removed");
  assert.deepEqual(sheetItems({ ...base, standing: "not_counted", notCountedReason: "revoked_capability" }, abilities), ["copy"]);
  assert.deepEqual(sheetItems({ ...base, mine: false, author: "k1", delivery: null }, abilities), ["copy", "remove"]);
  assert.deepEqual(sheetItems({ ...base, mine: false, author: "k1", delivery: null, removed: "by_author" }, abilities), []);
  assert.deepEqual(sheetItems(base, undefined), ["copy"], "no abilities known: only Copy");
});

test("delete and remove confirm with 04's sentence; edit needs no confirmation", async () => {
  const { confirmationFor, sheetItemLabel } = await import("../../src/ui/message_sheet");
  const { actions } = await import("../../src/ui/strings");
  assert.equal(confirmationFor("edit"), null);
  assert.deepEqual(confirmationFor("delete"), { sentence: actions.confirmDelete, confirm: actions.delete });
  assert.deepEqual(confirmationFor("remove"), { sentence: actions.confirmRemove, confirm: actions.removeConfirm });
  assert.match(actions.confirmDelete, /can't be undone/);
  assert.deepEqual(sheetItemLabel, { copy: actions.copy, edit: actions.edit, delete: actions.delete, remove: actions.remove });
});

test("the sheet follows the live timeline: it closes when its message is deleted elsewhere", async () => {
  const { sheetFor } = await import("../../src/ui/message_sheet");
  const allowed = { allowed: true } as const;
  const abilities = { author_edit: allowed, author_tombstone: allowed, moderator_tombstone: { allowed: false, reason: "no_capability" } as const };
  const m: Message = {
    id: "m",
    ref: { root: "m", latest: "m2" },
    author: "me",
    text: "now",
    edited: true,
    removed: null,
    mine: true,
    delivery: "on_relay",
    standing: "honored",
    notCountedReason: null,
    firstSeenMs: null,
    unread: false,
    arrivedLate: false,
  };
  const timeline = (messages: Message[]) => ({
    replica: "r",
    title: "General",
    archived: false,
    messages,
    canPost: true,
    postRefusal: null,
    unreadCount: 0,
    unmarked: [],
    health: { ops: 0, bytes: 0, messages: 0, opsLimit: 4000, bytesLimit: 8 * 1024 * 1024 },
  });
  const open = sheetFor(timeline([m]), abilities, "m");
  assert.deepEqual(open, { message: m, items: ["copy", "edit", "delete"] }, "the message is read from the current timeline, with its latest ref");
  assert.equal(sheetFor(timeline([{ ...m, removed: "by_author", text: "" }]), abilities, "m"), null);
  assert.equal(sheetFor(null, abilities, "m"), null);
});

test("editing in the composer never touches the saved draft, whether the edit is saved or cancelled", async () => {
  const { createDraftSaver } = await import("../../src/ui/thread_view");
  const { beginEdit, composerChange, composerText, endEdit, canSaveEdit } = await import("../../src/ui/message_sheet");
  const saved: (string | null)[] = [];
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers = {
    set: (fn: () => void) => (pending.set(++next, fn), next),
    clear: (handle: unknown) => void pending.delete(handle as number),
  };
  const fire = () => {
    const fns = [...pending.values()];
    pending.clear();
    for (const fn of fns) fn();
  };
  const saver = createDraftSaver({ save: async (text) => void saved.push(text), delayMs: 400, timers });
  const target = { id: "m", ref: { root: "m", latest: "m" }, text: "original" };

  let state = composerChange({ draft: "", edit: null }, "half a draft", saver);
  assert.equal(composerText(state), "half a draft");
  state = await beginEdit(state, target, saver);
  assert.deepEqual(saved, ["half a draft"], "entering edit mode saves the pending draft at once");
  assert.equal(composerText(state), "original", "the composer shows the message's text");
  assert.equal(canSaveEdit(state, false), false, "unchanged text cannot be saved as an edit");

  state = composerChange(state, "edited text", saver);
  fire();
  assert.equal(composerText(state), "edited text");
  assert.equal(canSaveEdit(state, false), true);
  assert.equal(canSaveEdit(state, true), false, "not while an edit is being signed");
  assert.equal(canSaveEdit(composerChange(state, "   ", saver), false), false, "empty text cannot be saved");
  assert.deepEqual(saved, ["half a draft"], "edit keystrokes are never saved as the draft");

  const afterSave = endEdit(state);
  assert.equal(composerText(afterSave), "half a draft", "after the edit is saved the draft is back");
  const afterCancel = endEdit(composerChange(state, "abandoned", saver));
  assert.equal(composerText(afterCancel), "half a draft", "after a cancel the draft is back");
  fire();
  assert.deepEqual(saved, ["half a draft"], "neither path wrote or cleared the draft");
});
