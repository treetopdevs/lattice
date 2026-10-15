# Plan 190: Make carrier frame admissibility independent of the VM atom table (`Lattice.Carrier.Wire`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 442da5f07..HEAD -- apps/lattice_core/lib/lattice/carrier/wire.ex apps/lattice_core/lib/lattice/canonical.ex apps/lattice_core/test/lattice2/carrier_wire_test.exs apps/lattice_core/lib/lattice/browser_log_store.ex`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED–HIGH (V-01 core: a decode rule in the carrier wire format; no byte change to any
  canonical encoding, id or signature)
- **Depends on**: plan 184 merged (so `authority.ex` has one writer at a time); plan 185's
  `npm run e2e:vectors` harness is the cheapest end-to-end re-check but is not required
- **Category**: security / correctness (determinism of admission across runtimes)
- **Planned at**: commit `442da5f07` plus the plan 185 spike branch, 2026-10-08 (Round 6)
- **Amended**: 2026-10-15 for operator ruling D2 (closed vocabulary). The earlier `Canonical.Atom` approach is superseded; see the Amendment section.

## Why this matters

Plan 185 ran the real `Lattice.Authority` judge inside a Popcorn Web Worker against the 68 signed
vectors and found 63 equal and 5 unequal. All five fail the same way: `Lattice.Carrier.Wire.decode_op/1`
refuses a frame as `malformed_op` because the frame names an atom that does not exist in the
decoding VM (`:seize_records`, `:ghost`, `:nested`, `:malformed`). The oracle that wrote those vectors
had the atoms, because they appear in the exporter's own source. The same five frames are refused by
a native OTP 28 node that has every `lattice_core` module loaded except `Mix.Tasks.Lattice.ExportVectors`,
so the defect is not Popcorn's (`docs/research/one_judge_runtime_spike.md`, plan 185).

Whether a node admits a signed frame therefore depends on which modules happen to be loaded in that
node. Two correct nodes can disagree on admission, and because descendants of a refused op stay pending,
their logs, quarantine sets and states diverge. That violates the prime directive (every runtime must
match `Lattice.Sim` byte-for-byte) and is a cheap network-split primitive: any peer can author an op
whose body carries `["atom", "<fresh name>"]`, and only the nodes that happen to know the name will
ever see that op's descendants. The TypeScript client decodes atom names as strings and admits such
frames, so BEAM and TS also disagree today.

The fix is a closed vocabulary: admission depends only on the frame bytes and one checked-in list of
atom names, which both runtimes load. The earlier idea of decoding unknown names into
`Lattice.Canonical.Atom` is withdrawn (see the Amendment section below).

## Current state

`apps/lattice_core/lib/lattice/carrier/wire.ex`:

- Op decode (lines 65–104): `{:ok, kind} <- existing_atom(kind), true <- kind in @op_kinds,
  {:ok, body} <- decode_term(body), {:ok, cap} <- decode_term(cap), true <- Canonical.signable?(body) …`
  and any failure returns `{:error, :malformed_op}`.
- `defp encode_term(value) when is_atom(value), do: ["atom", Atom.to_string(value)]` (line 208).
  There is no `encode_term` clause for `%Lattice.Canonical.Atom{}`; a struct falls into the map clause.
- `defp decode_term(["atom", value], _depth) when is_binary(value), do: existing_atom(value)` (line 262).
- Delegation decode (lines 336–352): `{:ok, ops} <- existing_atoms(ops), {:ok, roles} <- existing_atoms(roles)`.
- Report decode (lines 174–185): `decode_reason_pairs/1` maps each reason through `existing_atom/1`
  and returns `{:error, :malformed_term}` on an unknown reason. Reasons are judge-defined atoms; this
  path stays strict.
- Lines 377–391:

  ```elixir
  defp existing_atoms(values), do: reduce_atoms(values, [])
  defp reduce_atoms([], acc), do: {:ok, Enum.reverse(acc)}
  defp reduce_atoms([value | rest], acc) do
    with {:ok, atom} <- existing_atom(value), do: reduce_atoms(rest, [atom | acc])
  end
  defp existing_atom(value) when is_binary(value) do
    {:ok, String.to_existing_atom(value)}
  rescue
    ArgumentError -> {:error, :unknown_atom}
  end
  defp existing_atom(_), do: {:error, :unknown_atom}
  ```

`apps/lattice_core/lib/lattice/canonical.ex`: `defmodule Lattice.Canonical.Atom` (line 1,
`@enforce_keys [:name]`, `defstruct [:name]`); `defp encode(atom) when is_atom(atom), do:
encode_tagged(@atom_tag, Atom.to_string(atom))` (line 158) and
`defp encode(%Lattice.Canonical.Atom{name: name}) when is_binary(name), do: encode_tagged(@atom_tag, name)`
(line 204), so an atom and the struct with its name produce identical bytes; `signable?/1` (line 140)
succeeds for the struct. `Township.Election.OfflineBundle` already decodes with it.

`apps/lattice_core/test/lattice2/carrier_wire_test.exs`: line 86 asserts that a delegation frame whose
`"ops"` is `["definitely_not_an_existing_atom"]` decodes to `{:error, :malformed_op}` (this plan changes
that expectation on purpose); line 206 asserts an unknown *reason* in a report is `:malformed_term`
(unchanged).

`apps/lattice_core/lib/lattice/browser_log_store.ex:99-104` has a private copy of `existing_atom/1`
for the stored quarantine reason; out of scope (reasons stay strict).

`clients/lattice-client/src/carrier.ts:149` types atom terms as `["atom", string]` and admits any
name. The closed vocabulary changes this; see the Amendment section.

Five vectors demonstrate the defect (`clients/lattice-client/test/vectors/<name>.json`, each with
`oracleCarrierOps`): `township_authority_unattenuated_transfer` (`:seize_records`, oracle verdict
`invalid_transfer`), `township_authority_undeclared_role_tick` (`:ghost`, `malformed_term` twice),
`township_beacon_witnessed_certificate_metadata` (`:nested`, `unauthorized_beacon`),
`township_beacon_witnessed_policy_metadata` (`:nested`, honored), `township_policy_target_reason_taxonomy`
(`:malformed`, `malformed_command`).

## Amendment (2026-10-15): closed vocabulary (operator ruling D2)

The operator ruled on 2026-10-14 that atom names are admitted on the wire only from one checked-in vocabulary, and that both runtimes refuse any name outside it. This replaces the earlier approach of decoding unknown names as `Lattice.Canonical.Atom`, which is withdrawn. Under that approach the admission decision still depended on which atoms the VM had loaded: the same bytes became a struct in one VM and an atom in another, and the ordering and map-key code had to handle both shapes. A closed vocabulary makes admission a pure function of the bytes and one list, and it bounds the atom table, because the decoder only creates atoms whose names are on the list.

### Design

1. **Vocabulary.** `Lattice.Carrier.WireVocabulary` (`apps/lattice_core/lib/lattice/carrier/wire_vocabulary.ex`) holds a sorted, checked-in list of names, exposed as `names/0` and `known?/1`. The list must contain every atom name a carrier term may legitimately use: op kinds, body and authority tags, replica command, field and role names, and every atom name in the committed vectors and the exporter source.
2. **One source, two runtimes.** `mix lattice.export_vectors` writes the same list to `clients/lattice-client/test/vectors/wire_vocabulary.json` and to `clients/lattice-client/src/wire_vocabulary.ts` (generated, committed). The existing vector-regeneration check diffs both files, so the TypeScript list cannot drift from the Elixir list.
3. **BEAM decode.** In `wire.ex`, a name on the list decodes with `String.to_atom/1`. A name off the list returns `{:error, :unknown_atom}`, which the op decoder already maps to `:malformed_op`. This replaces `String.to_existing_atom/1` for names on the list only. `decode_reason_pairs/1`, `browser_log_store.ex` and the judge stay strict and unchanged.
4. **TypeScript decode.** `clients/lattice-client/src/carrier.ts` refuses an atom name that is not in `wire_vocabulary.ts`, with the same malformed-op outcome as the BEAM.
5. **Encoding is unchanged.** Canonical bytes, ids and signatures do not change, so the committed vectors do not change. The existing refusal test at `carrier_wire_test.exs:86` (`definitely_not_an_existing_atom` gives `:malformed_op`) stays valid unchanged, because that name is not on the list.

### Steps

**Step 1 (RED): the list covers the committed vectors.** Add `apps/lattice_core/test/lattice2/wire_vocabulary_test.exs`. It fails if any atom name in a committed vector (`clients/lattice-client/test/vectors/**/*.json`, `oracleCarrierOps` and `frames` bodies) is not in `WireVocabulary.names/0`. It also fails if the TypeScript list differs from the Elixir list. Expected result before the list exists: fails.

**Step 2 (GREEN): build the list.** Create `wire_vocabulary.ex` from the vectors, the exporter source and the replica DSL declarations (command, field and role names in `Township.Matter`, `Treehouse.*` and `Toolshed.*`). Make the exporter emit the two generated files. Expected result: Step 1 passes, and `git diff --exit-code -- clients/lattice-client/test/vectors` shows only the two new files.

**Step 3 (RED then GREEN): BEAM admission.** In `carrier_wire_test.exs`, add a test that a name on the list decodes even when the decoding VM has never seen that atom, and that a name off the list refuses the op as `:malformed_op`. Then change `wire.ex` as described in Design item 3.

**Step 4: peer-node determinism (the V-01 proof).** Create `apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs`. For each of the five plan 185 vectors (`township_authority_unattenuated_transfer`, `township_authority_undeclared_role_tick`, `township_beacon_witnessed_certificate_metadata`, `township_beacon_witnessed_policy_metadata`, `township_policy_target_reason_taxonomy`), start one isolated node with `:peer.start_link/1` in `setup_all`, with `args` taken from `:code.get_path/0`. In the peer, assert via `:erpc.call/4` that `String.to_existing_atom/1` raises for each of `"seize_records"`, `"ghost"`, `"nested"` and `"malformed"`. Then decode `oracleCarrierOps`, run `Lattice.Authority.analyze/2` and `Lattice.Reduce.reduce/3`, and return the sorted `[op_id, reason]` pairs and the canonical state. Compute the same in the parent VM. Assert the two agree, and that the pairs equal the vector's `authorityQuarantine`.

**Step 5: TypeScript.** Make the `carrier.ts` change in Design item 4. Run `npm run conformance` with no vector change. Add one refusal test in the client: a frame with an off-list name is refused as malformed, the same outcome as the BEAM.

**Step 6: full gate.** `mix check`; `npm run conformance`; the vector and list regeneration diff. Optional: the plan 185 browser re-check, if its harness is present on the branch.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Toolchain | `export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"` then `~/.asdf/shims/mix …` | (bare `mix` is a broken shim) |
| List and wire tests | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/wire_vocabulary_test.exs apps/lattice_core/test/lattice2/carrier_wire_test.exs` | 0 failures |
| Peer determinism | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs` | 0 failures |
| Vectors and list unchanged after regeneration | `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors && git diff --exit-code -- clients/lattice-client/test/vectors` | exit 0 |
| TS conformance | `cd clients/lattice-client && npm ci && npm run build && npm run typecheck && npm run conformance` | pass |
| Full gate | `ERL_FLAGS='+S 4:4' ~/.asdf/shims/mix check` | 0 failures, Credo clean |

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/carrier/wire_vocabulary.ex` (new) and `apps/lattice_core/lib/lattice/carrier/wire.ex` (atom decode)
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (emit the two generated list files)
- `clients/lattice-client/src/carrier.ts` (atom refusal) and `clients/lattice-client/src/wire_vocabulary.ts` (generated)
- `apps/lattice_core/test/lattice2/carrier_wire_test.exs`, `wire_vocabulary_test.exs` (new), `wire_atom_vocabulary_test.exs` (new), and the client test for the refusal
- `plans/README.md` row 190

**Out of scope** (do NOT touch):
- `apps/lattice_core/lib/lattice/canonical.ex`: the `Canonical.Atom` struct and its encoding stay as they are.
- `authority.ex`, `reduce.ex`, and any replica module. If the judge raises on an atom it did not expect, that is a STOP.
- `decode_reason_pairs/1` and `browser_log_store.ex`: reasons stay strict.

**Branch and review**: rework the existing PR #114 (`claude/190-wire-atom-determinism`) to this design, replacing its `Canonical.Atom` commits. Do not open a second PR. Policy rule 3 applies: the diff is under `apps/lattice_core/lib/lattice/carrier/` and touches `clients/lattice-client/src/carrier.ts`, so it needs a second independent review.

## Test plan

- `wire_vocabulary_test.exs`: committed vectors use only listed names; the Elixir and TypeScript lists are equal.
- `carrier_wire_test.exs`: a listed name decodes in a VM that has not loaded it; an off-list name is `:malformed_op`.
- `wire_atom_vocabulary_test.exs`: the five vectors are judged identically by a peer VM that lacks the atoms and by the parent VM, and both match the oracle.
- Client: an off-list name is refused; conformance is unchanged.
- Existing property suites (convergence, identical quarantine, byte-identical replay) stay green.

## Done criteria

- [ ] `wire_vocabulary.ex` and the generated `wire_vocabulary.ts` exist, and their lists are equal
- [ ] `wire_vocabulary_test.exs`, `carrier_wire_test.exs` and `wire_atom_vocabulary_test.exs` pass
- [ ] `git diff --exit-code -- clients/lattice-client/test/vectors` exits 0 after regeneration
- [ ] `npm run conformance` passes, with the client refusal test added
- [ ] `mix check` passes
- [ ] PR #114 is reworked to this design, and `plans/README.md` row 190 is one line

## STOP conditions

- A committed vector changes after regeneration. Encoding changed, which this plan forbids.
- A name a committed vector needs is absent from the list, and adding it would make a name an attacker can choose admissible. Stop and report; do not add it.
- The judge, reducer or a replica module raises (not quarantines) on a decoded atom. Report the module and clause; that fix belongs to plan 188's pipeline.
- The peer-node test shows different verdicts in the two VMs. Report the vector and both verdicts.
- `:peer` cannot start with the full code path after one hour of trying. Report it, and cite the plan 185 browser harness as the alternative evidence.

## Maintenance notes

- Adding a new replica command, field, role or op kind means adding its name to the vocabulary. The Step 1 test fails until it is listed.
- Any decoder that calls `String.to_existing_atom/1` on wire bytes reintroduces the defect. Review for it under policy rule 3.
- `browser_log_store.ex` and `decode_reason_pairs/1` keep strict reason decoding on purpose.
- If plan 185 is re-decided GO after this lands, the Worker's `judge.ex` needs no change, because it decodes through `Wire`.
