import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { DEMO_KEYS_PUBLIC, DEMO_ROLE_LABEL, DEMO_ROLES, type DemoRole } from "./identities";

// Demo only (M1a.6): the role switcher and demo relay origin, with the public-keys notice. Rendered only
// by the composition root when the demo is enabled. Uses the same React Native primitives as App.tsx.

export interface DemoBarColors {
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  warn: string;
}

export interface DemoBarProps {
  colors: DemoBarColors;
  role: DemoRole;
  onRole(role: DemoRole): void;
  originDraft: string;
  onOriginDraft(text: string): void;
  onReconnect(): void;
  detail?: string | null;
}

export function DemoBar({ colors: c, role, onRole, originDraft, onOriginDraft, onReconnect, detail }: DemoBarProps): React.JSX.Element {
  return (
    <View testID="demo-bar" style={[styles.card, { backgroundColor: c.surface, borderColor: c.warn }]}>
      <Text style={[styles.title, { color: c.text }]}>Demo</Text>
      <Text style={[styles.notice, { color: c.warn }]}>{DEMO_KEYS_PUBLIC}</Text>
      <View style={styles.segmentRow}>
        {DEMO_ROLES.map((mode) => {
          const active = role === mode;
          return (
            <Pressable
              key={mode}
              accessibilityRole="button"
              onPress={() => onRole(mode)}
              style={[
                styles.segmentBtn,
                { backgroundColor: active ? c.accent : c.surfaceAlt, borderColor: active ? c.accent : c.border },
              ]}
            >
              <Text style={[styles.segmentText, { color: active ? c.accentText : c.text }]}>{DEMO_ROLE_LABEL[mode]}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={[styles.label, { color: c.muted }]}>Demo relay address</Text>
      <TextInput
        value={originDraft}
        onChangeText={onOriginDraft}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { backgroundColor: c.surfaceAlt, color: c.text, borderColor: c.border }]}
      />
      <Pressable accessibilityRole="button" onPress={onReconnect} style={[styles.actionBtn, { backgroundColor: c.accent }]}>
        <Text style={[styles.actionText, { color: c.accentText }]}>Reconnect</Text>
      </Pressable>
      {detail ? <Text style={[styles.label, { color: c.muted, marginTop: 8 }]}>{detail}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 14 },
  title: { fontSize: 15, fontWeight: "700", marginBottom: 6 },
  notice: { fontSize: 13, lineHeight: 18, marginBottom: 10, fontWeight: "600" },
  segmentRow: { flexDirection: "row", gap: 8 },
  segmentBtn: { flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, alignItems: "center" },
  segmentText: { fontSize: 13, fontWeight: "600" },
  label: { fontSize: 12, marginTop: 10, marginBottom: 4 },
  input: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 8, fontSize: 13, marginBottom: 10 },
  actionBtn: { paddingVertical: 9, borderRadius: 8, alignItems: "center" },
  actionText: { fontSize: 14, fontWeight: "600" },
});
