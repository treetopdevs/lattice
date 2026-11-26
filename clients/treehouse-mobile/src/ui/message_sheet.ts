import type { Ability } from "../session/projections/abilities";
import type { MessageLineage, MessageView, ThreadTimeline } from "../session/projections/thread_timeline";
import { actions } from "./strings";
import type { DraftSaver } from "./thread_view";

// The long-press sheet and the composer's edit mode (04 "Long-press sheet", M1b.3). Pure: no react,
// react-native or expo, so Core tests run them. Whether a command is allowed is the Abilities read model's
// answer (the judge's per-command verdict for this key, including the archive rule); whether a message is
// mine, counted or removed is ThreadTimeline's. These helpers only combine the two.
//
// M1b.5: Copy is in the sheet for every message with text (counted or not), so every such bubble opens the
// sheet and none is selectable (iOS would float its own Copy callout over the sheet). The screen does the
// copying (src/ui/clipboard.ts); this module only says Copy is offered. Details is not in the sheet: no
// Message details screen exists yet (PROGRESS).

export type SheetItem = "copy" | "edit" | "delete" | "remove";

/** The items that confirm first and then run a signed command. */
export type ConfirmedItem = Exclude<SheetItem, "copy" | "edit">;

export const sheetItemLabel: Record<SheetItem, string> = {
  copy: actions.copy,
  edit: actions.edit,
  delete: actions.delete,
  remove: actions.remove,
};

type Abilities = Readonly<Record<string, Ability>> | undefined;

const allowed = (abilities: Abilities, command: string) => abilities?.[command]?.allowed === true;

/**
 * 04: Copy for any message with text (a placeholder has none). Edit and Delete for my honored message (the
 * abilities say whether the thread still takes them); Remove as moderator for others' messages when this key
 * may remove. A not-counted message offers only Copy, so it can be posted again: the judge would refuse a
 * change to it as a quarantined target, and a removed one as already tombstoned.
 */
export function sheetItems(m: MessageView, abilities: Abilities): SheetItem[] {
  if (m.removed !== null) return [];
  const items: SheetItem[] = m.text !== "" ? ["copy"] : [];
  if (m.standing !== "honored") return items;
  if (m.mine) {
    if (allowed(abilities, "author_edit")) items.push("edit");
    if (allowed(abilities, "author_tombstone")) items.push("delete");
    return items;
  }
  if (allowed(abilities, "moderator_tombstone")) items.push("remove");
  return items;
}

/**
 * The open sheet, re-read from the current timeline by message id: the latest ref and text, and null when
 * the message is gone or no item is left (deleted or removed elsewhere), so the sheet closes. Since M1b.5 an
 * archived thread leaves Copy, so the sheet stays open with Copy only.
 */
export function sheetFor(
  timeline: ThreadTimeline | null,
  abilities: Abilities,
  id: string,
): { message: MessageView; items: SheetItem[] } | null {
  const message = timeline?.messages.find((m) => m.id === id);
  if (!message) return null;
  const items = sheetItems(message, abilities);
  return items.length === 0 ? null : { message, items };
}

/** 04: irreversible actions confirm once, naming what cannot be undone. Copy and Edit have no confirmation. */
export function confirmationFor(item: SheetItem): { sentence: string; confirm: string } | null {
  if (item === "delete") return { sentence: actions.confirmDelete, confirm: actions.delete };
  if (item === "remove") return { sentence: actions.confirmRemove, confirm: actions.removeConfirm };
  return null;
}

/** The composer's text: the draft (saved on every pause) or, in edit mode, an edit that is never saved. */
export interface ComposerState {
  draft: string;
  edit: { id: string; ref: MessageLineage; text: string; original: string } | null;
}

export const composerText = (s: ComposerState): string => (s.edit ? s.edit.text : s.draft);

/** A keystroke: goes to the edit when editing, else to the draft and its saver. */
export function composerChange(s: ComposerState, text: string, saver: DraftSaver): ComposerState {
  if (s.edit) return { ...s, edit: { ...s.edit, text } };
  saver.change(text);
  return { ...s, draft: text };
}

/** Enter edit mode: the pending draft is saved first, then kept aside untouched until the edit ends. */
export async function beginEdit(
  s: ComposerState,
  target: { id: string; ref: MessageLineage; text: string },
  saver: DraftSaver,
): Promise<ComposerState> {
  await saver.flush();
  return { ...s, edit: { ...target, original: target.text } };
}

/** Leave edit mode (saved or cancelled): the draft comes back as it was. */
export const endEdit = (s: ComposerState): ComposerState => ({ ...s, edit: null });

/** Save is enabled when the edited text is non-empty, differs from the message, and no edit is running. */
export function canSaveEdit(s: ComposerState, busy: boolean): boolean {
  return s.edit !== null && !busy && s.edit.text.trim() !== "" && s.edit.text !== s.edit.original;
}
