import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSession } from "./SessionProvider";
import { usePalette } from "./theme";
import { useReadModel } from "./useReadModel";
import { problemTitle } from "./problem_copy";
import { linkPillLabel, recovery, threadsTab, waitingSuffix } from "./strings";
import { NO_GROUP_YET, NO_RELAY_ACCESS, relayAccess } from "./trust_card";

// The banners every placeholder screen shows (M1a.7): the link pill, the connect error and notice, and the
// problem card with 04's recovery offers. Real layout is M1b. `compact` (M1b.1) leaves out the pill row, for
// screens that show the pill in their own header. The key is shown by its key check, never its realm (01).

export function SessionBanner({ compact = false }: { compact?: boolean }): React.JSX.Element {
  const c = usePalette();
  const { session, loading, error, notice, exportHeld, confirmResync, demo, identity } = useSession();
  const status = useReadModel((m) => m.status);
  const linkStatus = useReadModel((m) => m.linkStatus);
  const feed = useReadModel((m) => m.link);
  const group = useReadModel((m) => m.group);
  // A cheap lookup over the feed state (one route), not a projection.
  const access = feed ? relayAccess(feed, group?.replica ?? null) : null;
  const phase = status?.phase ?? null;
  const problem = phase === "history_invalid" || phase === "identity_mismatch" || phase === "removed";

  const pill = !demo
    ? NO_GROUP_YET
    : loading || !linkStatus
      ? linkPillLabel.connecting
      : `${linkPillLabel[linkStatus.pill]}${linkStatus.waiting > 0 ? ` ${waitingSuffix(linkStatus.waiting)}` : ""}`;

  return (
    <View>
      {compact ? null : (
        <View style={[styles.row, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
          <Text testID="link-pill" style={[styles.pill, { color: linkStatus?.pill === "live" ? c.live : c.warn }]}>
            {pill}
          </Text>
          <Text style={[styles.muted, { color: c.muted }]} numberOfLines={1}>
            {identity ? threadsTab.keyCheck(identity.fingerprint) : ""}
          </Text>
        </View>
      )}
      {access === "no_relay_access" ? <Text testID="no-relay-access" style={[styles.banner, { backgroundColor: c.error }]}>{NO_RELAY_ACCESS}</Text> : null}
      {error && access !== "no_relay_access" ? <Text style={[styles.banner, { backgroundColor: c.error }]}>{error}</Text> : null}
      {notice ? <Text style={[styles.banner, { backgroundColor: c.warn }]}>{notice}</Text> : null}
      {problem && status ? (
        <View testID="problem" style={[styles.card, { backgroundColor: c.surface, borderColor: c.error }]}>
          <Text style={[styles.title, { color: c.text }]}>{problemTitle(status)}</Text>
          {/* identity_mismatch says its reason in words (M1b.2); history_invalid keeps its reason code (04). */}
          {status.reason && phase === "history_invalid" ? (
            <Text style={[styles.muted, { color: c.muted }]}>
              {status.reason}
              {status.replica ? ` · ${status.replica}` : ""}
            </Text>
          ) : null}
          <Pressable accessibilityRole="button" disabled={!session} onPress={() => void exportHeld()} style={[styles.button, { borderColor: c.border }]}>
            <Text style={{ color: c.text }}>{recovery.export}</Text>
          </Pressable>
          {phase === "history_invalid" ? (
            <Pressable accessibilityRole="button" onPress={confirmResync} style={[styles.button, { borderColor: c.border }]}>
              <Text style={{ color: c.text }}>{recovery.resync}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, gap: 12 },
  pill: { fontSize: 13, fontWeight: "600" },
  muted: { fontSize: 12, flexShrink: 1 },
  banner: { color: "#FFFFFF", fontSize: 12, fontWeight: "600", paddingHorizontal: 16, paddingVertical: 8 },
  card: { margin: 12, padding: 12, borderRadius: 10, borderWidth: 1, gap: 8 },
  title: { fontSize: 15, fontWeight: "700" },
  button: { borderWidth: 1, borderRadius: 8, paddingVertical: 8, alignItems: "center" },
});
