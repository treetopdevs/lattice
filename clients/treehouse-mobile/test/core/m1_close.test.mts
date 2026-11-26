import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { carrierOpsToSemanticOps, observeTreehouse, treehouseCommandDecoders } from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";

// M1 closing review (Codex gpt-6.2-sol high and Antigravity Neon medium, run independently on af29e3a09). One
// test per accepted finding that Core can reach. References are lattice-client's judge (observeTreehouse) or
// the source the finding names, never the projection compared with itself.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const judge = (product: "Treehouse.Space" | "Treehouse.Thread", frames: readonly CarrierOpFrame[]) =>
  observeTreehouse(product, carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders(product))).quarantineReasons;

test("a removed key the admin invites again is joining, not stuck on removed (Neon 2)", async () => {
  const { buildGroup } = await import("../support/group_fixture");
  const { authorAs, rootCap } = await import("../support/authoring");
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectSessionStatus } = await import("../../src/session/projections/session_status");
  const group = await buildGroup({ members: 2 });
  const bob = group.members[1]!;
  const cap = rootCap(group.space.frames);
  const ops = carrierOpsToSemanticOps([...group.space.frames], {}, treehouseCommandDecoders("Treehouse.Space"));
  const threads = ops.find((op) => op.command === "issue_invitation")!.commandArgs![1] as string[];

  const removal = await authorAs(group.admin, "Treehouse.Space", group.space.frames, { command: "remove_member", recipient: bob.pubkey }, cap);
  const removed = [...group.space.frames, removal];
  const reinvite = await authorAs(group.admin, "Treehouse.Space", removed, { command: "issue_invitation", recipient: bob.pubkey, threads }, cap);
  const reinvited = [...removed, reinvite];
  // The judge honors both: the removal and the later invitation.
  const verdicts = judge("Treehouse.Space", reinvited);
  assert.equal(verdicts.has(removal.id), false);
  assert.equal(verdicts.has(reinvite.id), false, "the judge honors an invitation for a removed key");

  const phase = (frames: CarrierOpFrame[]) =>
    projectSessionStatus({
      custody: "available",
      myKey: bob.pubkey,
      history: { ok: true },
      space: viewReplica(group.space.replica, "Treehouse.Space", frames),
      held: [],
    }).phase;
  assert.equal(phase(removed), "removed");
  assert.equal(phase(reinvited), "joining", "an invitation after the removal resumes the join");
  // The admin withdraws the new invitation: removed again.
  const withdrawn = await authorAs(group.admin, "Treehouse.Space", reinvited, { command: "revoke_invitation", invitationId: reinvite.id }, cap);
  assert.equal(judge("Treehouse.Space", [...reinvited, withdrawn]).has(withdrawn.id), false);
  assert.equal(phase([...reinvited, withdrawn]), "removed");
});

test("a removed key gets no composer and signs nothing, even while its Thread grant is still live (Codex 4)", async () => {
  const { openPhone } = await import("../support/command_session");
  const { authorAs, rootCap } = await import("../support/authoring");
  const { threadFooter } = await import("../../src/ui/refusal_view");
  const { phaseCopy } = await import("../../src/ui/strings");
  const phone = await openPhone({ members: 1, as: (g) => g.members[0]! });
  try {
    const { group, who } = phone;
    const removal = await authorAs(group.admin, "Treehouse.Space", group.space.frames, { command: "remove_member", recipient: who.pubkey }, rootCap(group.space.frames));
    await phone.deliver(group.space.replica, [removal]);
    const models = phone.session.read();
    assert.equal(models.status.phase, "removed");
    const timeline = models.timelines[group.thread.replica]!;
    // The Group removal arrived before the Thread grant revocation: the grant alone would still allow a post.
    assert.equal(timeline.postRefusal, null, "precondition: the Thread grant is still live");
    assert.deepEqual(threadFooter({ timeline, phase: models.status.phase }), { kind: "cannot_post", line: phaseCopy.removed });
    for (const command of ["post", "author_edit", "author_tombstone", "moderator_tombstone", "archive_thread"])
      assert.equal(models.abilities.replicas[group.thread.replica]?.[command]?.allowed ?? false, false, `${command} is not offered`);
    const posted = await phone.session.postMessage(group.thread.replica, "after the removal");
    assert.equal(posted.ok, false);
    assert.equal(phone.signs.count, 0, "nothing was signed");
    assert.equal(phone.threadProfile().outbox.length, 0);
    const screen = read("src/app/thread/[replica].tsx");
    assert.match(screen, /footer\?\.kind === "composer"/, "the composer shows only when the footer says so");
  } finally {
    await phone.close();
  }
});

test("a revoke that lands while a post is being signed is judged before the post is saved (Codex 5)", async () => {
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { revokeThreadGrant } = await import("../support/authoring");
  const { MemoryReplicaDisk, MemoryReplicaStore } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { postMessage } = await import("../../src/session/commands/post_message");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  await store.adopt(group.thread.replica, "Treehouse.Thread");
  await store.mergeSync(group.thread.replica, group.thread.frames, []);
  const revoke = await revokeThreadGrant(group, member, group.thread.frames, heads(group.thread.frames));
  const inner = MemoryKeyCustody.holding(member.signer);
  let merged = false;
  const custody = {
    status: () => inner.status(),
    publicKey: () => inner.publicKey(),
    create: () => inner.create(),
    async sign(bytes: Uint8Array) {
      // While custody signs (a Keychain prompt, say), a pull merges the admin's revoke.
      if (!merged) {
        merged = true;
        await store.mergeSync(group.thread.replica, [revoke], []);
      }
      return inner.sign(bytes);
    },
  };
  const outcome = await postMessage({ custody, store, myKey: () => member.pubkey, nudge: () => undefined }, group.thread.replica, "signed during a revoke");
  assert.ok(merged);
  assert.deepEqual(outcome, { ok: false, reason: "revoked_capability" });
  assert.equal(store.profile(group.thread.replica)!.outbox.length, 0, "the doomed post is not saved");
});

test("a pull that repeats an id within one batch is merged, not refused as invalid history (Neon 4)", async () => {
  const { buildGroup } = await import("../support/group_fixture");
  const { MemoryReplicaDisk, MemoryReplicaStore } = await import("../../src/session/memory/replica_store");
  const { MemoryKeyCustody } = await import("../../src/session/memory/key_custody");
  const { ManualClock } = await import("../../src/session/memory/clock");
  const { MemoryRelayLink } = await import("../../src/session/memory/relay_link");
  const { openMemoryLocalStore } = await import("../../src/local/local_store");
  const { createTreehouseSession } = await import("../../src/session/session");
  type Host = Parameters<Parameters<typeof createTreehouseSession>[0]["link"]>[0];
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const store = new MemoryReplicaStore(new MemoryReplicaDisk(), new ManualClock(1_000));
  await store.open();
  await store.adopt(group.space.replica, "Treehouse.Space");
  await store.mergeSync(group.space.replica, group.space.frames, []);
  await store.adopt(group.thread.replica, "Treehouse.Thread");
  let host: Host | null = null;
  const session = createTreehouseSession({
    custody: MemoryKeyCustody.holding(member.signer),
    store,
    clock: new ManualClock(2_000),
    local: await openMemoryLocalStore(),
    link: (h) => {
      host = h;
      return new MemoryRelayLink();
    },
  });
  await session.open();
  try {
    const frames = group.thread.frames;
    const doubled = [...frames, frames[frames.length - 1]!];
    assert.equal(await host!.mergeSync(group.thread.replica, doubled, []), true);
    assert.deepEqual(store.profile(group.thread.replica)!.frames.map((f) => f.id), frames.map((f) => f.id));
  } finally {
    await session.close();
  }
});

test("audit grants are matched to the judge's record, not by id alone (Codex 6)", async () => {
  const { buildGroup, heads, testIdentity } = await import("../support/group_fixture");
  const { authorTownshipDelegation, carrierDelegationsFromFrames, memberCapability } = await import("@treetopdevs/lattice-client");
  const { viewReplica } = await import("../../src/session/projections/replica_view");
  const { projectAuditView } = await import("../../src/session/projections/audit_view");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const replica = group.thread.replica;
  const honored = memberCapability(group.thread.frames, member.pubkey, replica, { product: "Treehouse.Thread", command: "post" })!;
  // A stranger's record that carries the honored grant's id with its own audience and operations.
  const stranger = testIdentity("stranger");
  const forged = structuredClone(
    await authorTownshipDelegation({ replica, deps: heads(group.thread.frames), audiencePubkey: stranger.signer.publicKey, parentId: honored.id, ops: ["post", "archive_thread"], roles: [], live: false, signer: stranger.signer }),
  );
  const retag = (term: unknown): void => {
    if (!Array.isArray(term)) return;
    if (term[0] === "delegation" && term[1] && typeof term[1] === "object") (term[1] as { id: string }).id = honored.id;
    else for (const child of term) retag(child);
  };
  retag(forged.body);
  const frames = [...group.thread.frames, forged];
  const records = carrierDelegationsFromFrames(frames).filter((d) => d.id === honored.id);
  assert.equal(records.length, 2, "precondition: two records share the honored id");

  const grants = projectAuditView({ views: [viewReplica(replica, "Treehouse.Thread", frames)], feed: { configured: false, routes: [] } }).replicas[0]!.grants.filter(
    (g) => g.id === honored.id,
  );
  const usable = grants.filter((g) => g.state === "usable");
  assert.equal(usable.length, 1, "only one record is usable");
  assert.equal(usable[0]!.audience, honored.audience, "the usable one is the judge's own record");
  assert.deepEqual(usable[0]!.ops, [...honored.ops]);
  const other = grants.find((g) => g.audience !== honored.audience)!;
  assert.equal(other.state, "not_usable", "the record with the borrowed id is not usable");
});

test("a confirmation whose action is gone closes; a stale re-sync alert does nothing (Neon 5, Neon 12)", async () => {
  const { confirmationLeft } = await import("../../src/ui/message_sheet");
  assert.equal(confirmationLeft("delete", ["copy", "edit", "delete"]), "delete");
  assert.equal(confirmationLeft("delete", ["copy"]), null, "Delete was taken away while confirming");
  assert.equal(confirmationLeft("remove", ["copy"]), null);
  assert.equal(confirmationLeft(null, ["copy"]), null);
  const sheet = read("src/ui/MessageSheet.tsx");
  assert.match(sheet, /confirmationLeft\(/, "the sheet re-checks the pending confirmation against the live items");
  const provider = read("src/ui/SessionProvider.tsx");
  assert.match(provider, /appRef\.current !== current/, "confirmResync acts only on the session the alert was raised for");
});

test("the dev self-check is required only behind __DEV__, like the replica store check (Neon 11)", () => {
  const group = read("src/app/(tabs)/group.tsx");
  assert.doesNotMatch(group, /^import \{ runSelfCheck \}/m, "no static import of the self-check");
  assert.match(group, /__DEV__\s*\?\s*require\("\.\.\/\.\.\/native\/selfcheck"\)/);
});

/** 01's "Not to be called" column, as lower-case terms. */
function notToBeCalled(): string[] {
  const text = readFileSync(join(ROOT, "../../docs/treehouse-mobile/01-ubiquitous-language.md"), "utf8");
  const start = text.indexOf("## Domain terms");
  const block = text.slice(start, text.indexOf("\n## ", start + 1));
  const terms: string[] = [];
  for (const line of block.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 6 || cells[1] === "Term in code" || cells[1]!.startsWith("---")) continue;
    for (const t of cells[4]!.split(",")) if (t.trim()) terms.push(t.trim().toLowerCase());
  }
  assert.ok(terms.includes("founder") && terms.includes("kick"), "01's column parsed");
  return terms;
}

test("demo labels pass 01's word lists, the Not to be called column included (Neon 8, Codex 12)", async () => {
  const { DEMO_ROLE_LABEL, DEMO_KEYS_PUBLIC } = await import("../../src/demo/identities");
  const never = notToBeCalled();
  const text = readFileSync(join(ROOT, "../../docs/treehouse-mobile/01-ubiquitous-language.md"), "utf8");
  const neverBlock = text.slice(text.indexOf("## Words the app never uses"));
  const neverUsed = [...neverBlock.slice(0, neverBlock.indexOf("\n## ", 1)).matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!.toLowerCase());
  for (const label of [...Object.values(DEMO_ROLE_LABEL), DEMO_KEYS_PUBLIC])
    for (const word of [...never, ...neverUsed]) {
      // "founder as a role" names the concept; the word itself is what must not appear.
      const term = word.replace(/ as a role$/, "");
      assert.ok(!new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(label), `demo copy "${label}" uses "${term}"`);
    }
});

test("concurrent author and moderator tombstones are both honored; the label is the same on every phone (Neon 6, rejected)", async () => {
  // Pins the evidence for rejecting Neon 6: the judge honors both concurrent tombstones, so "Removed by
  // moderator" is a true fact, and the fixed precedence does not depend on the order frames arrived in.
  const { buildGroup, heads } = await import("../support/group_fixture");
  const { authorAs, postAt } = await import("../support/authoring");
  const { memberCapability } = await import("@treetopdevs/lattice-client");
  const { projectThreadTimeline } = await import("../../src/session/projections/thread_timeline");
  const group = await buildGroup({ members: 1 });
  const member = group.members[0]!;
  const replica = group.thread.replica;
  const post = await postAt(member, group.thread.frames, "both remove this", heads(group.thread.frames));
  const base = [...group.thread.frames, post];
  const capOf = (who: typeof member, command: string) => memberCapability(base, who.pubkey, replica, { product: "Treehouse.Thread", command })!.id;
  const byAuthor = await authorAs(member, "Treehouse.Thread", base, { command: "author_tombstone", postId: post.id, targetId: post.id }, capOf(member, "author_tombstone"), heads(base));
  const byModerator = await authorAs(group.admin, "Treehouse.Thread", base, { command: "moderator_tombstone", postId: post.id, targetId: post.id }, capOf(group.admin, "moderator_tombstone"), heads(base));
  const verdicts = judge("Treehouse.Thread", [...base, byAuthor, byModerator]);
  assert.equal(verdicts.has(byAuthor.id), false, "the author's delete is honored");
  assert.equal(verdicts.has(byModerator.id), false, "the moderator's concurrent remove is honored");
  const label = (frames: CarrierOpFrame[]) =>
    projectThreadTimeline({ replica, profile: { frames, outbox: [], acked: [] }, myKey: member.pubkey, route: null }).messages.find((m) => m.id === post.id)?.removed;
  assert.equal(label([...base, byAuthor, byModerator]), "by_moderator");
  assert.equal(label([...base, byModerator, byAuthor]), "by_moderator", "arrival order does not change it");
});
