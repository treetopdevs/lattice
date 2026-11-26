import React from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Palette } from "./theme";

// The cannot-post bar (04 Thread screen, M1b.5): replaces the composer with one line that gives the reason
// and who can fix it (src/ui/refusal_view.ts picks the words from the judge's answer). It grows with dynamic
// type and the screen reader hears the line itself.

export function CannotPostBar({ line, bottomInset, colors: c }: { line: string; bottomInset: number; colors: Palette }): React.JSX.Element {
  return (
    <View
      testID="cannot-post-bar"
      style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.border, paddingBottom: 14 + bottomInset }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={line}
    >
      <Text style={[styles.line, { color: c.text }]}>{line}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  line: { fontSize: 15 },
});
