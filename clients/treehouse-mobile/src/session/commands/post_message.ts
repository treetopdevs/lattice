import { carrierOpsToSemanticOps, materialize, treehouseCommandDecoders, treehouseThreadSchema } from "@treetopdevs/lattice-client";
import { MESSAGE_MAX_CHARS, refuse } from "../outcomes";
import type { Outcome, PostRefusal } from "../outcomes";
import { runCommand } from "./pipeline";
import type { CommandContext } from "./pipeline";

/** postMessage(thread, text): text checks first, so a refused text is never signed. */
export async function postMessage(
  ctx: CommandContext,
  thread: string,
  rawText: string,
): Promise<Outcome<{ id: string }, PostRefusal>> {
  const text = rawText.trim();
  if (text.length === 0) return refuse("empty_text");
  if ([...text].length > MESSAGE_MAX_CHARS) return refuse("text_too_long");
  // lattice-client refuses to sign a lone surrogate; say so here rather than as a custody failure.
  if (!wellFormedUtf16(text)) return refuse("malformed_text");
  return runCommand<"archived thread">(ctx, {
    replica: thread,
    product: "Treehouse.Thread",
    command: { command: "post", text },
    refuseEarly(frames) {
      const ops = carrierOpsToSemanticOps([...frames], {}, treehouseCommandDecoders("Treehouse.Thread"));
      return materialize(treehouseThreadSchema, ops).state.archived === true ? "archived thread" : null;
    },
  });
}

/** True unless the text holds a lone UTF-16 surrogate (no String.prototype.isWellFormed reliance on Hermes). */
function wellFormedUtf16(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}
