import React, { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { runSelfCheck } from "../../native/selfcheck";
import type { SelfCheck } from "../../native/selfcheck";
import { keyLines, relayRows, safetyLines } from "../../ui/group_view";
import { RelayCard } from "../../ui/RelayCard";
import { KeyCard, SafetyCard } from "../../ui/SafetyCard";
import { SessionBanner } from "../../ui/SessionBanner";
import { useSession } from "../../ui/SessionProvider";
import { audit as auditCopy, exportFile, groupTab, recovery, refusalCopy, threadsTab } from "../../ui/strings";
import { HOSTING_SENTENCE, relayAccess } from "../../ui/trust_card";
import { usePalette } from "../../ui/theme";
import type { Palette } from "../../ui/theme";
import { useReadModel } from "../../ui/useReadModel";

// Group tab (04, M1b.7): the group summary, Relay (the approved HOSTING_SENTENCE, relay address, connection per
// thread, waiting, Sync now, Pause sync), Safety, My key, a link to Verify & audit, and Export, which writes the
// held Space frames to a file and shares it. Every value is a read model's, worded by src/ui/group_view.ts.
// Below them sit the demo bar and the dev-only Self-check and Replica store check cards (the M0.1 and M1a.2
// simulator gates).

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
  const router = useRouter();
  const { session, app, identity, detail, demo, setError, exportHeld } = useSession();
  const group = useReadModel((m) => m.group);
  const linkStatus = useReadModel((m) => m.linkStatus);
  const threads = useReadModel((m) => m.threads);
  const feed = useReadModel((m) => m.link);
  const [selfCheck, setSelfCheck] = useState<SelfCheck | "running" | null>(null);
  const [storeCheck, setStoreCheck] = useState<ReplicaStoreCheckResult | "running" | string | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  // The saved-file line belongs to the key that exported it; a role switch or re-sync starts without it.
  useEffect(() => setExported(null), [session]);
  const access = feed ? relayAccess(feed, group?.replica ?? null) : null;
  const rows = useMemo(() => (linkStatus ? relayRows(linkStatus, threads, group?.replica ?? null) : []), [linkStatus, threads, group]);
  const safety = useMemo(() => safetyLines(demo?.safetyNote ?? null), [demo?.safetyNote]);

  const setPaused = async (paused: boolean) => {
    if (!session) return;
    setError(null);
    const outcome = paused ? await session.goOffline() : await session.goOnline();
    if (!outcome.ok) setError(refusalCopy[outcome.reason]);
  };
  const syncNow = async () => {
    if (!session) return;
    const outcome = await session.syncNow();
    if (!outcome.ok) setError(refusalCopy[outcome.reason]);
  };
  const runExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      setExported(await exportHeld());
    } finally {
      setExporting(false);
    }
  };
  const summary = group
    ? [
        groupTab.members(group.memberCount),
        groupTab.threads(group.threadSlots.used, group.threadSlots.total),
        group.myRoles.length > 0 ? groupTab.roles(group.myRoles.map((r) => groupTab.role[r]).join(", ")) : groupTab.noRole,
      ].join(" · ")
    : groupTab.noGroup;

  return (
    <View style={[styles.root, { backgroundColor: c.bg }]}>
      <SessionBanner />
      <ScrollView contentContainerStyle={styles.list}>
        <Card c={c} title={group?.name || threadsTab.noGroupName}>
          <Text testID="group-summary" style={[styles.body, { color: c.muted }]}>
            {summary}
          </Text>
        </Card>

        <RelayCard
          colors={c}
          hosting={HOSTING_SENTENCE}
          link={linkStatus}
          rows={rows}
          addresses={app?.relayAddresses ?? []}
          noRelayAccess={access === "no_relay_access"}
          disabled={!session}
          onPauseChange={(paused) => void setPaused(paused)}
          onSyncNow={() => void syncNow()}
          onOpenAudit={() => router.push("/audit")}
          auditLabel={auditCopy.open}
          auditHint={auditCopy.openHint}
        />

        <SafetyCard colors={c} lines={safety} />

        {identity ? <KeyCard colors={c} lines={keyLines(identity, threadsTab.keyCheck)} /> : null}

        <Card c={c} title={groupTab.exportTitle}>
          <Pressable
            testID="export-file"
            accessibilityRole="button"
            accessibilityLabel={recovery.export}
            accessibilityHint={groupTab.exportHint}
            disabled={!session || exporting}
            onPress={() => void runExport()}
            style={[styles.button, { backgroundColor: c.surfaceAlt, borderColor: c.border }]}
          >
            <Text style={[styles.buttonText, { color: c.text }]}>{recovery.export}</Text>
          </Pressable>
          {exported ? (
            <Text testID="export-saved" accessibilityLiveRegion="polite" selectable style={[styles.mono, { color: c.muted }]}>
              {exportFile.saved(exported)}
            </Text>
          ) : null}
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
  body: { fontSize: 15, lineHeight: 21 },
  buttonText: { fontSize: 15, fontWeight: "600" },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: "700" },
  actions: { flexDirection: "row", gap: 8 },
  button: { flex: 1, borderWidth: 1, borderRadius: 8, paddingVertical: 9, alignItems: "center" },
  mono: { fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
});
