import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1b.5 Refusal states (04 Thread screen: "Cannot post" and "My message not counted"). Why this key cannot
// post comes from the judge: the Abilities answer for `post`, refined by lattice-client's own frontier verdict
// on this key's post grants (delegationFrontierRefusal: revoked or lapsed). A message's not-counted reason is
// the judge's quarantine reason. The references are lattice-client's observeTreehouse and the frames lattice-
// client's helpers author; src/ui/refusal_view.ts only puts those facts into words.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("a revoked post grant replaces the composer with the reason, and the line names the admin", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { revokeThreadGrant } = await import("../support/authoring");
  const { cannotPostLine } = await import("../../src/ui/refusal_view");
  const { cannotPostCopy } = await import("../../src/ui/strings");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const revoke = await revokeThreadGrant(group, member, group.thread.frames, heads(group.thread.frames));

  const phone = await openPhone({ group, as: () => member });
  try {
    const before = phone.session.read().timelines[group.thread.replica]!;
    assert.equal(before.canPost, true);
    assert.equal(before.postRefusal, null, "a member who may post has no refusal");
    await phone.deliver(group.thread.replica, [revoke]);
    const after = phone.session.read().timelines[group.thread.replica]!;
    assert.equal(after.canPost, false);
    assert.equal(after.postRefusal, "revoked_capability");
    const line = cannotPostLine({ postRefusal: after.postRefusal, phase: "member", archived: after.archived });
    assert.equal(line, cannotPostCopy.revoked_capability);
    assert.match(line, /admin/, "the line says who can fix it");
  } finally {
    await phone.close();
  }
});

test("a post saved before the revoke arrived is not counted with the judge's reason, offers Copy, and the bar agrees", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { revokeThreadGrant } = await import("../support/authoring");
  const { carrierOpsToSemanticOps, observeTreehouse, treehouseCommandDecoders } = await import("@treetopdevs/lattice-client");
  const { quarantineReason } = await import("../../src/session/outcomes");
  const { sheetItems } = await import("../../src/ui/message_sheet");
  const { cannotPostLine, notCountedLine } = await import("../../src/ui/refusal_view");
  const { cannotPostCopy, refusalCopy } = await import("../../src/ui/strings");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  // The admin revokes concurrently with the member's post: neither saw the other.
  const revoke = await revokeThreadGrant(group, member, group.thread.frames, heads(group.thread.frames));

  const phone = await openPhone({ group, as: () => member });
  try {
    const posted = await phone.session.postMessage(group.thread.replica, "said while the revoke was on its way");
    assert.ok(posted.ok, "the phone did not hold the revoke yet, so the pre-judge let the post through");
    await phone.deliver(group.thread.replica, [revoke]);

    // Reference: lattice-client's judge over the frames this phone holds.
    const frames = phone.threadProfile().frames;
    const judged = observeTreehouse("Treehouse.Thread", carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread")));
    const raw = judged.quarantineReasons.get(posted.value.id);
    assert.equal(raw, "revoked_capability", "the judge does not count the post");

    const models = phone.session.read();
    const timeline = models.timelines[group.thread.replica]!;
    const mine = timeline.messages.find((m) => m.id === posted.value.id)!;
    assert.equal(mine.standing, "not_counted");
    assert.equal(mine.notCountedReason, quarantineReason(raw!));
    assert.equal(mine.text, "said while the revoke was on its way", "the text stays, so it can be copied and re-sent");
    assert.deepEqual(sheetItems(mine, models.abilities.replicas[group.thread.replica]), ["copy"], "only Copy: the judge would refuse a change to it");
    assert.equal(notCountedLine(mine), refusalCopy.revoked_capability);
    const { bubbleLabel } = await import("../../src/ui/thread_view");
    const label = bubbleLabel(mine, "You");
    assert.ok(label.includes("The admin took this away from you"), "the screen reader hears the reason");
    assert.doesNotMatch(label, /\.\./, "no doubled full stop between parts (seen on the simulator)");

    assert.equal(timeline.postRefusal, mine.notCountedReason, "the bar gives the reason the judge gave the post");
    assert.equal(cannotPostLine({ postRefusal: timeline.postRefusal, phase: "member", archived: false }), cannotPostCopy.revoked_capability);
  } finally {
    await phone.close();
  }
});

test("a key with no grant in the thread is told it was never given posting", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup, testIdentity } = await import("../support/group_fixture");
  const { cannotPostLine } = await import("../../src/ui/refusal_view");
  const { cannotPostCopy } = await import("../../src/ui/strings");
  const group = await buildGroup({ members: 1 });
  const phone = await openPhone({ group, as: () => testIdentity("stranger") });
  try {
    const timeline = phone.session.read().timelines[group.thread.replica]!;
    assert.equal(timeline.canPost, false);
    assert.equal(timeline.postRefusal, "no_capability");
    assert.equal(cannotPostLine({ postRefusal: "no_capability", phase: "member", archived: false }), cannotPostCopy.no_capability);
  } finally {
    await phone.close();
  }
});

test("the cannot-post line: removed from the group and archived take precedence, every reason has words", async () => {
  const { cannotPostLine } = await import("../../src/ui/refusal_view");
  const { cannotPostCopy, phaseCopy, thread } = await import("../../src/ui/strings");
  assert.equal(cannotPostLine({ postRefusal: null, phase: "member", archived: false }), null, "allowed: the composer stays");
  assert.equal(cannotPostLine({ postRefusal: "revoked_capability", phase: "removed", archived: false }), phaseCopy.removed);
  assert.equal(cannotPostLine({ postRefusal: "archived thread", phase: "member", archived: true }), thread.archived);
  assert.equal(cannotPostLine({ postRefusal: "no_capability", phase: "member", archived: true }), thread.archived);
  for (const [reason, line] of Object.entries(cannotPostCopy)) {
    assert.ok(line.length > 0, `${reason} has a line`);
    assert.equal(cannotPostLine({ postRefusal: reason as keyof typeof cannotPostCopy, phase: "member", archived: false }), line);
  }
  assert.match(cannotPostCopy.lease_expired, /admin/);
  assert.match(cannotPostCopy.no_capability, /admin/);
});

test("Copy comes first for any message with text; a placeholder offers nothing", async () => {
  const { sheetItems, sheetItemLabel } = await import("../../src/ui/message_sheet");
  const { actions } = await import("../../src/ui/strings");
  type Message = import("../../src/session/projections/thread_timeline").MessageView;
  const allowed = { allowed: true } as const;
  const none = { allowed: false, reason: "no_capability" } as const;
  const base: Message = {
    id: "m", ref: { root: "m", latest: "m" }, author: "k1", text: "hi", edited: false, removed: null, mine: false,
    delivery: null, standing: "honored", notCountedReason: null, firstSeenMs: null, unread: false, arrivedLate: false,
  };
  const member = { author_edit: allowed, author_tombstone: allowed, moderator_tombstone: none };
  assert.deepEqual(sheetItems(base, member), ["copy"], "another member's message: Copy only");
  assert.deepEqual(sheetItems({ ...base, mine: true, delivery: "on_relay" }, member), ["copy", "edit", "delete"]);
  assert.deepEqual(sheetItems({ ...base, removed: "by_moderator", text: "" }, member), []);
  assert.deepEqual(sheetItems(base, undefined), ["copy"], "copying needs no ability");
  assert.equal(sheetItemLabel.copy, actions.copy);
});

test("the screens render the bar and the not-counted bubble, and the clipboard stays out of Core modules", () => {
  const screen = read("src/app/thread/[replica].tsx");
  assert.match(screen, /<CannotPostBar\b/);
  assert.match(read("src/ui/MessageList.tsx"), /<NotCountedBubble\b/);
  const bubble = read("src/ui/NotCountedBubble.tsx");
  assert.match(bubble, /accessibilityActions/, "Copy text is reachable by a screen reader on the bubble itself");
  for (const pure of ["src/ui/message_sheet.ts", "src/ui/thread_view.ts", "src/ui/strings.ts", "src/ui/refusal_view.ts"])
    assert.doesNotMatch(read(pure), /expo-clipboard/, `${pure} is loaded by Core tests`);
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.match(pkg.dependencies["expo-clipboard"] ?? "", /^~58\./, "expo-clipboard at the SDK 58 version");
});
