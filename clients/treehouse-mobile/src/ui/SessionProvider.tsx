import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Alert, AppState, Share } from "react-native";
import type { AppSession } from "../native/app_session";
import { pubkeyFingerprint } from "../native/custody";
import type { MobileIdentity } from "../native/custody";
import { bindLifecycle } from "../native/lifecycle";
import type { LifecycleBinding } from "../native/lifecycle";
import type { TreehouseSession } from "../session/session";
import { recovery, refusalCopy } from "./strings";
import { HISTORY_INVALID } from "./trust_card";
import type { Palette } from "./theme";

// SessionProvider (M1a.7): holds the one app session for the running identity and hands it to the routes.
// It knows nothing of the demo: the composition root (src/composition.tsx) passes a Bootstrap that connects
// an identity to its routes and, in dev builds only, a demo bar slot. Lifecycle is bound here: foreground
// starts the link and syncs, background stops it (src/native/lifecycle.ts).

/** What a connect produced: the identity and, when this phone holds a group's routes, its app session. */
export interface Connected {
  identity: MobileIdentity;
  /** Null when there is no group to open (a build without the demo has no routes yet). */
  app: AppSession | null;
  /** Display names by public key that the bootstrap knows (the demo participants' realms). */
  names: Readonly<Record<string, string>>;
  /** One dev line about the routes, or null. */
  detail: string | null;
}

/** The demo bar's props, structurally (the composition root adapts src/demo's DemoBar to it). */
export interface DemoBarSlotProps {
  colors: Palette;
  role: string;
  onRole(role: string): void;
  originDraft: string;
  onOriginDraft(text: string): void;
  onReconnect(): void;
  detail?: string | null;
}

export interface Bootstrap {
  /** Null in a release build without EXPO_PUBLIC_TREEHOUSE_DEMO=1. */
  demo: {
    initialOrigin: string;
    /** Why the dev pointer was refused (never replaced by the public relay), or null. */
    initialError: string | null;
    defaultRole: string;
    Bar: ComponentType<DemoBarSlotProps>;
  } | null;
  connect(origin: string, role: string): Promise<Connected>;
}

export interface DemoControls {
  origin: string;
  role: string;
  setRole(role: string): void;
  originDraft: string;
  setOriginDraft(text: string): void;
  reconnect(): void;
  Bar: ComponentType<DemoBarSlotProps>;
}

export interface SessionContextValue {
  session: TreehouseSession | null;
  app: AppSession | null;
  identity: MobileIdentity | null;
  detail: string | null;
  loading: boolean;
  error: string | null;
  notice: string | null;
  setError(text: string | null): void;
  /** Me, a petname, a bootstrap name, or the key fingerprint. */
  displayName(pubkey: string, petname?: string | null): string;
  /** 04 recovery: save the held Space frames to a file (share sheet). Offered in every phase. */
  exportHeld(): Promise<void>;
  /** 04 recovery: re-sync from the relay into a fresh store, after confirmation. history_invalid only. */
  confirmResync(): void;
  demo: DemoControls | null;
}

const SessionContext = createContext<SessionContextValue | null>(null);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SessionProvider({ boot, children }: { boot: Bootstrap; children: ReactNode }): React.JSX.Element {
  const appRef = useRef<AppSession | null>(null);
  const connectGenRef = useRef(0);
  const lifecycleRef = useRef<LifecycleBinding | null>(null);
  const [app, setApp] = useState<AppSession | null>(null);
  const [identity, setIdentity] = useState<MobileIdentity | null>(null);
  const [names, setNames] = useState<Readonly<Record<string, string>>>({});
  const [detail, setDetail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(boot.demo?.initialError ?? null);
  const [notice, setNotice] = useState<string | null>(null);
  const [origin, setOrigin] = useState(boot.demo?.initialOrigin ?? "");
  // Bumped by Reconnect, so retrying the same origin still reconnects.
  const [attempt, setAttempt] = useState(0);
  const [originDraft, setOriginDraft] = useState(boot.demo?.initialOrigin ?? "");
  const [role, setRole] = useState(boot.demo?.defaultRole ?? "");

  /** Swap in a new app session and close the previous one. */
  const install = useCallback(async (next: AppSession | null) => {
    const previous = appRef.current;
    appRef.current = next;
    setApp(next);
    if (previous && previous !== next) await previous.close();
    if (!next) {
      setNotice(null);
      return;
    }
    // A session that opened while the app was already in the background must not keep its sockets (03).
    lifecycleRef.current?.reconcile();
    const history = next.session.read().history;
    setError(history.ok ? null : `${HISTORY_INVALID} (${history.reason})`);
    const carried = next.carryOver;
    const notices = [
      carried && !carried.ok ? `${recovery.carryOverFailed} (${carried.reason})` : null,
      ...next.adoptFailed.map((f) => `${f.replica}: ${f.reason}`),
    ].filter((n): n is string => n !== null);
    setNotice(notices.length > 0 ? notices.join("\n") : null);
  }, []);

  const connect = useCallback(
    async (targetOrigin: string, targetRole: string) => {
      // A later connect (role or origin switch, re-sync) supersedes this one.
      const generation = ++connectGenRef.current;
      const stale = () => generation !== connectGenRef.current;
      setLoading(true);
      if (boot.demo?.initialError) {
        setError(boot.demo.initialError);
        setLoading(false);
        return;
      }
      try {
        await install(null);
        if (stale()) return;
        const connected = await boot.connect(targetOrigin, targetRole);
        if (stale()) {
          await connected.app?.close();
          return;
        }
        setIdentity(connected.identity);
        setNames(connected.names);
        setDetail(connected.detail);
        await install(connected.app);
      } catch (err) {
        if (!stale()) setError(errorText(err));
      } finally {
        if (!stale()) setLoading(false);
      }
    },
    [boot, install],
  );

  useEffect(() => {
    void connect(origin, role);
  }, [connect, origin, role, attempt]);

  useEffect(
    () => () => {
      connectGenRef.current++;
      void install(null);
    },
    [install],
  );

  // Lifecycle (03): through a ref, because a re-sync or a role switch replaces the session.
  useEffect(() => {
    const binding = bindLifecycle(AppState, {
      foreground: async () => appRef.current?.session.foreground(),
      background: async () => appRef.current?.session.background(),
    });
    lifecycleRef.current = binding;
    return () => {
      lifecycleRef.current = null;
      binding();
    };
  }, []);

  const exportHeld = useCallback(async () => {
    const session = appRef.current?.session;
    if (!session) return;
    try {
      const exported = await session.exportSpaceFrames();
      if (!exported.ok) {
        setError(refusalCopy[exported.reason]);
        return;
      }
      await Share.share({ message: exported.value.text, title: exported.value.fileName }, { subject: recovery.exportTitle });
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  const confirmResync = useCallback(() => {
    const current = appRef.current;
    if (!current) return;
    Alert.alert(recovery.resyncTitle, recovery.confirmResync, [
      { text: recovery.cancel, style: "cancel" },
      {
        text: recovery.confirm,
        style: "destructive",
        onPress: () => {
          const generation = ++connectGenRef.current;
          void (async () => {
            try {
              const fresh = await current.resync();
              if (generation !== connectGenRef.current) {
                await fresh.close();
                return;
              }
              await install(fresh);
            } catch (err) {
              setError(errorText(err));
            }
          })();
        },
      },
    ]);
  }, [install]);

  const displayName = useCallback(
    (pubkey: string, petname?: string | null) => {
      if (identity && pubkey === identity.publicKeyBase64) return identity.realm;
      return petname || names[pubkey] || pubkeyFingerprint(pubkey);
    },
    [identity, names],
  );

  const demo = useMemo<DemoControls | null>(
    () =>
      boot.demo
        ? {
            origin,
            role,
            setRole,
            originDraft,
            setOriginDraft,
            reconnect: () => {
              setOrigin(originDraft.trim() || boot.demo!.initialOrigin);
              setAttempt((n) => n + 1);
            },
            Bar: boot.demo.Bar,
          }
        : null,
    [boot, origin, role, originDraft],
  );

  const value = useMemo<SessionContextValue>(
    () => ({
      session: app?.session ?? null,
      app,
      identity,
      detail,
      loading,
      error,
      notice,
      setError,
      displayName,
      exportHeld,
      confirmResync,
      demo,
    }),
    [app, identity, detail, loading, error, notice, displayName, exportHeld, confirmResync, demo],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession outside SessionProvider");
  return value;
}
