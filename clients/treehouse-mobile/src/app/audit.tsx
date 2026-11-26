import React, { useMemo } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { auditSections } from "../ui/group_view";
import { SessionBanner } from "../ui/SessionBanner";
import { useSession } from "../ui/SessionProvider";
import { audit as auditCopy } from "../ui/strings";
import { usePalette } from "../ui/theme";
import { useReadModel } from "../ui/useReadModel";

// Verify & audit (04 Group tab, M1b.7), pushed from the Group tab. Read-only: per replica (the Group first),
// the op count, frontier, relay generation and matches-relay, every grant with its state (usable, revoked,
// lapsed) and every op that is not counted with the judge's raw reason. Every fact is the AuditView's, put
// into words by src/ui/group_view.ts; this is the one screen where protocol words are allowed. Scrolls, so
// large text sizes never clip; ids and reasons are selectable so they can be compared.

export default function AuditScreen(): React.JSX.Element {
  const c = usePalette();
  const bottom = useSafeAreaInsets().bottom;
  const { displayName } = useSession();
  const view = useReadModel((m) => m.audit);
  const threads = useReadModel((m) => m.threads);
  const group = useReadModel((m) => m.group);
  const roster = useReadModel((m) => m.roster);
  const sections = useMemo(() => {
    if (!view) return [];
    const petnames = new Map((roster?.members ?? []).map((m) => [m.pubkey, m.petname] as const));
    return auditSections(view, {
      spaceReplica: group?.replica ?? null,
      threads,
      name: (key) => displayName(key, petnames.get(key) ?? null),
    });
  }, [view, threads, group, roster, displayName]);

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <SessionBanner />
      <ScrollView testID="audit-list" contentContainerStyle={[styles.content, { paddingBottom: 24 + bottom }]}>
        <Text style={[styles.intro, { color: c.muted }]}>{auditCopy.intro}</Text>
        {sections.length === 0 ? <Text style={[styles.body, { color: c.text }]}>{auditCopy.empty}</Text> : null}
        {sections.map((s) => (
          <View key={s.replica} testID={`audit-${s.title}`} style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text accessibilityRole="header" style={[styles.title, { color: c.text }]}>
              {s.title}
            </Text>
            <Text selectable style={[styles.mono, { color: c.muted }]}>
              {s.replica}
            </Text>
            {s.facts.map((f) => (
              <View key={f.key} style={styles.fact} accessible accessibilityLabel={f.accessibilityLabel}>
                <Text style={[styles.label, { color: c.muted }]}>{f.label}</Text>
                <Text selectable style={[styles.mono, { color: c.text }]}>
                  {f.value}
                </Text>
              </View>
            ))}
            <Text accessibilityRole="header" style={[styles.subtitle, { color: c.text }]}>
              {auditCopy.grants}
            </Text>
            {s.grants.length === 0 ? <Text style={[styles.body, { color: c.muted }]}>{auditCopy.noGrants}</Text> : null}
            {s.grants.map((g) => (
              <Text
                key={g.id}
                selectable
                accessibilityLabel={g.text}
                style={[styles.body, { color: g.state === "usable" ? c.text : c.warn }]}
              >
                {g.text}
              </Text>
            ))}
            <Text accessibilityRole="header" style={[styles.subtitle, { color: c.text }]}>
              {auditCopy.notCounted}
            </Text>
            {s.notCounted.length === 0 ? <Text style={[styles.body, { color: c.muted }]}>{auditCopy.allCounted}</Text> : null}
            {s.notCounted.map((q) => (
              <Text key={q.id} selectable accessibilityLabel={q.text} style={[styles.mono, { color: c.text }]}>
                {q.text}
              </Text>
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 12, gap: 12 },
  intro: { fontSize: 14, lineHeight: 20 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 8 },
  title: { fontSize: 17, fontWeight: "700" },
  subtitle: { fontSize: 15, fontWeight: "700", marginTop: 6 },
  fact: { gap: 2 },
  label: { fontSize: 13, fontWeight: "600" },
  body: { fontSize: 15, lineHeight: 21 },
  mono: { fontSize: 13, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
});
