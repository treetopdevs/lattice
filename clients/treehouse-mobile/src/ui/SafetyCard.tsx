import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { myKey, safety } from "./strings";
import type { Palette } from "./theme";

// The Safety and My key cards (04 Group tab, M1b.7): plain lines from src/ui/group_view.ts (safetyLines,
// keyLines). Safety claims no encryption, no removal from other phones and no availability; the demo line, in
// dev builds only, comes from the demo fence through the composition root.

function LineCard({ colors: c, title, lines, testID }: { colors: Palette; title: string; lines: readonly string[]; testID: string }) {
  return (
    <View testID={testID} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>
        {title}
      </Text>
      {lines.map((line) => (
        <View key={line} style={styles.row} accessible accessibilityLabel={line}>
          <Text style={[styles.bullet, { color: c.muted }]} importantForAccessibility="no">
            •
          </Text>
          <Text style={[styles.body, { color: c.text }]}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

export function SafetyCard({ colors, lines }: { colors: Palette; lines: readonly string[] }): React.JSX.Element {
  return <LineCard colors={colors} title={safety.title} lines={lines} testID="safety-card" />;
}

export function KeyCard({ colors, lines }: { colors: Palette; lines: readonly string[] }): React.JSX.Element {
  return <LineCard colors={colors} title={myKey.title} lines={lines} testID="key-card" />;
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 8 },
  title: { fontSize: 17, fontWeight: "700" },
  row: { flexDirection: "row", gap: 8 },
  bullet: { fontSize: 15, lineHeight: 21 },
  body: { fontSize: 15, lineHeight: 21, flex: 1 },
});
