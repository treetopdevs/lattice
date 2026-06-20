# Lattice 2.0 — Path to a real system

This POC runs every realm in one BEAM with a simulated transport. This document
records what replacing the simulation with a real carrier requires, where
Keyhive/Beelay interop slots in, and why compaction is the first scaling cliff.

## 1. Replace `Lattice.Net` with a real carrier

`Lattice.Net` is the only module that assumes in-process locality, and the public API
never does — realms are addressed by id, sync is a function over two logs, and live
sends go through the v1 Gateway. To run a realm in a second OS process / a browser:

* **Wire format.** Define an explicit, language-neutral canonical encoding for ops and
  delegations (canonical CBOR is the natural choice) so that a Rust/JS/AtomVM peer and
  a BEAM peer hash and verify identically. This replaces the `:erlang.term_to_binary`
  shortcut (ADR 0001) — the *only* place the current encoding is BEAM-specific.
* **Transport.** Carry op batches and live messages over WebSocket (server↔browser) or
  Erlang distribution (server↔server). The v1 repo already has a WebSocket boundary
  (`apps/lattice_server`) and a browser-BEAM carrier spike to build on. `Lattice.Sync`
  and `Lattice.Live` keep their signatures; only the bytes-on-the-wire layer changes.
* **AtomVM browser node.** The "tab" realm becomes an AtomVM instance running the same
  `Lattice.Op`/`Log`/`Reduce`/`Authority` code, persisting its log in browser storage
  and dumping/restoring exactly as `Lattice.Log.dump/restore` already do.
* **Liveness-driven heartbeats.** Succession dormancy (ADR 0004) should derive its
  heartbeats from real connection liveness on the carrier rather than explicit ops.

The deterministic-simulation test suite stays valuable as the carrier's conformance
oracle: a real carrier must produce the same final logs/state as `Lattice.Sim` for the
same op set.

## 2. Efficient frontier-diff sync (Beelay)

The POC's `Lattice.Sync` ships the full set of op ids to compute a diff — fine at demo
scale, quadratic at real scale. A real system negotiates from frontiers recursively
(Beelay-style): exchange compact frontier summaries / Bloom-ish digests, then transfer
only the genuinely-missing ops. This is a bandwidth optimization that does **not**
change the observable contract (converge to identical op sets, idempotently).

## 3. Where Keyhive/Beelay interop slots in

* **Keyhive (confidentiality).** Wrap `Op.body` and delegation payloads in encryption
  under group keys; drive key rotation from the capability-change ops
  (grant/transfer/revoke) this design already produces. The DAG, reduction, and
  quarantine logic are unchanged — encryption is a layer *above* the integrity
  substrate (see `threat_model_v2.md`). Lattice's `Authority` delegation chain is the
  natural place to attach BeeKEM membership operations.
* **Beelay (sync/storage).** Adopt Beelay's frontier negotiation and its
  Sedimentree-style storage/compaction (below) in place of `Lattice.Sync`'s naive diff
  and `Lattice.Log`'s unbounded map.

## 4. Compaction is the first scaling cliff (Sedimentree)

A Replica's identity is its **entire** op-log, which grows without bound — the POC never
compacts (only an optional naive snapshot was in scope). The first thing that breaks at
scale is memory/disk and reduction cost: reducing a long-lived thread means folding
every op ever written, and sync ships ever-larger histories.

The fix is **Sedimentree-style layered compaction**: periodically snapshot the reduced
state at a stable causal frontier, retain a verifiable chain of snapshots ("strata"),
and garbage-collect ops beneath a snapshot once all participants have acknowledged it —
while keeping enough history for time travel and audit to remain meaningful. This is
delicate because:

* snapshots must be deterministic and verifiable (re-reduce to check), and
* authority/quarantine decisions depend on causal ancestry, so a snapshot must preserve
  enough of the authority DAG (or a verified summary of holder state) to keep
  stale-holder/revocation checks sound.

Until compaction exists, Lattice 2.0 is correct but not durable-at-scale — which is the
honest boundary of this POC.

## 5. Other deferred work (explicitly out of POC scope)

Multi-Replica references and cross-replica GC; partial-sync "shapes" (subscribe to a
slice of a Replica); performance optimization of reduction (incremental rather than
full re-fold); real PKI / identity binding; and consensus (deliberately avoided — the
model is coordination-free CRDT + single-writer authority, not BFT consensus).
