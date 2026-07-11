# Plan 122: Township instrument read model (G1)

## Status

DONE.

## Objective

Start the production-instrument track with one public, structured read-model seam over the
verified Township log. `Township.ReadModel.observe/2` must expose the log-rooted inputs for the
Threads, Roles, Members, and Trust graph panels, keep W4 vouches outside `Township.Matter`, and
preserve every Plan 121 audit-bundle byte while `Township.AuditBundle` reuses the same derivation.

Planned at commit `c64f4df`.

## Canonical panel contract

PD-001-A section A4 names one instrument screen with five panels:

- **Threads**: materialized title, summary, posts, and clerk-locked state. Live offline/pending and
  partition-heal indicators remain a later transport-status input.
- **Roles**: current holder fingerprints plus authority quarantine, reasons, and audit entries.
- **Members**: the materialized member set plus authority-quarantined `admit`/`remove_member`
  mutations, so W0's denied append is observable without becoming convergent state.
- **Attest**: the deterministic tally and honest receipt-free status for caller-held vouch bodies.
  Vouches and coercion tokens never enter the Matter log.
- **Trust graph**: the delegation graph with optional display labels. The causal op-DAG remains a
  separate evidence projection used by the same instrument and the Plan 121 bundle.

The G1-G5 names in PD-001-A are POC exit gates, not read-model field names.

## Public seam

```elixir
Township.ReadModel.observe(log,
  labels: %{fingerprint => display_name},
  vouches: [Lattice.Attestation.vouch_body()],
  attestation: Lattice.Attestation.Stub
)
```

The result has atom-keyed structured data under `:threads`, `:roles`, `:members`, `:attest`,
`:trust_graph`, and `:op_dag`. Only `:trust_graph` may depend on `labels`. Four panel projections and
the op-DAG derive from `matter.log`; `:attest` derives from the explicitly supplied vouch bodies.

## Scope

- Add `Township.ReadModel.observe/2` in `lattice_core`.
- Delegate state to `Lattice.state/2`, authority to `Lattice.Authority.analyze/2`, and the causal
  graph to `Lattice.Graph.ReplicaSnapshot.build/2`.
- Move delegation trust-graph derivation from `Township.AuditBundle` into the read model.
- Derive denied member mutations by selecting quarantined `admit` and `remove_member` command ops;
  do not implement another authority predicate.
- Tally caller-held vouch bodies through the supplied `Lattice.Attestation` implementation and
  expose `receipt_free?` plus `:stubbed | :real` status.
- Refactor `Township.AuditBundle` to serialize the structured read model without changing the
  seven-file contract or any tracked artifact byte.
- Add a focused test against the unchanged Plan 121 golden log/artifacts and independent W0/W4
  literal facts.

## Non-goals

- No Phoenix, LiveView, Vue, endpoint, route, HTML, CSS, or rendered panel.
- No live offline/pending/heal indicator, transfer/admit/vouch control, or coercion-token storage.
- No change to `Township.Matter`, `Lattice.Sim`, authority semantics, the attestation contract, or
  the Plan 121 bundle schema.
- No receipt-freeness claim: the current default must remain `receipt_free? == false` and
  `status == :stubbed`.
- No packaged-GUI/WKWebView click-through, mobile/iOS, cross-device, physical-device, production
  TLS, QR-camera, or LAN-discovery claim.

## STOP conditions

- Stop if a panel reimplements reduction, authority, attestation tallying, or op-DAG logic instead
  of calling the existing public seams.
- Stop if any projection other than `trust_graph` changes when display labels change.
- Stop if vouch bodies or coercion tokens enter `Township.Matter` or `matter.log`.
- Stop if any byte under `artifacts/township/` changes during the AuditBundle refactor.
- Stop if the W0 denied append cannot be observed from the existing authority quarantine without
  adding a new policy or mutation to `Township.Matter`.
- Stop if the documentation calls this a production UI or says that a panel is rendered.

## TDD plan

1. RED: add `apps/lattice_core/test/township/read_model_test.exs` against
   `Township.ReadModel.observe/2` before the module exists.
2. GREEN: implement only enough structured derivation to satisfy the tracked W1/W2/W3 facts, the
   generated W0 denied-admit fact, and the caller-held W4 tally fact.
3. REFACTOR: make `Township.AuditBundle` serialize the read model and prove the existing tracked
   bundle remains byte-identical.
4. GREEN: add the Plan 122 docs/index/build-map contract and advance mobile readiness only after
   the code contract is green.
5. VERIFY: run focused ExUnit, `mix verify`, `mix check`, the tracked bundle verifier,
   `mobile:tauri-readiness`, and `git diff --check`.
6. REVIEW: obtain a read-only Claude Code final review of derivation reuse, trust boundaries,
   bundle byte stability, W4 honesty, and completion wording before commit.

## TDD evidence

- FIRST RED (fixture): the focused test stopped at `Log.restore/1` with `:unsafe_dump` because the
  safe external-term decoder had not loaded every `lattice_core` struct atom. The test now preloads
  application modules before restoring the fixed Plan 121 log.
- INTENDED RED: `mix test apps/lattice_core/test/township/read_model_test.exs` then failed with
  `UndefinedFunctionError` for `Township.ReadModel.observe/2`.
- GREEN: `Township.ReadModel.observe/2` delegates state, authority, op-DAG, and attestation work to
  the existing public seams; the focused panel contract passed.
- CHARACTERIZATION: the existing fresh-process bundle test was strengthened from four legacy files
  to all seven Plan 121 files and passed before the refactor.
- REFACTOR GREEN: `Township.AuditBundle` now serializes `Township.ReadModel` output; the read-model
  and audit-bundle files passed together with all seven generated files byte-identical to the
  tracked golden bundle.
- DOCS RED: the Plan 122 documentation contract failed while this plan and its index row were still
  `IN PROGRESS` and the build map did not name the new boundary.
- DOCS GREEN: this plan, the index, and the build map now record the bounded read-model claim and
  retain the explicit no-rendered-UI boundary.

## Second opinion

- Claude Code ranked this Phase G read-model slice ahead of another Android probe or a fabricated
  packaged-WKWebView control test. The latter has no reliable macOS accessibility seam, while the
  remaining iOS/physical mobile work is externally blocked.
- After reading the canonical A4 panel table, Claude corrected the G1-G5 terminology, required a
  hard split between log-rooted panels and caller-held W4 vouches, required display labels to enter
  only the trust graph, and required the unchanged Plan 121 bundle plus independent literals to
  guard against a tautological refactor.
- Refined design verdict: `VERDICT: PROCEED`.
- Final implementation review found no correctness, security, test-independence, or claim-honesty
  defects and returned `VERDICT: SHIP IT`. Its one low efficiency note identified a redundant full
  read-model rebuild during label validation; the verifier now reuses its already-derived model.
- Claude's focused review of that final optimization found no actionable issues and returned
  `VERDICT: SHIP IT` again.

## Verification

- `~/.asdf/shims/mix test apps/lattice_core/test/township/read_model_test.exs apps/lattice_core/test/township/audit_bundle_test.exs` — 4 tests, 0 failures.
- `~/.asdf/shims/mix verify` — 277 tests and 24 properties across the umbrella, 0 failures.
- `~/.asdf/shims/mix check` — full verification plus strict Credo, exit 0. A new alias-order
  advisory in `Township.ReadModel` was corrected; a direct `mix credo --strict` rerun reports only
  existing findings outside this diff.
- `~/.asdf/shims/mix lattice.township.verify_bundle --dir artifacts/township` — verified.
- `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness` — passed.
- SHA-256 checks for all seven `artifacts/township/*` files are unchanged from the pre-refactor
  baseline.
- `~/.asdf/shims/mix format --check-formatted` and `git diff --check` — clean.

## Completion claim

Plan 122 adds `Township.ReadModel.observe/2`, a public structured read-model foundation for the
five A4 instrument panels. Threads, Roles, Members, Trust graph, and causal op-DAG evidence derive
from the existing log reducer, authority judge, and graph builders; the Attest projection tallies
explicit caller-held vouch bodies and reports the current stub as `receipt_free? == false`.
Display labels can alter only trust-graph node labels, and `Township.AuditBundle` now serializes the
same structured derivation without changing any Plan 121 artifact byte.

This does not build Phoenix, LiveView, Vue, or render a panel. It does not add live
offline/pending/heal indicators or controls, change Matter/authority/attestation semantics, claim
receipt-freeness, or add packaged-GUI, mobile/iOS, cross-device, physical-device, production TLS,
QR-camera, or LAN-discovery evidence.
