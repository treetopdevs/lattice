import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import { FaultNative } from "./support/fault_native";
import { resolveContinuationProfileFromFrames, carrierDelegationsFromFrames, authorTownshipRevocation } from "@treetopdevs/lattice-client";

const pub = (n: number) => Buffer.from(ed25519.getPublicKey(new Uint8Array(32).fill(n))).toString("base64");
const setup = { nominee: pub(101), witnesses: [102, 103, 104].map(pub), threshold: 2, maxLeaseEpochs: 7 };
class BoundedNative extends FaultNative {
  children = new Map<string, Uint8Array>();
  created = 0;
  failAfterKey = false;
  failAfterWrite = false;
  async initializeThread(nonce: string) {
    const state = parseState(this.record);
    let seed = this.children.get(nonce);
    if (!seed) {
      if (state.profiles.some((p) => p.replica.startsWith(`replica:treehouse:thread:${nonce}#`))) throw Error("thread_key_missing");
      if (state.intent?.nonce !== nonce || !state.intent.setup) throw Error("thread_key_unbound");
      seed = crypto.getRandomValues(new Uint8Array(32)); this.children.set(nonce, seed); this.created++;
    }
    if (this.failAfterKey) this.failCommit = true;
    return Buffer.from(ed25519.getPublicKey(seed)).toString("base64");
  }
  async threadIdentity(nonce: string) {
    const held = parseState(this.record).profiles.some((p) => p.replica.startsWith(`replica:treehouse:thread:${nonce}#`));
    if (!held) throw Error("thread_key_unbound");
    if (!this.children.has(nonce)) throw Error("thread_key_missing");
    return this.initializeThread(nonce);
  }
  async signThread(nonce: string, bytes: Uint8Array) {
    assert(bytes.byteLength <= 64_000, "native signing limit");
    const seed = this.children.get(nonce);
    if (!seed) throw Error("thread_key_missing");
    return ed25519.sign(bytes, seed);
  }
  async commit(expected: number, next: string) {
    const committed = await super.commit(expected, next);
    if (committed && this.failAfterWrite && parseState(next).intent === null) throw Error("uncertain_write");
    return committed;
  }
}
const native = new BoundedNative();
let app = new TreehouseWorkflow(native);
await app.open(); await app.createSpace("Canopy");
const before = native.record;
await assert.rejects(() => app.createThread("Too many witnesses", { ...setup, witnesses: Array.from({ length: 17 }, (_, i) => pub(120 + i)) }), /invalid_thread_setup/);
assert.equal(native.record, before);
assert.equal(native.created, 0);
await assert.rejects(() => app.createThread("Invalid", { ...setup, threshold: 4 }), /invalid_thread_setup/);
assert.equal(native.record, before);
native.failAfterKey = true;
await assert.rejects(() => app.createThread("General", setup), /disk_write_refused/);
const intent = app.state.intent!;
assert.deepEqual(intent.setup, setup);
assert.equal(app.state.profiles.length, 1, "no half-Thread/reference/admission is published");
assert.equal(native.created, 1);
const pendingKey = await native.initializeThread(intent.nonce);
native.failAfterKey = false; native.failCommit = false;
app = new TreehouseWorkflow(native); await app.open(); await app.resumeCreation();
const child = app.state.profiles.find((p) => p.product === "Treehouse.Thread")!;
const root = child.frames.find((f) => f.deps.length === 0)!;
assert.equal(root.author, pendingKey);
assert.notEqual(root.author, app.state.publicKey);
assert.equal(native.created, 1);
assert.equal(app.state.intent, null);
const pin = await resolveContinuationProfileFromFrames({ replica: child.replica, frames: child.frames });
assert(pin.ok);
if (pin.ok) assert.deepEqual(pin.profile.witnesses, [...setup.witnesses].sort());
const grants = carrierDelegationsFromFrames(child.frames).filter((d) => d.audience === app.state.publicKey);
assert(grants.some((d) => d.ops.includes("post")));
assert.deepEqual(app.views.get(app.state.profiles[0]!.replica)!.state.members, [app.state.publicKey]);
await app.command(child.replica, { command: "post", text: "Participant post" });
const post = app.state.profiles[1]!.frames.at(-1)!;
assert.equal(post.author, app.state.publicKey);
if (process.env.TREEHOUSE_BOUNDED_CREATION_ARTIFACT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.TREEHOUSE_BOUNDED_CREATION_ARTIFACT, JSON.stringify({
    version: 1, product: "treehouse", readiness: "recovery_not_ready", publicKey: app.state.publicKey,
    profiles: app.state.profiles.map((profile) => {
      const view = app.views.get(profile.replica)!;
      return { ...profile, expect: { state: view.state, posts: view.posts, order: view.order,
        quarantine: [...view.quarantineReasons].sort(), operationCount: view.operationCount } };
    }),
  }));
}
const persisted = native.record;
app = new TreehouseWorkflow(native); await app.open();
assert.equal(native.record, persisted, "reopen does not write history");
assert.equal(native.created, 1);
assert(app.canAuthor(child.replica, "archive_thread"));
await app.command(child.replica, { command: "archive_thread" });
assert.equal(app.state.profiles[1]!.frames.at(-1)!.author, pendingKey, "moderation uses the native child signer");
assert.equal(app.views.get(child.replica)!.state.archived, true);

// A completed uncertain write is recognized; a missing child key is never replaced.
native.failAfterWrite = true;
await app.createThread("Second", setup);
assert.equal(app.state.profiles.length, 3);
assert.equal(native.created, 2);
native.failAfterWrite = false;
const second = app.state.profiles[2]!;
const secondNonce = second.replica.split(":")[3]!.split("#")[0]!;
const secondKey = await native.initializeThread(secondNonce);
const secondGrant = carrierDelegationsFromFrames(second.frames).find((d) => d.audience === app.state.publicKey)!;
const revoke = await authorTownshipRevocation({ replica: second.replica,
  signer: { publicKey: Buffer.from(secondKey, "base64"), sign: (bytes) => native.signThread(secondNonce, bytes) },
  deps: [second.frames.at(-1)!.id], delegationId: secondGrant.id });
const revoked = structuredClone(app.state); revoked.revision++; revoked.profiles[2]!.frames.push(revoke);
assert(await native.commit(app.state.revision, JSON.stringify(revoked)));
app = new TreehouseWorkflow(native); await app.open();
assert(!app.canAuthor(second.replica, "post"));
assert(app.canAuthor(second.replica, "archive_thread"));
const beforeRefusedPost = native.record;
await assert.rejects(() => app.command(second.replica, { command: "post", text: "Must refuse" }), /no_capability/);
assert.equal(native.record, beforeRefusedPost, "no child-root posting fallback after participant revocation");
const beforeAdditional = native.record;
await assert.rejects(() => app.createThread("Blocked", setup), /existing_thread_grant_unavailable/);
assert.equal(native.record, beforeAdditional, "a revoked existing grant refuses before persisting a new intent");
assert.equal(native.created, 2);
native.children.delete(intent.nonce);
app = new TreehouseWorkflow(native); await app.open();
assert.equal(app.threadKeyIssue(child.replica), "thread_key_missing");
assert(!app.canAuthor(child.replica, "archive_thread"));
assert.equal(native.created, 2);
assert.equal(app.views.get(child.replica)!.state.title, "General");


const capNative = new BoundedNative();
const capApp = new TreehouseWorkflow(capNative); await capApp.open(); await capApp.createSpace("Scope cap");
for (const title of ["One", "Two", "Three"]) await capApp.createThread(title, setup);
const beforeFourth = capNative.record;
await assert.rejects(() => capApp.createThread("Fourth", setup), /thread_cap_reached/);
assert.equal(capNative.record, beforeFourth);
assert.equal(capNative.created, 3);
const malformed = { ...parseState(capNative.record), intent: { kind: "thread", name: "Bad", nonce: "A".repeat(43), setup: null } };
assert.throws(() => parseState(JSON.stringify(malformed)), /invalid_creation_intent/);
const firstCapChild = capApp.state.profiles[1]!;
const firstCapNonce = firstCapChild.replica.split(":")[3]!.split("#")[0]!;
const childRoot = await capNative.threadIdentity(firstCapNonce);
const genesisCap = carrierDelegationsFromFrames(firstCapChild.frames).find((d) => d.parent_id === null && d.ops.includes("archive_thread"))!;
const rootRevoke = await authorTownshipRevocation({ replica: firstCapChild.replica,
  signer: { publicKey: Buffer.from(childRoot, "base64"), sign: (bytes) => capNative.signThread(firstCapNonce, bytes) },
  deps: [firstCapChild.frames.at(-1)!.id], delegationId: genesisCap.id });
const withoutRoot = structuredClone(capApp.state); withoutRoot.revision++; withoutRoot.profiles[1]!.frames.push(rootRevoke);
assert(await capNative.commit(capApp.state.revision, JSON.stringify(withoutRoot)));
const noRoot = new TreehouseWorkflow(capNative); await noRoot.open();
assert(!noRoot.canAuthor(firstCapChild.replica, "archive_thread"), "empty continuation pin grants no moderation");
await assert.rejects(() => noRoot.command(firstCapChild.replica, { command: "archive_thread" }), /no_capability/);

const maxNative = new BoundedNative(); const maxApp = new TreehouseWorkflow(maxNative);
await maxApp.open(); await maxApp.createSpace("Maximum setup");
const sizeBefore = Buffer.byteLength(maxNative.record!);
await maxApp.createThread("x".repeat(16_384), { ...setup, witnesses: Array.from({ length: 16 }, (_, i) => pub(120 + i)) });
assert(Buffer.byteLength(maxNative.record!) - sizeBefore < 131_072, "maximum title/profile fits the reserved creation transaction");
console.log("PASS bounded workflow: atomic creation, independent custody, exact retry, restart, participant posting, root moderation and missing-key refusal");
