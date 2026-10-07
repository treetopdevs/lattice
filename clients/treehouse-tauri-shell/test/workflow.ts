import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  authorTreehouseCommand,
  carrierDelegationsFromFrames,
  decodeTreehouseAcceptance,
  decodeTreehouseJoinRequest,
  decodeTreehouseOffer,
  encodeTreehouseAcceptance,
  encodeTreehouseOffer,
} from "@treetopdevs/lattice-client";
import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import type { PreviewNative, Draft } from "../src/treehouse_state";

class MemoryNative implements PreviewNative {
  record: string | null = null;
  seed: Uint8Array | null = null;
  creates = 0;
  writes = 0;
  drafts = new Map<string, Draft>();
  async open() {
    return {
      record: this.record,
      publicKey: this.seed
        ? Buffer.from(ed25519.getPublicKey(this.seed)).toString("base64")
        : null,
      keyStatus: (this.seed
        ? "available"
        : parseState(this.record).publicKey
          ? "missing"
          : "absent") as "available" | "missing" | "absent",
    };
  }
  async initialize() {
    if (!this.seed) {
      this.seed = crypto.getRandomValues(new Uint8Array(32));
      this.creates++;
    }
    return (await this.open()).publicKey!;
  }
  async commit(expected: number, next: string) {
    if (parseState(this.record).revision !== expected) return false;
    this.record = next;
    this.writes++;
    return true;
  }
  async loadDraft(replica: string) {
    return this.drafts.get(replica) ?? null;
  }
  async saveDraft(replica: string, expected: number, text: string) {
    if ((this.drafts.get(replica)?.revision ?? 0) !== expected) return null;
    const draft: Draft = { version: 1, revision: expected + 1, text };
    this.drafts.set(replica, draft);
    return draft;
  }
  async sign(bytes: Uint8Array) {
    return ed25519.sign(bytes, this.seed!);
  }
}
const native = new MemoryNative();
const app = new TreehouseWorkflow(native);
await app.open();
assert.equal(app.state.profiles.length, 0);
assert.equal(native.creates, 0, "empty boot never initializes signing keys");
await app.createSpace("Canopy");
assert.equal(
  app.state.profiles.length,
  1,
  "explicit creation durably retains one real Space",
);
const restarted = new TreehouseWorkflow(native);
await restarted.open();
assert.deepEqual(restarted.state, app.state);
assert.equal(native.creates, 1);
console.log("PASS empty boot, explicit signed creation and retained restart");

await app.createThread("Field notes");
const thread = app.state.active!;
assert.equal(app.views.get(thread)!.state.title, "Field notes");
const beforeDraftWrites = native.writes;
const draft = await app.saveDraft(thread, 0, "First note");
assert.equal(
  native.writes,
  beforeDraftWrites,
  "typing never rewrites the aggregate history",
);
const postId = await app.command(
  thread,
  { command: "post", text: draft.text },
  draft.revision,
);
assert.equal((await app.draft(thread)).text, "");
const firstPost = app.views.get(thread)!.posts[0]!;
assert.equal(firstPost.id, postId);
await app.command(thread, {
  command: "author_edit",
  postId,
  targetId: postId,
  text: "Edited note",
});
assert.equal(app.views.get(thread)!.posts[0]!.text, "Edited note");
const laterDraft = await app.saveDraft(
  thread,
  draft.revision,
  "Still drafting",
);
await app.command(thread, { command: "archive_thread" });
const archived = new TreehouseWorkflow(native);
await archived.open();
assert.equal(archived.views.get(thread)!.state.archived, true);
assert.equal((await archived.draft(thread)).text, laterDraft.text);
assert.equal(archived.views.get(thread)!.posts[0]!.id, postId);
const saved = native.record;
await assert.rejects(
  archived.command(thread, { command: "post", text: "Refused" }),
  /archived/,
);
assert.equal(native.record, saved);
await archived.command(thread, {
  command: "moderator_tombstone",
  postId,
  targetId: postId,
});
assert.equal(archived.views.get(thread)!.posts.length, 0);
console.log(
  "PASS real local Thread, draft watermark, post/edit/archive/restart and moderator tombstone",
);

// Fail after the key is durable but before its public binding is acknowledged.
const interruptedNative = new MemoryNative();
const interrupted = new TreehouseWorkflow(interruptedNative);
await interrupted.open();
const originalCommit = interruptedNative.commit.bind(interruptedNative);
let refuseIdentity = true;
interruptedNative.commit = async (revision, record) => {
  if (refuseIdentity && parseState(record).publicKey)
    throw new Error("disk_write_refused");
  return originalCommit(revision, record);
};
await assert.rejects(
  interrupted.createSpace("Retry canopy"),
  /disk_write_refused/,
);
assert.equal(parseState(interruptedNative.record).profiles.length, 0);
const pendingIntent = parseState(interruptedNative.record).intent;
assert(pendingIntent);
assert.equal(interruptedNative.creates, 1);
refuseIdentity = false;
const retry = new TreehouseWorkflow(interruptedNative);
await retry.open();
await retry.resumeCreation();
assert.equal(interruptedNative.creates, 1);
assert(retry.state.profiles[0]!.replica.includes(pendingIntent.nonce));
await retry.createThread("Concurrent notes");
const concurrentThread = retry.state.active!;
const stale = new TreehouseWorkflow(interruptedNative);
await stale.open();
const acknowledged = await retry.command(concurrentThread, {
  command: "post",
  text: "Keep this",
});
const acknowledgedBytes = interruptedNative.record;
await assert.rejects(
  stale.command(concurrentThread, { command: "post", text: "Stale writer" }),
  /stale_saved_state/,
);
assert.equal(interruptedNative.record, acknowledgedBytes);
assert(
  retry.state.profiles
    .flatMap((p) => p.frames)
    .some((f) => f.id === acknowledged),
);
// A lost reply after commit is resolved from the identical captured public bytes.
interruptedNative.commit = async (revision, record) => {
  await originalCommit(revision, record);
  throw new Error("lost_reply");
};
await retry.command(concurrentThread, {
  command: "post",
  text: "Acknowledged after reread",
});
assert.equal(retry.views.get(concurrentThread)!.posts.length, 2);
console.log(
  "PASS interrupted key binding, exact retry, two writers and uncertain acknowledgement",
);

await retry.createThread("Another readable thread");
const otherReadableThread = retry.state.active!;
await retry.command(otherReadableThread, { command: "post", text: "Second thread history" });
const goodRecord = interruptedNative.record!;
const hostile = JSON.parse(goodRecord);
hostile.profiles[0].frames[0].sig = Buffer.alloc(64).toString("base64");
interruptedNative.record = JSON.stringify(hostile);
await assert.rejects(
  new TreehouseWorkflow(interruptedNative).open(),
  /invalid_retained_history/,
);
assert.equal(
  interruptedNative.record,
  JSON.stringify(hostile),
  "refusal preserves the hostile snapshot",
);
interruptedNative.record = goodRecord;
const originalSeed = interruptedNative.seed;
interruptedNative.seed = null;
const readOnly = new TreehouseWorkflow(interruptedNative);
await readOnly.open();
assert.equal(readOnly.keyAvailable, false);
assert.equal(readOnly.state.active, otherReadableThread);
const beforeReadSelectionWrites = interruptedNative.writes;
const beforeReadSelectionRevision = readOnly.state.revision;
await readOnly.select(concurrentThread);
assert.equal(readOnly.state.active, concurrentThread);
assert.equal(readOnly.views.get(concurrentThread)!.posts.length, 2);
assert.equal(interruptedNative.writes, beforeReadSelectionWrites,
  "missing-key thread selection never commits the retained record");
assert.equal(readOnly.state.revision, beforeReadSelectionRevision);
assert.equal(interruptedNative.record, goodRecord);
const readOnlyReopened = new TreehouseWorkflow(interruptedNative);
await readOnlyReopened.open();
assert.equal(readOnlyReopened.state.active, otherReadableThread,
  "read-only navigation does not replace the retained selection");
await readOnly.select(otherReadableThread);
assert.equal(readOnly.views.get(otherReadableThread)!.posts[0]!.text, "Second thread history");
await assert.rejects(readOnly.select("unknown-thread"), /unknown_profile/);
assert.equal(readOnly.state.active, otherReadableThread);
await assert.rejects(
  readOnly.command(concurrentThread, {
    command: "post",
    text: "No replacement key",
  }),
  /identity_unavailable/,
);
assert.equal(interruptedNative.creates, 1);
assert.equal(interruptedNative.record, goodRecord);
interruptedNative.seed = crypto.getRandomValues(new Uint8Array(32));
await assert.rejects(
  new TreehouseWorkflow(interruptedNative).open(),
  /identity_mismatch/,
);
interruptedNative.seed = originalSeed;
interruptedNative.record = null;
await assert.rejects(
  new TreehouseWorkflow(interruptedNative).open(),
  /missing_local_history/,
);
assert.equal(interruptedNative.creates, 1);
console.log(
  "PASS captured hostile input, missing history/key and mismatched identity refusal",
);

if (process.env.TREEHOUSE_WORKFLOW_ARTIFACT) {
  const { writeFile } = await import("node:fs/promises");
  const current = new TreehouseWorkflow(native);
  await current.open();
  await writeFile(
    process.env.TREEHOUSE_WORKFLOW_ARTIFACT,
    JSON.stringify({
      version: 1,
      product: "treehouse",
      readiness: "recovery_not_ready",
      publicKey: current.state.publicKey,
      profiles: current.state.profiles.map((p) => {
        const v = current.views.get(p.replica)!;
        return {
          ...p,
          expect: {
            state: v.state,
            posts: v.posts,
            order: v.order,
            quarantine: [...v.quarantineReasons].sort(),
            operationCount: v.operationCount,
          },
        };
      }),
    }),
  );
}

// Migrate an authenticated pre-release envelope, preserving every original frame.
const migrationNative = new MemoryNative();
migrationNative.seed = native.seed;
const oldEnvelope = JSON.parse(native.record!);
oldEnvelope.version = 0;
delete oldEnvelope.clearedDrafts;
delete oldEnvelope.relay;
for (const p of oldEnvelope.profiles) delete p.acked;
migrationNative.record = JSON.stringify(oldEnvelope);
const migrated = new TreehouseWorkflow(migrationNative);
await migrated.open();
assert.equal(JSON.parse(migrationNative.record!).version, 2);
assert.deepEqual(
  migrated.state.profiles,
  oldEnvelope.profiles.map((p: object) => ({ ...p, acked: [] })),
);
assert.equal(migrated.state.revision, oldEnvelope.revision + 1);
const migrationAgain = new TreehouseWorkflow(migrationNative);
await migrationAgain.open();
assert.deepEqual(migrationAgain.state, migrated.state);
console.log(
  "PASS authenticated N-1 metadata migration retains exact signed frames and current reopen",
);

const quarantineNative = new MemoryNative();
quarantineNative.seed = native.seed;
quarantineNative.record = native.record;
const qState = parseState(quarantineNative.record);
const qThread = qState.profiles.find((p) => p.product === "Treehouse.Thread")!;
const outsider = crypto.getRandomValues(new Uint8Array(32));
const denied = await authorTreehouseCommand({
  product: qThread.product,
  replica: qThread.replica,
  deps: [qThread.frames.at(-1)!.id],
  capId: carrierDelegationsFromFrames(qThread.frames)[0]!.id,
  signer: {
    publicKey: ed25519.getPublicKey(outsider),
    sign: async (bytes) => ed25519.sign(bytes, outsider),
  },
  command: { command: "post", text: "Authentic but unauthorized" },
});
qThread.frames.push(denied);
qThread.outbox.push(denied.id);
quarantineNative.record = JSON.stringify(qState);
const quarantineReader = new TreehouseWorkflow(quarantineNative);
await quarantineReader.open();
assert(
  quarantineReader.views.get(qThread.replica)!.quarantineReasons.has(denied.id),
);
assert(
  !quarantineReader.views
    .get(qThread.replica)!
    .posts.some((p) => p.id === denied.id),
);
assert(
  quarantineReader.state.profiles
    .flatMap((p) => p.frames)
    .some((f) => f.id === denied.id),
);
console.log(
  "PASS authenticated quarantined history remains retained and has no projected effect",
);

const partialNative = new MemoryNative();
partialNative.seed = native.seed;
const partial = parseState(native.record!);
const onlySpace = partial.profiles.find(
  (p) => p.product === "Treehouse.Space",
)!;
onlySpace.frames = onlySpace.frames.slice(0, 1);
onlySpace.outbox = onlySpace.frames.map((f) => f.id);
partial.profiles = [onlySpace];
partial.active = onlySpace.replica;
partial.clearedDrafts = {};
partialNative.record = JSON.stringify(partial);
await assert.rejects(
  new TreehouseWorkflow(partialNative).open(),
  /incomplete_profile_initialization/,
  "a retained genesis alone cannot be presented as a named group",
);

// ---- Plan 181 slice 2b: enrollment workflow --------------------------------------------------------------
const SERVER_KEY = Buffer.alloc(32, 7).toString("base64");
const UNKNOWN_REPLICA = `replica:treehouse:thread:${"A".repeat(43)}#root:${"B".repeat(43)}`;
const TRUNCATED_HANDOFF = `township-pairing:v1:${Buffer.from(
  JSON.stringify({ url: "ws://127.0.0.1:1", replica: "township" }),
).toString("base64url")}`;
const fresh = async (n: MemoryNative) => {
  const w = new TreehouseWorkflow(n);
  await w.open();
  return w;
};
const clone = (n: MemoryNative) => {
  const c = new MemoryNative();
  c.record = n.record;
  c.seed = n.seed;
  return c;
};
const spaceOf = (a: TreehouseWorkflow) =>
  a.state.profiles.find((p) => p.product === "Treehouse.Space")!;
const threadsOf = (a: TreehouseWorkflow) =>
  a.state.profiles.filter((p) => p.product === "Treehouse.Thread");
const routeEntry = (replica: string, port: number, over: object = {}) => ({
  replica,
  url: `ws://127.0.0.1:${port}`,
  expectedPeerRealm: "relay",
  expectedPeerPubkey: SERVER_KEY,
  ...over,
});
const routeList = (a: TreehouseWorkflow, realm: string, only?: number) =>
  JSON.stringify({
    localRealm: realm,
    routes: a.state.profiles
      .map((p, i) => routeEntry(p.replica, 47000 + i))
      .slice(0, only),
  });
/** Stands in for a verified relay pull: merge the source's frames into the target record. */
function copyHistory(target: MemoryNative, source: MemoryNative) {
  const from = parseState(source.record);
  const into = parseState(target.record);
  const merged = from.profiles.map((p) => {
    const have = into.profiles.find((q) => q.replica === p.replica);
    const ids = new Set(have?.frames.map((f) => f.id));
    const added = p.frames.filter((f) => !ids.has(f.id)).map((f) => structuredClone(f));
    return {
      product: p.product,
      replica: p.replica,
      frames: [...(have?.frames ?? []), ...added],
      outbox: have?.outbox ?? [],
      acked: [...(have?.acked ?? []), ...added.map((f) => f.id)],
    };
  });
  for (const own of into.profiles)
    if (!merged.some((m) => m.replica === own.replica)) merged.push(own);
  into.profiles = merged;
  into.active ??= merged.at(-1)!.replica;
  into.revision += 1;
  target.record = JSON.stringify(into);
}
const unchanged = async (n: MemoryNative, run: () => Promise<unknown>, pattern: RegExp) => {
  const before = n.record;
  await assert.rejects(run(), pattern);
  assert.equal(n.record, before, `refusal ${pattern} leaves the saved record untouched`);
};
const flipByte = (b64: string) => {
  const bytes = Buffer.from(b64, "base64");
  bytes[0]! ^= 1;
  return bytes.toString("base64");
};

// Founder: a real Space and Thread, then the hand-configured route list.
const fNative = new MemoryNative();
const fApp = await fresh(fNative);
await fApp.createSpace("Canopy");
await fApp.createThread("Field notes");
const spaceReplica = spaceOf(fApp).replica;
const threadReplica = threadsOf(fApp)[0]!.replica;

// Join intent lifecycle at the workflow level.
const jNative = new MemoryNative();
const jApp = await fresh(jNative);
assert.equal(jNative.creates, 0, "cold start mints no key");
const joinRequest = await jApp.beginJoin();
assert.equal(decodeTreehouseJoinRequest(joinRequest).publicKey, jApp.state.publicKey);
assert.equal(jNative.creates, 1);
assert.equal(jApp.state.intent, null, "the join intent is cleared by the key commit");
assert.equal(jApp.state.profiles.length, 0);
assert.equal(jApp.state.relay, null);
assert.equal(await jApp.beginJoin(), joinRequest, "a second beginJoin repeats the request");
assert.equal(jNative.creates, 1);
const jReopened = await fresh(jNative);
assert.equal(await jReopened.beginJoin(), joinRequest);
assert.equal(jNative.creates, 1, "reopening never mints a key");
await assert.rejects(fApp.beginJoin(), /identity_creation_not_allowed/);
{
  const interrupted = new MemoryNative();
  const app = await fresh(interrupted);
  const commit = interrupted.commit.bind(interrupted);
  let refuse = true;
  interrupted.commit = async (rev, record) => {
    if (refuse && parseState(record).publicKey) throw new Error("disk_write_refused");
    return commit(rev, record);
  };
  await assert.rejects(app.beginJoin(), /disk_write_refused/);
  assert.equal(parseState(interrupted.record).intent?.kind, "join");
  assert.equal(interrupted.creates, 1);
  refuse = false;
  const retry = await fresh(interrupted);
  assert.equal(
    decodeTreehouseJoinRequest(await retry.beginJoin()).publicKey,
    retry.state.publicKey,
  );
  assert.equal(interrupted.creates, 1, "the interrupted join reuses its single key");
  const pending = new MemoryNative();
  const space = await fresh(pending);
  const pendingCommit = pending.commit.bind(pending);
  pending.commit = async (rev, record) => {
    if (parseState(record).publicKey) throw new Error("disk_write_refused");
    return pendingCommit(rev, record);
  };
  await assert.rejects(space.createSpace("Half"), /disk_write_refused/);
  await assert.rejects(fresh(pending).then((a) => a.beginJoin()), /different_creation_pending/);
}
console.log("PASS join intent lifecycle: one key, idempotent request, interrupted retry, no reopen minting");

// Founder refusals before any route exists.
await unchanged(fNative, () => fApp.issueInvitation(TRUNCATED_HANDOFF, "joiner"), /wrong_product/);
await unchanged(fNative, () => fApp.issueInvitation(joinRequest, ""), /invalid_local_realm/);
await unchanged(fNative, () => fApp.issueInvitation(joinRequest, "joiner"), /routes_not_configured/);
for (const [list, pattern] of [
  ["not json", /invalid_route_list/],
  [JSON.stringify({ localRealm: "f", routes: [routeEntry(UNKNOWN_REPLICA, 1)] }), /unknown_route_replica/],
  [JSON.stringify({ localRealm: "f", routes: [routeEntry(spaceReplica, 1, { url: "http://127.0.0.1:1" })] }), /invalid_route/],
  [JSON.stringify({ localRealm: "f", routes: [routeEntry(spaceReplica, 1, { url: "ws://example.com:80" })] }), /invalid_route/],
  [JSON.stringify({ localRealm: "f", routes: [routeEntry(spaceReplica, 1, { expectedPeerPubkey: "AAAA" })] }), /invalid_route/],
  [JSON.stringify({ localRealm: "f", routes: [routeEntry(spaceReplica, 1), routeEntry(spaceReplica, 2)] }), /duplicate_route/],
  [JSON.stringify({ localRealm: "f", routes: [1, 2, 3, 4, 5].map((i) => routeEntry(spaceReplica, i)) }), /too_many_routes/],
] as const)
  await unchanged(fNative, () => fApp.configureRoutes(list), pattern);
await fApp.configureRoutes(routeList(fApp, "founder", 1));
assert.equal(fApp.state.relay!.routes.length, 1);
assert.equal(fApp.state.relay!.localRealm, "founder");
await unchanged(fNative, () => fApp.issueInvitation(joinRequest, "joiner"), /thread_scope_exceeds_routes/);
const beforeSame = fNative.record;
await fApp.configureRoutes(routeList(fApp, "founder", 1));
assert.equal(fNative.record, beforeSame, "the same route list is a no-op");
await unchanged(
  fNative,
  () =>
    fApp.configureRoutes(
      JSON.stringify({ localRealm: "founder", routes: [routeEntry(spaceReplica, 9999)] }),
    ),
  /relay_already_configured/,
);
await fApp.configureRoutes(routeList(fApp, "founder"));
assert.equal(fApp.state.relay!.routes.length, 2, "adding the Thread route extends the set");
console.log("PASS route list validation, no-op repeat, no replacement, extension only");

// Issue the invitation (Sign only: no network exists in this module).
const revBeforeIssue = fApp.state.revision;
const offer = await fApp.issueInvitation(joinRequest, "joiner");
const offered = decodeTreehouseOffer(offer);
assert.equal(offered.space, spaceReplica);
assert.deepEqual(offered.threads, [{ replica: threadReplica, archived: false }]);
assert.equal(offered.localRealm, "joiner");
assert.equal(offered.routes.length, 2);
assert.equal(fApp.state.revision, revBeforeIssue + 1);
assert.equal(spaceOf(fApp).outbox.includes(offered.invitationId), true);
assert(!offer.includes(Buffer.from(fNative.seed!).toString("base64")), "no seed in the offer");
assert.equal(await fApp.issueInvitation(joinRequest, "joiner"), offer, "reissue reuses the invitation");
assert.equal(fApp.state.revision, revBeforeIssue + 1);
{
  // Four honored Threads cannot be carried by the four-route lite shell.
  const capNative = new MemoryNative();
  const cap = await fresh(capNative);
  await cap.createSpace("Wide");
  for (const t of ["A", "B", "C", "D"]) await cap.createThread(t);
  await cap.configureRoutes(
    JSON.stringify({
      localRealm: "founder",
      routes: cap.state.profiles.slice(0, 4).map((p, i) => routeEntry(p.replica, 47100 + i)),
    }),
  );
  await unchanged(capNative, () => cap.issueInvitation(joinRequest, "joiner"), /thread_scope_exceeds_routes/);
  // With a relay configured, a fourth Thread is refused before it is authored.
  const small = new MemoryNative();
  const smallApp = await fresh(small);
  await smallApp.createSpace("Small");
  for (const t of ["A", "B", "C"]) await smallApp.createThread(t);
  await smallApp.configureRoutes(routeList(smallApp, "founder"));
  await unchanged(small, () => smallApp.createThread("D"), /thread_cap_reached/);
}
console.log("PASS invitation issue, reissue idempotence, route cap refusals");

// Joiner: Use (review) persists nothing, confirm persists routes, wrong input changes nothing.
const tamper = (edit: (o: ReturnType<typeof decodeTreehouseOffer>) => void) => {
  const o = structuredClone(offered);
  edit(o);
  return encodeTreehouseOffer(o);
};
await unchanged(jNative, () => jApp.useOffer(joinRequest), /wrong_product/);
await unchanged(jNative, () => jApp.useOffer(TRUNCATED_HANDOFF), /wrong_product/);
await unchanged(jNative, () => jApp.useOffer(tamper((o) => { o.routes[0]!.url = "ws://example.com:80"; })), /invalid_route/);
await unchanged(jNative, () => jApp.useOffer(tamper((o) => { o.routes[0]!.expectedPeerPubkey = "AAAA"; })), /invalid_route/);
await unchanged(jNative, () => jApp.useOffer(tamper((o) => { o.routes.pop(); })), /route_replica_mismatch/);
await unchanged(jNative, () => jApp.useOffer(tamper((o) => { o.localRealm = "  "; })), /invalid_local_realm/);
await unchanged(jNative, () => jApp.confirmOffer(), /no_pending_offer/);
{
  const coldNative = new MemoryNative();
  const cold = await fresh(coldNative);
  await unchanged(coldNative, () => cold.useOffer(offer), /join_not_begun/);
  assert.equal(coldNative.creates, 0);
  assert.equal(coldNative.record, null);
  const otherNative = new MemoryNative();
  const other = await fresh(otherNative);
  await other.createSpace("Elsewhere");
  await unchanged(otherNative, () => other.useOffer(offer), /wrong_replica/);
}
const beforeUse = jNative.record;
const review = await jApp.useOffer(offer);
assert.equal(jNative.record, beforeUse, "Use is review only");
assert.equal(review.space, spaceReplica);
assert.equal(review.routes.length, 2);
assert.equal(review.routes[0]!.expectedPeerPubkey, SERVER_KEY);
assert.equal(review.invitationVerified, false, "the invitation cannot be verified before the Space is pulled");
const revBeforeConfirm = jApp.state.revision;
await jApp.confirmOffer();
assert.equal(jApp.state.revision, revBeforeConfirm + 1);
assert.equal(jApp.state.relay!.localRealm, "joiner");
assert.deepEqual(
  jApp.state.relay!.routes.map((r) => r.replica),
  [spaceReplica, threadReplica],
);
const afterConfirm = jNative.record;
await jApp.useOffer(offer);
await jApp.confirmOffer();
assert.equal(jNative.record, afterConfirm, "a second confirm of the same offer is a no-op");
await unchanged(jNative, () => jApp.acceptInvitation(offer), /space_unavailable/);
console.log("PASS offer review, confirmation and wrong-input refusals leave the record unchanged");

// A second prospective joiner, used for recipient-binding negatives.
const j2Native = new MemoryNative();
const j2 = await fresh(j2Native);
const j2Request = await j2.beginJoin();
await j2.useOffer(offer);
await j2.confirmOffer();

// Stand in for the first verified pull on both joiners.
copyHistory(jNative, fNative);
copyHistory(j2Native, fNative);
const jPulled = await fresh(jNative);
const j2Pulled = await fresh(j2Native);
assert.equal((await jPulled.useOffer(offer)).invitationVerified, true);
await unchanged(jNative, () => jPulled.acceptInvitation(tamper((o) => { o.invitationId = "not-an-op"; })), /invitation_not_found/);
await unchanged(jNative, () => jPulled.acceptInvitation(tamper((o) => { o.threads = []; o.routes.pop(); })), /offer_scope_mismatch/);
await unchanged(jNative, () => jPulled.acceptInvitation(tamper((o) => { o.routes[0]!.url = "ws://127.0.0.1:1"; })), /offer_not_confirmed/);
await unchanged(j2Native, () => j2Pulled.acceptInvitation(offer), /wrong_recipient/);
await unchanged(jNative, () => jPulled.acceptInvitation(joinRequest), /wrong_product/);
const beforeAccept = jNative.record;
const acceptanceText = await jPulled.acceptInvitation(offer);
assert.equal(jNative.record, beforeAccept, "accepting signs but persists nothing");
const acceptance = decodeTreehouseAcceptance(acceptanceText);
assert.equal(acceptance.replica, spaceReplica);
assert.equal(acceptance.invitationId, offered.invitationId);
assert.equal(acceptance.recipient, jPulled.state.publicKey);
assert.equal(await jPulled.acceptInvitation(offer), acceptanceText, "the signed acceptance is deterministic");
console.log("PASS acceptance: wrong recipient, scope, route and replica refusals; acceptance signs only");

// Joiner has no grant yet: the shell refuses locally, and a forged grantless post quarantines exactly.
assert.equal(jPulled.canAuthor(threadReplica, "post"), false);
await unchanged(jNative, () => jPulled.command(threadReplica, { command: "post", text: "too early" }), /no_capability/);
{
  const forged = clone(jNative);
  const state = parseState(forged.record);
  const thread = state.profiles.find((p) => p.replica === threadReplica)!;
  const pubkey = Uint8Array.from(Buffer.from(state.publicKey!, "base64"));
  const post = await authorTreehouseCommand({
    product: "Treehouse.Thread",
    replica: threadReplica,
    deps: [thread.frames.at(-1)!.id],
    capId: null,
    signer: { publicKey: pubkey, sign: async (bytes) => ed25519.sign(bytes, forged.seed!) },
    command: { command: "post", text: "grantless" },
  });
  thread.frames.push(post);
  thread.outbox.push(post.id);
  forged.record = JSON.stringify(state);
  const reader = await fresh(forged);
  assert.equal(reader.views.get(threadReplica)!.quarantineReasons.get(post.id), "no_capability");
  assert.equal(reader.views.get(threadReplica)!.posts.length, 0);
}

// Founder: admit and grant.
const wrongAcceptance = (edit: (a: typeof acceptance) => void) => {
  const a = structuredClone(acceptance);
  edit(a);
  return encodeTreehouseAcceptance(a);
};
await unchanged(fNative, () => fApp.admitAndGrant(offer), /wrong_product/);
await unchanged(fNative, () => fApp.admitAndGrant(wrongAcceptance((a) => { a.acceptance = flipByte(a.acceptance); })), /invalid_acceptance/);
await unchanged(fNative, () => fApp.admitAndGrant(wrongAcceptance((a) => { a.replica = threadReplica; })), /wrong_replica/);
await unchanged(fNative, () => fApp.admitAndGrant(wrongAcceptance((a) => { a.recipient = decodeTreehouseJoinRequest(j2Request).publicKey; })), /wrong_recipient/);
await unchanged(jNative, () => jPulled.admitAndGrant(acceptanceText), /no_capability/);
{
  // Scope drift: a Thread added after the invitation makes the signed scope stale.
  const drift = clone(fNative);
  const driftApp = await fresh(drift);
  await driftApp.createThread("Added later");
  await unchanged(drift, () => driftApp.admitAndGrant(acceptanceText), /stale_scope/);
  const driftJoiner = clone(jNative);
  copyHistory(driftJoiner, drift);
  await unchanged(driftJoiner, async () => (await fresh(driftJoiner)).acceptInvitation(offer), /stale_scope/);
  // Revocation closes the invitation for both sides.
  const revoked = clone(fNative);
  const revApp = await fresh(revoked);
  const rs = parseState(revoked.record);
  const sp = rs.profiles.find((p) => p.product === "Treehouse.Space")!;
  const cap = carrierDelegationsFromFrames(sp.frames).find((d) => d.parent_id === null)!;
  const refs = new Set(sp.frames.flatMap((f) => f.deps));
  const revoke = await authorTreehouseCommand({
    product: "Treehouse.Space",
    replica: sp.replica,
    deps: sp.frames.filter((f) => !refs.has(f.id)).map((f) => f.id).sort(),
    capId: cap.id,
    signer: { publicKey: Uint8Array.from(Buffer.from(rs.publicKey!, "base64")), sign: async (b) => ed25519.sign(b, revoked.seed!) },
    command: { command: "revoke_invitation", invitationId: offered.invitationId },
  });
  sp.frames.push(revoke);
  sp.outbox.push(revoke.id);
  rs.revision += 1;
  revoked.record = JSON.stringify(rs);
  const revFounder = await fresh(revoked);
  await unchanged(revoked, () => revFounder.admitAndGrant(acceptanceText), /revoked/);
  const revJoiner = clone(jNative);
  copyHistory(revJoiner, revoked);
  await unchanged(revJoiner, async () => (await fresh(revJoiner)).acceptInvitation(offer), /revoked/);
  void revApp;
}
const revBeforeAdmit = fApp.state.revision;
const spaceFramesBefore = spaceOf(fApp).frames.length;
const threadFramesBefore = threadsOf(fApp)[0]!.frames.length;
const admitted = await fApp.admitAndGrant(acceptanceText);
assert(admitted.admit);
assert.equal(admitted.grants.length, 1);
assert.equal(fApp.state.revision, revBeforeAdmit + 1, "admit and grant persist as one commit");
assert.equal(spaceOf(fApp).frames.length, spaceFramesBefore + 1);
assert.equal(threadsOf(fApp)[0]!.frames.length, threadFramesBefore + 1);
assert(spaceOf(fApp).outbox.includes(admitted.admit!));
const grantFrame = threadsOf(fApp)[0]!.frames.find((f) => f.id === admitted.grants[0])!;
const grantDelegation = carrierDelegationsFromFrames([grantFrame as CarrierOpFrame])[0]!;
assert.equal(grantDelegation.audience, acceptance.recipient);
assert.deepEqual([...grantDelegation.ops].sort(), ["author_edit", "author_tombstone", "post"]);
assert.equal(fApp.views.get(spaceReplica)!.quarantineReasons.size, 0);
const afterAdmit = fNative.record;
const replay = await fApp.admitAndGrant(acceptanceText);
assert.deepEqual(replay, { admit: null, grants: [] });
assert.equal(fNative.record, afterAdmit, "a replayed admit authors nothing and persists nothing");
console.log("PASS admit and grant: negatives, drift, revocation, one commit and idempotent replay");

// Joiner posts under the member capability, founder pulls it.
copyHistory(jNative, fNative);
const jMember = await fresh(jNative);
assert.equal(jMember.canAuthor(threadReplica, "post"), true);
assert.equal(jMember.canAuthor(threadReplica, "archive_thread"), false);
const memberPost = await jMember.command(threadReplica, { command: "post", text: "Hello from the member" });
const memberView = jMember.views.get(threadReplica)!;
assert.equal(memberView.posts.at(-1)!.id, memberPost);
assert.equal(memberView.posts.at(-1)!.author, jMember.state.publicKey);
assert.equal(memberView.quarantineReasons.size, 0);
assert(jMember.state.profiles.find((p) => p.replica === threadReplica)!.outbox.includes(memberPost));
await jMember.command(threadReplica, { command: "author_edit", postId: memberPost, targetId: memberPost, text: "Edited by member" });
assert.equal(jMember.views.get(threadReplica)!.posts.at(-1)!.text, "Edited by member");
await unchanged(jNative, () => jMember.command(threadReplica, { command: "archive_thread" }), /no_capability/);
await assert.rejects(jMember.createThread("Not allowed"), /root_capability_unavailable/);
copyHistory(fNative, jNative);
const founderAfter = await fresh(fNative);
assert.equal(founderAfter.views.get(threadReplica)!.posts.at(-1)!.text, "Edited by member");
assert.equal(founderAfter.views.get(threadReplica)!.quarantineReasons.size, 0);
console.log("PASS member post and edit under the exact-audience grant; founder reads it; no root authority for the member");
