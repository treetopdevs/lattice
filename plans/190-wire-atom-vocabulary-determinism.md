# Plan 190: Make carrier frame admissibility independent of the VM atom table (`Lattice.Carrier.Wire`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8a822e4a8..HEAD -- apps/lattice_core/lib/lattice/carrier/wire.ex apps/lattice_core/lib/lattice/canonical.ex apps/lattice_core/test/lattice2/carrier_wire_test.exs apps/lattice_core/lib/lattice/browser_log_store.ex apps/lattice_core/lib/lattice/op.ex apps/lattice_core/lib/lattice/sim.ex apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex clients/lattice-client/src/carrier.ts clients/lattice-client/src/codec.ts clients/lattice-client/test/carrier.ts clients/lattice-client/test/support clients/lattice-client/test/treehouse_catalog_cutoff.ts clients/lattice-client/test/treehouse_catalog_trust.ts apps/lattice_popcorn_spike/scripts/shared.mjs .github/workflows/flagship.yml clients/lattice-client/test/continuation_authoring.ts clients/lattice-client/test/township_authoring.ts apps/lattice_core/lib/lattice/live.ex apps/lattice_core/lib/lattice/registry.ex apps/lattice_core/lib/treehouse/space.ex apps/lattice_node_spike/lib/lattice_node_spike/township_scenario.ex apps/lattice_popcorn_spike/browser/lib/durable.ex apps/lattice_popcorn_spike/browser/lib/realm.ex apps/lattice_core/lib/treehouse/member_continuity_authoring.ex apps/lattice_core/lib/treehouse/catalog_cutoff.ex apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex`
> PR #114 (head `abfd76a9a`, merged to main as `b8878dd64` on 2026-10-15) changed the files this plan lists, with the superseded `Canonical.Atom` design. The Current-state excerpts describe `8a822e4a8`, the commit this plan was amended on, so the drift command reports PR #114's changes against that baseline. The rework must replace those changes first, and stop only on a mismatch they do not explain.
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
  and returns `{:error, :malformed_term}` on an unknown reason. Reasons are the `Log.accept/2` outcomes that `Sync` puts in a report; this path validates against `reasons/0` (Design item 3).
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

1. **Vocabulary.** `Lattice.Carrier.WireVocabulary` (`apps/lattice_core/lib/lattice/carrier/wire_vocabulary.ex`) holds a sorted, checked-in list of names, exposed as `names/0` and `known?/1`. It must contain every atom name a legitimate carrier op can carry: op kinds; body, authority and cap tags; the command, field and role names declared by every `use Lattice.Replica` module under `apps/*/lib` (for example `Lattice.Demo.Thread`, whose `:join`, `:leave` and `:lock` the node-spike scenario sends over the carrier); the atom names the exporter emits; and the names committed frames use, provided some repo source mentions them (the STOP rule). `reasons/0` holds every reason a wire report can carry (Design item 3). Step 1 enforces the replica declarations and the committed frames.
2. **One source, two runtimes.** `mix lattice.export_vectors` writes the list only to `clients/lattice-client/src/wire_vocabulary.ts` (generated, committed). It must not write any file into `clients/lattice-client/test/vectors`: `test/conformance.ts:286` loads every top-level `.json` file there as a conformance vector, so a list file would break `npm run conformance`. Equality between the two lists comes from generation and the Step 6 regeneration check, not from an ExUnit test that parses the TypeScript file, because policy rule 6 forbids new source-text assertions.
3. **BEAM op decode only.** Op-frame decode uses a new vocabulary helper, separate from `existing_atom/1` (`wire.ex:442-448`). For a listed name it returns `String.to_atom/1`; for any other name it returns `{:error, :unknown_atom}`, which maps to `:malformed_op`. The helper applies to atom terms inside op bodies and caps, and to delegation `ops` and `roles` in `reduce_atoms/2`. `decode_term/2` takes the mode from its caller, so the op path and the value path can differ.
   - These stay strict and unchanged: `decode_value/1`, a standalone value API that closed artifact protocols use, and whose doc says it still refuses names this VM does not hold; the op-kind check (`existing_atom(kind)`); and `browser_log_store.ex`'s reason decoding (its two encode callers change, Design item 5).
   - `decode_reason_pairs/1` (`wire.ex:212`) changes: it no longer relies on atom existence. A report reason is accepted only if it is on `Lattice.Carrier.WireVocabulary.reasons/0`, which holds exactly the `Log.accept/2` outcomes that `Sync.deliver/2` puts in a report: `:bad_signature` and `:already_quarantined` (quarantined), and `:wrong_replica` (rejected). Authority verdicts such as `:invalid_transfer` are op-level quarantine reasons, not report reasons, so they stay out of this list, and report decoding must refuse them. Atom existence cannot decide reports: op admission now creates atoms for listed names, so a report's admissibility would otherwise depend on which op frames were decoded earlier.
   - The TypeScript push-report decoder (`decodePushReport`, `carrier.ts:2355`) validates `quarantined` and `rejected` against the same `reasons/0` list, so a relay response is refused on both runtimes. State reports keep their own reason domain: `decodeStateReport` reads structural and authority quarantine reasons through the same `reasonPairs` helper (`carrier.ts:2384-2385`), and those include values such as `revoked_capability`, `not_holder` and `unauthorized_revoke`.
   - The `existing_atoms_only?` guard (`wire.ex:51` and `414-430`) sees only atoms that decoding has already created, so it accepts them. Leave it, and do not rely on it for admission.
4. **TypeScript op admission.** The vocabulary check must refuse an off-list name before an op is built, not after. Today `carrierOpToSemanticOp` (`carrier.ts:1347`) calls `assertCarrierOpFrame(frame, false)`, and its catch-all turns a term-decoding error into a `malformed_term` op that stays in the log (`carrier.ts:1370-1372`). BEAM never admits such a frame, so the catch-all must not retain a refused name. The catch-all also covers `cap` decoding: `cap` is decoded inside the same `try` in `carrierOpToSemanticOp`, so an off-list name in `cap` must refuse the batch rather than become a retained `malformed_term` op. `carrierOpsToSemanticOps` (`carrier.ts:1335`) maps frames with no per-frame guard, so a throw from `assertCarrierOpFrame` (`carrier.ts:1797`) already aborts the batch. Keep that: an off-list name refuses the whole batch with no partial output. This matches the BEAM batch path. `Wire.decode_ops/1` (`carrier/wire.ex:110-124`) halts on the first refused frame, and the pull path uses it (`apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex:412`). Per-frame omission would let TypeScript admit siblings that BEAM refuses. The per-frame BEAM push path (`Wire.decode_op/1`, `apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex:246`) is a separate decision that TypeScript does not mirror.
   - Delegations: `isCarrierDelegation` (`carrier.ts:206-220`) checks `ops` and `roles` only with `isStringArray`. Each name must also be on the list. An op whose delegation carries an off-list name is refused the same way as an op with an off-list atom.
5. **Encoding enforces the vocabulary too.** Replica command arguments are untyped, and `Wire.encode_term/1` (`wire.ex:208`) and `authorCarrierOp` (`codec.ts:145`) encode any atom name today. So a locally authored op could be signed with an off-list name, and every peer would refuse it, leaving its descendants pending. Every production path that encodes a locally authored op calls a checked encode in each runtime, which returns `{:error, :unknown_atom}` (BEAM) or throws (TypeScript) for an off-list name. The exporter's `carrier_frame/1` (Step 1 (c)) uses the same checked encode, so authoring and export share one rule. Canonical bytes for accepted names do not change, so committed vectors do not change. The existing refusal test (`carrier_wire_test.exs:86`, where `definitely_not_an_existing_atom` gives `:malformed_op`) stays valid unchanged, because that name is not on the list. Every production caller of `Wire.encode_op/1` moves to the checked encode and propagates `{:error, :unknown_atom}` as a refusal, never embedding or encoding the result: `apps/lattice_core/lib/lattice/browser_log_store.ex` (line 13 in `dump_payload/1`, line 49 in `encode_quarantine_entry/1`) and `apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex` (lines 170 and 256). The authoring seam is at the op constructor as well: `Lattice.Op.authored/6` (new, `op.ex`) is `Op.new/6` with the same check on body and cap, and returns `{:error, :unknown_atom}` before anything is signed. Every production call of `Op.new/6` that authors a locally signed op moves to it: `apps/lattice_core/lib/lattice/live.ex:82`; `registry.ex:337, 383, 401`; `apps/lattice_core/lib/treehouse/space.ex:115, 118, 219, 232, 245`; `apps/lattice_core/lib/treehouse/member_continuity_authoring.ex:188`, which builds its op by hand and must run the same check before the signature is requested; `apps/lattice_node_spike/lib/lattice_node_spike/township_scenario.ex:76`; `apps/lattice_popcorn_spike/browser/lib/durable.ex:81`; and `apps/lattice_popcorn_spike/browser/lib/realm.ex:186`. `Lattice.Sim` (`sim.ex`) is the oracle and stays on unchecked `Op.new/6`: adversarial tests author names outside the list through it, and its test replicas (for example `:explode` in `application_compaction_mirror_test.exs`) stay outside the list too. The exporter's `Op.new/6` calls also stay unchecked, because its names are on the list by construction (Step 1 (c)). The encoders of persisted or relayed ops propagate `{:error, :unknown_atom}` as a refusal and never embed or encode the result: `apps/lattice_core/lib/lattice/browser_log_store.ex:13, 49`; `apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex:170, 256`; `apps/lattice_core/lib/treehouse/member_continuity_authoring.ex:67, 78`; `apps/lattice_core/lib/treehouse/catalog_cutoff.ex:80`; `apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex:292`; `apps/lattice_popcorn_spike/browser/lib/durable.ex:123`; and `apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex:126`. A carrier that finds an off-list persisted op at read time does not serve it. Migrating operations that are already persisted is a separate operator decision.

### Steps

**Step 1 (RED): the list covers what it must.** Add `apps/lattice_core/test/lattice2/wire_vocabulary_test.exs`. It makes two checks, and fails if either finds a name missing from `WireVocabulary.names/0`. (a) Declarations: for every module in every umbrella application (each app in `Mix.Project.apps_paths/0`, loaded and read through `Application.spec/2`) that exports `__lattice_commands__/0`, every command name; every field name from `__lattice_fields__/0`; every role named in an authority field spec (`%{kind: :authority, role: role}`) in `__lattice_fields__/0`; and every succession role from `__lattice_succession__/0`. Also every op kind from `Lattice.Carrier.Wire.op_kinds/0`. Browser replicas live in a separate project, so the same declaration check runs in that project's own suite, `apps/lattice_popcorn_spike/browser/test/vocabulary_test.exs` (new), over the `lattice_browser` application spec. That covers `LatticeBrowser.Notes`, its `:post` command and its `:notes` field. The suite uses `WireVocabulary` through the copy that `shared.mjs` places in `browser/lib/shared/`. That copy is gitignored, so run `npm run prepare:shared` first. The Popcorn workflow does the same before `mix test`. (b) Committed frames: it walks every committed `.json` file under `clients/lattice-client/test/vectors/**`, recursively, and within each file finds every carrier-frame object (an object with `body` and `cap` keys), wherever it sits: inside a frame array, or as a singleton field such as `carrierOp`, `revokeOp` or `foreignCarrierOp`. In each frame it collects every ["atom", name] term in `body` and `cap`, and every delegation `ops` and `roles` entry. Checking only named fields misses frames: across the committed corpora, 106 distinct names appear, 39 of them only outside the top-level `oracleCarrierOps` bodies (for example `__continuation__`, `catalog_bootstrap_v1` and `attest_member_key_v1`), and `township_carrier_w1.json` holds frame arrays under `clientBaseCarrierOps`, `clientDivergedCarrierOps` and `peerDivergedCarrierOps`. (c) Exporter completeness: every frame the exporter writes goes through one checked helper, `carrier_frame/1`. Today `CarrierWire.encode_op/1` is called from `carrier_ops/1` (`export_vectors.ex:5287`) and from singleton fields at lines 2785, 4022, 5109, 5110, 5146, 5192 and 5193. Route all of them through `carrier_frame/1`, which checks each atom name in the emitted frame against `WireVocabulary.names/0` and raises on the first name not listed, naming it. Because (b) also walks singleton frames, a name that reaches any committed vector fails Step 1 even if a call site is missed. This covers names no committed vector happens to use, for the vectors the Mix exporter writes. TypeScript writers are covered by (e). The exporter writes no wire reports, so this check does not cover `reasons/0`. (d) Report reasons: a test drives `Log.accept/2` and `Sync.deliver/2` through a valid op, a forged op, a repeated forged op, an op with a missing dependency, and an op targeting another replica (which `Log.accept/2` rejects as `:wrong_replica`, `log.ex:205`, and the carrier relay returns in its report), and asserts that the reasons those reports carry are exactly `reasons/0`, which is `:bad_signature`, `:already_quarantined` and `:wrong_replica` at present. (e) TypeScript writers: six writers under `clients/lattice-client/test/support/export_*.ts` write committed vectors. Each calls `assertWireVocabulary(frame)` on every frame before it writes, and the freshness gate regenerates the four writers that have committed outputs and diffs `clients/lattice-client/test/vectors`, and smoke-runs the other two (Step 6), so a new atom is caught at write time and in the committed-file check. Expected before the list exists: fails.

**Step 2 (GREEN): build the list.** Create `wire_vocabulary.ex` from the sources in Design item 1, with `reasons/0` as an explicit checked-in list of the reasons a Sync report can carry (Design item 3), and make the exporter emit the generated `clients/lattice-client/src/wire_vocabulary.ts`, which exports both the names and `reasons/0`. Expose the existing `@op_kinds` attribute (`wire.ex:20`) as a public `Wire.op_kinds/0`, so Step 1 can read it. Expected: Step 1 passes, and the Step 6 check shows only that new file.

**Step 3 (RED then GREEN): BEAM op admission.** In `carrier_wire_test.exs`, add tests that: a listed name in an op body decodes in a VM that has never seen that atom; an off-list name in the body refuses the op as `:malformed_op`, an off-list name in `cap` does the same, a delegation whose `ops` includes an off-list name refuses the op, a delegation whose `roles` includes one does too (separate cases, so each field is pinned); and a cold VM that decodes an op with a listed body atom, then a report whose reason is that same string, refuses the report as `:malformed_term`. The checked encode refuses an off-list atom in a command argument, and a listed name encodes and round-trips through decode in a cold VM. A refused `Op.authored/6` returns an error, and a log it would have been appended to stays unchanged. Then make the Design item 3 change. Expected: the new tests pass, and the `decode_value` tests are unchanged.

**Step 4: peer-node determinism (the V-01 proof).** Create `apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs`. For each of the five plan 185 vectors (`township_authority_unattenuated_transfer`, `township_authority_undeclared_role_tick`, `township_beacon_witnessed_certificate_metadata`, `township_beacon_witnessed_policy_metadata`, `township_policy_target_reason_taxonomy`), start one fresh isolated node per vector with `:peer.start_link(%{connection: :standard_io, args: [~c"-pa" | :code.get_path()]})`. Do not pass `name`: `mix test` runs non-distributed, and `:peer` refuses a named node in that state with `:not_alive` (checked on OTP 28). `standard_io` needs no distribution. The `-pa` prefix is required: `args` are passed to `erl` as-is, so bare paths are not code paths. In the peer, assert via `:peer.call/4` that `String.to_existing_atom/1` raises for `"seize_records"`, `"ghost"`, `"nested"` and `"malformed"`. Module and log are fixed by the vector, not by convention. The `replica` prefix picks the module: `replica:matter:` gives `Township.Matter`, and `replica:policy:` gives `Mix.Tasks.Lattice.ExportVectors.PolicyFixture`, the module the exporter uses at `export_vectors.ex:4289`. The test asserts that the vector's `schema.name` agrees with that module, so a mismatch fails. Decode `oracleCarrierOps` with `Wire.decode_ops/1`, then build the log as the browser does (`browser/lib/judge.ex:55`): `{log, report} = Sync.deliver(Log.new(vector.replica), ops)`. Run `analysis = Lattice.Authority.analyze/2`, and run `Lattice.Reduce.reduce(module, log, quarantine: analysis.quarantine)`. The `quarantine` option is required: `Reduce.reduce/3` defaults to an empty quarantine, which would let denied commands in `township_policy_target_reason_taxonomy` reach the state. Encode the reduced state with the exporter's `state_json(module, log, realms)`, which the exporter must expose for the test. In each peer that call runs only after the decode and judge steps, because loading the exporter module brings its vector-only atoms into the VM, and a fresh peer per vector keeps one vector's atoms out of the next vector's decode. Decode the vector's `realmByPubkey` keys from Base64 to raw public-key bytes first: `realm_index/1` (`export_vectors.ex:5949`) keys its map by raw bytes, and with string keys `realm_for_pub/2` misses and emits a fingerprint instead of the expected `clerk` or `resident`. Compute the same in the parent VM. Assert that the two VMs agree on the sorted `[op_id, reason]` pairs and on the state, and that their Sync reports are equal. If a Sync report refusal disagrees with the authority verdict for any op, STOP and report both. Build the pairs as the exporter's `authority_quarantine/2` does (`export_vectors.ex:5880-5886`): take `Authority.analyze(module, log).reasons`, map each entry to `[op_id, Atom.to_string(reason)]`, and sort. Then assert that the pairs equal the vector's `expectAtFullFrontier.authorityQuarantine` and that the state equals `expectAtFullFrontier.state`. Both fields are nested under `expectAtFullFrontier`; there is no top-level `authorityQuarantine`.

**Step 5: TypeScript.** Make the Design item 4 changes. Put the refusal tests in `clients/lattice-client/test/carrier.ts`, which `npm run carrier:township` runs (`npm run conformance` does not). They must cover, through `carrierOpsToSemanticOps`: an off-list body atom, an off-list atom in `cap`, an off-list delegation `ops` name, an off-list delegation `roles` name, and a mixed batch with one off-list frame and one valid frame. Each must refuse the whole batch with no partial output, matching the BEAM batch path. The TypeScript suite also reads the committed vector JSON and asserts that the generated `wire_vocabulary.ts` exports every name in the committed frames. The authoring tests also cover `authorCarrierOp` in `src/codec.ts`: an off-list atom in a command argument is refused before signing, and a listed name round-trips. `decodePushReport` refuses a `quarantined` or `rejected` reason that is not in `reasons/0`, and the relay-response tests cover a valid reason and an off-list reason. State-report decoding is not restricted to `reasons/0`. The catalog and profile suites that `flagship.yml:291-300` runs (`catalog:bootstrap`, `catalog:codec`, `catalog:cutoff`, `catalog:trust`, `member:continuity:codec`, `member:continuity` and `continuation:profile`) run in this step too. The deliberate off-list authoring sites switch to `authorCarrierOpUnchecked`: `test/treehouse_catalog_cutoff.ts:112`, `test/treehouse_catalog_trust.ts:352-353`, `:541-542`, the loop at `:652-653`, `test/continuation_authoring.ts:129-132` (`missing_delegation`) and `test/township_authoring.ts:828-832` (`unrelated`). To find any others, list every atom name in `clients/lattice-client/test/*.ts` (`atom("…")` and `["atom", "…"]`) and move each site whose name is not in `wire_vocabulary.ts` to `authorCarrierOpUnchecked`, a test-only signer in `clients/lattice-client/test/support/unchecked_author.ts`. It builds on the exported canonical encoders and skips the checked atom encode, and nothing in `src/` exports it, so the package's public surface does not change. Run `npm run conformance` as well, which must pass with no vector change.

**Step 6: full gate.** Run the commands in the table below. TypeScript writers in the freshness gate, run from `clients/lattice-client`, each with the arguments its own usage check requires. Four writers have committed outputs at their default paths, so the gate regenerates them and the diff covers them: `npx tsx test/support/export_continuation_authoring.ts`, `npx tsx test/support/export_member_continuity.ts`, `npx tsx test/support/export_member_continuity_semantics.ts` and `npx tsx test/support/export_treehouse_catalog_trust.ts`. Two writers have no committed output at their default path, so they run as smoke tests into a scratch directory, where they cannot create untracked files: `npx tsx test/support/export_treehouse_catalog_cutoff.ts --out "$scratch/cutoff.json"`, `npx tsx test/support/export_treehouse_catalog_cutoff.ts --with-member-continuity --out "$scratch/cutoff-mc.json"`, and `npx tsx test/support/export_member_continuity_catalog.ts --out "$scratch/catalog.json"`, with `scratch=$(mktemp -d)`. The catalog writer requires `--out` or `--verify-beam` and has no default path. The Commands table row runs exactly these commands. Add `carrier/wire_vocabulary.ex` to the `sources` array in `apps/lattice_popcorn_spike/scripts/shared.mjs` in the same commit as the `wire.ex` change. `scripts/compile.mjs` calls `prepareShared()` on every build, and `wire.ex` now calls the new module, so this is required whether or not the browser re-check runs.

## Commands you will need

| Purpose | Command | Expected |
|---|---|---|
| Toolchain: the server toolchain. Every row sets its own PATH inside a subshell, so no export persists into another row. Per AGENTS.md, the shim is called with the install's `bin` prefixed on PATH. At the repo root the shim alone gave OTP 29 when checked, so the prefix is what selects OTP 28 for the server rows | `(export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"; ~/.asdf/shims/mix --version)` | Mix 1.19.5 on OTP 28 |
| List and wire tests | `(export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"; npm --prefix clients/lattice-client ci && npm --prefix clients/lattice-client run build && npm --prefix clients/treehouse-tauri-shell ci && ~/.asdf/shims/mix test apps/lattice_core/test/lattice2/wire_vocabulary_test.exs apps/lattice_core/test/lattice2/carrier_wire_test.exs)` | 0 failures |
| Peer determinism | `(export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"; npm --prefix clients/lattice-client ci && npm --prefix clients/lattice-client run build && npm --prefix clients/treehouse-tauri-shell ci && ~/.asdf/shims/mix test apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs)` | 0 failures |
| CI-only: the Popcorn workflow's browser job, with its pinned OTP 29.0.6 and Elixir 1.20.4 prepended to PATH, so the `mix` that `compile.mjs` spawns uses them too. Local runs need that toolchain installed | `(export PATH="$HOME/.asdf/installs/erlang/29.0.6/bin:$HOME/.asdf/installs/elixir/1.20.4-otp-29/bin:$PATH"; cd apps/lattice_popcorn_spike && npm ci && npm run prepare:shared && cd browser && ~/.asdf/shims/mix deps.get && ~/.asdf/shims/mix format --check-formatted && ~/.asdf/shims/mix test && cd .. && npm test && npm run build)` | 0 failures |
| Existing vectors unchanged after regeneration | `(export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"; npm --prefix clients/lattice-client ci && npm --prefix clients/lattice-client run build && npm --prefix clients/treehouse-tauri-shell ci && MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors && git diff --exit-code -- clients/lattice-client/test/vectors)` | exit 0 |
| Generated outputs fresh: the list, the built `dist`, and the vectors | `(export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"; npm --prefix clients/lattice-client ci && npm --prefix clients/lattice-client run build && npm --prefix clients/treehouse-tauri-shell ci && MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors && npm --prefix clients/lattice-client ci && scratch=$(mktemp -d) && (cd clients/lattice-client && npx tsx test/support/export_continuation_authoring.ts && npx tsx test/support/export_member_continuity.ts && npx tsx test/support/export_member_continuity_semantics.ts && npx tsx test/support/export_treehouse_catalog_trust.ts && npx tsx test/support/export_treehouse_catalog_cutoff.ts --out "$scratch/cutoff.json" && npx tsx test/support/export_treehouse_catalog_cutoff.ts --with-member-continuity --out "$scratch/cutoff-mc.json" && npx tsx test/support/export_member_continuity_catalog.ts --out "$scratch/catalog.json") && npm --prefix clients/lattice-client run build && git diff --exit-code -- clients/lattice-client/test/vectors clients/lattice-client/src/wire_vocabulary.ts clients/lattice-client/dist && test -z "$(git status --porcelain -- clients/lattice-client/test/vectors clients/lattice-client/src/wire_vocabulary.ts clients/lattice-client/dist)")` | exit 0 |
| TS refusal and carrier tests, as the flagship job runs them. The live suite spawns a BEAM peer, so the row runs with the server toolchain on PATH | `(export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"; cd clients/lattice-client && npm ci && npm run build && npm run typecheck && npm run carrier:township && npm run carrier:relay && npm run carrier:relay-sync && npm run carrier:township:live && npm run catalog:bootstrap && npm run catalog:codec && npm run catalog:cutoff && npm run catalog:trust && npm run member:continuity:codec && npm run member:continuity && npm run continuation:profile && npm run township:authoring)` | pass |
| TS conformance | `(cd clients/lattice-client && npm run conformance)` | pass, no vector change |
| Full gate: the AGENTS.md preparation runs first, inside the command, so a fresh checkout has its dependencies | `(export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"; npm --prefix clients/lattice-client ci && npm --prefix clients/lattice-client run build && npm --prefix clients/treehouse-tauri-shell ci && ERL_FLAGS='+S 4:4' ~/.asdf/shims/mix check)` | 0 failures, Credo clean |
| Per-app Sobelow boundary checks (AGENTS.md; not part of `mix check`) | `(export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"; cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit --skip && cd ../township_web && ~/.asdf/shims/mix sobelow --exit --skip)` | exit 0 |

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/browser_log_store.ex` (lines 13 and 49, the checked-encode propagation only) and `apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex` (lines 170 and 256)
- `apps/lattice_core/lib/lattice/carrier/wire_vocabulary.ex` (new) and `apps/lattice_core/lib/lattice/carrier/wire.ex` (op-path decode and the checked encode, and report reason validation against `reasons/0`)
- `apps/lattice_core/lib/lattice/op.ex` (new `Op.authored/6`). `sim.ex` is the oracle and stays unchanged.
- The production callers and encoders from Design item 5: `live.ex`, `registry.ex`, `treehouse/space.ex`, `treehouse/member_continuity_authoring.ex`, `treehouse/catalog_cutoff.ex`, the node-spike `township_scenario.ex` and `ws_handler.ex`, `carrier_server/holder.ex`, and the browser `durable.ex` and `realm.ex`, plus the encode callers in `browser_log_store.ex` and `web_socket.ex`.
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (emit the generated TypeScript file, and expose `state_json` for the peer test)
- `clients/lattice-client/src/carrier.ts` (admission and delegation check, and `assertWireVocabulary`) and `clients/lattice-client/src/wire_vocabulary.ts` (generated)
- `clients/lattice-client/src/codec.ts` (the checked atom encode in `authorCarrierOp`, before signing)
- `clients/lattice-client/test/support/unchecked_author.ts` (new: the test-only `authorCarrierOpUnchecked`, not exported from `src/`)
- `clients/lattice-client/test/continuation_authoring.ts` and `clients/lattice-client/test/township_authoring.ts` (the deliberate sites move to `authorCarrierOpUnchecked`)
- `clients/lattice-client/test/support/export_*.ts` (the six TypeScript vector writers call `assertWireVocabulary` before writing)
- `clients/lattice-client/dist/` (the whole tracked tree: `tsconfig.json` includes `src` and `test`, so the build rewrites `dist/src` and `dist/test`, for example `dist/test/carrier.js`; all of it is committed with the source, and `package.json` exports point at `dist/src`)
- `apps/lattice_popcorn_spike/scripts/shared.mjs` (add `carrier/wire_vocabulary.ex` to `sources`, required)
- Tests: `carrier_wire_test.exs`, `wire_vocabulary_test.exs` (new), `wire_atom_vocabulary_test.exs` (new), `clients/lattice-client/test/carrier.ts`, and `apps/lattice_popcorn_spike/browser/test/vocabulary_test.exs` (new, browser replicas).
- `.github/workflows/flagship.yml`: the vector freshness step that runs `lattice.export_vectors` also diffs `clients/lattice-client/src/wire_vocabulary.ts` and fails on untracked files under it. Policy rule 3 applies to workflow files, so it needs a second review.
- `plans/README.md` row 190

**Out of scope** (do NOT touch):
- `canonical.ex`: the `Canonical.Atom` struct and its encoding stay as they are.
- `authority.ex`, `reduce.ex`, and the replica declarations in any replica module. The authoring call sites listed in Design item 5 are the only changes allowed in `treehouse/space.ex`. If the judge raises on an atom it did not expect, that is a STOP.
- `decode_value/1` and the op-kind check. These stay strict. In `browser_log_store.ex` only lines 13 and 49 change, to the checked encode (Design item 5); its reason decoding stays as it is. `decode_reason_pairs/1` changes as Design item 3 describes.

**Branch and review**: PR #114 (`claude/190-wire-atom-determinism`, head `abfd76a9a`) merged to main as `b8878dd64` with the superseded `Canonical.Atom` design. The rework is a new PR from current main that replaces that decode path with this design. Do not reopen PR #114. Policy rule 3 applies: the diff is under `apps/lattice_core/lib/lattice/carrier/` and touches `clients/lattice-client/src/carrier.ts`, so it needs a second independent review.

## Test plan

- `wire_vocabulary_test.exs`: committed vector names are listed in `WireVocabulary.names/0`.
- `test/carrier.ts`: batch refusal for off-list names and delegations, mixed batches included; the generated list exports every committed frame name.
- `carrier_wire_test.exs`: op-path admission and refusal per Step 3; the cold-VM report refusal; `decode_value` unchanged.
- `wire_atom_vocabulary_test.exs`: the five vectors are judged identically by a peer VM that lacks the atoms and by the parent VM, and both match the oracle.
- `test/carrier.ts` (run by `npm run carrier:township`): off-list names are absent from semantic ingest, both in bodies and in delegations.
- Existing property suites (convergence, identical quarantine, byte-identical replay) stay green.

## Done criteria

- [ ] `wire_vocabulary.ex` and the generated `wire_vocabulary.ts` exist, and the regeneration check shows the TypeScript file is fresh
- [ ] Authoring and encoding refuse off-list names in both runtimes, and a listed name round-trips in both
- [ ] The catalog and profile suites in `flagship.yml:291-300`, and `npm run township:authoring`, pass, with the adversarial fixtures on `authorCarrierOpUnchecked`
- [ ] `wire_vocabulary_test.exs`, `carrier_wire_test.exs` and `wire_atom_vocabulary_test.exs` pass; core suite 0 failures
- [ ] A cold-VM test shows a report reason is refused unless it is on `reasons/0`, even when an op decode created the same atom
- [ ] The Popcorn workflow's browser job passes (its CI command is the browser row), and the exporter raises on no emitted name
- [ ] After regeneration, both the existing-vector diff and the generated-file check in the Commands table pass
- [ ] `npm run carrier:township`, `carrier:relay`, `carrier:relay-sync` and `carrier:township:live` (refusal tests included) and `npm run conformance` pass
- [ ] `mix check` passes
- [ ] Every production `Op.new/6` caller listed in Design item 5 uses `Op.authored/6` and propagates the error, every encoder listed there propagates the error, and the deliberate fixture sites use `authorCarrierOpUnchecked`
- [ ] `mix sobelow --exit --skip` passes in `apps/lattice_server` and `apps/township_web`
- [ ] The flagship freshness step diffs `clients/lattice-client/src/wire_vocabulary.ts`, not only the vectors and `dist`
- [ ] `shared.mjs` lists `carrier/wire_vocabulary.ex`, and the Popcorn prepare step copies it
- [ ] the rework PR replaces the `Canonical.Atom` decode path that PR #114 merged, and `plans/README.md` row 190 is one line

## STOP conditions

- A committed vector changes after regeneration. Encoding changed, which this plan forbids.
- A name a committed vector or a replica declaration needs appears in no repo source file: no file under `apps/*/lib`, `apps/*/browser/lib`, `apps/*/test/support`, `clients/lattice-client/src` or `clients/lattice-client/test`, excluding `vectors`, `dist`, and the list itself (`wire_vocabulary.ex` and `src/wire_vocabulary.ts`), so a name cannot satisfy the check by being in the list. A source file counts only when it mentions the name outside the list, such as a replica, judge, exporter or test. The unsafe property is that no code in the repo mentions the name, so nothing defines its meaning to the judge. Attacker-selectability alone is not the test: every peer-chosen name is selectable. A name that some repo source mentions stays eligible. Stop and report; do not add a name no source mentions.
- The judge, reducer or a replica module raises (not quarantines) on a decoded atom. Report the module and clause; that fix belongs to plan 188's pipeline.
- The peer-node test shows different verdicts in the two VMs. Report the vector and both verdicts.
- `:peer` cannot start with the full code path after one hour of trying. Report it, and cite the plan 185 browser harness as the alternative evidence.

## Maintenance notes

- Adding a new replica command, field, role or op kind means adding its name to the vocabulary. The Step 1 test fails until it is listed.
- Any op-frame decoder that calls `String.to_existing_atom/1` on wire bytes reintroduces the defect. Review for it under policy rule 3. `decode_value/1` is deliberately strict and is not covered by this rule. `decode_reason_pairs/1` is covered by the reason check instead.
- `browser_log_store.ex` and `decode_value/1` keep strict decoding on purpose. `decode_reason_pairs/1` validates against `reasons/0`, not atom existence.
- If plan 185 is re-decided GO after this lands, the Worker's `judge.ex` needs no change, because it decodes through `Wire`.
