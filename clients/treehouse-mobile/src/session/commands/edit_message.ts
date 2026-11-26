import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { MessageLineage } from "../projections/thread_timeline";
import type { EditRefusal, Outcome } from "../outcomes";
import { projectThreadTimeline } from "../projections/thread_timeline";
import { checkText } from "./post_message";
import { runCommand } from "./pipeline";
import type { CommandContext } from "./pipeline";

/**
 * The edit or tombstone target for a message: the latest edit of its lineage as the held timeline shows it
 * (the same LWW winner the text comes from), never the caller's `ref.latest`, which may be stale. A root
 * the timeline does not show (unknown, quarantined, not a post) is passed through unchanged, so the judge
 * names the denial (missing target, quarantined target, wrong target kind).
 */
export function lineageTarget(thread: string, frames: readonly CarrierOpFrame[], root: string): string {
  const timeline = projectThreadTimeline({ replica: thread, profile: { frames: [...frames], outbox: [], acked: [] }, myKey: null, route: null });
  return timeline.messages.find((m) => m.id === root)?.ref.latest ?? root;
}

/** editMessage(thread, ref, text): author_edit of ref.root, targeting the lineage's latest edit. */
export async function editMessage(
  ctx: CommandContext,
  thread: string,
  ref: MessageLineage,
  rawText: string,
): Promise<Outcome<{ id: string }, EditRefusal>> {
  const checked = checkText(rawText);
  if (!checked.ok) return checked;
  const text = checked.value;
  return runCommand(ctx, {
    replica: thread,
    product: "Treehouse.Thread",
    command: (frames) => ({ command: "author_edit", postId: ref.root, targetId: lineageTarget(thread, frames, ref.root), text }),
  });
}
