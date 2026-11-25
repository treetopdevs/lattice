import type { LocalStore } from "../../local/local_store";
import { ok, refuse } from "../outcomes";
import type { LinkRefusal, Outcome } from "../outcomes";
import type { FeedState, RelayLink } from "../ports";

// Link commands (03): goOnline, goOffline, syncNow over the RelayLink. The person's choice is the
// `syncEnabled` setting (the Offline pill). History that failed its check never goes online, so nothing more
// is merged into it. Route states stay shell-kit's; a refused or reconnecting route is not a refusal here.

export interface LinkContext {
  link: RelayLink;
  local: LocalStore;
  historyOk(): boolean;
  /** False when the key and the held history disagree (02 Invariant 8): nothing goes online. */
  identityOk(): boolean;
}

async function attempt(step: () => Promise<FeedState>): Promise<Outcome<FeedState, LinkRefusal>> {
  try {
    return ok(await step());
  } catch {
    return refuse("link_failed");
  }
}

async function setSync(ctx: LinkContext, enabled: boolean): Promise<LinkRefusal | null> {
  try {
    await ctx.local.setSetting("syncEnabled", enabled);
    return null;
  } catch {
    return "storage_failed";
  }
}

/** Turn sync on: start the link (its feed syncs on start). */
export async function goOnline(ctx: LinkContext): Promise<Outcome<FeedState, LinkRefusal>> {
  if (!ctx.historyOk()) return refuse("history_invalid");
  if (!ctx.identityOk()) return refuse("identity_mismatch");
  const failed = await setSync(ctx, true);
  if (failed) return refuse(failed);
  return attempt(async () => {
    await ctx.link.start();
    return ctx.link.state();
  });
}

/** Turn sync off: stop the link and close its sockets. Saved posts stay on this phone. */
export async function goOffline(ctx: LinkContext): Promise<Outcome<FeedState, LinkRefusal>> {
  const failed = await setSync(ctx, false);
  if (failed) return refuse(failed);
  return attempt(async () => {
    await ctx.link.stop();
    return ctx.link.state();
  });
}

/** Sync now. While sync is off the link dials nothing and reports its idle state. */
export async function syncNow(ctx: LinkContext): Promise<Outcome<FeedState, LinkRefusal>> {
  if (!ctx.historyOk()) return refuse("history_invalid");
  if (!ctx.identityOk()) return refuse("identity_mismatch");
  if (!ctx.local.setting("syncEnabled")) return ok(ctx.link.state());
  return attempt(() => ctx.link.syncNow());
}
