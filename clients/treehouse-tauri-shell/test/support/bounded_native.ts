import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519.js";
import { parseState } from "../../src/treehouse_state";
import { FaultNative } from "./fault_native";

/** Shared fault-injecting seed store for workflow tests, never packaged evidence. */
export class BoundedNative extends FaultNative {
  children = new Map<string, Uint8Array>();
  bindings = new Set<string>();
  outOfScope = new Set<string>();
  created = 0;
  failAfterKey = false;
  failAfterWrite = false;
  async initializeThread(nonce: string) {
    const state = parseState(this.record);
    let seed = this.children.get(nonce);
    if (!seed) {
      if (this.bindings.has(nonce)) throw Error("thread_key_missing");
      if (state.profiles.some((p) => p.replica.startsWith(`replica:treehouse:thread:${nonce}#`))) throw Error("thread_key_missing");
      if (state.intent?.nonce !== nonce || !state.intent.setup) throw Error("thread_key_unbound");
      seed = crypto.getRandomValues(new Uint8Array(32)); this.children.set(nonce, seed); this.bindings.add(nonce); this.created++;
    }
    if (this.failAfterKey) this.failCommit = true;
    return Buffer.from(ed25519.getPublicKey(seed)).toString("base64");
  }
  async threadIdentity(nonce: string) {
    if (this.outOfScope.has(nonce)) throw Error("thread_key_not_in_scope");
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
    const old = parseState(this.record), candidate = parseState(next);
    if (old.intent?.setup && !candidate.intent && candidate.profiles.length === old.profiles.length) {
      if (!this.bindings.has(old.intent.nonce) || this.children.has(old.intent.nonce)) throw Error("thread_abandon_not_allowed");
    }
    const committed = await super.commit(expected, next);
    if (committed && this.failAfterWrite && parseState(next).intent === null) throw Error("uncertain_write");
    return committed;
  }
}
