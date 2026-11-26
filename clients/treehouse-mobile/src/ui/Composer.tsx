import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { MessageLineage } from "../session/projections/thread_timeline";
import { beginEdit, canSaveEdit, composerChange, composerText, endEdit } from "./message_sheet";
import type { ComposerState } from "./message_sheet";
import { actions, thread as threadCopy } from "./strings";
import type { Palette } from "./theme";
import { canSend, createDraftSaver } from "./thread_view";

// The Thread screen's composer (04, M1b.2). Keystrokes stay here; the draft is saved through the session on
// every pause and when the screen loses focus or closes, so it survives a relaunch. The stored draft fills the
// composer once, and never over text already typed. A post that the session accepts clears the draft.
// M1b.3 edit mode: Edit in the long-press sheet puts the message's text in the composer; those keystrokes
// never reach the draft saver, and saving or cancelling the edit brings the saved draft back unchanged.

const PAUSE_MS = 400;
const MAX_LENGTH = 4000;

interface Props {
  /** The stored draft from the session's `drafts` read model, or null. */
  stored: string | null;
  canPost: boolean;
  /** Space below the bar for the home indicator. */
  bottomInset: number;
  colors: Palette;
  /** Resolves false when the draft was not saved, so the saver tries again. */
  saveDraft(text: string | null): Promise<boolean>;
  /** Posts the text; resolves true when the session accepted it (it is then saved on this phone). */
  post(text: string): Promise<boolean>;
  /** The message being edited (set by the sheet's Edit), or null. */
  editing: { id: string; ref: MessageLineage; text: string } | null;
  /** Signs the edit; resolves true when the session accepted it. */
  saveEdit(ref: MessageLineage, text: string): Promise<boolean>;
  /** The edit ended (saved or cancelled). */
  onEndEdit(): void;
}

export function Composer({ stored, canPost, bottomInset, colors: c, saveDraft, post, editing, saveEdit, onEndEdit }: Props): React.JSX.Element {
  const [state, setState] = useState<ComposerState>({ draft: "", edit: null });
  const [busy, setBusy] = useState(false);
  const input = useRef<React.ComponentRef<typeof TextInput>>(null);
  const text = composerText(state);
  const save = useRef(saveDraft);
  save.current = saveDraft;
  const saver = useMemo(
    () =>
      createDraftSaver({
        save: (value) => save.current(value),
        delayMs: PAUSE_MS,
        timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) },
      }),
    [],
  );

  useEffect(() => {
    const seeded = saver.seed(stored);
    if (seeded !== null) setState((s) => ({ ...s, draft: seeded }));
  }, [saver, stored]);
  useEffect(() => () => void saver.flush(), [saver]);

  // Entering edit mode saves the pending draft first; the draft then waits untouched beside the edit.
  const editingId = editing?.id ?? null;
  useEffect(() => {
    if (!editing) {
      setState(endEdit);
      return;
    }
    let live = true;
    void beginEdit({ draft: "", edit: null }, editing, saver).then((next) => {
      if (!live) return;
      setState((s) => ({ ...s, edit: next.edit }));
      input.current?.focus();
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saver, editingId]);

  // The saver is called here, in the handler, not inside a state updater (which React may run twice or late).
  const stateRef = useRef(state);
  stateRef.current = state;
  const onChange = (next: string) => {
    const updated = composerChange(stateRef.current, next, saver);
    stateRef.current = updated;
    setState(updated);
  };

  const send = async () => {
    if (state.edit) {
      if (!canSaveEdit(state, busy)) return;
      setBusy(true);
      try {
        if (await saveEdit(state.edit.ref, state.edit.text)) {
          setState(endEdit);
          onEndEdit();
        }
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!canSend(text, canPost, busy)) return;
    setBusy(true);
    try {
      if (await post(text)) {
        setState((s) => ({ ...s, draft: "" }));
        await saver.clear();
      }
    } finally {
      setBusy(false);
    }
  };
  const cancelEdit = () => {
    setState(endEdit);
    onEndEdit();
  };

  const isEditing = state.edit !== null;
  const enabled = isEditing ? canSaveEdit(state, busy) : canSend(text, canPost, busy);
  const buttonText = isEditing ? (busy ? actions.savingEdit : actions.saveEdit) : busy ? threadCopy.posting : threadCopy.post;
  return (
    <View style={[styles.wrap, { backgroundColor: c.surface, borderTopColor: c.border, paddingBottom: 8 + bottomInset }]}>
      {isEditing ? (
        <View testID="editing-bar" style={styles.editingBar}>
          <Text style={[styles.editingText, { color: c.muted }]}>{actions.editing}</Text>
          <Pressable
            testID="edit-cancel"
            accessibilityRole="button"
            accessibilityLabel={actions.cancel}
            onPress={cancelEdit}
            disabled={busy}
            hitSlop={8}
          >
            <Text style={[styles.editingCancel, { color: c.accent }]}>{actions.cancel}</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.bar}>
      <TextInput
        ref={input}
        testID="composer"
        accessibilityLabel={isEditing ? actions.editLabel : threadCopy.composerLabel}
        value={text}
        onChangeText={onChange}
        onBlur={() => void saver.flush()}
        editable={!busy}
        placeholder={threadCopy.write}
        placeholderTextColor={c.muted}
        style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
        multiline
        maxLength={MAX_LENGTH}
      />
      <Pressable
        testID="send"
        accessibilityRole="button"
        accessibilityLabel={buttonText}
        accessibilityState={{ disabled: !enabled, busy }}
        disabled={!enabled}
        onPress={() => void send()}
        style={[styles.send, { backgroundColor: enabled ? c.accent : c.border }]}
      >
        <Text style={[styles.sendText, { color: enabled ? c.accentText : c.muted }]}>{buttonText}</Text>
      </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, gap: 6 },
  bar: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  editingBar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8, paddingHorizontal: 4 },
  editingText: { fontSize: 13, fontWeight: "600" },
  editingCancel: { fontSize: 15, fontWeight: "600" },
  input: { flex: 1, minHeight: 40, maxHeight: 140, borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 9, fontSize: 16 },
  send: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 18, justifyContent: "center" },
  sendText: { fontSize: 16, fontWeight: "700" },
});
