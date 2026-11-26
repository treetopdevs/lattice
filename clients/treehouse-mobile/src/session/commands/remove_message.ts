import type { MessageLineage } from "../projections/thread_timeline";
import type { Outcome, RemoveRefusal } from "../outcomes";
import { lineageTarget } from "./edit_message";
import { runCommand } from "./pipeline";
import type { CommandContext } from "./pipeline";

/**
 * removeMessage(thread, ref): moderator_tombstone. Needs a live grant carrying the moderator role
 * (`no_capability` otherwise) and the judge's current moderator holder (`not_holder` from the pre-judge).
 * Allowed on an archived Thread, as the judge allows it.
 */
export function removeMessage(ctx: CommandContext, thread: string, ref: MessageLineage): Promise<Outcome<{ id: string }, RemoveRefusal>> {
  return runCommand(ctx, {
    replica: thread,
    product: "Treehouse.Thread",
    command: (frames) => ({ command: "moderator_tombstone", postId: ref.root, targetId: lineageTarget(thread, frames, ref.root) }),
  });
}
