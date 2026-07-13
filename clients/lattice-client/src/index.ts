// @treetopdevs/lattice-client — a framework-agnostic TypeScript realm.
//
// This is the client half of a Lattice realm: it stores an op-DAG, reduces it
// to replica state (byte-for-byte the same result Elixir's Sim produces), and
// reconciles with a peer over the carrier. It is UI-framework-neutral on
// purpose — the Tauri (Vue 3.5) and Expo (React Native) shells both consume it.
//
// Tier A (available now, conformance-tested against Sim): op model, DAG,
// CRDT reduction, the shared quarantine predicate, materialization, sync.
// Tier B/E1: canonical encoding, op hashing/signature verification, and
// shell bridge seams — see codec.ts / identity.ts / tauri_bridge.ts.

export * from "./op";
export * from "./schema";
export * from "./dag";
export * from "./quarantine";
export * from "./authority";
export * from "./crdt/reducers";
export * from "./materialize";
export * from "./sync";
export * from "./carrier";
export * from "./codec";
export * from "./identity";
export * from "./local_log";
export * from "./tauri_bridge";
export * from "./township";
