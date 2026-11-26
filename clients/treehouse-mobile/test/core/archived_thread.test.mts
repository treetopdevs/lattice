import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// M1b.6 Archived thread (04 Thread screen "Archived" state and Thread info). Whether a thread is archived is
// the judge's materialized `archived` field; who may archive is the Abilities answer for `archive_thread`
// (delegation, moderator holder, judge policy). References: the Sim archive vector (state, live posts, op
// count) and real fixture sessions whose frames lattice-client signs and judges. src/ui/thread_info.ts and
// src/ui/refusal_view.ts only put those facts into words.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

test("the archived flag, message count and op count of the info screen equal the Sim archive vector", async () => {
  const { loadTreehouseVector } = await import("../support/vectors");
  const { projectThreadTimeline, ROLLOVER_BYTES, ROLLOVER_OPS } = await import("../../src/session/projections/thread_timeline");
  const { threadInfoView } = await import("../../src/ui/thread_info");
  const vector = loadTreehouseVector("treehouse_thread_archive");
  const state = vector.expected.state as { archived: boolean; title: string };
  const timeline = projectThreadTimeline({
    replica: vector.replica,
    profile: { frames: vector.frames, outbox: [], acked: [] },
    myKey: null,
    route: null,
  });
  assert.equal(timeline.archived, state.archived);
  assert.equal(timeline.archived, true, "the vector ends archived");
  assert.equal(timeline.health.messages, vector.expected.order.length, "messages are Sim's live posts");
  assert.equal(timeline.health.ops, vector.frames.length);
  assert.equal(ROLLOVER_OPS, 4000, "04: 4,000 ops");
  assert.equal(ROLLOVER_BYTES, 8 * 1024 * 1024, "04: 8 MiB");
  assert.equal(timeline.health.opsLimit, ROLLOVER_OPS);
  assert.equal(timeline.health.bytesLimit, ROLLOVER_BYTES);

  const info = threadInfoView(timeline, undefined);
  assert.equal(info.title, state.title);
  assert.equal(info.archived, true);
  assert.equal(info.canArchive, false, "nobody can archive an archived thread");
  const rows = Object.fromEntries(info.rows.map((r) => [r.key, r.value]));
  assert.equal(rows.messages, String(vector.expected.order.length));
  assert.match(rows.ops ?? "", new RegExp(`^${vector.frames.length} of 4,000$`));
  assert.match(rows.size ?? "", / of 8 MB$/);
  for (const r of info.rows) assert.ok(r.label.length > 0 && r.accessibilityLabel.includes(r.value), `${r.key} reads label and value`);
});

test("Archive is offered to the moderator holder only, and not once the thread is archived", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup } = await import("../support/group_fixture");
  const { threadInfoView } = await import("../../src/ui/thread_info");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const thread = group.thread.replica;

  const memberPhone = await openPhone({ group, as: () => member });
  try {
    const models = memberPhone.session.read();
    assert.deepEqual(models.abilities.replicas[thread]!.archive_thread, { allowed: false, reason: "no_capability" });
    assert.equal(threadInfoView(models.timelines[thread]!, models.abilities.replicas[thread]).canArchive, false, "a member is not offered Archive");
  } finally {
    await memberPhone.close();
  }

  const admin = await openPhone({ group, as: (g) => g.admin });
  try {
    const before = admin.session.read();
    assert.deepEqual(before.abilities.replicas[thread]!.archive_thread, { allowed: true }, "the fixture admin holds the moderator role");
    assert.equal(threadInfoView(before.timelines[thread]!, before.abilities.replicas[thread]).canArchive, true);
    const archived = await admin.session.archiveThread(thread);
    assert.ok(archived.ok, `archive refused: ${JSON.stringify(archived)}`);
    const after = admin.session.read();
    assert.equal(after.timelines[thread]!.archived, true);
    // The judge would honor a second archive (it is a write of the same value), so the Abilities answer stays
    // allowed; Archive is still not offered once archived (01: no unarchive, nothing left to close).
    assert.deepEqual(after.abilities.replicas[thread]!.archive_thread, { allowed: true }, "observed judge answer after an archive");
    assert.equal(threadInfoView(after.timelines[thread]!, after.abilities.replicas[thread]).canArchive, false);
  } finally {
    await admin.close();
  }
});

test("an archived thread replaces the composer with the banner for moderator and member alike", async () => {
  const { openPhone } = await import("../support/command_session");
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { revokeThreadGrant } = await import("../support/authoring");
  const { observeTreehouse, carrierOpsToSemanticOps, treehouseCommandDecoders } = await import("@treetopdevs/lattice-client");
  const { threadFooter } = await import("../../src/ui/refusal_view");
  const { cannotPostCopy } = await import("../../src/ui/strings");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const thread = group.thread.replica;

  const admin = await openPhone({ group, as: (g) => g.admin });
  let archiveFrame;
  try {
    assert.deepEqual(threadFooter({ timeline: admin.session.read().timelines[thread]!, phase: "member" }), { kind: "composer" });
    const archived = await admin.session.archiveThread(thread);
    assert.ok(archived.ok);
    archiveFrame = admin.threadProfile().frames.find((f) => f.id === archived.value.id)!;
    assert.deepEqual(threadFooter({ timeline: admin.session.read().timelines[thread]!, phase: "member" }), { kind: "archived" }, "the moderator too");
  } finally {
    await admin.close();
  }

  const phone = await openPhone({ group, as: () => member });
  try {
    assert.deepEqual(threadFooter({ timeline: phone.session.read().timelines[thread]!, phase: "member" }), { kind: "composer" });
    await phone.deliver(thread, [archiveFrame]);
    // Reference: lattice-client's judge over the frames this phone holds.
    const frames = phone.threadProfile().frames;
    const judged = observeTreehouse("Treehouse.Thread", carrierOpsToSemanticOps(frames, {}, treehouseCommandDecoders("Treehouse.Thread")));
    assert.equal((judged.state as { archived?: boolean }).archived, true);
    const timeline = phone.session.read().timelines[thread]!;
    assert.equal(timeline.archived, true);
    assert.deepEqual(threadFooter({ timeline, phase: "member" }), { kind: "archived" });
    assert.deepEqual(threadFooter({ timeline, phase: "removed" }), { kind: "archived" }, "the thread's archive comes before the key's removal");
  } finally {
    await phone.close();
  }

  // A revoked member in a live thread still gets the M1b.5 bar, not the banner.
  const revoke = await revokeThreadGrant(group, member, group.thread.frames, heads(group.thread.frames));
  const revoked = await openPhone({ group, as: () => member });
  try {
    await revoked.deliver(thread, [revoke]);
    assert.deepEqual(threadFooter({ timeline: revoked.session.read().timelines[thread]!, phase: "member" }), {
      kind: "cannot_post",
      line: cannotPostCopy.revoked_capability,
    });
  } finally {
    await revoked.close();
  }
});

test("the archive confirmation says it cannot be undone, and the banner keeps 04's words", async () => {
  const { thread, threadInfo } = await import("../../src/ui/strings");
  assert.equal(thread.archived, "Archived. No new messages.");
  assert.match(threadInfo.confirmArchive, /can't be undone/);
  assert.match(threadInfo.confirmArchive, /No one can post/);
  assert.equal(threadInfo.archiveConfirm, "Archive");
});

test("the thread info route exists, is registered, and the thread screen links to it and shows the banner", () => {
  assert.ok(existsSync(join(ROOT, "src/app/thread-info/[replica].tsx")), "thread-info/[replica] route");
  assert.ok(existsSync(join(ROOT, "src/ui/ArchivedBanner.tsx")));
  const layout = read("src/app/_layout.tsx");
  assert.match(layout, /name="thread-info\/\[replica\]"/);
  const screen = read("src/app/thread/[replica].tsx");
  assert.match(screen, /headerRight/);
  assert.match(screen, /pathname: "\/thread-info\/\[replica\]"/);
  assert.match(screen, /<ArchivedBanner/);
  assert.match(screen, /threadFooter\(/);
  const info = read("src/app/thread-info/[replica].tsx");
  assert.match(info, /threadInfoView\(/);
  assert.match(info, /<ConfirmDialog/);
  assert.match(info, /session\.archiveThread\(/);
  assert.doesNotMatch(info, /lattice-client/, "no protocol code in the route");
});
