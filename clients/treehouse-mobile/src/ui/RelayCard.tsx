import React from "react";
import { Platform, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import type { LinkStatus } from "../session/projections/link_status";
import type { RelayRow } from "./group_view";
import { syncSwitch } from "./group_view";
import { linkPillLabel, NO_RELAY_ACCESS, relay as relayCopy, waitingSuffix } from "./strings";
import type { Palette } from "./theme";

// The Relay card (04 Group tab, M1b.7): the approved hosting sentence, the relay address, the connection per
// thread, the waiting count, Sync now and the Pause sync switch. Every value comes from LinkStatus and the
// rows src/ui/group_view.ts words; the switch reads the person's setting, not the pill. Each state is words,
// never colour alone, and the card grows with dynamic type.

export interface RelayCardProps {
  colors: Palette;
  /** The one approved hosting sentence (01), passed by the Group tab. */
  hosting: string;
  link: LinkStatus | null;
  rows: readonly RelayRow[];
  addresses: readonly string[];
  noRelayAccess: boolean;
  disabled: boolean;
  onPauseChange(paused: boolean): void;
  onSyncNow(): void;
  onOpenAudit(): void;
  auditLabel: string;
  auditHint: string;
}

export function RelayCard(p: RelayCardProps): React.JSX.Element {
  const c = p.colors;
  const sw = p.link ? syncSwitch(p.link) : null;
  const pill = p.link ? `${linkPillLabel[p.link.pill]}${p.link.waiting > 0 ? ` ${waitingSuffix(p.link.waiting)}` : ""}` : "-";
  return (
    <View testID="relay-card" style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>
        {relayCopy.title}
      </Text>
      <Text testID="trust-card" style={[styles.body, { color: c.muted }]}>
        {p.hosting}
      </Text>
      {p.noRelayAccess ? <Text style={[styles.body, { color: c.error }]}>{NO_RELAY_ACCESS}</Text> : null}
      <View accessible accessibilityLabel={`${relayCopy.address}: ${p.addresses.join(", ") || relayCopy.noAddress}`}>
        <Text style={[styles.label, { color: c.muted }]}>{relayCopy.address}</Text>
        <Text testID="relay-origin" selectable style={[styles.mono, { color: c.text }]}>
          {p.addresses.length > 0 ? p.addresses.join("\n") : relayCopy.noAddress}
        </Text>
      </View>
      <Text testID="link-state" style={[styles.pill, { color: c.text }]}>
        {pill}
      </Text>
      <View testID="relay-routes" style={styles.rows}>
        {p.rows.map((r) => (
          <Text key={r.replica} accessibilityLabel={r.accessibilityLabel} style={[styles.body, { color: c.text }]}>
            {r.text}
          </Text>
        ))}
        <Text style={[styles.body, { color: c.muted }]}>
          {p.link && p.link.waiting > 0 ? relayCopy.waitingTotal(p.link.waiting) : relayCopy.nothingWaiting}
        </Text>
      </View>
      {sw ? (
        <View style={styles.switchRow}>
          <Text style={[styles.switchLabel, { color: c.text }]}>{sw.label}</Text>
          <Switch
            testID="pause-sync"
            value={sw.paused}
            disabled={p.disabled}
            onValueChange={p.onPauseChange}
            accessibilityLabel={sw.label}
            accessibilityHint={sw.hint}
            trackColor={{ false: c.border, true: c.warn }}
          />
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={relayCopy.syncNow}
        disabled={p.disabled || sw?.paused === true}
        onPress={p.onSyncNow}
        style={[styles.button, { backgroundColor: c.surfaceAlt, borderColor: c.border, opacity: p.disabled || sw?.paused ? 0.5 : 1 }]}
      >
        <Text style={[styles.buttonText, { color: c.text }]}>{relayCopy.syncNow}</Text>
      </Pressable>
      <Pressable
        testID="open-audit"
        accessibilityRole="button"
        accessibilityLabel={p.auditLabel}
        accessibilityHint={p.auditHint}
        onPress={p.onOpenAudit}
        style={[styles.button, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}
      >
        <Text style={[styles.buttonText, { color: c.text }]}>{`${p.auditLabel} ›`}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 10 },
  title: { fontSize: 17, fontWeight: "700" },
  body: { fontSize: 15, lineHeight: 21 },
  label: { fontSize: 13, fontWeight: "600" },
  mono: { fontSize: 14, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  pill: { fontSize: 15, fontWeight: "600" },
  rows: { gap: 4 },
  switchRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  switchLabel: { fontSize: 15, flexShrink: 1 },
  button: { borderWidth: 1, borderRadius: 8, paddingVertical: 11, paddingHorizontal: 12, alignItems: "center" },
  buttonText: { fontSize: 15, fontWeight: "600" },
});
