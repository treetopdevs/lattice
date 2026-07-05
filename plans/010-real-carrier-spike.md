# Plan 010 (design/spike): Prove the v2 invariants over a real carrier (replace simulated `Lattice.Net`)

> **Executor instructions**: This is a **design + spike** plan, not a production build.
> Produce the deliverables, hit the GATE criteria, and write the findings doc. If a GATE
> fails, that is a valid outcome — record why and STOP. Update `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 81b9bfd..HEAD -- apps/lattice_core/lib/lattice/net.ex apps/lattice_core/lib/lattice/sync.ex docs/path_to_real.md`
> If these moved materially, re-read them before planning the spike.

## Status

- **Priority**: P2 (direction)
- **Effort**: L (light path ~1 week) / XL (AtomVM browser path)
- **Risk**: MED–HIGH (toolchain for the browser path; distribution semantics for the node path)
- **Depends on**: 006 useful (pins the simulated `Net` contract the carrier must match)
- **Category**: direction
- **Planned at**: commit `81b9bfd`, 2026-06-20

## Why this matters

Lattice 2.0 is proven only **in-process**: `Lattice.Sim` + `Lattice.Net` simulate
partitions and delivery in one BEAM. The thesis — "the log is the truth; the connection
is the cache; nothing assumes in-process locality" — is asserted but not demonstrated
across a real boundary. `net.ex:1-12` and `docs/path_to_real.md` explicitly designate
`Lattice.Net` as the swappable seam, and a server-side carrier spike
(`apps/lattice_carrier_spike`) plus an AtomVM browser design (`docs/plans/2026-05-23-atomvm-browser-design.md`)
already exist. The highest-value next step is to run a v2 convergence scenario over a
**real** carrier and show identical final logs/state to the simulator.

## Recommended approach: two paths, do the light one first

- **Light path (recommended first, ~1 week): second OS-process BEAM node over a real
  transport.** Reuse the existing Cowboy WebSocket boundary (`apps/lattice_server`) or
  Erlang distribution to carry op batches between two BEAM nodes, each hosting a realm's
  `Lattice.Log`. This proves partition/heal/sync over real IO with the mature distribution
  stack and minimal toolchain risk. It directly de-risks the thesis.
- **Heavy path (later, XL): AtomVM/WASM browser tab realm.** Follow
  `docs/plans/2026-05-23-atomvm-browser-design.md` (phase-0 bake-off of AtomVM-emscripten
  vs Popcorn, gates, threat-model delta). Toolchain-risky (WASM, OTP-version pinning);
  scope as its own plan after the light path validates the carrier seam.

This plan covers the **light path** spike and the shared `Carrier` abstraction.

## Current state (the seam)

- `apps/lattice_core/lib/lattice/net.ex` — pure simulator: `partition/3`, `heal/3`,
  `connected?/3`, `enqueue/4`, `drain/2`. It gates whether two realms exchange traffic.
- `apps/lattice_core/lib/lattice/sync.ex` — `reconcile/2` (pure, over two `Log`s),
  `missing/2`, `deliver/2`. The actual op-application path; carrier-independent.
- `apps/lattice_core/lib/lattice/sim.ex` — drives realms+Net in one process (the oracle).
- `apps/lattice_server` — a working Cowboy WebSocket server + a real WS client
  (`Lattice.Transport.WebSocket.Client`).
- `docs/path_to_real.md` §1–2 — the wire-format + frontier-negotiation requirements.

## Deliverables

1. A `docs/adr/0005-carrier-interface.md` (or `docs/lattice2_carrier.md`) defining a
   `Lattice.Carrier` behaviour: the minimal callbacks to (a) advertise a frontier,
   (b) request/transfer missing ops, (c) deliver a live ephemeral message — such that
   both `Lattice.Net` (sim) and a real WS carrier implement it, and `Lattice.Sync`/
   `Lattice.Live` consume it unchanged.
2. A spike under `apps/lattice_carrier_spike/` (or a new `apps/lattice_node_spike/`) that
   runs **two BEAM OS processes**, each hosting one realm's `Lattice.Log` for one replica,
   exchanging ops over the existing WebSocket boundary.
3. A spike test/script that runs a convergence scenario (both realms append commands while
   "partitioned" = socket closed, then heal = reconnect + sync) and asserts the final
   reduced state on both nodes equals the `Lattice.Sim` oracle's result for the same op
   set.
4. A short findings note (append to `docs/path_to_real.md` or the ADR): what worked, the
   wire-format decision, and what the AtomVM path still needs.

## GATE criteria (the spike succeeds iff)

- Two real BEAM OS processes converge to **byte-identical reduced state** for a scenario
  with at least one partition+heal cycle, matching the `Sim` oracle for the same ops.
- Sync is idempotent over the wire (a second reconcile transfers nothing).
- A tampered op injected on the wire is rejected at the receiver (reuses
  `Lattice.Log.accept/2`'s signature check) — i.e. the integrity guarantee survives the
  real carrier.
- No change to `Lattice.Sync`/`Lattice.Reduce`/`Lattice.Authority` public behavior (the
  carrier is additive).

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Compile | `~/.asdf/shims/mix compile` | exit 0 |
| Spike test | `cd apps/<spike_app> && ~/.asdf/shims/mix test` | spike scenario passes |
| Sim oracle (reference) | `~/.asdf/shims/mix run scripts/lattice2_demo.exs` | the in-process baseline |

## Scope

**In scope**: a new/extended spike app, a carrier ADR/doc, spike tests, and a
`Lattice.Carrier` behaviour module. The wire format (start with the pinned
`:erlang.term_to_binary` used by `Lattice.Op`; note CBOR as the cross-runtime follow-up).

**Out of scope**:
- Changing `Lattice.Sync`/`Reduce`/`Authority`/`Log` semantics — the carrier must be
  additive; if you find you must change them, STOP and report (the "no in-process
  locality" claim would be at stake).
- The AtomVM/WASM browser build — separate (heavy) plan.
- Production hardening (auth, reconnection backoff, partial sync) — note as follow-ups.

## STOP conditions

- The convergence GATE cannot be met without changing `Sync`/`Reduce`/`Authority` —
  report it; that is a genuine finding about the seam, not something to paper over.
- The wire round-trip of an op does not re-hash/verify identically (a `term_to_binary`
  portability problem) — record it; it motivates the CBOR follow-up from `path_to_real.md`.

## Open questions for the maintainer (resolve during the spike, record answers)

- WS boundary vs Erlang distribution for the node path? (WS reuses existing code + matches
  the browser story; distribution is faster to stand up but not browser-relevant.)
- Frontier negotiation: ship full id-set (current `Sync` behavior, fine for the spike) or
  prototype recursive frontier diff (Beelay-style) now?
- Does the `Carrier` behaviour also carry `Lattice.Live` ephemeral messages, or only log
  sync, for the first spike?

## Maintenance notes

- Keep `Lattice.Sim` as the conformance oracle: any real carrier must reproduce the
  simulator's final state for a given op set. The plan-006 `net_test.exs` pins the
  simulated contract.
- The findings note should explicitly update the "stretch goals not done" list in
  `docs/lattice_poc_status.md`.
