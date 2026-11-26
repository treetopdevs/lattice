import React, { useCallback, useMemo } from "react";
import { FlatList, StyleSheet, Text, View } from "react-native";
import type { MessageView, ThreadTimeline } from "../session/projections/thread_timeline";
import { Bubble } from "./Bubble";
import { thread as threadCopy } from "./strings";
import { UnreadDivider } from "./UnreadDivider";
import type { Palette } from "./theme";
import { localDay, timelineItems } from "./thread_view";
import type { OpenMarks, TimelineItem } from "./thread_view";

// The Thread screen's message list (04, M1b.2): bottom-anchored, canonical order, virtualized. The items are
// built once per timeline object (the session keeps an unchanged timeline identical), then reversed for the
// inverted list so the newest sits at the bottom. The empty text replaces the list rather than sitting in
// it, because an inverted list would draw it mirrored.

interface Props {
  timeline: ThreadTimeline | null;
  nameOf(pubkey: string): string;
  colors: Palette;
  /** M1b.3: whether the long-press sheet has items for a message, and how to open it. */
  canOpenSheet(message: MessageView): boolean;
  onOpenSheet(id: string): void;
  /** M1b.4: the unread divider and arrived-later ids the screen holds while open. */
  marks: OpenMarks;
}

export function MessageList({ timeline, nameOf, colors: c, canOpenSheet, onOpenSheet, marks }: Props): React.JSX.Element {
  const items = useMemo(() => timelineItems(timeline, nameOf, localDay(Date.now()), marks).reverse(), [timeline, nameOf, marks]);
  const renderItem = useCallback(
    ({ item }: { item: TimelineItem }) =>
      item.kind === "unread" ? (
        <UnreadDivider label={item.label} accessibilityLabel={item.accessibilityLabel} colors={c} />
      ) : item.kind === "day" ? (
        <Text style={[styles.day, { color: c.muted }]} accessibilityRole="header">
          {item.label}
        </Text>
      ) : (
        <Bubble item={item} colors={c} onOpenSheet={canOpenSheet(item.message) ? onOpenSheet : undefined} />
      ),
    [c, canOpenSheet, onOpenSheet],
  );

  if (!timeline || timeline.messages.length === 0)
    return (
      <View style={styles.empty}>
        <Text testID="timeline-empty" style={[styles.emptyText, { color: c.muted }]}>
          {timeline ? threadCopy.empty : threadCopy.notHeld}
        </Text>
      </View>
    );

  return (
    <FlatList
      testID="timeline"
      accessibilityLabel={threadCopy.messages(timeline.title)}
      inverted
      data={items}
      keyExtractor={(item) => item.key}
      renderItem={renderItem}
      contentContainerStyle={styles.list}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
    />
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: 12, paddingVertical: 10 },
  day: { alignSelf: "center", fontSize: 12, fontWeight: "600", marginTop: 14, marginBottom: 4 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyText: { fontSize: 15 },
});
