import { MESSAGE_MAX_CHARS, ok, refuse } from "../outcomes";
import type { Outcome, PostRefusal, TextRefusal } from "../outcomes";
import { runCommand } from "./pipeline";
import type { CommandContext } from "./pipeline";

/** postMessage(thread, text): text checks first, so a refused text is never signed. */
export async function postMessage(
  ctx: CommandContext,
  thread: string,
  rawText: string,
): Promise<Outcome<{ id: string }, PostRefusal>> {
  const checked = checkText(rawText);
  if (!checked.ok) return checked;
  const text = checked.value;
  // No app-side archive check: after the capability check, the pre-judge names "archived thread" itself.
  return runCommand<never>(ctx, {
    replica: thread,
    product: "Treehouse.Thread",
    command: { command: "post", text },
  });
}

/** The message text rules shared by post and edit (O-10): trimmed, non-empty, at most 4,000 code points. */
export function checkText(rawText: string): Outcome<string, TextRefusal> {
  const text = rawText.trim();
  if (text.length === 0) return refuse("empty_text");
  if ([...text].length > MESSAGE_MAX_CHARS) return refuse("text_too_long");
  // lattice-client refuses to sign a lone surrogate; say so here rather than as a custody failure.
  if (!wellFormedUtf16(text)) return refuse("malformed_text");
  return ok(text);
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
