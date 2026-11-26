import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { thread as threadCopy } from "./strings";
import type { Palette } from "./theme";

// The archived banner (04 Thread screen, M1b.6): replaces the composer in an archived thread, for every key,
// the moderator included. 04 adds a link to the successor when one exists; no successor exists in M1
// (rollover needs G-2 and the Thread replica records none), so there is no link. It grows with dynamic type
// and the screen reader hears the line itself.

export function ArchivedBanner({ bottomInset, colors: c }: { bottomInset: number; colors: Palette }): React.JSX.Element {
  return (
    <View
      testID="archived-banner"
      style={[styles.bar, { backgroundColor: c.surface, borderTopColor: c.border, paddingBottom: 14 + bottomInset }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={threadCopy.archived}
    >
      <Text style={[styles.line, { color: c.text }]}>{threadCopy.archived}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  line: { fontSize: 15, fontWeight: "600" },
});
