import React from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { SessionBanner } from "../../ui/SessionBanner";
import { removedPlaceholder, thread as threadCopy, waitingSuffix } from "../../ui/strings";
import { NO_GROUP_YET } from "../../ui/trust_card";
import { usePalette } from "../../ui/theme";
import { useReadModel } from "../../ui/useReadModel";

// Threads tab placeholder (M1a.7): the ThreadList read model as plain text; a row pushes the thread screen.
// The designed list is M1b.1.

export default function ThreadsScreen(): React.JSX.Element {
  const c = usePalette();
  const list = useReadModel((m) => m.threads);
  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <SessionBanner />
      <FlatList
        testID="thread-list"
        data={list?.threads ?? []}
        keyExtractor={(item) => item.replica}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={{ color: c.muted }}>{list ? threadCopy.noThreads : NO_GROUP_YET}</Text>}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${item.title}`}
            disabled={!item.held}
            onPress={() => router.push({ pathname: "/thread/[replica]", params: { replica: item.replica } })}
            style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
          >
            <Text style={[styles.title, { color: c.text }]}>
              # {item.title}
              {item.unreadCount > 0 ? ` (${item.unreadCount})` : ""}
            </Text>
            <Text style={{ color: c.muted }} numberOfLines={1}>
              {!item.held
                ? threadCopy.notHeld
                : item.last
                  ? item.last.removed
                    ? removedPlaceholder[item.last.removed]
                    : item.last.text
                  : threadCopy.empty}
            </Text>
            <Text style={[styles.meta, { color: c.muted }]}>
              {item.connection ?? "idle"}
              {item.waitingCount > 0 ? ` ${waitingSuffix(item.waitingCount)}` : ""}
              {item.archived ? ` · ${threadCopy.archived}` : ""}
            </Text>
          </Pressable>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 12, gap: 8 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, gap: 4 },
  title: { fontSize: 15, fontWeight: "600" },
  meta: { fontSize: 12 },
});
