import React, { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ThreadListItem } from "../session/projections/thread_list";
import { threadsTab } from "./strings";
import type { Palette } from "./theme";
import { threadRowView } from "./thread_rows";

// One Threads tab row (04, M1b.1): title, last message with its author's name, unread count, a waiting-to-send
// mark and, when the link is up but this thread's route is not, a quiet "Not connected". Every mark is words;
// colour only repeats them. No fixed heights, so dynamic type grows the row instead of clipping it.

interface Props {
  item: ThreadListItem;
  colors: Palette;
  nameOf(pubkey: string, petname?: string | null): string;
  onOpen(replica: string): void;
}

export const ThreadRow = memo(function ThreadRow({ item, colors: c, nameOf, onOpen }: Props): React.JSX.Element {
  const view = threadRowView(item, nameOf);
  return (
    <Pressable
      testID={`thread-row-${item.replica}`}
      accessibilityRole="button"
      accessibilityLabel={view.accessibilityLabel}
      accessibilityHint={threadsTab.openThread(item.title)}
      disabled={!item.held}
      onPress={() => onOpen(item.replica)}
      style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.surfaceAlt : c.surface, borderColor: c.border }]}
    >
      <View style={styles.top}>
        <Text style={[styles.title, { color: item.archived ? c.muted : c.text }]} numberOfLines={2}>
          # {view.title}
        </Text>
        {view.unreadLabel ? (
          <View style={[styles.badge, { backgroundColor: c.accent }]}>
            <Text style={[styles.badgeText, { color: c.accentText }]}>{view.unreadLabel}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.preview, { color: c.muted, fontWeight: view.unreadLabel ? "600" : "400" }]} numberOfLines={2}>
        {view.preview}
      </Text>
      {view.waitingLabel || view.routeMark ? (
        <View style={styles.marks}>
          {view.waitingLabel ? <Text style={[styles.mark, { color: c.warn }]}>{`◷ ${view.waitingLabel}`}</Text> : null}
          {view.routeMark ? <Text style={[styles.mark, { color: c.muted }]}>{`○ ${view.routeMark}`}</Text> : null}
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, gap: 4 },
  top: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: "600" },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 12, fontWeight: "700" },
  preview: { fontSize: 14 },
  marks: { flexDirection: "row", flexWrap: "wrap", columnGap: 12, rowGap: 2 },
  mark: { fontSize: 12 },
});
