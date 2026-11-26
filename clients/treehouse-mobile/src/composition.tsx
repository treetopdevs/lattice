import React from "react";
import { ExpoSecureStoreKeyStore, loadOrCreateDeviceIdentity } from "./native/custody";
import { openAppSession } from "./native/app_session";
import type { AppRoute, AppSessionDeps } from "./native/app_session";
import { openExpoLegacyDb, readLegacyProfiles } from "./native/legacy_snapshot";
import type { LegacyDb } from "./native/legacy_snapshot";
import { openExpoReplicaDb } from "./native/sqlite_replica_store";
import { openExpoLocalStore } from "./local/sqlite_local_store";
import type { LocalStore } from "./local/local_store";
import { systemClock } from "./session/memory/clock";
import type { Bootstrap, Connected, DemoBarSlotProps } from "./ui/SessionProvider";

// The composition root (M1a.7, was src/App.tsx): the real adapters, and the demo behind its fence. Only this
// file reaches src/demo. Demo code (public demo identities, the demo relay manifest, the demo bar) is
// reachable only in dev builds or with EXPO_PUBLIC_TREEHOUSE_DEMO=1. The flag is read by dot notation so Metro
// inlines it (SDK 58 environment-variable guide); without it the demo modules are never required. Without the
// demo the app holds only this phone's own key and no group (joining comes with invitations).
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

type DemoManifest = import("./demo/manifest").DemoEndpointsManifest;

const keyStore = new ExpoSecureStoreKeyStore();
// The device-local store: one expo-sqlite file for the app's lifetime. No memory fallback (M1a.3).
let local: Promise<LocalStore> | null = null;
// The M0 snapshot file, opened once and only read (carry-over).
let legacyDb: Promise<LegacyDb> | null = null;

function appDeps(store: LocalStore): AppSessionDeps {
  return {
    local: store,
    clock: systemClock,
    openReplicaDb: openExpoReplicaDb,
    async readLegacyProfiles(namespace) {
      legacyDb ??= openExpoLegacyDb();
      return readLegacyProfiles(await legacyDb, namespace);
    },
  };
}

function routesOf(manifest: DemoManifest): AppRoute[] {
  return manifest.endpoints
    .filter((ep) => ep.product === "Treehouse.Space" || ep.product === "Treehouse.Thread")
    .map((ep) => ({
      replica: ep.replica,
      product: ep.product as AppRoute["product"],
      url: ep.ws_url,
      expectedPeerRealm: ep.peer_realm,
      expectedPeerPubkey: ep.peer_pubkey,
    }));
}

// The demo origin is the public demo relay unless the dev-build pointer names a loopback relay. A pointer that
// is not loopback is an error, never a silent switch to the public relay.
function initialOrigin(modules: DemoModules): { origin: string; error: string | null } {
  try {
    return { origin: modules.manifest.demoOrigin(modules.manifest.DEMO_ORIGIN_POINTER), error: null };
  } catch (e) {
    return { origin: "", error: e instanceof Error ? e.message : String(e) };
  }
}

function demoBarSlot(modules: DemoModules): React.ComponentType<DemoBarSlotProps> {
  const { DEMO_ROLES } = modules.identities;
  const isRole = (r: string): r is (typeof DEMO_ROLES)[number] => (DEMO_ROLES as readonly string[]).includes(r);
  const Bar = modules.bar.DemoBar;
  return function DemoBarSlot(props: DemoBarSlotProps) {
    return <Bar {...props} role={isRole(props.role) ? props.role : DEMO_ROLES[0]} />;
  };
}

async function connect(origin: string, role: string): Promise<Connected> {
  if (!demo) {
    // No demo: this phone's own key only. No route is known, so nothing dials (no group yet).
    const own = await loadOrCreateDeviceIdentity(keyStore, "mobile-device");
    return { identity: own, app: null, detail: null };
  }
  const { DEMO_ROLES } = demo.identities;
  const demoRole = (DEMO_ROLES as readonly string[]).includes(role) ? (role as (typeof DEMO_ROLES)[number]) : DEMO_ROLES[0];
  const manifest = await demo.manifest.fetchDemoEndpoints(origin);
  const identity = await demo.identities.loadDemoIdentity(origin, demoRole);
  local ??= openExpoLocalStore();
  const app = await openAppSession(appDeps(await local), { identity, routes: routesOf(manifest) });
  return {
    identity,
    app,
    detail: `Mode: ${manifest.mode} · Routes: ${routesOf(manifest).length}${__DEV__ ? ` · store ${app.epoch}` : ""}`,
  };
}

export const bootstrap: Bootstrap = {
  demo: demo
    ? (() => {
        const start = initialOrigin(demo);
        return {
          initialOrigin: start.origin,
          initialError: start.error,
          defaultRole: demo.identities.DEMO_ROLES[0],
          Bar: demoBarSlot(demo),
          safetyNote: demo.identities.DEMO_KEYS_PUBLIC,
        };
      })()
    : null,
  connect,
};
