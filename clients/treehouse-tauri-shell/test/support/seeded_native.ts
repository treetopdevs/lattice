import { ed25519 } from "@noble/curves/ed25519.js";
import { parseState } from "../../src/treehouse_state";
import type { Draft, PreviewNative } from "../../src/treehouse_state";

/**
 * In-memory native adapter with a fixed test seed. This is the named test double of the Slice 4
 * headless gate; the packaged job never uses it. The seed is a public synthetic test string's hash, so
 * the relay manifest can pre-seed transport admission before the app exists. Like the dev-trace seam
 * it plans for the packaged variant, the key reads as absent until the saved record holds a public key
 * or a creation intent, so first launch is still an explicit creation and never a mismatch.
 */
export class SeededNative implements PreviewNative {
  record: string | null = null;
  creates = 0;
  drafts = new Map<string, Draft>();
  constructor(private readonly seed: Uint8Array) {}
  private publicKey() {
    return Buffer.from(ed25519.getPublicKey(this.seed)).toString("base64");
  }
  async open() {
    const saved = parseState(this.record);
    const keyed = saved.publicKey !== null || saved.intent !== null;
    return {
      record: this.record,
      publicKey: keyed ? this.publicKey() : null,
      keyStatus: (keyed ? "available" : "absent") as "available" | "absent",
    };
  }
  async initialize() {
    this.creates++;
    return this.publicKey();
  }
  async commit(expected: number, next: string) {
    if (parseState(this.record).revision !== expected) return false;
    this.record = next;
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
    return ed25519.sign(bytes, this.seed);
  }
}
