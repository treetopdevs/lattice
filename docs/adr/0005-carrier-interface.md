# ADR 0005 — The carrier interface (`Lattice.Carrier`), proven over a real WebSocket

- **Status**: accepted (plan 010 light-path spike, 2026-07-03; M2 hardening, 2026-07-05)
- **Context**: Lattice 2.0's thesis — *the log is the truth; the connection is the
  cache; nothing assumes in-process locality* — was proven only inside one BEAM, with
  `Lattice.Net` simulating delivery. `docs/path_to_real.md` §1 designates `Lattice.Net`
  as the swappable seam. This ADR fixes the shape of that seam and records the result
  of exercising it across two BEAM OS processes over a real WebSocket.

## Decision 1: the behaviour

`Lattice.Carrier` (in `lattice_core`) is the minimal contract between one realm's
`Lattice.Log` and one peer over *some* transport. A carrier is a module implementing
the behaviour plus an opaque connection value:

| Callback | Meaning |
|---|---|
| `advertise(conn, log)` | Announce our log; learn the peer's op-id set. |
| `pull(conn, have)` | Ops the peer holds that `have` lacks, in causal order. |
| `push(conn, ops)` | Transfer ops; peer applies via `Lattice.Log.accept/2` and reports. |
| `live(conn, payload)` | Deliver an ephemeral message that must never enter any log. |

Deliberate exclusions:

- **No `connect`/`close` callbacks.** Connection lifecycle is transport-specific (the
  simulator has none) and nothing in the sync contract depends on it. A closed/failed
  connection is simply `{:error, term}` from any callback.
- **No validation on the carrier.** The carrier moves bytes. Integrity (signature +
  content hash), dependency buffering, and quarantine live behind `Log.accept/2`,
  reached through `Lattice.Sync.deliver/2` — identical for live delivery, simulated
  sync, and real-socket sync.

`Lattice.Carrier.sync/3` is the transport-independent reconciliation driver: it
composes the four callbacks with the unchanged `Lattice.Sync.missing/2` default path +
`Lattice.Sync.deliver/2`. M2 adds dependency-closed `Lattice.Sync.missing/3` shapes for
callers that need partial sync without changing existing carrier semantics. Two
implementations exist:

- `Lattice.Carrier.SimNet` — in-process, gated by `Lattice.Net.connected?/3`
  (`{:error, :partitioned}` while cut). Pinned against `Sync.reconcile/2` in
  `apps/lattice_core/test/lattice2/carrier_test.exs`.
- `LatticeNodeSpike.WsCarrier` — a real WebSocket (`:gen_tcp` + RFC 6455 handshake
  via `Lattice.Transport.WebSocket.Client`) against a Cowboy listener in a **second
  BEAM OS process** (`apps/lattice_node_spike`).

## Decision 2: wire format — shared versioned carrier frames

Ops travel inside JSON envelopes using `Lattice.Carrier.Wire`, a centralized,
versioned, JSON-safe frame schema. The wire module serializes complete ops,
delegations, sync reports, and push-result frames; integrity is still decided by
`Lattice.Log.accept/2`, not by the carrier decoder.

Signed op and delegation bytes are no longer BEAM-term-only: `Lattice.Op` and
`Lattice.Authority.Delegation` use `Lattice.Canonical` (ADR 0001). The current BEAM
carrier still reconstructs `%Lattice.Op{}` structs internally, so the browser/AtomVM
realm must implement the shared wire schema before it can replace the BEAM bridge.

## M2 hardening delta

- canonical signed bytes are no longer BEAM-term-only;
- full op wire frames are centralized in `Lattice.Carrier.Wire`;
- carrier sessions require explicit local/peer trust anchors and are authenticated by
  signed challenge/response before protocol messages are served;
- reconnect/backoff helpers and batch budgets are explicit;
- partial sync shapes are dependency-closed and can restrict `Carrier.sync/4` outbound
  transfer;
- compaction GC now has a tested membership acknowledgement helper, but no production
  compaction caller yet.

## Spike result (plan 010 GATE) — all criteria met

`apps/lattice_node_spike/test/node_carrier_spike_test.exs` spawns
`priv/peer_node.exs` as a second OS process (no Erlang distribution anywhere; the
control channel is stdout for `PEER_READY <port>` + stdin EOF as the orphan
lifeline). Scenario: seeded shared prefix → socket closed (**partition**) → both
sides author offline (including an unauthorized `:lock`) → reconnect (**heal**) →
`Carrier.sync/3`. Verified:

1. **Convergence, byte-identical**: both OS processes reduce to the same
   `term_to_binary`-deterministic state bytes, equal to the `Lattice.Sim` oracle's
   result for the same op set (both oracle realms). Op-id sets and frontiers match
   exactly. Authority quarantine of the unauthorized `:lock` is identical on both
   sides (it is part of the reduced-state bytes).
2. **Determinism across OS processes**: because identities are seeded
   (`Identity.from_seed/2`) and Ed25519 + the canonical encoding are deterministic,
   the shared prefix (genesis, grant, joins) hashed to the *same op ids on both
   nodes with zero transfer* — the first sync moved `sent: 0, received: 0`.
3. **Idempotency over the wire**: the post-heal re-sync transferred
   `sent: 0, received: 0`.
4. **Integrity survives the carrier**: an op tampered on the wire (body mutated,
   id/sig kept) was quarantined `:bad_signature` by the receiver's `Log.accept/2`,
   retained for audit, left state bytes unchanged — and did **not** poison the
   genuine op with the same id, which was subsequently accepted.
5. **Live ephemeral path**: a `live` payload crossed the carrier and the peer's log
   size did not change.
6. **Additive**: no change to `Lattice.Sync`/`Lattice.Reduce`/`Lattice.Authority`
   semantics; the full existing suite stays green.

## Open questions from plan 010 — answers

- **WS boundary vs Erlang distribution?** WebSocket. It reuses the existing Cowboy
  boundary and the raw client, matches the browser story the carrier must eventually
  serve, and keeps Erlang distribution (a full-trust mesh) out of the security story.
  Distribution was not used even as a control plane.
- **Frontier negotiation?** Full id-set (`advertise` returns every op id), matching
  today's `Lattice.Sync` POC behavior. Recursive frontier diff (Beelay-style) is a
  bandwidth optimization with no observable-contract change
  (`docs/path_to_real.md` §2); it slots into `advertise`/`pull` without touching the
  behaviour's consumers.
- **Does the carrier carry `Lattice.Live` ephemerals?** Yes — `live/2` is in the
  behaviour from day one (the seam must not be sync-only, or M2 would re-cut it),
  but the spike only proves transport + never-logged; wiring it to
  `Lattice.Live.call/3` authorization is follow-up work.

## What the AtomVM/browser (heavy) path still needs

1. A native browser/AtomVM implementation of `Lattice.Canonical` and
   `Lattice.Carrier.Wire` for hash/verify and frame parity across runtimes.
2. The phase-0 bake-off of `docs/plans/2026-05-23-atomvm-browser-design.md`
   (AtomVM-emscripten vs Popcorn), OTP-version pinning for `:crypto` eddsa.
3. Browser-side log persistence now has a JSON-safe payload contract and IndexedDB
   adapter; the cleaned browser realm still needs to consume it.
4. Production deployment hardening still remains around PKI/identity binding,
   confidentiality, snapshot trust, and operational observability.

## Consequences

- The Township exit-gate G1 run (two physical nodes, W1/W3 assertions) now has a
  working substrate pattern: point the workflow harness at a `Lattice.Carrier`
  implementation instead of `Sim`'s in-process sync — the assertions carry over
  unchanged (`PD-001 §6 V-03`).
- `Lattice.Sim` remains the conformance oracle for any future carrier: the spike
  test's structure (same op set → byte-identical reduced state vs the oracle) is
  the template plan 013 (compaction) and the M2 carrier should reuse.
