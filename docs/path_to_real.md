# Lattice 2.0 — Path to a real system

This POC runs every realm in one BEAM with a simulated transport. This document
records what replacing the simulation with a real carrier requires, where
Keyhive/Beelay interop slots in, and why compaction is the first scaling cliff.

## 1. Replace `Lattice.Net` with a real carrier

`Lattice.Net` is the only module that assumes in-process locality, and the public API
never does — realms are addressed by id, sync is a function over two logs, and live
sends go through the v1 Gateway. To run a realm in a second OS process / a browser:

* **Wire format.** M2 defines `Lattice.Canonical` for signed op/delegation bytes and
  `Lattice.Carrier.Wire` for versioned JSON-safe full-op frames. A Rust/JS/AtomVM peer
  still needs its own implementation of that schema, but it no longer has to reproduce
  `:erlang.term_to_binary` to hash and verify ops.
* **Transport.** Carry op batches and live messages over WebSocket (server↔browser) or
  Erlang distribution (server↔server). The v1 repo already has a WebSocket boundary
  (`apps/lattice_server`) and a browser-BEAM carrier spike to build on. `Lattice.Sync`
  and `Lattice.Live` keep their signatures; only the bytes-on-the-wire layer changes.
* **AtomVM browser node.** The "tab" realm becomes an AtomVM instance running the same
  `Lattice.Op`/`Log`/`Reduce`/`Authority` code, persisting its log in browser storage
  and dumping/restoring via the JSON-safe `Lattice.BrowserLogStore` payload contract.
* **Liveness-driven heartbeats.** Succession dormancy (ADR 0004) should derive its
  heartbeats from real connection liveness on the carrier rather than explicit ops.

The deterministic-simulation test suite stays valuable as the carrier's conformance
oracle: a real carrier must produce the same final logs/state as `Lattice.Sim` for the
same op set.

**Spike result (plan 010, 2026-07-03) — the light path is proven.** `Lattice.Carrier`
(behaviour + `Lattice.Carrier.sync/3` driver) now defines this seam, and
`apps/lattice_node_spike` runs it for real: two BEAM OS processes, each holding one
realm's `Lattice.Log`, exchanging ops over a genuine WebSocket (Cowboy server +
`:gen_tcp` RFC 6455 client; no Erlang distribution). A partition (socket closed) +
offline divergence + heal (reconnect + sync) converges to **byte-identical reduced
state** on both nodes, equal to the `Lattice.Sim` oracle for the same op set; re-sync
transfers nothing; an op tampered on the wire is quarantined by `Log.accept/2`'s
signature check; `Sync`/`Reduce`/`Authority` were untouched. The original light path
used pinned `term_to_binary` for BEAM↔BEAM frames; M2 replaces that current boundary
with the shared canonical bytes and wire frames described below. Details and
open-question answers: `docs/adr/0005-carrier-interface.md`.

**M2 hardening result (2026-07-05).** The carrier substrate now has canonical signed
bytes, shared wire frames, explicit trust anchors plus signed challenge/response
sessions, deterministic reconnect backoff helpers, dependency-closed partial sync shapes
that can restrict outbound carrier transfer, bounded push batches, tested membership
acknowledgements for future compaction GC, and a BEAM-side browser log-store payload
helper that preserves quarantine reports. The browser/AtomVM track still needs to
consume those schemas and wire persistence in its own runtime.

**Stable write-boundary and app result (Plans 127-130, 2026-07-12).** A dedicated supervised
`lattice_carrier_server` now serves authenticated pull by default and may opt selected trusted
realms into relaying one already-signed operation to a path-backed source. The server persists a
changed log before acknowledgement and keeps only a transport identity. Plan 129 closes the
packaged desktop write-boundary gap: the actual Tauri app carries explicit relay pairing state,
uses its existing native key and pulled delegation evidence to author the Sim-identical post,
drains only acknowledged outbox frames, and converges with a distinct fresh-BEAM observer after an
OS-process restart. This remains request/response relay, not server push, participant custody,
mobile relay, TLS/public deployment, or a receipt-free attestation result.

Plan 130 closes the first participant-loop gap without moving that boundary. A fresh carrier-backed
LiveView prepares an unsigned post request; the paired Tauri app validates it, retains local
capability/dependency/key custody, and authors and relays only after explicit review, Post, and Sync
actions. The Ubuntu gate and packaged macOS LaunchServices gate compare the observed operation and
fresh restarted projection with `Lattice.Sim`. This does not add server push, broader participant
controls, a mobile/device result, TLS/public deployment, full Phase G, or receipt-free W4.

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

A Replica's identity is its **entire** op-log, which grows without bound. The plan-013
spike proves a Sedimentree-style summary can preserve state/authority equivalence at a
stable frontier, but production compaction is not wired into `Lattice.Log`, `Registry`,
`Sync`, `Authority`, or `Reduce`. The first thing that breaks at scale is memory/disk
and reduction cost: reducing a long-lived thread means folding every op ever written,
and sync ships ever-larger histories.

The fix is **Sedimentree-style layered compaction**: periodically snapshot the reduced
state at a stable causal frontier, retain a verifiable chain of snapshots ("strata"),
and garbage-collect ops beneath a snapshot once all participants have acknowledged it —
while keeping enough history for time travel and audit to remain meaningful. This is
delicate because:

* snapshots must be deterministic and verifiable (re-reduce to check), and
* authority/quarantine decisions depend on causal ancestry, so a snapshot must preserve
  enough of the authority DAG (or a verified summary of holder state) to keep
  stale-holder/revocation checks sound.

Until production compaction exists, Lattice 2.0 is correct but not durable-at-scale —
which is the honest boundary of this POC.

## 5. Other deferred work (explicitly out of POC scope)

Multi-Replica references and cross-replica GC; performance optimization of reduction
(incremental rather than full re-fold); real PKI / identity binding; confidentiality;
snapshot trust/quorum; and consensus (deliberately avoided — the model is
coordination-free CRDT + single-writer authority, not BFT consensus).
