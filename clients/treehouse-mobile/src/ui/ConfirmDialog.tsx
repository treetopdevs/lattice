import React from "react";
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { actions } from "./strings";
import type { Palette } from "./theme";

// One confirmation for an irreversible action (04 principle 4, M1b.3): the sentence names what cannot be
// undone, then Cancel and the action. It is content, not its own Modal: MessageSheet swaps it in place of the
// sheet inside one Modal, so iOS never presents a second modal while the first is dismissing. The sentence
// scrolls rather than clips at the largest text sizes.

interface Props {
  sentence: string;
  confirm: string;
  busy: boolean;
  colors: Palette;
  onCancel(): void;
  onConfirm(): void;
}

export function ConfirmDialog({ sentence, confirm, busy, colors: c, onCancel, onConfirm }: Props): React.JSX.Element {
  // A bounded card lets the sentence's ScrollView shrink, and scroll, only when it would not fit.
  const maxHeight = useWindowDimensions().height * 0.75;
  return (
    <View testID="confirm-dialog" style={[styles.card, { backgroundColor: c.surface, borderColor: c.border, maxHeight }]}>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <Text testID="confirm-sentence" accessibilityRole="alert" style={[styles.sentence, { color: c.text }]}>
          {sentence}
        </Text>
      </ScrollView>
      <View style={styles.row}>
        <Pressable
          testID="confirm-cancel"
          accessibilityRole="button"
          accessibilityLabel={actions.cancel}
          onPress={onCancel}
          disabled={busy}
          style={({ pressed }) => [styles.button, { borderColor: c.border, opacity: pressed ? 0.6 : 1 }]}
        >
          <Text style={[styles.label, { color: c.text }]}>{actions.cancel}</Text>
        </Pressable>
        <Pressable
          testID="confirm-action"
          accessibilityRole="button"
          accessibilityLabel={confirm}
          accessibilityState={{ disabled: busy, busy }}
          onPress={onConfirm}
          disabled={busy}
          style={({ pressed }) => [styles.button, { backgroundColor: c.error, borderColor: c.error, opacity: pressed || busy ? 0.6 : 1 }]}
        >
          <Text style={[styles.label, { color: c.surface }]}>{confirm}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16, gap: 14 },
  scroll: { flexGrow: 0, flexShrink: 1 },
  scrollContent: {},
  sentence: { fontSize: 16, lineHeight: 22 },
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10, justifyContent: "flex-end" },
  button: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 10, minHeight: 44, justifyContent: "center" },
  label: { fontSize: 16, fontWeight: "600" },
});
