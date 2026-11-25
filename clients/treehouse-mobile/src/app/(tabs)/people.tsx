import React from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SessionBanner } from "../../ui/SessionBanner";
import { useSession } from "../../ui/SessionProvider";
import { people as peopleCopy } from "../../ui/strings";
import { usePalette } from "../../ui/theme";
import { useReadModel } from "../../ui/useReadModel";

// People tab placeholder (M1a.7): the Roster read model as plain text. The designed tab is M2.

export default function PeopleScreen(): React.JSX.Element {
  const c = usePalette();
  const { displayName } = useSession();
  const roster = useReadModel((m) => m.roster);
  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <SessionBanner />
      <ScrollView contentContainerStyle={styles.list} testID="roster">
        {(roster?.members ?? []).length === 0 ? <Text style={{ color: c.muted }}>{peopleCopy.onlyMe}</Text> : null}
        {(roster?.members ?? []).map((m) => (
          <View key={m.pubkey} style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Text style={[styles.title, { color: c.text }]}>
              {displayName(m.pubkey, m.petname)}
              {m.isMe ? ` (${peopleCopy.you})` : ""}
            </Text>
            <Text style={{ color: c.muted }}>
              {[...m.roles, m.isRoot ? peopleCopy.startedGroup : null].filter(Boolean).join(" · ")}
            </Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 12, gap: 8 },
  row: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, padding: 12, gap: 4 },
  title: { fontSize: 15, fontWeight: "600" },
});
