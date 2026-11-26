import type { ArchiveRefusal, Outcome } from "../outcomes";
import { runCommand } from "./pipeline";
import type { CommandContext } from "./pipeline";

/**
 * archiveThread(thread): archive_thread, moderator holder only. Afterwards the judge refuses post, author
 * edit and author delete as `archived thread`; a moderator remove still counts. No early refusal here: the
 * pre-judge decides.
 */
export function archiveThread(ctx: CommandContext, thread: string): Promise<Outcome<{ id: string }, ArchiveRefusal>> {
  return runCommand(ctx, { replica: thread, product: "Treehouse.Thread", command: { command: "archive_thread" } });
}
