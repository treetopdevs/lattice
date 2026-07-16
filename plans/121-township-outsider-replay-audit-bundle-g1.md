# Plan 121: Township outsider-replay audit bundle (G1)

## Status

DONE

## Objective

Turn the Township demo's asserted audit artifacts into a hermetic, independently
replayable public contract. An outsider must be able to treat `matter.log` as
the only authoritative input, re-derive the materialized state, authority
verdict, causal op-DAG, and delegation trust graph in a fresh process, and
detect corrupted claims.

This closes the audit-surface half of the Phase G gate before the production UI
introduces another projection of the same state.

## Bundle Contract

- `matter.log` is the authoritative replay input.
- `state.json` is the `Township.Matter` state re-derived from the log.
- `audit.json` is the normalized `Lattice.Authority.analyze/2` verdict.
- `op_dag.json` is `Lattice.Graph.ReplicaSnapshot` data for the frontier canvas.
- `trust_graph.dot` and `trust_graph.mermaid` are the authority/delegation graph.
- `manifest.json` indexes the files and carries display-only
  fingerprint-to-realm labels.

Manifest labels may change rendered trust-graph labels only. They must never
affect state, quarantine, reasons, holders, frontier, or graph topology.

## Scope

- Add `Township.AuditBundle` as the single deterministic bundle projection.
- Reuse `Lattice.state/2`, `Lattice.Authority.analyze/2`,
  `Lattice.Graph.ReplicaSnapshot`, and `Lattice.Graph.Export`; do not implement a
  second reducer or authority judge.
- Let `scripts/township_demo.exs` write through that module and honor
  `TOWNSHIP_ARTIFACTS_DIR`, retaining today's tracked directory as the default.
- Add `mix lattice.township.verify_bundle --dir PATH` as the public fresh-process
  verifier.
- Gate the producer and verifier through ExUnit, including authoritative-data
  corruption and display-label corruption negatives.
- Preserve the existing audit and trust-graph bytes, regenerate `matter.log`
  once with deterministic external term encoding, and add the three missing
  Phase G feed files.

## Non-Goals

This does not build Phoenix, LiveView, Vue, or any production UI panel.
It does not change `Township.Matter`, `Lattice.Sim`, authority semantics, or W4.
It does not claim receipt-freeness, mobile convergence, cross-device exchange,
or physical-device behavior.

## STOP Conditions

- Stop if expected state or authority data is read from the JSON claim being
  verified instead of re-derived from `matter.log`.
- Stop if verification reimplements reduction or authority logic.
- Stop if display labels influence any authoritative field or graph edge.
- Stop if a temporary-output run writes to the tracked artifact directory.
- Stop if timestamps, random ids, or map iteration order make output bytes
  nondeterministic.
- Stop if docs call this a completed Phase G UI.

## TDD Evidence

- RED 1: a fresh demo process ignores `TOWNSHIP_ARTIFACTS_DIR`, so no temporary
  bundle exists.
- GREEN 1: the demo writes only to the requested temporary directory.
- RED 2: the public bundle projection and verifier task do not exist.
- GREEN 2: a fresh verifier replays every claim and accepts the clean bundle.
- RED/GREEN 3: altered `audit.json` fails as an authoritative mismatch; altered
  manifest labels fail only the rendered trust-graph comparison.
- RED 4: two encodings of the same 40-op log differed because `Log.dump/2`
  omitted OTP's deterministic external-term option.
- GREEN 4: `Log.dump/2` now emits `term_to_binary(..., [:deterministic])` while
  `Log.restore/1` remains compatible with legacy v1 dumps.
- RED/GREEN 5: extra files and control-character display labels are rejected
  without allowing labels to affect state, authority, or op-DAG verification.

## Second Opinion

Claude Code selected the audit bundle ahead of the read model and LiveView
scaffold because G5 and the Phase G audit surface were still prose-only. On
refinement, Claude required separate state, authority, op-DAG, and delegation
graph artifacts; one log-rooted projection; untrusted display labels; canonical
JSON ordering; fresh-process verification; and corruption negatives. It
returned `PROCEED`. When fresh-VM evidence exposed nondeterministic log bytes,
Claude required a substrate root-cause test instead of weakening the contract;
the deterministic encoder test went RED, the one-line `Log.dump/2` fix went
GREEN, and Claude again returned `PROCEED`.

## Verification

- `~/.asdf/shims/mix test apps/lattice_core/test/township/audit_bundle_test.exs`
- `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/log_sync_test.exs`
- `TOWNSHIP_ARTIFACTS_DIR=$(mktemp -d) ~/.asdf/shims/mix run scripts/township_demo.exs`
- `~/.asdf/shims/mix lattice.township.verify_bundle --dir PATH`
- `~/.asdf/shims/mix verify`
