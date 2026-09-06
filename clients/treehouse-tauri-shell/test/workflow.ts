import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
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
migrationNative.record = JSON.stringify(oldEnvelope);
const migrated = new TreehouseWorkflow(migrationNative);
await migrated.open();
assert.equal(JSON.parse(migrationNative.record!).version, 1);
assert.deepEqual(migrated.state.profiles, oldEnvelope.profiles);
assert.equal(migrated.state.revision, oldEnvelope.revision + 1);
const migrationAgain = new TreehouseWorkflow(migrationNative);
await migrationAgain.open();
assert.deepEqual(migrationAgain.state, migrated.state);
console.log(
  "PASS authenticated N-1 metadata migration retains exact signed frames and current reopen",
);

const { authorTreehouseCommand, carrierDelegationsFromFrames } = await import(
  "@treetopdevs/lattice-client"
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
