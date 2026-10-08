import { ed25519 } from "@noble/curves/ed25519.js";
import { parseState } from "../../src/treehouse_state";
import type { Draft, PreviewNative } from "../../src/treehouse_state";

/**
 * In-memory native adapter with fault injection. This is the named test double of the Slice 3 and
 * Slice 4 headless gates; the packaged job never uses it. Faults: a failing `commit` (the disk
 * refuses the write after the relay already acknowledged) and a commit trace for ordering checks.
 */
export class FaultNative implements PreviewNative {
  record: string | null = null;
  seed: Uint8Array | null = null;
  writes = 0;
  failCommit = false;
  readonly trace: string[];
  drafts = new Map<string, Draft>();
  constructor(trace: string[] = []) {
    this.trace = trace;
  }
  async open() {
    return {
      record: this.record,
      publicKey: this.seed ? Buffer.from(ed25519.getPublicKey(this.seed)).toString("base64") : null,
      keyStatus: (this.seed
        ? "available"
        : parseState(this.record).publicKey
          ? "missing"
          : "absent") as "available" | "missing" | "absent",
    };
  }
  async initialize() {
    if (!this.seed) this.seed = crypto.getRandomValues(new Uint8Array(32));
    return (await this.open()).publicKey!;
  }
  async commit(expected: number, next: string) {
    this.trace.push("commit");
    if (this.failCommit) throw new Error("disk_write_refused");
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
