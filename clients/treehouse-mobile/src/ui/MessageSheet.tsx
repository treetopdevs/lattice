import React, { useEffect, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MessageView } from "../session/projections/thread_timeline";
import { ConfirmDialog } from "./ConfirmDialog";
import { confirmationFor, confirmationLeft, sheetItemLabel } from "./message_sheet";
import type { ConfirmedItem, SheetItem } from "./message_sheet";
import { actions, removedPlaceholder } from "./strings";
import type { Palette } from "./theme";

// The long-press sheet (04, M1b.3): one Modal over the whole screen (the stack header too), whose content is
// either the sheet's items (Copy, Edit, Delete, Remove as moderator) or, for Delete and Remove, the confirmation. `open` is re-read from the current
// timeline by the screen on every change (sheetFor), so a message deleted elsewhere closes the sheet.

interface Props {
  open: { message: MessageView; items: SheetItem[] } | null;
  colors: Palette;
  onClose(): void;
  onEdit(message: MessageView): void;
  /** M1b.5: copies the message's text; the sheet closes at once. */
  onCopy(message: MessageView): void;
  /** Runs a confirmed delete or remove; resolves when the session has answered. */
  onConfirmed(item: ConfirmedItem, message: MessageView): Promise<void>;
}

export function MessageSheet({ open: live, colors: c, onClose, onEdit, onCopy, onConfirmed }: Props): React.JSX.Element {
  const bottom = useSafeAreaInsets().bottom;
  // The Modal fades out after `live` goes null; the last sheet stays drawn for the fade instead of an empty card.
  const last = useRef(live);
  if (live) last.current = live;
  const open = live ?? last.current;
  const [confirming, setConfirming] = useState<ConfirmedItem | null>(null);
  const [busy, setBusy] = useState(false);
  const messageId = open?.message.id ?? null;
  // A fresh open (or another message) starts at the sheet, never at a confirmation left from last time.
  const shown = live !== null;
  useEffect(() => {
    if (shown) setConfirming(null);
  }, [messageId, shown]);
  // A confirmation whose action was taken away while it was open (a remote archive, a revoked grant) closes
  // back to the sheet rather than staying tappable (closing review, Neon). Not while that action is running.
  const liveItems = live?.items.join(",") ?? "";
  useEffect(() => {
    if (live && confirming && !busy && confirmationLeft(confirming, live.items) === null) setConfirming(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveItems, confirming, busy]);

  const pick = (item: SheetItem) => {
    if (!open) return;
    if (item === "copy") {
      onCopy(open.message);
      onClose();
      return;
    }
    if (item === "edit") {
      onEdit(open.message);
      onClose();
      return;
    }
    setConfirming(item);
  };
  const confirm = async () => {
    if (!open || !confirming || busy) return;
    setBusy(true);
    try {
      await onConfirmed(confirming, open.message);
    } finally {
      setBusy(false);
      setConfirming(null);
      onClose();
    }
  };
  const confirmation = confirming ? confirmationFor(confirming) : null;
  const preview = open ? (open.message.removed ? removedPlaceholder[open.message.removed] : open.message.text) : "";

  // Android Back and the VoiceOver escape gesture wait, like the backdrop, while a delete or remove runs.
  return (
    <Modal visible={live !== null} transparent animationType="fade" onRequestClose={busy ? () => undefined : onClose}>
      <View style={styles.root} accessibilityViewIsModal onAccessibilityEscape={busy ? undefined : onClose}>
        <Pressable
          testID="sheet-backdrop"
          style={styles.backdrop}
          // Hidden from screen readers: the sheet's and the dialog's own Cancel buttons are the way out.
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          onPress={busy ? undefined : onClose}
        />
        <View style={[styles.holder, { paddingBottom: 12 + bottom }]} pointerEvents="box-none">
          {confirmation ? (
            <ConfirmDialog
              sentence={confirmation.sentence}
              confirm={confirmation.confirm}
              busy={busy}
              colors={c}
              onCancel={() => setConfirming(null)}
              onConfirm={() => void confirm()}
            />
          ) : (
            <View testID="message-sheet" style={[styles.sheet, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text accessibilityRole="header" style={[styles.title, { color: c.muted }]}>
                {actions.sheetTitle}
              </Text>
              <Text numberOfLines={3} style={[styles.preview, { color: c.text }]}>
                {preview}
              </Text>
              {open?.items.map((item) => (
                <Pressable
                  key={item}
                  testID={`sheet-${item}`}
                  accessibilityRole="button"
                  accessibilityLabel={sheetItemLabel[item]}
                  onPress={() => pick(item)}
                  style={({ pressed }) => [styles.item, { borderTopColor: c.border, opacity: pressed ? 0.6 : 1 }]}
                >
                  <Text style={[styles.itemText, { color: item === "copy" || item === "edit" ? c.text : c.error }]}>{sheetItemLabel[item]}</Text>
                </Pressable>
              ))}
              <Pressable
                testID="sheet-cancel"
                accessibilityRole="button"
                accessibilityLabel={actions.cancel}
                onPress={onClose}
                style={({ pressed }) => [styles.item, { borderTopColor: c.border, opacity: pressed ? 0.6 : 1 }]}
              >
                <Text style={[styles.itemText, styles.cancel, { color: c.accent }]}>{actions.cancel}</Text>
              </Pressable>
            </View>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.4)" },
  holder: { paddingHorizontal: 12 },
  sheet: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingTop: 14, overflow: "hidden" },
  title: { fontSize: 13, fontWeight: "600", paddingHorizontal: 16 },
  preview: { fontSize: 15, paddingHorizontal: 16, paddingTop: 4, paddingBottom: 12 },
  item: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 14, minHeight: 48, justifyContent: "center" },
  itemText: { fontSize: 17 },
  cancel: { fontWeight: "600" },
});
