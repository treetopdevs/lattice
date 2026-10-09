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

The repository already has the right value for this: `Lattice.Canonical.Atom` ("atom-name value for
safe cross-process decoding of canonical terms"), which `Lattice.Canonical` encodes exactly as an atom
of the same name. Decoding an unknown name into that struct instead of refusing the frame makes
admission a pure function of the bytes, keeps every id and signature verifying, and lets the judge
treat the value like any undeclared atom.

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
name; no TypeScript change is expected.

Five vectors demonstrate the defect (`clients/lattice-client/test/vectors/<name>.json`, each with
`oracleCarrierOps`): `township_authority_unattenuated_transfer` (`:seize_records`, oracle verdict
`invalid_transfer`), `township_authority_undeclared_role_tick` (`:ghost`, `malformed_term` twice),
`township_beacon_witnessed_certificate_metadata` (`:nested`, `unauthorized_beacon`),
`township_beacon_witnessed_policy_metadata` (`:nested`, honored), `township_policy_target_reason_taxonomy`
(`:malformed`, `malformed_command`).

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Toolchain | `export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"` then `~/.asdf/shims/mix …` | (bare `mix` is a broken shim) |
| Wire tests | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_wire_test.exs` | 0 failures |
| Core suite | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2` | 0 failures |
| Vectors unchanged | `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors && git diff --exit-code --stat -- clients/lattice-client/test/vectors` | exit 0 |
| TS conformance | `cd clients/lattice-client && npm ci && npm run build && npm run typecheck && npm run conformance` | pass (no TS change) |
| Full gate | `ERL_FLAGS='+S 4:4' ~/.asdf/shims/mix check` | 0 failures, Credo clean |
| Browser re-check (if plan 185 merged) | `cd apps/lattice_popcorn_spike && npm run prepare:shared && npm run build && npm run e2e:vectors` (browser toolchain: OTP 29.0.6 / Elixir 1.20.4) | 68 passed, 0 failed |

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/carrier/wire.ex` (decode and encode of atom terms and delegation
  op/role lists)
- `apps/lattice_core/test/lattice2/carrier_wire_test.exs` (one expectation changed, new tests)
- New test `apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs` (peer-node determinism proof)
- `plans/README.md` row 190; one addendum paragraph in `docs/research/one_judge_runtime_spike.md` if the
  browser re-check is run

**Out of scope** (do NOT touch):
- `apps/lattice_core/lib/lattice/canonical.ex` (the struct and its encoding already exist)
- `apps/lattice_core/lib/lattice/authority.ex`, `reduce.ex`, any replica module: if the judge or reducer
  crashes on a `%Canonical.Atom{}` where an atom was expected, that is a STOP (see below), not a patch
- Report decoding (`decode_reason_pairs/1`) and `browser_log_store.ex`: reasons stay strict
- `clients/lattice-client/src/**`

## Git workflow

- Branch from `origin/main` after plan 184 merges; commit per step
  (`fix(wire): decode unknown atom names as Canonical.Atom instead of refusing the frame`).
- Policy rule 3: this diff is under `apps/lattice_core/lib/lattice/carrier/`, so it needs a second
  independent review. Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Characterize (RED)

Add to `carrier_wire_test.exs` a test "an op whose body names an atom this VM has never seen still
decodes and verifies": author an op through the existing test helpers with a body that contains
`%Lattice.Canonical.Atom{name: "zz_wire_vocab_" <> Integer.to_string(System.unique_integer([:positive]))}`
(never write that name as an atom literal anywhere, or the atom will exist). Assert
`Wire.encode_op(op)` succeeds, `Wire.decode_op(frame)` returns `{:ok, decoded}`, `decoded.id == op.id`,
`Lattice.Op.valid?(decoded)` is true, and the decoded body contains the struct with the same name.
Add the delegation variant: a delegation whose `ops` includes such a struct round-trips with the struct
in `decoded.ops`. Change the expectation at line 86 so `{"ops", ["definitely_not_an_existing_atom"]}`
is no longer in the malformed list and instead has its own assertion that decoding succeeds with
`%Canonical.Atom{name: "definitely_not_an_existing_atom"}` in `ops`.

**Verify**: the new tests FAIL (today: `encode_term` has no struct clause and `decode_term` refuses);
every other test in the file passes.

### Step 2: Decode unknown names as `Canonical.Atom`; encode the struct as an atom

In `wire.ex`:
- Add `defp encode_term(%Lattice.Canonical.Atom{name: name}) when is_binary(name), do: ["atom", name]`
  **before** the map clause.
- Replace line 262 with a clause that tries `existing_atom(value)` and on `{:error, :unknown_atom}`
  returns `{:ok, %Lattice.Canonical.Atom{name: value}}`.
- In `reduce_atoms/2`, apply the same fallback so delegation `ops` and `roles` lists admit unknown
  names as structs.
- Leave `existing_atom(kind)` and `kind in @op_kinds` as they are (an unknown kind is refused by every
  node identically), and leave `decode_reason_pairs/1` strict.

**Verify**: step 1 tests pass; `mix test apps/lattice_core/test/lattice2/carrier_wire_test.exs` → 0 failures.

### Step 3: Prove the judge treats the struct like an undeclared atom

Run the core suite and the vector regeneration command. The committed vectors must not change (the
oracle VM has every atom, and encoding is unchanged). Then run `npm run conformance` in the client.

**Verify**: core suite 0 failures; `git diff --exit-code -- clients/lattice-client/test/vectors` exits 0;
conformance passes.

### Step 4: Peer-node determinism test (the V-01 proof)

Create `apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs`. For each of the five vectors
named above (read from `clients/lattice-client/test/vectors`), start an isolated node with
`:peer.start_link(%{name: ..., args: [~c"-pa" | :code.get_path()]})` (one argument string per list
element; `:code.get_path/0` already returns charlists)
(OTP 28 `:peer`; one node for the whole module, started in `setup_all`, stopped with `:peer.stop/1`).
Before decoding, assert in the peer via `:erpc.call/4` that `Code.ensure_loaded?(Mix.Tasks.Lattice.ExportVectors)`
is false and that `String.to_existing_atom/1` raises for each of `"seize_records"`, `"ghost"`,
`"nested"`, `"malformed"`. Then, in the peer: decode `oracleCarrierOps` with `Wire.decode_ops/1`, build
the log the way `apps/lattice_popcorn_spike/browser/lib/judge.ex` (plan 185) or the exporter does,
run `Lattice.Authority.analyze/2` and `Lattice.Reduce.reduce/3`, and return the sorted
`[op_id, Atom.to_string(reason)]` pairs and `Lattice.Canonical.term(state)`. In the parent VM compute
the same from the same frames and assert both equal, and assert the pairs equal the vector's
`authorityQuarantine`.

**Verify**: the test passes for all five; running it against the step-1 (pre-fix) `wire.ex` would fail
with `{:error, :malformed_op}` in the peer (check once by temporarily reverting step 2 locally, then
restore; do not commit the revert).

### Step 5: Full gate and the browser re-check

`mix check`; then, if `apps/lattice_popcorn_spike/test/vector-browser.mjs` exists on your branch, run
the browser re-check and append one dated paragraph to `docs/research/one_judge_runtime_spike.md`
stating the new count (expected 68 passed, 0 failed, 7 skipped) and that the plan 185 vector-equality
row is now met, so the operator can re-decide the spike without re-running steps 1–3 of plan 185.

**Verify**: `mix check` 0 failures; browser re-check 68/68 if run.

## Test plan

- `carrier_wire_test.exs`: round-trip of unknown atom names in op bodies and delegation op/role lists
  (RED then GREEN); existing malformed-frame assertions unchanged except the one named above.
- `wire_atom_vocabulary_test.exs`: five vectors judged identically by a peer VM that lacks the atoms
  and by the parent VM that has them; quarantine pairs equal the oracle's.
- Existing property suites (convergence, identical quarantine, byte-identical replay) stay green.

## Done criteria

- [ ] `grep -n "Canonical.Atom" apps/lattice_core/lib/lattice/carrier/wire.ex` shows the encode clause and the decode fallback
- [ ] `carrier_wire_test.exs` and `wire_atom_vocabulary_test.exs` pass; core suite 0 failures
- [ ] `git diff --exit-code -- clients/lattice-client/test/vectors` exits 0 after regeneration
- [ ] `npm run conformance` passes with no TypeScript change
- [ ] `mix check` passes
- [ ] `plans/README.md` row 190 is one line

## STOP conditions

- Any committed vector changes after regeneration: encoding changed, which this plan forbids.
- The judge, reducer or a replica module raises (not quarantines) when an op body, cap, delegation
  `ops` or `roles` contains `%Canonical.Atom{}` where an atom was expected. Report the module and clause;
  that fix belongs to the judge's owner (plan 188's pipeline), not here.
- The peer-node test shows a verdict difference between the two VMs after step 2: the struct is being
  treated differently from the atom somewhere. Report the vector and both verdicts.
- `:peer` cannot start with the full code path in this environment after one hour of trying; report, and
  cite the plan 185 browser harness as the alternative evidence.

## Maintenance notes

- Any new decoder that calls `String.to_existing_atom/1` on bytes from the wire reintroduces this
  defect; review for it under policy rule 3 (carrier files).
- `browser_log_store.ex` and `decode_reason_pairs/1` keep strict reason decoding on purpose: reasons are
  produced by the judge, not by peers, and an unknown reason is a version mismatch, not an admission question.
- If plan 185 is re-decided GO after this lands, the Worker's `judge.ex` needs no change: it already
  decodes through `Wire`.
