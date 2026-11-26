import type { CarrierRoute } from "@treetopdevs/lattice-shell-kit";
import type { LocalStore } from "../local/local_store";
import { carryOverLegacyProfiles } from "../session/carry_over";
import type { CarryOverResult } from "../session/carry_over";
import type { Clock, HeldProfile, KeyCustody, RelayLink, TreehouseProduct } from "../session/ports";
import { createFeedRelayLink, createTreehouseSession } from "../session/session";
import type { FeedRelayLinkOptions, TreehouseSession } from "../session/session";
import type { MobileIdentity } from "./custody";
import { legacyNamespaceOf } from "./legacy_snapshot";
import { replicaDbName, SqliteReplicaStore } from "./sqlite_replica_store";
import type { ReplicaDb } from "./sqlite_replica_store";

// M1a.7 stage 1: the app's composition root for one identity, over the real adapters. It replaces the M0
// host bridge: the session owns the only merge path (its gated mergeSync), the ReplicaStore is SQLite, the
// LocalStore is the caller's durable one, and the M0 snapshot is carried over before the session opens so no
// unsynced post is stranded. It takes plain routes and an identity; it knows nothing of the demo.

/** One route plus the product it carries; the store adopts each replica before the first pull. */
export type AppRoute = CarrierRoute & { product: TreehouseProduct };

export interface AppSessionDeps {
  /** The device-local store, opened once by the caller (expo-sqlite on the phone). Never in memory in the app. */
  local: LocalStore;
  clock: Clock;
  /** Opens one replica database by file name. */
  openReplicaDb(name: string): Promise<ReplicaDb>;
  /** The M0 snapshot's profiles for one namespace, read only, or null when there is none. */
  readLegacyProfiles(namespace: string): Promise<Record<string, HeldProfile> | null>;
  link?: FeedRelayLinkOptions;
}

export interface AppSessionConfig {
  identity: MobileIdentity;
  routes: readonly AppRoute[];
}

/** The carry-over result, or why the M0 snapshot could not be read at all. Null when there was nothing to carry. */
export type CarryOverReport = CarryOverResult | { ok: false; replica: null; reason: string } | null;

export interface AppSession {
  session: TreehouseSession;
  carryOver: CarryOverReport;
  /** Routes whose replica could not be adopted (for example a product that conflicts with the held one). */
  adoptFailed: { replica: string; reason: string }[];
  /** Which store this key opened: 0 first, one more after each re-sync. */
  epoch: number;
  storeName: string;
  /**
   * The relay addresses this session dials (M1b.7, Group tab Relay card): each configured route's origin,
   * once. Configuration, not a protocol fact, so it is owned here, where the routes are known.
   */
  relayAddresses: string[];
  /**
   * Re-sync from the relay into a fresh store (04, history_invalid; the caller has asked for confirmation).
   * The failed store is left as it is: nothing is deleted or rewritten. Rejects with `history_ok` otherwise.
   * The fresh session opens (with verified history) before the pointer is saved and before this one closes;
   * on any failure the pointer is unchanged and this one stays open, so the caller keeps a usable
   * (history_invalid) session.
   */
  resync(): Promise<AppSession>;
  close(): Promise<void>;
}

/** The distinct `scheme://host[:port]` of each route URL, in route order. Path and query are dropped. */
export function relayOrigins(routes: readonly { url: string }[]): string[] {
  const origins = routes.map((r) => /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i.exec(r.url)?.[0] ?? r.url);
  return [...new Set(origins)];
}

/** KeyCustody over an already-loaded identity (a demo seed or the Keychain device key). */
export function identityCustody(identity: MobileIdentity): KeyCustody {
  return {
    status: async () => "available",
    publicKey: async () => identity.publicKeyBase64,
    create: async () => {
      throw new Error("key_exists");
    },
    sign: async (bytes) => identity.signer.sign(bytes),
  };
}

export function legacyNamespace(identity: MobileIdentity): string {
  return legacyNamespaceOf(identity.realm, identity.fingerprint);
}

/** The replica database file for one key and epoch. Epoch 0 is M1a.2's file name. */
export function replicaStoreName(publicKeyBase64: string, epoch: number): string {
  const base = replicaDbName(publicKeyBase64);
  return epoch === 0 ? base : base.replace(/\.db$/, `_r${epoch}.db`);
}

export function epochFor(local: LocalStore, publicKeyBase64: string): number {
  const epoch = local.setting("replicaStoreEpochs")[publicKeyBase64];
  return typeof epoch === "number" && Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
}

export async function openAppSession(deps: AppSessionDeps, config: AppSessionConfig, atEpoch?: number): Promise<AppSession> {
  const { identity } = config;
  // A re-sync opens its fresh store by epoch before the pointer names it (closing review, Codex).
  const epoch = atEpoch ?? epochFor(deps.local, identity.publicKeyBase64);
  const storeName = replicaStoreName(identity.publicKeyBase64, epoch);
  // One handle per store: the session's open() opens the store again and must reuse it.
  let db: Promise<ReplicaDb> | null = null;
  const store = new SqliteReplicaStore(() => (db ??= deps.openReplicaDb(storeName)), deps.clock);

  let carryOver: CarryOverReport = null;
  const adoptFailed: { replica: string; reason: string }[] = [];
  let storeOpened = false;
  try {
    await store.open();
    storeOpened = true;
  } catch {
    // session.open() opens it again and reports history_invalid with the reason; nothing is carried.
  }
  if (storeOpened) {
    // Only the first store carries the M0 snapshot. A re-sync store is the person's confirmed choice to start
    // from the relay, so the snapshot (left untouched on disk) is not imported again.
    if (epoch === 0) {
      try {
        const legacy = await deps.readLegacyProfiles(legacyNamespace(identity));
        // Verified first, writes nothing on failure, idempotent: a relaunch carries nothing new.
        if (legacy && Object.keys(legacy).length > 0) carryOver = await carryOverLegacyProfiles(store, legacy);
      } catch (error) {
        carryOver = { ok: false, replica: null, reason: error instanceof Error ? error.message : String(error) };
      }
    }
    // Adopt only writes the replica row; the first pull fills it through the session's gated mergeSync.
    for (const route of config.routes) {
      try {
        await store.adopt(route.replica, route.product);
      } catch (error) {
        adoptFailed.push({ replica: route.replica, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  // A carry-over that failed its check is a verify failure on launch (03): history_invalid, never online, so
  // the M0 posts it could not carry are not silently left behind by a session that looks healthy.
  const blocked = carryOver && !carryOver.ok ? { ok: false as const, replica: carryOver.replica, reason: `carry_over: ${carryOver.reason}` } : undefined;

  let link: RelayLink | null = null;
  const session = createTreehouseSession({
    custody: identityCustody(identity),
    store,
    clock: deps.clock,
    local: deps.local,
    link: (host) => (link = createFeedRelayLink(host, deps.link)),
    blockedHistory: blocked,
  });
  await session.open();
  await link!.configure({
    localRealm: identity.realm,
    routes: config.routes.map(({ replica, url, expectedPeerRealm, expectedPeerPubkey }) => ({
      replica,
      url,
      expectedPeerRealm,
      expectedPeerPubkey,
    })),
  });
  // History that failed its check never goes online (04); nor does a key that does not match it, nor a phone
  // whose person turned sync off (the saved setting, read before goOnline would set it).
  if (session.read().history.ok && session.read().status.phase !== "identity_mismatch" && deps.local.setting("syncEnabled"))
    await session.goOnline();

  const opened: AppSession = {
    session,
    carryOver,
    adoptFailed,
    epoch,
    storeName,
    relayAddresses: relayOrigins(config.routes),
    async resync() {
      if (session.read().history.ok) throw new Error("history_ok");
      // Open the fresh store first and save the pointer only once it opened with verified history. A fresh
      // store that cannot open is history_invalid, not a throw, so it is checked here: on any failure the
      // fresh session is closed, the pointer still names this store and this session stays open.
      const fresh = await openAppSession(deps, config, epoch + 1);
      const opened = fresh.session.read().history;
      if (!opened.ok) {
        await fresh.close();
        throw new Error(opened.reason);
      }
      try {
        const epochs = deps.local.setting("replicaStoreEpochs");
        await deps.local.setSetting("replicaStoreEpochs", { ...epochs, [identity.publicKeyBase64]: epoch + 1 });
      } catch (error) {
        await fresh.close();
        throw error;
      }
      // This session was history_invalid, so it never went online; closing it after the fresh one opened is safe.
      await session.close();
      return fresh;
    },
    close: () => session.close(),
  };
  return opened;
}
