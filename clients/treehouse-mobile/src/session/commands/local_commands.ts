import type { Draft, LocalStore } from "../../local/local_store";
import { ok, refuse } from "../outcomes";
import type { LocalRefusal, Outcome } from "../outcomes";

// Device-local commands (03): petname, draft, read marker. No op is authored and nothing reaches the
// replica store; the LocalStore normalizes (petnames trimmed and capped, read ids additive).

const local = async (write: () => Promise<void>): Promise<Outcome<null, LocalRefusal>> => {
  try {
    await write();
    return ok(null);
  } catch {
    return refuse("storage_failed");
  }
};

export const setPetname = (store: LocalStore, pubkey: string, name: string | null) => local(() => store.setPetname(pubkey, name));

export const saveDraft = (store: LocalStore, thread: string, draft: Draft | null) => local(() => store.saveDraft(thread, draft));

export const markRead = (store: LocalStore, thread: string, ids: readonly string[]) => local(() => store.markRead(thread, ids));
