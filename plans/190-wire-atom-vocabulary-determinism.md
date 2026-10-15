# Plan 190: Make carrier frame admissibility independent of the VM atom table (`Lattice.Carrier.Wire`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a822e4a8..HEAD -- apps/lattice_core/lib/lattice/carrier/wire.ex apps/lattice_core/lib/lattice/canonical.ex apps/lattice_core/test/lattice2/carrier_wire_test.exs apps/lattice_core/lib/lattice/browser_log_store.ex clients/lattice-client/src/carrier.ts clients/lattice-client/test/carrier.ts apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex apps/lattice_popcorn_spike/scripts/shared.mjs`
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
`"ops"` is `["definitely_not_an_existing_atom"]` decodes to `{:error, :malformed_op}` (unchanged by this plan); line 206 asserts an unknown *reason* in a report is `:malformed_term`
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

The operator ruled on 2026-10-14 that atom names are admitted on the wire only from one checked-in vocabulary, and that both runtimes refuse any name outside it. This replaces the earlier approach of decoding unknown names as `Lattice.Canonical.Atom`, which is withdrawn. Under that approach the admission decision still depended on which atoms the VM had loaded: the same bytes became a struct in one VM and an atom in another. A closed vocabulary makes op admission a pure function of the bytes and one list, and it bounds the atom table, because op decoding only creates atoms whose names are on the list.

### Design

1. **Vocabulary.** `Lattice.Carrier.WireVocabulary` (`apps/lattice_core/lib/lattice/carrier/wire_vocabulary.ex`) holds a sorted, checked-in list of names, exposed as `names/0` and `known?/1`. It must contain every atom name a legitimate carrier op can carry: op kinds; body, authority and cap tags; the command, field and role names declared by every `use Lattice.Replica` module under `apps/*/lib` (for example `Lattice.Demo.Thread`, whose `:join`, `:leave` and `:lock` the node-spike scenario sends over the carrier); the atom names the exporter emits; and the names committed frames use, provided some repo source mentions them (the STOP rule). Step 1 enforces the replica declarations and the committed frames.
2. **One source, two runtimes.** `mix lattice.export_vectors` writes the list only to `clients/lattice-client/src/wire_vocabulary.ts` (generated, committed). It must not write any file into `clients/lattice-client/test/vectors`: `test/conformance.ts:286` loads every top-level `.json` file there as a conformance vector, so a list file would break `npm run conformance`. Equality between the two lists comes from generation and the Step 6 regeneration check, not from an ExUnit test that parses the TypeScript file, because policy rule 6 forbids new source-text assertions.
3. **BEAM op decode only.** Op-frame decode uses a new vocabulary helper, separate from `existing_atom/1` (`wire.ex:442-448`). For a listed name it returns `String.to_atom/1`; for any other name it returns `{:error, :unknown_atom}`, which maps to `:malformed_op`. The helper applies to atom terms inside op bodies and caps, and to delegation `ops` and `roles` in `reduce_atoms/2`. `decode_term/2` takes the mode from its caller, so the op path and the value path can differ.
   - These stay strict and unchanged: `decode_value/1`, a standalone value API that closed artifact protocols use, and whose doc says it still refuses names this VM does not hold; `decode_reason_pairs/1` (`wire.ex:212`); the op-kind check (`existing_atom(kind)`); and `browser_log_store.ex`.
   - The `existing_atoms_only?` guard (`wire.ex:51` and `414-430`) sees only atoms that decoding has already created, so it accepts them. Leave it, and do not rely on it for admission.
4. **TypeScript op admission.** The vocabulary check must refuse an off-list name before an op is built, not after. Today `carrierOpToSemanticOp` (`carrier.ts:1347`) calls `assertCarrierOpFrame(frame, false)`, and its catch-all turns a term-decoding error into a `malformed_term` op that stays in the log (`carrier.ts:1370-1372`). BEAM never admits such a frame, so the catch-all must not retain a refused name. `carrierOpsToSemanticOps` (`carrier.ts:1335`) maps frames with no per-frame guard, so a throw from `assertCarrierOpFrame` (`carrier.ts:1797`) already aborts the batch. Keep that: an off-list name refuses the whole batch with no partial output. This matches the BEAM batch path. `Wire.decode_ops/1` (`carrier/wire.ex:110-124`) halts on the first refused frame, and the pull path uses it (`apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex:412`). Per-frame omission would let TypeScript admit siblings that BEAM refuses. The per-frame BEAM push path (`Wire.decode_op/1`, `apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex:246`) is a separate decision that TypeScript does not mirror.
   - Delegations: `isCarrierDelegation` (`carrier.ts:206-220`) checks `ops` and `roles` only with `isStringArray`. Each name must also be on the list. An op whose delegation carries an off-list name is refused the same way as an op with an off-list atom.
5. **Encoding is unchanged.** Canonical bytes, ids and signatures do not change, so committed vectors do not change. The existing refusal test (`carrier_wire_test.exs:86`, where `definitely_not_an_existing_atom` gives `:malformed_op`) stays valid unchanged, because that name is not on the list.

### Steps

**Step 1 (RED): the list covers what it must.** Add `apps/lattice_core/test/lattice2/wire_vocabulary_test.exs`. It makes two checks, and fails if either finds a name missing from `WireVocabulary.names/0`. (a) Declarations: for every module in the `lattice_core` application spec that exports `__lattice_commands__/0`, every command name; every field name from `__lattice_fields__/0`; every role named in an authority field spec (`%{kind: :authority, role: role}`) in `__lattice_fields__/0`; and every succession role from `__lattice_succession__/0`. Also every op kind from `Lattice.Carrier.Wire.op_kinds/0`. (b) Committed frames: it walks every committed `.json` file under `clients/lattice-client/test/vectors/**`, recursively, and within each file finds every array whose elements are carrier-frame objects (objects with `body` and `cap` keys), wherever that array sits. In each frame it collects every ["atom", name] term in `body` and `cap`, and every delegation `ops` and `roles` entry. Checking only named fields misses frames: across the committed corpora, 106 distinct names appear, 39 of them only outside the top-level `oracleCarrierOps` bodies (for example `__continuation__`, `catalog_bootstrap_v1` and `attest_member_key_v1`), and `township_carrier_w1.json` holds frame arrays under `clientBaseCarrierOps`, `clientDivergedCarrierOps` and `peerDivergedCarrierOps`. Expected before the list exists: fails.

**Step 2 (GREEN): build the list.** Create `wire_vocabulary.ex` from the sources in Design item 1, and make the exporter emit the generated `clients/lattice-client/src/wire_vocabulary.ts`. Expose the existing `@op_kinds` attribute (`wire.ex:20`) as a public `Wire.op_kinds/0`, so Step 1 can read it. Expected: Step 1 passes, and the Step 6 check shows only that new file.

**Step 3 (RED then GREEN): BEAM op admission.** In `carrier_wire_test.exs`, add tests that: a listed name in an op body decodes in a VM that has never seen that atom; an off-list name refuses the op as `:malformed_op`; and a delegation whose `ops` or `roles` includes an off-list name refuses the op. Then make the Design item 3 change. Expected: the new tests pass, and the `decode_value` and reason tests are unchanged.

**Step 4: peer-node determinism (the V-01 proof).** Create `apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs`. For each of the five plan 185 vectors (`township_authority_unattenuated_transfer`, `township_authority_undeclared_role_tick`, `township_beacon_witnessed_certificate_metadata`, `township_beacon_witnessed_policy_metadata`, `township_policy_target_reason_taxonomy`), start one isolated node in `setup_all` with `:peer.start_link(%{name: ..., args: [~c"-pa" | :code.get_path()]})`. The `-pa` prefix is required: `args` are passed to `erl` as-is, so bare paths are not code paths. In the peer, assert via `:erpc.call/4` that `String.to_existing_atom/1` raises for `"seize_records"`, `"ghost"`, `"nested"` and `"malformed"`. Then decode `oracleCarrierOps` with `Wire.decode_ops/1`, run `analysis = Lattice.Authority.analyze/2`, and run `Lattice.Reduce.reduce(module, log, quarantine: analysis.quarantine)`. The `quarantine` option is required: `Reduce.reduce/3` defaults to an empty quarantine, which would let denied commands in `township_policy_target_reason_taxonomy` reach the state. Encode the reduced state with the exporter's `state_json(module, log, realms)`, which the exporter must expose for the test. Decode the vector's `realmByPubkey` keys from Base64 to raw public-key bytes first: `realm_index/1` (`export_vectors.ex:5949`) keys its map by raw bytes, and with string keys `realm_for_pub/2` misses and emits a fingerprint instead of the expected `clerk` or `resident`. Compute the same in the parent VM. Assert that the two VMs agree on the sorted `[op_id, reason]` pairs and on the state. Then assert that the pairs equal the vector's `expectAtFullFrontier.authorityQuarantine` and that the state equals `expectAtFullFrontier.state`. Both fields are nested under `expectAtFullFrontier`; there is no top-level `authorityQuarantine`.

**Step 5: TypeScript.** Make the Design item 4 changes. Put the refusal tests in `clients/lattice-client/test/carrier.ts`, which `npm run carrier:township` runs (`npm run conformance` does not). They must cover, through `carrierOpsToSemanticOps`: an off-list body atom, an off-list delegation name, and a mixed batch with one off-list frame and one valid frame. Each must refuse the whole batch with no partial output, matching the BEAM batch path. The TypeScript suite also reads the committed vector JSON and asserts that the generated `wire_vocabulary.ts` exports every name in the committed frames. Run `npm run conformance` as well, which must pass with no vector change.

**Step 6: full gate.** Run the commands in the table below. Add `carrier/wire_vocabulary.ex` to the `sources` array in `apps/lattice_popcorn_spike/scripts/shared.mjs` in the same commit as the `wire.ex` change. `scripts/compile.mjs` calls `prepareShared()` on every build, and `wire.ex` now calls the new module, so this is required whether or not the browser re-check runs.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Toolchain | `export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"` then `~/.asdf/shims/mix …` | (bare `mix` is a broken shim) |
| List and wire tests | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/wire_vocabulary_test.exs apps/lattice_core/test/lattice2/carrier_wire_test.exs` | 0 failures |
| Peer determinism | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs` | 0 failures |
| Existing vectors unchanged after regeneration | `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors && git diff --exit-code -- clients/lattice-client/test/vectors` | exit 0 |
| Generated outputs fresh: the list, the built `dist`, and the vectors | `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors && npm --prefix clients/lattice-client run build && git diff --exit-code -- clients/lattice-client/test/vectors clients/lattice-client/src/wire_vocabulary.ts clients/lattice-client/dist && test -z "$(git status --porcelain -- clients/lattice-client/test/vectors clients/lattice-client/src/wire_vocabulary.ts clients/lattice-client/dist)"` | exit 0 |
| TS refusal tests | `cd clients/lattice-client && npm ci && npm run build && npm run typecheck && npm run carrier:township` | pass |
| TS conformance | `cd clients/lattice-client && npm run conformance` | pass, no vector change |
| Full gate, after the AGENTS.md prerequisites `npm --prefix clients/lattice-client ci`, `npm --prefix clients/lattice-client run build` and `npm --prefix clients/treehouse-tauri-shell ci` | `ERL_FLAGS='+S 4:4' ~/.asdf/shims/mix check` | 0 failures, Credo clean |

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/carrier/wire_vocabulary.ex` (new) and `apps/lattice_core/lib/lattice/carrier/wire.ex` (op-path decode only)
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (emit the generated TypeScript file, and expose `state_json` for the peer test)
- `clients/lattice-client/src/carrier.ts` (admission and delegation check) and `clients/lattice-client/src/wire_vocabulary.ts` (generated)
- `clients/lattice-client/dist/src/` (the rebuilt `carrier`, `wire_vocabulary` and `authority` output, committed with the source: `dist` is tracked and `package.json` exports point at it)
- `apps/lattice_popcorn_spike/scripts/shared.mjs` (add `carrier/wire_vocabulary.ex` to `sources`, required)
- Tests: `carrier_wire_test.exs`, `wire_vocabulary_test.exs` (new), `wire_atom_vocabulary_test.exs` (new), and `clients/lattice-client/test/carrier.ts`
- `plans/README.md` row 190

**Out of scope** (do NOT touch):
- `canonical.ex`: the `Canonical.Atom` struct and its encoding stay as they are.
- `authority.ex`, `reduce.ex`, and any replica module. If the judge raises on an atom it did not expect, that is a STOP.
- `decode_value/1`, `decode_reason_pairs/1`, the op-kind check, and `browser_log_store.ex`. These stay strict.

**Branch and review**: rework the existing PR #114 (`claude/190-wire-atom-determinism`) to this design, replacing its `Canonical.Atom` commits. Do not open a second PR. Policy rule 3 applies: the diff is under `apps/lattice_core/lib/lattice/carrier/` and touches `clients/lattice-client/src/carrier.ts`, so it needs a second independent review.

## Test plan

- `wire_vocabulary_test.exs`: committed vector names are listed in `WireVocabulary.names/0`.
- `test/carrier.ts`: batch refusal for off-list names and delegations, mixed batches included; the generated list exports every committed frame name.
- `carrier_wire_test.exs`: op-path admission and refusal per Step 3; `decode_value` unchanged.
- `wire_atom_vocabulary_test.exs`: the five vectors are judged identically by a peer VM that lacks the atoms and by the parent VM, and both match the oracle.
- `test/carrier.ts` (run by `npm run carrier:township`): off-list names are absent from semantic ingest, both in bodies and in delegations.
- Existing property suites (convergence, identical quarantine, byte-identical replay) stay green.

## Done criteria

- [ ] `wire_vocabulary.ex` and the generated `wire_vocabulary.ts` exist, and the regeneration check shows the TypeScript file is fresh
- [ ] `wire_vocabulary_test.exs`, `carrier_wire_test.exs` and `wire_atom_vocabulary_test.exs` pass; core suite 0 failures
- [ ] After regeneration, both the existing-vector diff and the generated-file check in the Commands table pass
- [ ] `npm run carrier:township` (refusal tests) and `npm run conformance` pass
- [ ] `mix check` passes
- [ ] `shared.mjs` lists `carrier/wire_vocabulary.ex`, and the Popcorn prepare step copies it
- [ ] PR #114 is reworked to this design, and `plans/README.md` row 190 is one line

## STOP conditions

- A committed vector changes after regeneration. Encoding changed, which this plan forbids.
- A name a committed vector or a replica declaration needs appears in no repo source file: no file under `apps/*/lib`, `apps/*/test/support`, `clients/lattice-client/src` or `clients/lattice-client/test`, excluding `vectors` and `dist`. The unsafe property is that no code in the repo mentions the name, so nothing defines its meaning to the judge. Attacker-selectability alone is not the test: every peer-chosen name is selectable. A name that some repo source mentions stays eligible. Stop and report; do not add a name no source mentions.
- The judge, reducer or a replica module raises (not quarantines) on a decoded atom. Report the module and clause; that fix belongs to plan 188's pipeline.
- The peer-node test shows different verdicts in the two VMs. Report the vector and both verdicts.
- `:peer` cannot start with the full code path after one hour of trying. Report it, and cite the plan 185 browser harness as the alternative evidence.

## Maintenance notes

- Adding a new replica command, field, role or op kind means adding its name to the vocabulary. The Step 1 test fails until it is listed.
- Any op-frame decoder that calls `String.to_existing_atom/1` on wire bytes reintroduces the defect. Review for it under policy rule 3. Reason decoding (`decode_reason_pairs/1`) and `decode_value/1` are deliberately strict and are not covered by this rule.
- `browser_log_store.ex`, `decode_reason_pairs/1` and `decode_value/1` keep strict decoding on purpose.
- If plan 185 is re-decided GO after this lands, the Worker's `judge.ex` needs no change, because it decodes through `Wire`.
