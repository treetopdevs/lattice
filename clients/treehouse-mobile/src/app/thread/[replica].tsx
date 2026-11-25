import React, { useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { SessionBanner } from "../../ui/SessionBanner";
import { useSession } from "../../ui/SessionProvider";
import { deliveryLabel, message as messageCopy, refusalCopy, removedPlaceholder, thread as threadCopy } from "../../ui/strings";
import { usePalette } from "../../ui/theme";
import { useReadModel } from "../../ui/useReadModel";

// Thread screen placeholder (M1a.7): the ThreadTimeline read model as plain text, plus a minimal Post so the
// lifecycle gate has something to sync. The designed screen (bubbles, delivery marks, drafts) is M1b.2.

export default function ThreadScreen(): React.JSX.Element {
  const c = usePalette();
  const { replica: param } = useLocalSearchParams<{ replica: string }>();
  const replica = typeof param === "string" ? param : "";
  const { session, displayName, setError } = useSession();
  const timeline = useReadModel((m) => m.timelines[replica] ?? null, [replica]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);

  const post = async () => {
    if (!session || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const outcome = await session.postMessage(replica, draft);
      if (outcome.ok) setDraft("");
      else setError(refusalCopy[outcome.reason]);
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView style={[styles.root, { backgroundColor: c.bg }]} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <Stack.Screen options={{ title: timeline ? `# ${timeline.title}` : threadCopy.screenTitle }} />
      <SessionBanner />
      <Text testID="thread-meta" style={[styles.meta, { color: c.muted }]}>
        {timeline ? `${timeline.messages.length} messages · ${timeline.health.ops} ops · ${timeline.unreadCount} unread` : threadCopy.notHeld}
      </Text>
      <FlatList
        testID="timeline"
        data={timeline?.messages ?? []}
        keyExtractor={(m) => m.id}
        contentContainerStyle={styles.list}
        ListEmptyComponent={<Text style={{ color: c.muted }}>{threadCopy.empty}</Text>}
        renderItem={({ item }) => (
          <View style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.author, { color: c.text }]}>
              {displayName(item.author)}
              {item.edited ? ` · ${messageCopy.edited}` : ""}
              {item.arrivedLate ? ` · ${messageCopy.arrivedLate}` : ""}
              {item.standing === "not_counted" ? ` · ${messageCopy.notCounted}` : ""}
            </Text>
            <Text style={{ color: item.removed ? c.muted : c.text }}>{item.removed ? removedPlaceholder[item.removed] : item.text}</Text>
            {item.delivery ? <Text style={[styles.meta, { color: c.muted }]}>{deliveryLabel[item.delivery]}</Text> : null}
          </View>
        )}
      />
      <View style={[styles.composer, { backgroundColor: c.surface, borderTopColor: c.border }]}>
        {timeline?.canPost ? (
          <>
            <TextInput
              testID="composer"
              value={draft}
              onChangeText={setDraft}
              placeholder={threadCopy.write}
              placeholderTextColor={c.muted}
              style={[styles.input, { color: c.text, borderColor: c.border, backgroundColor: c.surfaceAlt }]}
              multiline
              maxLength={4000}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={threadCopy.post}
              disabled={sending || !draft.trim()}
              onPress={() => void post()}
              style={[styles.send, { backgroundColor: sending || !draft.trim() ? c.border : c.accent }]}
            >
              <Text style={{ color: c.accentText, fontWeight: "700" }}>{threadCopy.post}</Text>
            </Pressable>
          </>
        ) : (
          <Text style={{ color: c.muted }}>{timeline?.archived ? threadCopy.archived : threadCopy.cannotPost}</Text>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 12, gap: 8 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 10, gap: 4 },
  author: { fontSize: 13, fontWeight: "600" },
  meta: { fontSize: 12, paddingHorizontal: 12, paddingTop: 6 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, minHeight: 40, maxHeight: 110, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 15 },
  send: { paddingHorizontal: 16, paddingVertical: 10, borderRadius: 10 },
});
