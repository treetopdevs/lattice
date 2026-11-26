import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LinkStatus } from "../session/projections/link_status";
import { threadsTab } from "./strings";
import type { Palette } from "./theme";
import { linkPillView } from "./thread_rows";
import type { PillTone } from "./thread_rows";

// The Group connection pill (04 Threads tab header, M1b.1). A dot plus the label: the colour repeats the
// words, never replaces them. Tapping it opens the relay details (the Group tab until a Relay screen exists).

const toneColor = (c: Palette, tone: PillTone) =>
  tone === "live" ? c.live : tone === "warn" ? c.warn : tone === "error" ? c.error : c.muted;

export function LinkPill({ status, colors: c, onPress }: { status: LinkStatus | null; colors: Palette; onPress(): void }): React.JSX.Element {
  const view = linkPillView(status);
  const color = toneColor(c, view.tone);
  return (
    <Pressable
      testID="link-pill"
      accessibilityRole="button"
      accessibilityLabel={view.accessibilityLabel}
      accessibilityHint={threadsTab.pillHint}
      onPress={onPress}
      hitSlop={8}
      style={({ pressed }) => [styles.pill, { borderColor: color, backgroundColor: c.surface, opacity: pressed ? 0.7 : 1 }]}
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={[styles.label, { color: c.text }]}>{view.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: { flexDirection: "row", alignItems: "center", gap: 6, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, alignSelf: "flex-start" },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
});
