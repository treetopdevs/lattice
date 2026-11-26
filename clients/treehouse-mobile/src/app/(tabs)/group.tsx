import React, { useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { runSelfCheck } from "../../native/selfcheck";
import type { SelfCheck } from "../../native/selfcheck";
import { SessionBanner } from "../../ui/SessionBanner";
import { useSession } from "../../ui/SessionProvider";
import { linkPillLabel, recovery, refusalCopy, relay as relayCopy, threadsTab } from "../../ui/strings";
import { HOSTING_SENTENCE, NO_RELAY_ACCESS, relayAccess } from "../../ui/trust_card";
import { usePalette } from "../../ui/theme";
import type { Palette } from "../../ui/theme";
import { useReadModel } from "../../ui/useReadModel";

// Group tab placeholder (M1a.7): the group summary, the relay section with the trust card, recovery, the demo
// bar, and the dev-only Self-check and Replica store check cards (the M0.1 and M1a.2 simulator gates). The
// designed tab is M1b.7.

// M1a.2 simulator gate: the ReplicaStore contract against expo-sqlite. Dev builds only; a release bundle
// never requires the module (Metro folds __DEV__).
const replicaStoreCheck: typeof import("../../native/replica_store_device_check") | null = __DEV__
  ? require("../../native/replica_store_device_check")
  : null;
type ReplicaStoreCheckResult = import("../../native/replica_store_device_check").DeviceCheckResult;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function Card({ c, title, children }: { c: Palette; title: string; children: React.ReactNode }) {
  return (
    <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[styles.cardTitle, { color: c.text }]}>{title}</Text>
      {children}
    </View>
  );
}

function Button({ c, label, onPress, disabled }: { c: Palette; label: string; onPress(): void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}
    >
      <Text style={{ color: c.text, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export default function GroupScreen(): React.JSX.Element {
  const c = usePalette();
  const { session, identity, detail, demo, setError, exportHeld } = useSession();
  const group = useReadModel((m) => m.group);
  const linkStatus = useReadModel((m) => m.linkStatus);
  const feed = useReadModel((m) => m.link);
  const [selfCheck, setSelfCheck] = useState<SelfCheck | "running" | null>(null);
  const [storeCheck, setStoreCheck] = useState<ReplicaStoreCheckResult | "running" | string | null>(null);
  const access = feed ? relayAccess(feed, group?.replica ?? null) : null;

  const toggleSync = async () => {
    if (!session || !linkStatus) return;
    setError(null);
    const outcome = linkStatus.pill === "offline" ? await session.goOnline() : await session.goOffline();
    if (!outcome.ok) setError(refusalCopy[outcome.reason]);
  };
  const syncNow = async () => {
    if (!session) return;
    const outcome = await session.syncNow();
    if (!outcome.ok) setError(refusalCopy[outcome.reason]);
  };

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <SessionBanner />
      <ScrollView contentContainerStyle={styles.list}>
        <Card c={c} title={group?.name || "Group"}>
          <Text testID="group-summary" style={[styles.mono, { color: c.muted }]}>
            {group
              ? `members ${group.memberCount} · threads ${group.threadSlots.used}/${group.threadSlots.total} · my roles ${group.myRoles.join(", ") || "none"}`
              : "no group"}
          </Text>
        </Card>

        <Card c={c} title="Relay">
          <Text testID="trust-card" style={{ color: c.muted, lineHeight: 19 }}>
            {HOSTING_SENTENCE}
          </Text>
          {access === "no_relay_access" ? <Text style={{ color: c.error, marginTop: 8 }}>{NO_RELAY_ACCESS}</Text> : null}
          {demo ? (
            <Text testID="relay-origin" style={[styles.mono, { color: c.text, marginTop: 8 }]}>
              {demo.origin || "no relay"}
            </Text>
          ) : null}
          <Text testID="link-state" style={[styles.mono, { color: c.muted, marginTop: 8 }]}>
            {linkStatus ? linkPillLabel[linkStatus.pill] : "-"}
            {(linkStatus?.routes ?? []).map((r) => `\n${r.connection} · waiting ${r.waiting} · ${r.replica.slice(0, 40)}`).join("")}
          </Text>
          <View style={styles.actions}>
            <Button c={c} label={linkStatus?.pill === "offline" ? relayCopy.resumeSync : relayCopy.pauseSync} onPress={() => void toggleSync()} disabled={!session} />
            <Button c={c} label={relayCopy.syncNow} onPress={() => void syncNow()} disabled={!session} />
          </View>
          <Button c={c} label={recovery.export} onPress={() => void exportHeld()} disabled={!session} />
        </Card>

        <Card c={c} title="Key">
          <Text style={[styles.mono, { color: c.muted }]}>
            {identity ? `${threadsTab.keyCheck(identity.fingerprint)} (${identity.source})` : "-"}
          </Text>
        </Card>

        {demo ? (
          <demo.Bar
            colors={c}
            role={demo.role}
            onRole={demo.setRole}
            originDraft={demo.originDraft}
            onOriginDraft={demo.setOriginDraft}
            onReconnect={demo.reconnect}
            detail={detail}
          />
        ) : null}

        {__DEV__ ? (
          <Card c={c} title="Self-check">
            <Button
              c={c}
              label="Run Self-check"
              disabled={selfCheck === "running"}
              onPress={() => {
                setSelfCheck("running");
                runSelfCheck().then(setSelfCheck, () => setSelfCheck(null));
              }}
            />
            {selfCheck === "running" ? (
              <Text style={[styles.mono, { color: c.muted }]}>running</Text>
            ) : selfCheck ? (
              <View testID="selfcheck-result">
                <Text style={[styles.mono, { color: c.text }]}>custody: {selfCheck.custody.ok ? "pass" : "FAIL"} ({selfCheck.custody.detail})</Text>
                <Text style={[styles.mono, { color: c.text }]}>
                  storage: {selfCheck.storage.ok ? "pass" : "FAIL"} {selfCheck.storage.backend} ({selfCheck.storage.detail})
                </Text>
                <Text style={[styles.mono, { color: c.text }]}>crypto: {selfCheck.crypto.ok ? "pass" : "FAIL"} ({selfCheck.crypto.detail})</Text>
              </View>
            ) : null}
          </Card>
        ) : null}

        {replicaStoreCheck ? (
          <Card c={c} title="Replica store check">
            <Button
              c={c}
              label="Run replica store check"
              disabled={storeCheck === "running"}
              onPress={() => {
                setStoreCheck("running");
                replicaStoreCheck
                  .runReplicaStoreDeviceCheck()
                  .then(setStoreCheck, (e: unknown) => setStoreCheck(`error: ${errorText(e)}`.slice(0, 160)));
              }}
            />
            {storeCheck === "running" ? (
              <Text style={[styles.mono, { color: c.muted }]}>running</Text>
            ) : typeof storeCheck === "string" ? (
              <Text style={[styles.mono, { color: c.text }]}>{storeCheck}</Text>
            ) : storeCheck ? (
              <View testID="replica-store-check-result">
                <Text style={[styles.mono, { color: c.text }]}>
                  {storeCheck.adapter}: {storeCheck.passed}/{storeCheck.total} pass
                </Text>
                {storeCheck.cases.map((k) => (
                  <Text key={k.name} style={[styles.mono, { color: c.text }]}>
                    {k.ok ? "pass" : "FAIL"} {k.name}
                    {k.detail ? ` (${k.detail})` : ""}
                  </Text>
                ))}
              </View>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  list: { padding: 12, gap: 12 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  actions: { flexDirection: "row", gap: 8 },
  button: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 9, alignItems: "center" },
  mono: { fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
});
