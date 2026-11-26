import type { SessionPhase } from "../session/projections/session_status";
import type { MessageView, PostRefusalReason, ThreadTimeline } from "../session/projections/thread_timeline";
import { cannotPostCopy, phaseCopy, refusalCopy, thread as threadCopy } from "./strings";

// Refusal states on the Thread screen (04, M1b.5). Pure: no react, react-native or expo, so Core tests run
// them. Whether this key may post, and why not, is the timeline's `postRefusal` (the judge's answer); whether
// it was removed from the group is SessionStatus's phase; why a message is not counted is the judge's
// quarantine reason. These helpers only choose the words.

export interface CannotPostInputs {
  postRefusal: PostRefusalReason | null;
  phase: SessionPhase;
  archived: boolean;
}

/**
 * The line that replaces the composer, or null when posting is allowed. An archived thread says so first
 * (the screen shows M1b.6's banner instead, through threadFooter); a key the group removed is told that, since asking for posting back would not help;
 * otherwise the judge's reason with who can fix it.
 */
export function cannotPostLine({ postRefusal, phase, archived }: CannotPostInputs): string | null {
  if (postRefusal === null) return null;
  if (archived || postRefusal === "archived thread") return threadCopy.archived;
  if (phase === "removed") return phaseCopy.removed;
  return cannotPostCopy[postRefusal];
}

/** What sits under the message list (M1b.6): the composer, the archived banner, or the cannot-post bar. */
export type ThreadFooter = { kind: "composer" } | { kind: "archived" } | { kind: "cannot_post"; line: string };

/**
 * M1b.6: an archived thread shows the banner in place of the composer for everyone, moderator included,
 * before any reason that is about this key (removal, a revoked grant); otherwise the M1b.5 line, or the
 * composer when posting is allowed.
 */
export function threadFooter({ timeline, phase }: { timeline: Pick<ThreadTimeline, "archived" | "postRefusal">; phase: SessionPhase }): ThreadFooter {
  if (timeline.archived || timeline.postRefusal === "archived thread") return { kind: "archived" };
  const line = cannotPostLine({ postRefusal: timeline.postRefusal, phase, archived: false });
  return line === null ? { kind: "composer" } : { kind: "cannot_post", line };
}

/** The reason line under a not-counted message of mine, or null for a counted one. */
export function notCountedLine(m: MessageView): string | null {
  if (m.standing !== "not_counted") return null;
  return refusalCopy[m.notCountedReason ?? "quarantined"];
}
