# Township G1 Carrier Acceptance

Township exit gate G1 now runs W0-W3 across two physical BEAM OS processes over
the real WebSocket carrier. `Lattice.Sim` remains the oracle: the socket run must
match the Sim materialized state and the authority quarantine reasons exactly.

## What Carried Over Unchanged

- `Township.Matter` stayed transport-agnostic.
- `Lattice.Attestation` stayed a W4 seam; no receipt-free crypto was added.
- `Lattice.Carrier`, `Lattice.Carrier.Wire`, and `Lattice.Sync` stayed unchanged.
- The workflow semantics stayed the same: admission by cap, partitioned
  deliberation, clerk transfer, stale-holder quarantine, and restore-ready log
  state.

## New Harness Plumbing

- `LatticeNodeSpike.TownshipScenario` defines the deterministic Township prefix,
  the partition-time divergence, the Sim oracle, seeded session identities, and
  deterministic state bytes.
- `LatticeNodeSpike.Peer` now accepts `scenario: SomeModule`, defaulting to the
  existing Thread scenario. It reports semantic `authority_quarantine` alongside
  structural log quarantine.
- `apps/lattice_node_spike/priv/peer_node.exs` accepts an optional scenario module
  argument so tests can boot the child BEAM process with the Township scenario.

## Gate Assertions

`apps/lattice_node_spike/test/township_carrier_test.exs` verifies:

- seeded base-prefix op ids match before sync;
- a wrong peer key is rejected before sync;
- socket close forces the physical partition and peer-side divergence;
- reconnect plus `Lattice.Carrier.sync/3` converges the resident and clerk logs;
- materialized state bytes match the Sim oracle;
- the stale clerk `reopen_matter` op is quarantined as `:not_holder` on both logs;
- a second sync transfers no ops;
- the child BEAM process shuts down cleanly.

## Remaining Boundaries

This proves G1 for two BEAM nodes. It does not prove browser/phone realms; those
still need the ADR-P08/canonical CBOR work so non-BEAM clients can author and
verify the same signed bytes. It also does not change W4: receipt-freeness remains
stubbed behind `Lattice.Attestation` until the M4 primitive exists.

Plan 017 is independent of the performance plans, but plan 014 remains the next
carrier-determinism hardening step before using these results as a broad carrier
property claim.
