import React, { useCallback, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { LinkPill } from "../../ui/LinkPill";
import { SessionBanner } from "../../ui/SessionBanner";
import { useSession } from "../../ui/SessionProvider";
import { thread as threadCopy, threadsTab } from "../../ui/strings";
import { ThreadRow } from "../../ui/ThreadRow";
import { threadsTabRows } from "../../ui/thread_rows";
import type { ThreadsTabRow } from "../../ui/thread_rows";
import { NO_GROUP_YET } from "../../ui/trust_card";
import { usePalette } from "../../ui/theme";
import { useReadModel } from "../../ui/useReadModel";

// Threads tab (04, M1b.1). Reads GroupSummary, LinkStatus and ThreadList; one virtualized list, with the
// archived threads behind a collapsed toggle row that heads their section. New thread and the slots-full line are not shown: creating a
// thread needs G-2 and per-Thread keys (07 Non-goals), so `create_thread` is never allowed in M1.

export default function ThreadsScreen(): React.JSX.Element {
  const c = usePalette();
  const { displayName } = useSession();
  const list = useReadModel((m) => m.threads);
  const group = useReadModel((m) => m.group);
  const linkStatus = useReadModel((m) => m.linkStatus);
  const insets = useSafeAreaInsets();
  const [showArchived, setShowArchived] = useState(false);
  const data = useMemo(() => threadsTabRows(list, showArchived), [list, showArchived]);

  const open = useCallback((replica: string) => router.push({ pathname: "/thread/[replica]", params: { replica } }), []);
  const renderItem = useCallback(
    ({ item: row }: { item: ThreadsTabRow }) =>
      row.kind === "thread" ? (
        <ThreadRow item={row.item} colors={c} nameOf={displayName} onOpen={open} />
      ) : (
        <Pressable
          testID="archived-toggle"
          accessibilityRole="button"
          accessibilityState={{ expanded: row.open }}
          accessibilityHint={row.open ? threadsTab.hideArchived : threadsTab.showArchived}
          onPress={() => setShowArchived((v) => !v)}
          style={[styles.archived, { borderColor: c.border }]}
        >
          <Text style={{ color: c.muted, fontWeight: "600" }}>{`${row.open ? "▾" : "▸"} ${threadsTab.archivedSection(row.count)}`}</Text>
        </Pressable>
      ),
    [c, displayName, open],
  );

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10, backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <Text accessibilityRole="header" style={[styles.groupName, { color: c.text }]} numberOfLines={2}>
          {group?.name || threadsTab.noGroupName}
        </Text>
        <LinkPill status={linkStatus} colors={c} onPress={() => router.navigate("/group")} />
      </View>
      <SessionBanner compact />
      <FlatList
        testID="thread-list"
        data={data}
        keyExtractor={(row) => row.key}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={[styles.empty, { color: c.muted }]}>{list ? threadCopy.noThreads : NO_GROUP_YET}</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 10, gap: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  groupName: { fontSize: 28, fontWeight: "700" },
  list: { padding: 12, gap: 8 },
  empty: { fontSize: 15, paddingVertical: 24, textAlign: "center" },
  archived: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 12, paddingHorizontal: 4 },
});
