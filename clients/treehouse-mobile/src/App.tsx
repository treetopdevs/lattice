import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import {
  ExpoSecureStoreKeyStore,
  loadOrCreateDeviceIdentity,
  pubkeyColor,
  pubkeyFingerprint,
  type MobileIdentity,
} from "./native/custody";
import { runSelfCheck, type SelfCheck } from "./native/selfcheck";
import { TreehouseMobileHost } from "./lib/treehouse_mobile_host";
import type { DemoRole } from "./demo/identities";
import type { DemoEndpointsManifest } from "./demo/manifest";
import { createHostBridge, identityCustody } from "./lib/host_session_ports";
import { systemClock } from "./session/memory/clock";
import { createTreehouseSession, type TreehouseSession } from "./session/session";
import type { Delivery } from "./session/projections/thread_timeline";
import {
  HOSTING_SENTENCE,
  NO_GROUP_YET,
  NO_RELAY_ACCESS,
  HISTORY_INVALID,
  RELAY_REFUSED_PILL,
  relayAccess,
} from "./ui/trust_card";

// M1a.6: demo code (public demo identities, the demo relay manifest, the demo bar) is reachable only in
// dev builds or with EXPO_PUBLIC_TREEHOUSE_DEMO=1. The flag is read by dot notation so Metro inlines it
// (SDK 58 environment-variable guide); without it the demo modules are never required. Without the demo
// the app holds only this phone's own device key and no group (joining comes with invitations).
const DEMO_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_TREEHOUSE_DEMO === "1";
interface DemoModules {
  manifest: typeof import("./demo/manifest");
  identities: typeof import("./demo/identities");
  bar: typeof import("./demo/DemoBar");
}
const demo: DemoModules | null = DEMO_ENABLED
  ? {
      manifest: require("./demo/manifest"),
      identities: require("./demo/identities"),
      bar: require("./demo/DemoBar"),
    }
  : null;
const DEMO_ORIGIN = demo?.manifest.DEFAULT_DEMO_WSS_ORIGIN ?? "";

// M1a.2 simulator gate: the ReplicaStore contract against expo-sqlite. Dev builds only; a release bundle
// never requires the module (Metro folds __DEV__).
const replicaStoreCheck: typeof import("./native/replica_store_device_check") | null = __DEV__
  ? require("./native/replica_store_device_check")
  : null;
type ReplicaStoreCheckResult = import("./native/replica_store_device_check").DeviceCheckResult;

// M1a.1: the thread tab reads the session's ThreadTimeline and Post calls session.postMessage. The M0
// host still owns routes, sync and the People tab until M1a.4.
const DELIVERY_LABEL: Record<Delivery, string> = {
  saved: "Saved on this phone",
  sending: "Sending",
  on_relay: "On relay",
};

type TabId = "threads" | "people" | "relay";

interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentText: string;
  live: string;
  warn: string;
  error: string;
}

const LIGHT: Palette = {
  bg: "#F6F7F5",
  surface: "#FFFFFF",
  surfaceAlt: "#EEF1ED",
  border: "#DCE2DA",
  text: "#182019",
  muted: "#5B685E",
  accent: "#236B43",
  accentText: "#FFFFFF",
  live: "#1E7F4B",
  warn: "#B4690E",
  error: "#B83232",
};

const DARK: Palette = {
  bg: "#0F1411",
  surface: "#171E1A",
  surfaceAlt: "#202A24",
  border: "#2B3830",
  text: "#EFF4F0",
  muted: "#9BA99F",
  accent: "#3AA76D",
  accentText: "#09140E",
  live: "#3AA76D",
  warn: "#E2A23B",
  error: "#E06464",
};

export default function App(): React.JSX.Element {
  const scheme = useColorScheme();
  const c = scheme === "dark" ? DARK : LIGHT;

  const keyStoreRef = useRef<ExpoSecureStoreKeyStore | null>(null);
  if (!keyStoreRef.current) keyStoreRef.current = new ExpoSecureStoreKeyStore();

  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((n) => n + 1), []);

  const hostRef = useRef<TreehouseMobileHost | null>(null);
  const bridgeRef = useRef<ReturnType<typeof createHostBridge> | null>(null);
  if (!bridgeRef.current) bridgeRef.current = createHostBridge(() => hostRef.current!);
  const bridge = bridgeRef.current;
  if (!hostRef.current) {
    hostRef.current = new TreehouseMobileHost({
      onStateChange: () => {
        bridge.notify();
        bump();
      },
    });
  }
  const host = hostRef.current;
  const sessionRef = useRef<TreehouseSession | null>(null);
  const connectGenRef = useRef(0);

  const [tab, setTab] = useState<TabId>("threads");
  const [origin, setOrigin] = useState(DEMO_ORIGIN);
  const [originDraft, setOriginDraft] = useState(DEMO_ORIGIN);
  const [role, setRole] = useState<DemoRole>("founder");
  const [ownIdentity, setOwnIdentity] = useState<MobileIdentity | null>(null);
  const [manifest, setManifest] = useState<DemoEndpointsManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [selfCheck, setSelfCheck] = useState<SelfCheck | "running" | null>(null);
  const [storeCheck, setStoreCheck] = useState<ReplicaStoreCheckResult | "running" | string | null>(null);

  const connect = useCallback(
    async (targetOrigin: string, mode: DemoRole) => {
      // A later connect (identity or origin switch) supersedes this one: never keep a session whose
      // key differs from the identity the host was configured with.
      const generation = ++connectGenRef.current;
      const stale = () => generation !== connectGenRef.current;
      setLoading(true);
      setError(null);
      try {
        if (!demo) {
          // No demo: this phone's own key only. No route is known, so nothing dials (no group yet).
          const own = await loadOrCreateDeviceIdentity(keyStoreRef.current!, "mobile-device");
          if (!stale()) setOwnIdentity(own);
          return;
        }
        const fetchedManifest = await demo.manifest.fetchDemoEndpoints(targetOrigin);
        if (stale()) return;
        setManifest(fetchedManifest);
        const realmByPubkey = demo.manifest.demoRealmByPubkey(fetchedManifest);
        const identity = await demo.identities.loadDemoIdentity(targetOrigin, mode);
        // Nothing shared (manifest, session, host) is touched until this connect is known to be current.
        if (stale()) return;

        await sessionRef.current?.close();
        sessionRef.current = null;
        await host.configure(fetchedManifest.endpoints, identity, realmByPubkey);
        if (stale()) return;
        const session = createTreehouseSession({
          custody: identityCustody(identity),
          store: bridge.store,
          clock: systemClock,
          link: () => bridge.link,
        });
        await session.open();
        if (stale()) {
          await session.close();
          return;
        }
        sessionRef.current = session;
        // Verify-on-open runs over the held snapshot; a failure is history_invalid (03, 04): show it with
        // its reason code and do not go online, so nothing more is merged into history that failed.
        const history = session.read().history;
        if (!history.ok) {
          setError(`${HISTORY_INVALID} (${history.reason})`);
          return;
        }
        await host.goOnline();
      } catch (err) {
        if (!stale()) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!stale()) {
          setLoading(false);
          bump();
        }
      }
    },
    [host, bridge, bump],
  );

  useEffect(() => {
    void connect(origin, role);
    return () => {
      void sessionRef.current?.close();
      sessionRef.current = null;
      void host.dispose();
    };
  }, [connect, host, origin, role]);

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && host.isOnline()) {
        void host.syncNow();
      }
    });
    return () => sub.remove();
  }, [host]);

  const spaceEp = host.getSpaceEndpoint();
  const threadEp = host.getThreadEndpoint();
  const spaceView = spaceEp ? host.observeSpace(spaceEp.replica) : null;
  const timeline = threadEp ? sessionRef.current?.read().timelines[threadEp.replica] ?? null : null;
  const authorLabel = (pubkey: string): string => {
    if (identity && pubkey === identity.publicKeyBase64) return identity.realm;
    const named = Object.values(manifest?.participants ?? {}).find((p) => p.pubkey === pubkey);
    return named?.realm ?? pubkeyFingerprint(pubkey);
  };
  const feedState = host.getFeedState();
  const identity = host.getIdentity() ?? ownIdentity;
  const online = host.isOnline();
  const totalPending = host.getTotalPendingCount();
  const access = relayAccess(feedState, spaceEp?.replica ?? null);

  const statusPill = useMemo(() => {
    if (access === "no_relay_access") return { label: RELAY_REFUSED_PILL, color: c.error };
    if (!demo) return { label: "No group yet", color: c.muted };
    if (loading) return { label: "Connecting…", color: c.warn };
    if (!online) {
      return {
        label: totalPending > 0 ? `Offline · ${totalPending} queued` : "Offline",
        color: c.warn,
      };
    }
    const maxGen = feedState.routes.reduce((m, r) => Math.max(m, r.generation ?? 0), 0);
    const anyLive = feedState.routes.some((r) => r.connection === "live");
    if (anyLive) {
      return {
        label: totalPending > 0 ? `Live · ${totalPending} queued` : `Live · gen#${maxGen}`,
        color: c.live,
      };
    }
    return { label: "Syncing…", color: c.warn };
  }, [access, loading, online, totalPending, feedState, c.live, c.warn, c.error, c.muted]);

  const handleToggleOnline = async () => {
    // history_invalid: stay offline and keep the banner that says why.
    if (!host.isOnline() && sessionRef.current?.read().history.ok === false) return;
    setError(null);
    try {
      if (host.isOnline()) {
        await host.goOffline();
      } else {
        await host.goOnline();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    bump();
  };

  const handleSend = async () => {
    const session = sessionRef.current;
    if (!threadEp || !session || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const result = await session.postMessage(threadEp.replica, draft);
      if (result.ok) setDraft("");
      else setError(result.reason);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      bump();
    }
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: c.bg }]}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />

      {/* Top Header */}
      <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.border }]}>
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: c.text }]} numberOfLines={1}>
            {spaceView?.name || "Treehouse Mobile"}
          </Text>
          <Text style={[styles.headerSubtitle, { color: c.muted }]} numberOfLines={1}>
            {identity ? `${identity.realm} · ${identity.fingerprint}` : "Initializing key…"}
          </Text>
        </View>
        <Pressable
          onPress={handleToggleOnline}
          disabled={!demo}
          style={[styles.pill, { borderColor: statusPill.color, backgroundColor: c.surfaceAlt }]}
          accessibilityRole="button"
        >
          <View style={[styles.dot, { backgroundColor: statusPill.color }]} />
          <Text style={[styles.pillText, { color: c.text }]}>{statusPill.label}</Text>
        </Pressable>
      </View>

      {access === "no_relay_access" ? (
        <View testID="no-relay-access" style={[styles.errorBanner, { backgroundColor: c.error }]}>
          <Text style={styles.errorText}>{NO_RELAY_ACCESS}</Text>
        </View>
      ) : null}

      {error && access !== "no_relay_access" ? (
        <View style={[styles.errorBanner, { backgroundColor: c.error }]}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {/* Main Content */}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
      >
        {!demo && tab !== "relay" ? (
          <View style={styles.center}>
            <Text style={[styles.mutedText, { color: c.muted, textAlign: "center" }]}>{NO_GROUP_YET}</Text>
          </View>
        ) : loading && !spaceView ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={c.accent} />
            <Text style={[styles.mutedText, { color: c.muted, marginTop: 12 }]}>
              Connecting over authenticated WSS…
            </Text>
          </View>
        ) : tab === "threads" ? (
          <View style={styles.flex}>
            <View
              style={[
                styles.subHeader,
                { backgroundColor: c.surfaceAlt, borderBottomColor: c.border },
              ]}
            >
              <Text style={[styles.subHeaderTitle, { color: c.text }]}>
                # {timeline?.title || "General"}
              </Text>
              <Text style={[styles.subHeaderMeta, { color: c.muted }]}>
                {timeline ? `${timeline.messages.length} posts · ${host.getFrames(timeline.replica).length} ops` : ""}
              </Text>
            </View>

            <FlatList
              data={timeline?.messages ?? []}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.messageList}
              ListEmptyComponent={
                <Text style={[styles.mutedText, { color: c.muted, textAlign: "center" }]}>
                  No signed messages yet.
                </Text>
              }
              renderItem={({ item }) => (
                <View style={[styles.messageCard, { backgroundColor: c.surface, borderColor: c.border }]}>
                  <View style={styles.messageHeader}>
                    <View style={[styles.avatar, { backgroundColor: pubkeyColor(item.author) }]}>
                      <Text style={styles.avatarText}>
                        {authorLabel(item.author).slice(0, 2).toUpperCase()}
                      </Text>
                    </View>
                    <Text style={[styles.authorName, { color: c.text }]}>{authorLabel(item.author)}</Text>
                    {item.delivery && item.delivery !== "on_relay" ? (
                      <Text style={[styles.pendingTag, { color: c.warn }]}>{DELIVERY_LABEL[item.delivery]}</Text>
                    ) : (
                      <Text style={[styles.signedTag, { color: c.muted }]}>
                        {item.delivery ? DELIVERY_LABEL[item.delivery] : "Verified"}
                      </Text>
                    )}
                  </View>
                  <Text style={[styles.messageBody, { color: c.text }]}>{item.text}</Text>
                </View>
              )}
            />

            {/* Composer */}
            <View
              style={[styles.composer, { backgroundColor: c.surface, borderTopColor: c.border }]}
            >
              {timeline?.canPost ? (
                <>
                  <TextInput
                    value={draft}
                    onChangeText={setDraft}
                    placeholder={
                      online
                        ? "Write a signed text message…"
                        : "Offline — message will queue locally…"
                    }
                    placeholderTextColor={c.muted}
                    style={[
                      styles.input,
                      { backgroundColor: c.surfaceAlt, color: c.text, borderColor: c.border },
                    ]}
                    multiline
                    maxLength={2000}
                  />
                  <Pressable
                    onPress={handleSend}
                    disabled={sending || !draft.trim()}
                    style={[
                      styles.sendBtn,
                      {
                        backgroundColor:
                          sending || !draft.trim() ? c.border : c.accent,
                      },
                    ]}
                  >
                    <Text style={[styles.sendBtnText, { color: c.accentText }]}>
                      {sending ? "…" : "Post"}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <Text style={[styles.readOnlyNote, { color: c.muted }]}>
                  This key ({identity?.realm}) cannot post in this thread.
                </Text>
              )}
            </View>
          </View>
        ) : tab === "people" ? (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.text }]}>Space Authority</Text>
              <Text style={[styles.cardRow, { color: c.muted }]}>
                Admin: <Text style={{ color: c.text }}>{spaceView?.adminHolder ?? "—"}</Text>
              </Text>
              <Text style={[styles.cardRow, { color: c.muted }]}>
                Moderator: <Text style={{ color: c.text }}>{spaceView?.moderatorHolder ?? "—"}</Text>
              </Text>
              <Text style={[styles.cardRow, { color: c.muted }]}>
                Space Ops: <Text style={{ color: c.text }}>{spaceView?.opCount ?? 0}</Text> ·
                Quarantined:{" "}
                <Text style={{ color: c.text }}>{spaceView?.quarantinedCount ?? 0}</Text>
              </Text>
            </View>

            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.text }]}>
                Admitted Members ({spaceView?.members.length ?? 0})
              </Text>
              {(spaceView?.members ?? []).map((m) => (
                <View key={m.pubkey} style={styles.memberRow}>
                  <View style={[styles.avatar, { backgroundColor: m.color }]}>
                    <Text style={styles.avatarText}>{m.label.slice(0, 2).toUpperCase()}</Text>
                  </View>
                  <View style={styles.flex}>
                    <Text style={[styles.authorName, { color: c.text }]}>{m.label}</Text>
                    <Text style={[styles.mono, { color: c.muted }]}>Key {m.fingerprint}</Text>
                  </View>
                </View>
              ))}
            </View>
          </ScrollView>
        ) : (
          <ScrollView contentContainerStyle={styles.scrollContent}>
            {/* Trust card: the approved hosting sentence (01) */}
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.text }]}>Relay</Text>
              <Text testID="trust-card" style={[styles.disclosureText, { color: c.muted }]}>
                {HOSTING_SENTENCE}
              </Text>
              {access === "no_relay_access" ? (
                <Text style={[styles.disclosureText, { color: c.error, marginTop: 8 }]}>{NO_RELAY_ACCESS}</Text>
              ) : null}
            </View>

            {/* This phone's key (demo identities are chosen in the demo bar) */}
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.text }]}>Key</Text>
              {identity ? (
                <Text style={[styles.mono, { color: c.muted }]}>
                  {identity.realm} · {identity.fingerprint} ({identity.source})
                </Text>
              ) : null}
              {demo ? (
                <View style={[styles.actionRow, { marginTop: 10 }]}>
                  <Pressable
                    onPress={() => void host.syncNow()}
                    style={[styles.actionBtn, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderWidth: 1 }]}
                  >
                    <Text style={[styles.actionBtnText, { color: c.text }]}>Sync Now</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>

            {demo ? (
              <demo.bar.DemoBar
                colors={c}
                role={role}
                onRole={setRole}
                originDraft={originDraft}
                onOriginDraft={setOriginDraft}
                onReconnect={() => setOrigin(originDraft.trim() || DEMO_ORIGIN)}
                detail={manifest ? `Mode: ${manifest.mode} · Routes: ${host.getEndpoints().length}` : null}
              />
            ) : null}

            {__DEV__ ? (
              <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
                <Text style={[styles.cardTitle, { color: c.text }]}>Self-check</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Run self-check"
                  disabled={selfCheck === "running"}
                  onPress={() => {
                    setSelfCheck("running");
                    runSelfCheck().then(setSelfCheck, () => setSelfCheck(null));
                  }}
                  style={[styles.actionBtn, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderWidth: 1 }]}
                >
                  <Text style={[styles.actionBtnText, { color: c.text }]}>Run Self-check</Text>
                </Pressable>
                {selfCheck === "running" ? (
                  <Text style={[styles.mono, { color: c.muted, marginTop: 8 }]}>running</Text>
                ) : selfCheck ? (
                  <View testID="selfcheck-result" style={{ marginTop: 8 }}>
                    <Text style={[styles.mono, { color: c.text }]}>
                      custody: {selfCheck.custody.ok ? "pass" : "FAIL"} ({selfCheck.custody.detail})
                    </Text>
                    <Text style={[styles.mono, { color: c.text }]}>
                      storage: {selfCheck.storage.ok ? "pass" : "FAIL"} {selfCheck.storage.backend} ({selfCheck.storage.detail})
                    </Text>
                    <Text style={[styles.mono, { color: c.text }]}>
                      crypto: {selfCheck.crypto.ok ? "pass" : "FAIL"} ({selfCheck.crypto.detail})
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            {replicaStoreCheck ? (
              <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
                <Text style={[styles.cardTitle, { color: c.text }]}>Replica store check</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Run replica store check"
                  disabled={storeCheck === "running"}
                  onPress={() => {
                    setStoreCheck("running");
                    replicaStoreCheck
                      .runReplicaStoreDeviceCheck()
                      .then(setStoreCheck, (e: unknown) => setStoreCheck(`error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160)));
                  }}
                  style={[styles.actionBtn, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderWidth: 1 }]}
                >
                  <Text style={[styles.actionBtnText, { color: c.text }]}>Run replica store check</Text>
                </Pressable>
                {storeCheck === "running" ? (
                  <Text style={[styles.mono, { color: c.muted, marginTop: 8 }]}>running</Text>
                ) : typeof storeCheck === "string" ? (
                  <Text style={[styles.mono, { color: c.text, marginTop: 8 }]}>{storeCheck}</Text>
                ) : storeCheck ? (
                  <View testID="replica-store-check-result" style={{ marginTop: 8 }}>
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
              </View>
            ) : null}

            {/* Route Feed State */}
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.text }]}>Authenticated Routes</Text>
              {feedState.routes.map((r) => (
                <View key={r.replica} style={[styles.routeRow, { borderTopColor: c.border }]}>
                  <Text style={[styles.mono, { color: c.text }]} numberOfLines={1}>
                    {r.replica}
                  </Text>
                  <Text style={[styles.mono, { color: c.muted }]}>
                    {r.connection} · gen#{r.generation ?? 0} · ops {host.getFrames(r.replica).length}
                  </Text>
                </View>
              ))}
            </View>
          </ScrollView>
        )}
      </KeyboardAvoidingView>

      {/* Bottom Tab Bar */}
      <View style={[styles.tabBar, { backgroundColor: c.surface, borderTopColor: c.border }]}>
        {(
          [
            { id: "threads", label: "Threads" },
            { id: "people", label: "People" },
            { id: "relay", label: "Relay & Safety" },
          ] as { id: TabId; label: string }[]
        ).map((item) => {
          const active = tab === item.id;
          return (
            <Pressable
              key={item.id}
              onPress={() => setTab(item.id)}
              style={styles.tabItem}
              accessibilityRole="tab"
            >
              <Text
                style={[
                  styles.tabLabel,
                  { color: active ? c.accent : c.muted, fontWeight: active ? "700" : "500" },
                ]}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitleWrap: { flex: 1, marginRight: 12 },
  headerTitle: { fontSize: 18, fontWeight: "700" },
  headerSubtitle: { fontSize: 12, marginTop: 2 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  pillText: { fontSize: 12, fontWeight: "600" },
  errorBanner: { paddingHorizontal: 16, paddingVertical: 8 },
  errorText: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },
  subHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  subHeaderTitle: { fontSize: 15, fontWeight: "600" },
  subHeaderMeta: { fontSize: 12 },
  messageList: { padding: 14, gap: 10 },
  messageCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  messageHeader: { flexDirection: "row", alignItems: "center", marginBottom: 6 },
  avatar: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 8,
  },
  avatarText: { color: "#FFFFFF", fontSize: 11, fontWeight: "700" },
  authorName: { fontSize: 14, fontWeight: "600", flex: 1 },
  pendingTag: { fontSize: 11, fontWeight: "600" },
  signedTag: { fontSize: 11 },
  messageBody: { fontSize: 15, lineHeight: 21 },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 110,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 15,
  },
  sendBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  sendBtnText: { fontSize: 15, fontWeight: "700" },
  readOnlyNote: { fontSize: 13, lineHeight: 18, padding: 4 },
  scrollContent: { padding: 14, gap: 12 },
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
  },
  cardTitle: { fontSize: 15, fontWeight: "700", marginBottom: 8 },
  cardRow: { fontSize: 13, marginBottom: 4 },
  disclosureText: { fontSize: 13, lineHeight: 19 },
  memberRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
  actionRow: { flexDirection: "row", gap: 8 },
  actionBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: 8,
    alignItems: "center",
  },
  actionBtnText: { fontSize: 14, fontWeight: "600" },
  routeRow: {
    paddingTop: 8,
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  mono: { fontSize: 12, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace" },
  mutedText: { fontSize: 14 },
  tabBar: {
    flexDirection: "row",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  tabItem: { flex: 1, alignItems: "center", justifyContent: "center" },
  tabLabel: { fontSize: 13 },
});
