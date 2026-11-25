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
  createIdentityFromSeedHex,
  ExpoSecureStoreKeyStore,
  loadOrCreateDeviceIdentity,
  type MobileIdentity,
} from "./native/custody";
import { runSelfCheck, type SelfCheck } from "./native/selfcheck";
import {
  DEFAULT_DEMO_WSS_ORIGIN,
  fetchDemoEndpoints,
  fetchDemoSeed,
  TreehouseMobileHost,
  type DemoEndpointsManifest,
} from "./lib/treehouse_mobile_host";

type TabId = "threads" | "people" | "relay";
type IdentityMode = "founder" | "neighbor" | "device";

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
  if (!hostRef.current) {
    hostRef.current = new TreehouseMobileHost({ onStateChange: bump });
  }
  const host = hostRef.current;

  const [tab, setTab] = useState<TabId>("threads");
  const [origin, setOrigin] = useState(DEFAULT_DEMO_WSS_ORIGIN);
  const [originDraft, setOriginDraft] = useState(DEFAULT_DEMO_WSS_ORIGIN);
  const [identityMode, setIdentityMode] = useState<IdentityMode>("founder");
  const [manifest, setManifest] = useState<DemoEndpointsManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [selfCheck, setSelfCheck] = useState<SelfCheck | "running" | null>(null);

  const connect = useCallback(
    async (targetOrigin: string, mode: IdentityMode) => {
      setLoading(true);
      setError(null);
      try {
        const fetchedManifest = await fetchDemoEndpoints(targetOrigin);
        setManifest(fetchedManifest);

        const realmByPubkey: Record<string, string> = {};
        for (const info of Object.values(fetchedManifest.participants)) {
          realmByPubkey[info.pubkey] = info.realm;
        }

        let identity: MobileIdentity;
        if (mode === "device") {
          identity = await loadOrCreateDeviceIdentity(keyStoreRef.current!, "mobile-device");
        } else {
          const seed = await fetchDemoSeed(targetOrigin, mode);
          identity = createIdentityFromSeedHex(seed.realm, seed.seedHex, "demo-seed");
        }

        await host.configure(fetchedManifest.endpoints, identity, realmByPubkey);
        await host.goOnline();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
        bump();
      }
    },
    [host, bump],
  );

  useEffect(() => {
    void connect(origin, identityMode);
    return () => {
      void host.dispose();
    };
  }, [connect, host, origin, identityMode]);

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
  const threadView = threadEp ? host.observeThread(threadEp.replica) : null;
  const feedState = host.getFeedState();
  const identity = host.getIdentity();
  const online = host.isOnline();
  const totalPending = host.getTotalPendingCount();

  const statusPill = useMemo(() => {
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
  }, [loading, online, totalPending, feedState, c.live, c.warn]);

  const handleToggleOnline = async () => {
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
    if (!threadEp || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await host.postMessage(threadEp.replica, draft);
      setDraft("");
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
          style={[styles.pill, { borderColor: statusPill.color, backgroundColor: c.surfaceAlt }]}
          accessibilityRole="button"
        >
          <View style={[styles.dot, { backgroundColor: statusPill.color }]} />
          <Text style={[styles.pillText, { color: c.text }]}>{statusPill.label}</Text>
        </Pressable>
      </View>

      {error ? (
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
        {loading && !spaceView ? (
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
                # {threadView?.title || "General"}
              </Text>
              <Text style={[styles.subHeaderMeta, { color: c.muted }]}>
                {threadView ? `${threadView.posts.length} posts · ${threadView.opCount} ops` : ""}
              </Text>
            </View>

            <FlatList
              data={threadView?.posts ?? []}
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
                    <View style={[styles.avatar, { backgroundColor: item.authorColor }]}>
                      <Text style={styles.avatarText}>
                        {item.authorLabel.slice(0, 2).toUpperCase()}
                      </Text>
                    </View>
                    <Text style={[styles.authorName, { color: c.text }]}>{item.authorLabel}</Text>
                    {item.pending ? (
                      <Text style={[styles.pendingTag, { color: c.warn }]}>Queued offline</Text>
                    ) : (
                      <Text style={[styles.signedTag, { color: c.muted }]}>Verified</Text>
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
              {threadView?.canPost ? (
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
                  Read-only key ({identity?.realm}): switch to Founder or Neighbor in Relay & Safety
                  to post, or request an invitation to this space.
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
            {/* D1 Honest Relay Disclosure */}
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.text }]}>Relay & Safety Disclosure</Text>
              <Text style={[styles.disclosureText, { color: c.muted }]}>
                The relay holds a plaintext copy and can go offline, but cannot forge messages or
                change membership. Every message and membership change is Ed25519-signed and
                verified locally on this device.
              </Text>
            </View>

            {/* Identity Switcher */}
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.text }]}>Active Identity</Text>
              <View style={styles.segmentRow}>
                {(["founder", "neighbor", "device"] as IdentityMode[]).map((mode) => {
                  const active = identityMode === mode;
                  return (
                    <Pressable
                      key={mode}
                      onPress={() => setIdentityMode(mode)}
                      style={[
                        styles.segmentBtn,
                        {
                          backgroundColor: active ? c.accent : c.surfaceAlt,
                          borderColor: active ? c.accent : c.border,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          styles.segmentText,
                          { color: active ? c.accentText : c.text },
                        ]}
                      >
                        {mode === "device" ? "Keychain" : mode[0]!.toUpperCase() + mode.slice(1)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              {identity ? (
                <Text style={[styles.mono, { color: c.muted, marginTop: 8 }]}>
                  {identity.realm} · {identity.fingerprint} ({identity.source})
                </Text>
              ) : null}
            </View>

            {/* Relay Endpoint */}
            <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
              <Text style={[styles.cardTitle, { color: c.text }]}>WSS Relay Origin</Text>
              <TextInput
                value={originDraft}
                onChangeText={setOriginDraft}
                autoCapitalize="none"
                autoCorrect={false}
                style={[
                  styles.originInput,
                  { backgroundColor: c.surfaceAlt, color: c.text, borderColor: c.border },
                ]}
              />
              <View style={styles.actionRow}>
                <Pressable
                  onPress={() => setOrigin(originDraft.trim() || DEFAULT_DEMO_WSS_ORIGIN)}
                  style={[styles.actionBtn, { backgroundColor: c.accent }]}
                >
                  <Text style={[styles.actionBtnText, { color: c.accentText }]}>Reconnect</Text>
                </Pressable>
                <Pressable
                  onPress={() => void host.syncNow()}
                  style={[styles.actionBtn, { backgroundColor: c.surfaceAlt, borderColor: c.border, borderWidth: 1 }]}
                >
                  <Text style={[styles.actionBtnText, { color: c.text }]}>Sync Now</Text>
                </Pressable>
              </View>
              {manifest ? (
                <Text style={[styles.mono, { color: c.muted, marginTop: 8 }]}>
                  Mode: {manifest.mode} · Routes: {host.getEndpoints().length}
                </Text>
              ) : null}
            </View>

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
  segmentRow: { flexDirection: "row", gap: 8 },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: "center",
  },
  segmentText: { fontSize: 13, fontWeight: "600" },
  originInput: {
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    marginBottom: 10,
  },
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
