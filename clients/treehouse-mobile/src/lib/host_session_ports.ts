import type { CarrierOpFrame } from "@treetopdevs/lattice-client";
import type { MobileIdentity } from "../native/custody";
import type { FeedState, HeldReplica, KeyCustody, RelayLink, ReplicaStore } from "../session/ports";
import type { TreehouseMobileHost } from "./treehouse_mobile_host";

// Temporary bridge (M1a.1 to M1a.4): the session reads and writes the same identity-scoped snapshot that
// TreehouseMobileHost syncs, so the M0 screen has one frame source and no saved post is stranded in a
// second store. The host still owns routes, the feed and online/offline until M1a.4 and M1a.6 replace it;
// M1a.2's SQLite store must carry this snapshot's unsynced outbox over (defect a in 07).

export interface HostBridge {
  /** Call from the host's onStateChange: the store and link adapters re-announce host state. */
  notify(): void;
  store: ReplicaStore;
  link: RelayLink;
}

export function createHostBridge(getHost: () => TreehouseMobileHost): HostBridge {
  const storeListeners = new Set<(replica: string) => void>();
  const linkListeners = new Set<(state: FeedState) => void>();
  const replicas = (): HeldReplica[] =>
    getHost()
      .getEndpoints()
      .filter((ep) => ep.product === "Treehouse.Space" || ep.product === "Treehouse.Thread")
      .map((ep) => ({ replica: ep.replica, product: ep.product as HeldReplica["product"] }));
  const size = (replica: string) => {
    const p = getHost().profile(replica);
    return `${p?.frames.length ?? 0}:${p?.acked.length ?? 0}`;
  };

  const store: ReplicaStore = {
    async open() {},
    replicas,
    profile: (replica) => getHost().profile(replica),
    async adopt(replica, product) {
      if (!replicas().some((r) => r.replica === replica && r.product === product)) throw new Error("unknown_replica");
    },
    // The host saves frame and outbox together and does not sync here: the outcome must not await the
    // relay (03), so a failed sync cannot turn a saved post into storage_failed. The session's nudge syncs.
    appendAuthored: (replica, frame: CarrierOpFrame) => getHost().saveLocalFrame(replica, frame),
    async mergeSync(replica, pulled, ackedIds) {
      const before = size(replica);
      await getHost().mergeSync(replica, pulled, ackedIds);
      return size(replica) !== before;
    },
    // The M0 snapshot keeps no first-seen times; none is shown, as after a reinstall (03).
    firstSeenMs: () => undefined,
    onChange(listener) {
      storeListeners.add(listener);
      return () => storeListeners.delete(listener);
    },
  };

  // Routes, feed and online/offline stay with the host's own controls; the session only reads link state.
  // syncNow (the session's nudge after a post) syncs through the host only while the host is online.
  const link: RelayLink = {
    async configure() {},
    async start() {},
    async stop() {},
    async syncNow() {
      const host = getHost();
      if (host.isOnline()) await host.syncNow();
      return host.getFeedState();
    },
    state: () => getHost().getFeedState(),
    onState(listener) {
      linkListeners.add(listener);
      return () => linkListeners.delete(listener);
    },
  };

  return {
    store,
    link,
    notify() {
      const state = getHost().getFeedState();
      for (const listener of [...linkListeners]) listener(state);
      for (const { replica } of replicas()) for (const listener of [...storeListeners]) listener(replica);
    },
  };
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
