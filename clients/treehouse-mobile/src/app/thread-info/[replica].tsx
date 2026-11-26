import React, { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SessionBanner } from "../../ui/SessionBanner";
import { useSession } from "../../ui/SessionProvider";
import { refusalCopy, thread as threadCopy, threadInfo as infoCopy } from "../../ui/strings";
import { threadInfoView } from "../../ui/thread_info";
import { usePalette } from "../../ui/theme";
import { useReadModel } from "../../ui/useReadModel";

// Thread info (04, M1b.6): the thread's title, message and signed-entry counts and size against the rollover
// limits, and Archive for the moderator holder. Every fact is the ThreadTimeline's (`health`, `archived`) or
// the Abilities answer for `archive_thread`, put into words by src/ui/thread_info.ts. Archive is irreversible
// (01: no unarchive), so it confirms first with a sentence that says so (04 principle 4). Continue in a new
// thread is not shown: it needs G-2. Scrolls, so large text sizes never clip.

export default function ThreadInfoScreen(): React.JSX.Element {
  const c = usePalette();
  const bottom = useSafeAreaInsets().bottom;
  const { replica: param } = useLocalSearchParams<{ replica: string }>();
  const replica = typeof param === "string" ? param : "";
  const { session, setError } = useSession();
  const timeline = useReadModel((m) => m.timelines[replica] ?? null, [replica]);
  const abilities = useReadModel((m) => m.abilities.replicas[replica], [replica]) ?? undefined;
  const info = useMemo(() => (timeline ? threadInfoView(timeline, abilities) : null), [timeline, abilities]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Like the message sheet, the confirmation is re-read from the read model: an archive that arrives from
  // elsewhere while it is open closes it, so no redundant archive is signed.
  const canArchive = info?.canArchive === true;
  useEffect(() => {
    if (confirming && !busy && !canArchive) setConfirming(false);
  }, [confirming, busy, canArchive]);

  const archive = async () => {
    if (!session || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await session.archiveThread(replica);
      if (!outcome.ok) setError(refusalCopy[outcome.reason]);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ title: infoCopy.screenTitle }} />
      <SessionBanner />
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 24 + bottom }]}>
        {info ? (
          <>
            <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>{`# ${info.title}`}</Text>
            {info.archived ? (
              <Text testID="info-archived" style={[styles.archived, { color: c.text, backgroundColor: c.surfaceAlt }]}>
                {threadCopy.archived}
              </Text>
            ) : null}
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              {info.rows.map((r, i) => (
                <View
                  key={r.key}
                  testID={`info-${r.key}`}
                  accessible
                  accessibilityLabel={r.accessibilityLabel}
                  style={[styles.row, i > 0 && { borderTopColor: c.border, borderTopWidth: StyleSheet.hairlineWidth }]}
                >
                  <Text style={[styles.label, { color: c.muted }]}>{r.label}</Text>
                  <Text style={[styles.value, { color: c.text }]}>{r.value}</Text>
                </View>
              ))}
            </View>
            <Text style={[styles.note, { color: c.muted }]}>{infoCopy.limitsNote}</Text>
            {info.canArchive ? (
              <Pressable
                testID="info-archive"
                accessibilityRole="button"
                accessibilityLabel={infoCopy.archive}
                accessibilityHint={infoCopy.archiveHint}
                onPress={() => setConfirming(true)}
                style={({ pressed }) => [styles.archive, { borderColor: c.error, opacity: pressed ? 0.6 : 1 }]}
              >
                <Text style={[styles.archiveText, { color: c.error }]}>{infoCopy.archive}</Text>
              </Pressable>
            ) : null}
          </>
        ) : (
          <Text style={[styles.note, { color: c.muted }]}>{threadCopy.notHeld}</Text>
        )}
      </ScrollView>
      {/* Android Back and the VoiceOver escape gesture wait while the archive runs, like the message sheet. */}
      <Modal visible={confirming} transparent animationType="fade" onRequestClose={busy ? () => undefined : () => setConfirming(false)}>
        <View style={styles.modalRoot} accessibilityViewIsModal onAccessibilityEscape={busy ? undefined : () => setConfirming(false)}>
          <View style={styles.backdrop} accessible={false} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden />
          <View style={[styles.holder, { paddingBottom: 12 + bottom }]}>
            <ConfirmDialog
              sentence={infoCopy.confirmArchive}
              confirm={infoCopy.archiveConfirm}
              busy={busy}
              colors={c}
              onCancel={() => setConfirming(false)}
              onConfirm={() => void archive()}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 16, gap: 14 },
  title: { fontSize: 24, fontWeight: "700" },
  archived: { fontSize: 15, fontWeight: "600", padding: 12, borderRadius: 12, overflow: "hidden" },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 14 },
  row: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 8, paddingHorizontal: 14, paddingVertical: 12 },
  label: { fontSize: 15 },
  value: { fontSize: 15, fontWeight: "600" },
  note: { fontSize: 14, lineHeight: 20 },
  archive: { borderWidth: 1, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, minHeight: 48, justifyContent: "center", alignItems: "center" },
  archiveText: { fontSize: 17, fontWeight: "600" },
  modalRoot: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: "rgba(0,0,0,0.4)" },
  holder: { paddingHorizontal: 12 },
});
