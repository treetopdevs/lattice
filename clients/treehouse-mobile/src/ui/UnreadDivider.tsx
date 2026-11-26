import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Palette } from "./theme";

// The unread divider (04 Thread screen, M1b.4): a rule with words above the first unread id when the thread
// opened ("3 unread"). It is one screen-reader element with its own label; the rules are decoration. It
// wraps rather than clips at large dynamic type.

export function UnreadDivider({ label, accessibilityLabel, colors: c }: { label: string; accessibilityLabel: string; colors: Palette }): React.JSX.Element {
  return (
    <View testID="unread-divider" style={styles.row} accessible accessibilityRole="text" accessibilityLabel={accessibilityLabel}>
      <View style={[styles.rule, { backgroundColor: c.accent }]} />
      <Text style={[styles.label, { color: c.accent }]}>{label}</Text>
      <View style={[styles.rule, { backgroundColor: c.accent }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14, marginBottom: 2 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth * 2 },
  label: { fontSize: 12, fontWeight: "700", flexShrink: 1, textAlign: "center" },
});
