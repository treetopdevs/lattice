import type { MessageLineage } from "../projections/thread_timeline";
import type { DeleteRefusal, Outcome } from "../outcomes";
import { lineageTarget } from "./edit_message";
import { runCommand } from "./pipeline";
import type { CommandContext } from "./pipeline";

/** deleteMessage(thread, ref): author_tombstone, irreversible. The judge requires the root post's author. */
export function deleteMessage(ctx: CommandContext, thread: string, ref: MessageLineage): Promise<Outcome<{ id: string }, DeleteRefusal>> {
  return runCommand(ctx, {
    replica: thread,
    product: "Treehouse.Thread",
    command: (frames) => ({ command: "author_tombstone", postId: ref.root, targetId: lineageTarget(thread, frames, ref.root) }),
  });
}
