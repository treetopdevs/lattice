# Township POC — Agent Working Notes

This tree overlays the **Township POC** (PD-001-A) onto the existing `treetopdevs/lattice`
2.0 branch. It is meant to be dropped into that repo and driven to green. These notes tell
an agent what "done" means and what NOT to touch.

## What this is

Township is milestone **M5** in `PD-001`: one town-scale civic instance (≤10k participants)
running deliberation, roles, and receipt-free attestation on the Lattice substrate. This POC
is the **minimal cut** of it:

- **W0–W3 run on the real 2.0 core.** They drive the genuine `Lattice.Sim` harness against
  `Township.Matter`, a civic `Replica` built only from primitives that already exist
  (`:lww` / `:causal_list` / `:or_set` CRDTs and one `authority:` field).
- **W4 (attestation) is stubbed behind `Lattice.Attestation`.** Receipt-freeness is
  research-gated (M4, `PD-001 §6 R-02/R-03`) and could return "no", so the POC must not block
  on it. The stub proves the plumbing; the real primitive drops in later.

## Files in this overlay

| Path | Role |
|---|---|
| `apps/lattice_core/lib/township/matter.ex` | The civic Replica (modeled on `Lattice.Demo.Thread`). |
| `apps/lattice_core/lib/lattice/attestation.ex` | The seam: behaviour + `Stub` + `M4Placeholder`. |
| `apps/lattice_core/test/support/attestation_contract.ex` | Shared contract the Stub AND M4 must pass. |
| `apps/lattice_core/test/township/workflows_test.exs` | W0–W4 as falsifiable tests. |
| `scripts/township_demo.exs` | Narrated end-to-end run (`§5` storyline). |
| `apps/lattice_node_spike/lib/lattice_node_spike/township_scenario.ex` | G1 real-carrier Township scenario over two BEAM OS processes. |
| `apps/lattice_node_spike/test/township_carrier_test.exs` | G1 carrier acceptance test, checked against the `Lattice.Sim` oracle. |
| `scripts/township_carrier_demo.exs` | Narrated W0-W3 real-carrier run; W4 remains stubbed. |

## The one bet: the seam

`Lattice.Attestation` is the whole minimal-cut wager. If its callbacks (`cast_vouch/3`,
`tally/2`, `produce_alt/2`, `receipt_free?/0`) capture exactly what a receipt-free primitive
needs, then **M4 is a swap, not a rewrite**. The guard is `Lattice.Attestation.Contract`: it
runs the same suite against any implementation. The `Stub` passes everything except the
receipt-freeness property; a real M4 module must pass *all* of it.

**Do not** put vouches on the `Township.Matter` Replica as convergent fields. They are
attestation ops routed through the behaviour precisely so the schema doesn't change at M4.

## Acceptance criteria (the exit gate, PD-001-A §A5)

Drive these to green under the standard loop (`mix format` → `mix test` → the demo):

- **G2** — the four M1 properties (convergence, authority soundness, byte-identical replay,
  identical quarantine) hold over `Township.Matter`. `workflows_test.exs` asserts the first
  three directly; reuse the M1 StreamData generators for the property-level versions.
- **G3** — a real local decision is reached: `Attestation.tally/2` reflects the vouches
  deterministically.
- **G4** — the seam contract passes for the `Stub`. Add the `M4` contract module (commented
  in the contract file) when the primitive exists.
- **G5** — `scripts/township_demo.exs` narrates W0→W4 clean and emits trust-graph + audit
  artifacts an outsider can replay (reuse the V1 `mix lattice.graph.snapshot` exporters).

### G1 carrier acceptance exists — read this

G1 wants W0–W3 on **two physical BEAM nodes over the real WebSocket carrier**. That carrier is
present as the M2 substrate (`Lattice.Carrier`, `apps/lattice_node_spike`, and the
canonical/wire/session helpers), and the Township overlay now has a bounded G1 acceptance
path in `LatticeNodeSpike.TownshipScenario` plus
`apps/lattice_node_spike/test/township_carrier_test.exs`. The test spawns a second BEAM OS
process, syncs W0-W3 over `LatticeNodeSpike.WsCarrier`, checks semantic quarantine
reasons on both nodes, dump/restores the matter log, and compares the final materialized
state to the `Lattice.Sim` oracle. Keep the Sim tests: they remain the portable oracle and
the W4 attestation-stub coverage.

## Constraints — the "do not implement" boundary (PD-001 §6)

Named and **excluded from this POC**. If one starts looking necessary, question the
requirement, not the boundary:

- **No federation / cross-town identity / universal tally** — that is M6, deliberately last.
  There is intentionally no sixth workflow.
- **No key rotation, recovery, or E2EE** — M3 (roadmap R1). `Township.Matter` assumes stable
  identities for the POC.
- **No production compaction** — the first scaling cliff; the feasibility spike and M2
  carrier acknowledgements exist, but snapshot-aware `Authority`/`Reduce` integration and
  GC coordination are not built.
- **No real receipt-free crypto** — M4 (roadmap R2). The `Stub` stands in; `receipt_free?`
  stays `false` until the primitive clears JCJ.

## API reality check (verified against branch `claude/beautiful-gould-6b25d2`)

Use these real signatures — do not invent parallel APIs:

- `Lattice.Op.new(identity, replica, deps, kind, body, opts)`; kinds are
  `:command | :authority | :inbox | :tombstone`.
- Replica DSL: `field :x, merge: :lww | :or_set | :causal_list` **or** `field :x, authority: :role`
  (mutually exclusive); `command :name, [:args], do: [{field, mutation}]`; mutations are
  `{:write, v} | {:add, e} | {:remove, e} | {:append, v} | {:delete, id}` (absolute, never
  relative); `ephemeral` never logs; `succession :role, to:, after: {:dormant_ticks, n}`.
- `Lattice.Sim`: `new/4`, `create_replica/2` (`policies:`), `grant/4` (`ops:`), `transfer/5`,
  `succeed/4`, `request/4`, `command/5`, `partition/3`, `heal/3`, `sync_all/1`, `state/2`,
  `log/2`, `holder/3`, `identity/2`, `quarantined/3` (returns `false` or `{true, reason}`).
- `Lattice.Log`: `dump/2`, `restore/1`, `op_ids/1`, `frontier/1`, `topo_ops/1`.
- `Lattice.state/2`, `Lattice.state_at/3` for materialization and time travel.

## Toolchain preference

Prefer the **latest** Elixir, Phoenix LiveView, and Vue where a choice is open. The one UI
surface (PD-001-A §A4) is a single Phoenix LiveView with five panels — reserved for the app
layer per `PD-001 §2`; Vue 3.5 only if a non-LiveView browser realm is needed as the second
device. M2 chose and hardened the WebSocket carrier substrate; the remaining browser choice is
whether the tab realm is implemented as native AtomVM/WASM or a JS/Vue client that consumes
`Lattice.Canonical` and `Lattice.Carrier.Wire`.

## First moves

1. Compile against the 2.0 branch; run `mix test apps/lattice_core/test/township/` — get W0–W4
   green on the simulated substrate.
2. Run `scripts/township_demo.exs`; confirm the narration and the quarantine/tally beats.
3. Only then open roadmap R1 (real persistence, KERI rotation). Leave R2's stub-swap until the
   research track delivers the primitive and the M4 contract module passes.

## Parallel tracks — this overlay is the *application* track

Township is a downstream **consumer** of the substrate; developing Lattice itself happens in
the repo's own `plans/` directory (the **substrate** track). The two run in parallel and meet
at one seam:

- **Substrate track** — `plans/` (generated 2026-06-20). Foundation & hardening (`000`–`009`,
  e.g. 001 gates the full property suite in CI — needed before Township's M1 property claims can
  be trusted), then the direction spikes (`010`–`013`) and M2 hardening. **Plan `010` and M2
  provide the carrier substrate used by Township's G1 acceptance run**.
- **Application track** — this overlay. W0–W4 stay covered on `Sim`; W0-W3 also run over the
  real BEAM WebSocket carrier in the G1 Township scenario. W4 remains the attestation stub.
- **The seam** — `plans/010-real-carrier-spike.md`, ADR 0005, and M2 are the substrate carrier
  gate in this checkout. A Township overlay may add its own `010a` acceptance plan, but that file
  is not present here. The remaining coupling is explicit: any native browser realm
  (AtomVM/WASM or JS/Vue) must implement `Lattice.Canonical` and `Lattice.Carrier.Wire` before it
  can author or verify ops without the BEAM bridge.

Run as two Fable worktrees when the Township overlay is present: worktree 1 keeps the substrate
carrier hardening green; worktree 2 keeps the overlay green, including both the Sim oracle and
the real-carrier Township acceptance run.
