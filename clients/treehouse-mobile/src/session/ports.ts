import type { CarrierOpFrame, TreehouseProduct } from "@treetopdevs/lattice-client";
import type { RouteConfig } from "@treetopdevs/lattice-shell-kit";
import type { FeedState, HeldProfile } from "@treetopdevs/lattice-shell-kit/sync";

// The ports of the application layer (03). The session reaches custody, storage, the relay and time only
// through these. Adapters in src/session/memory (tests) and src/native (Expo) implement them.

export type { FeedState, HeldProfile, RouteConfig, TreehouseProduct };

export interface KeyCustody {
  status(): Promise<"none" | "available" | "unavailable">;
  /** Standard base64 of the 32-byte Ed25519 public key, or null when no key is held. */
  publicKey(): Promise<string | null>;
  /** Creates the device key; refuses if one exists. Returns its public key. */
  create(): Promise<string>;
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}

export interface HeldReplica {
  replica: string;
  product: TreehouseProduct;
}

export interface ReplicaStore {
  open(): Promise<void>;
  replicas(): HeldReplica[];
  /** The held frames, outbox and acked ids of one replica, in shell-kit's shape. */
  profile(replica: string): HeldProfile | undefined;
  adopt(replica: string, product: TreehouseProduct): Promise<void>;
  /** Retains one frame this device authored and adds it to the outbox, in one write. */
  appendAuthored(replica: string, frame: CarrierOpFrame): Promise<void>;
  /** The only path for pulled frames. Returns false, writing nothing, when nothing is new. */
  mergeSync(replica: string, pulled: CarrierOpFrame[], ackedIds: string[]): Promise<boolean>;
  /** Sole owner of first-seen times (03): set in the write that first retains or authors a frame. */
  firstSeenMs(replica: string, id: string): number | undefined;
  onChange(listener: (replica: string) => void): () => void;
}

export interface RelayLink {
  configure(config: RouteConfig | null): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  syncNow(): Promise<FeedState>;
  state(): FeedState;
  onState(listener: (state: FeedState) => void): () => void;
}

export interface Clock {
  now(): number;
}
