# Plan 205, 206 and 209: BEAM/TypeScript admission parity (closed rulings)

> **Executor instructions**: Two builders work in parallel, one on `apps/` (Elixir), one on
> `clients/lattice-client` (TypeScript). The vector names and field shapes below are the contract between
> them; do not rename. Run every verification command. If a probe in "Probe evidence" does not reproduce on
> your tree, stop and report; do not improvise a different ruling. Line numbers drift: grep the named
> function, not the number.

## Goal

Three rows in the plan index say the TypeScript client and the BEAM judge disagree about what a frame
means. The rows were filed as three TypeScript bugs. Probing both runtimes on the same bytes shows
only one of them (209) is a divergence in this slice's territory, and its fix is one predicate.
The other two (205, 206) are in parity today; they are closed by vectors that pin the agreement, so a later
change on either side cannot silently break it. The slice also records, as follow-up rows, the divergences
the probes surfaced that are not these three rows.

## Rows and rulings

| Row | BEAM today | TS today | Ruling | Side | Vector |
|---|---|---|---|---|---|
| 205 | A non-atom key in a genesis `policies` map is admitted on the wire, merged by `collect_policies`, and never consulted: `decide_succeed` looks up `Map.get(policies, role)` with an atom role from the schema. A claim by the named successor is `:unauthorized_succession`; the founder keeps the role. | `successionPolicies` skips a key whose term is not an atom. Same verdict on all eight key shapes probed. | Parity. The TS skip is the BEAM rule. Pin it. | none-pin-only | `township_authority_non_atom_policy_key` |
| 206 | Integer strings above 2^53-1 up to 2^64-1 are admitted at every position. Where a consumer needs a small integer (beacon policy fields, certificate fields) the value is invalid there, so the policy is ignored or the beacon is `:unauthorized_beacon`. | In the beacon metadata and certificate contexts `decodeCarrierTerm` returns an opaque `invalid_beacon_integer`; the frame is admitted and every consumer reaches the verdict BEAM reaches. 32 of 32 injected cases agree. | The filed gap does not reproduce as an admission or verdict difference. The opaque value is the design (Plan 179). Do not widen the horizon. Pin the contract at 2^53+1 and 2^64-1, which the existing vectors (2^53 only) do not cover. | none-pin-only | `township_beacon_witnessed_high_integer_metadata` |
| 209 | `decode_term` falls to `:malformed_term` for an atom term whose name is not a string (or whose arity is not 2); `decode_ops` refuses the whole batch as `:malformed_op`. | The pull path already refuses (`decodeCarrierOpFrame` throws). Direct `carrierOpsToSemanticOps` returns BOTH ops and marks the bad one `structuralError: "malformed_term"`, retained. | TS is wrong in the direct-ingest path. Refuse the batch there too, through the pre-`try` assertion Plan 190 added. | ts | `township_wire_malformed_atom_refusal` |

## Probe evidence

All probes ran on this tree; frames are real signed `Lattice.Sim` frames with one term replaced, because
wire decode does not verify signatures. Scratch scripts are not committed; the builders' vectors and
tests re-derive every cell below.

**205.** Genesis `policies` keyed by `"clerk"` (binary), `7`, `{:clerk}`, all three together, `nil`, `true`,
`[:clerk]` (BEAM `Sim` + `Wire.decode_ops` + `Authority.analyze`, then the same frames through TS
`materialize`): wire admits every shape, genesis op has no quarantine reason, the successor's claim is
`unauthorized_succession`, `Authority.holder(:clerk)` stays the founder. TS returns the identical reasons. The
control (`%{clerk: policy}`) honors the claim on both. TS `verifyCarrierOp` is valid on all of these frames,
so canonical bytes for mixed-type map keys agree.

**206.** Verdict matrix: values 2^53-1, 2^53, 2^53+1, 2^64-1 in eight positions, each through BEAM
`Authority.analyze` and TS `materialize` (decode first, as the pull path does). Positions: policy
`version`, `threshold`, `max_epoch_step`, an extra key; certificate `claim.version`, a certificate extra
key, a claim extra key, a signature-entry extra key. Result: 32 of 32 equal (an invalid policy replacement
leaves the earlier policy in force, so the beacon stays honored; an invalid certificate is
`unauthorized_beacon`).

Wire admission of the four inputs the row names (`P` = non-strict beacon position, `L` = legacy two-field
beacon epoch, `S` = strict position: witnessed body epoch, claim epoch, command argument, cap,
`dormant_ticks`):

| Input | BEAM wire | TS `decodeCarrierOpFrame` (strict, the pull path) |
|---|---|---|
| `["int","9007199254740992"]` (2^53, string) | admits in P, L, S | P admits (opaque value); L admits (exact decimal); S refuses |
| `["int","18446744073709551615"]` (2^64-1, string) | admits in P, L, S | same as above |
| `["int","18446744073709551616"]` (2^64, string) | refuses the batch | refuses |
| `["int",9007199254740992]` (2^53, JSON number) | refuses the batch | refuses |

Controls `["int",9007199254740991]` and `["int","9007199254740991"]` admit on both sides at every position.
In S, the 2^53+ rows are the documented portable-input limit (Plan 179 rejected widening
`parseCarrierInteger`; `docs/research/succession_tick_provenance.md`). For the two authority-tick positions BEAM
compensates with `malformed_tick_body?` so both sides give `malformed_term` (vector
`township_beacon_witnessed_horizon`, `witnessedBeaconHorizon`). That limit is not changed here.

**209.** Five name values (`5`, `null`, `["x"]`, `{}`, `true`) at the command name, a command argument, the
cap, and as a delegation `ops` and `roles` element, plus atom arity 1 and 3 and the Plan 190 off-list control: 29 variants. BEAM
`Wire.decode_ops` returns `{:error, :malformed_op}` for every one, for `[bad, good]` and `[good, bad]`.
TS, per variant:

- `decodeCarrierOpFrame(bad)`: throws `malformed carrier op`.
- `syncCarrierOnce` with a client whose `pull` returns `[bad, good]`: throws the same message. Pull is safe.
- `carrierOpsToSemanticOps([bad, good])`: returns two ops, the first with `structuralError: "malformed_term"`.
  This is the gap.
- Off-list string name (control, Plan 190): all three paths throw `atom name outside the wire vocabulary`.

## Design

### Row 209 (TypeScript, `clients/lattice-client/src/codec.ts`)

The "existing structural refusal path" is Plan 190's: `assertCarrierOpFrame` calls `assertWireVocabulary`
before its `try`, and `carrierOpsToSemanticOps` maps frames through it, so one refusal yields no ops.
`CarrierPeerError` (PR #131) classifies relay error *replies* to a submit, not a locally thrown refusal; it is
not involved here, and nothing in `submitCarrierFrames` changes.

1. `assertWireVocabularyTerm`, `"atom"` arm: first `if (term.length !== 2) throw new Error("malformed carrier op")`,
   then `assertWireVocabularyName(value)`.
2. `assertWireVocabularyName(name: unknown)`: `if (typeof name !== "string") throw new Error("malformed carrier op")`,
   then the existing off-list check and message. The delegation `ops`/`roles` loop already calls it per
   element, so a non-string element now refuses too. Non-array `ops`/`roles` stay with the delegation decoder.
3. Update the doc comment above `assertWireVocabularyTerm` (it says malformed shapes are ignored; an atom term's
   shape and name type are now checked here).
4. The message is deliberately the one `assertCarrierOpFrame` already throws for a malformed op, so the pull
   path and `decodeCarrierOpFrame` messages are byte-identical to today and the coercion test
   (`hash-preserving atom coercion is rejected before verification`, expects `malformed carrier op`)
   is unchanged.
5. Behaviour change to name in the PR: `authorCarrierOp` calls `assertWireVocabularyTerm` before signing, so it
   now also refuses a malformed atom term at authoring time. Typed `CarrierTerm` input cannot reach it; add one
   case to the existing `authorCarrierOp refuses an off-list name...` block that casts a bad term and expects
   `malformed carrier op`.
6. No change to `carrier.ts`, `authority.ts`, `parseCarrierInteger`, `decodeCarrierTerm` or the integer horizon.
7. Direct callers of `carrierOpsToSemanticOps` that do not decode first: `township.ts` (self-authored
   frames), `treehouse.ts` (store frames), `treehouse_enrollment.ts` (`opsOf`), and the local-candidate filter in
   `syncCarrierOnce` (a throw there already drops the candidate as unverifiable, the same outcome as before).
   Persisted store frames passed strict decode on persist, so none can carry a malformed atom; confirm by
   running the Treehouse suites (Gates) rather than assuming.

Tests (`clients/lattice-client/test/carrier.ts`):

- Remove `malformedAtomFrame` from `malformedTermFrames` (the "cannot wedge direct ingest" case). The other
  members (bad list/tuple/map/bin/int, unknown tag cap) stay retained; see Non-goals.
- In the Plan 190 section add a `refusedMalformed(name, frames)` helper (like `refused`, matching
  `/malformed carrier op/`, asserting `{refused: true, ops: 0}`) and cases: the 4 name values at body name, body
  argument and cap; atom arity 1 and 3; delegation `ops` and `roles` element for each value (unit test only,
  see vector note); `[bad, good]` and `[good, bad]` order; `decodeCarrierOpFrame` throws the same.
- Conformance, generic `capabilityCase.wireCases` block (below).

### Vector contract: `capabilityCase.wireCases`

Both new signed-scenario vectors that need a wire verdict carry this list; the generator asserts each BEAM
verdict with `Wire.decode_ops` and raises if it disagrees, so a vector cannot be generated from a wrong belief.

```
wireCases: [{ name, position, decode: "admit" | "malformed_op",
              directIngest?: "admit" | "refuse", frames: [<frame JSON>, ...] }]
```

TS check, new block in `test/conformance.ts` keyed on the field (not on scenario name):
`frames.map(decodeCarrierOpFrame)` throws iff `decode == "malformed_op"`; for `"admit"` each decoded frame
deep-equals its input (exact preservation); when `directIngest` is present,
`carrierOpsToSemanticOps(frames, vec.realmByPubkey)` throws iff it is `"refuse"` and otherwise returns
`frames.length` ops. A case that is silent on `directIngest` asserts nothing about direct ingest.

These are the first frames under `test/vectors/` whose signature is not honest (a term was replaced after
signing; wire decode precedes verification, so that is what both runtimes judge). Readers checked: the
Popcorn/Tauri judge harnesses select only `oracleCarrierOps`; the two vocabulary scans tolerate them;
conformance decodes only `oracleCarrierOps`. Any new reader of this directory must not treat every
`{body, cap}` object as signed.

### Row 209 vector (`township_wire_malformed_atom_refusal`, Elixir)

Generator `township_wire_malformed_atom_refusal/0` in `lattice.export_vectors.ex`, added to `scenarios/0`. Base
is a small `Sim` (`Township.Matter`, replica `replica:matter:wire-malformed-atom`; realms `clerk`, `resident`;
`create_replica`, `grant` `ops: [:post]`, two `post` commands, `sync_all`) through `capability_scenario_with_canonical_ops`,
so `oracleCarrierOps` are the honest signed frames and the generic conformance checks run on them.
`capabilityCase`: `"case" => "wire_malformed_atom_refusal"`, `"honoredOperationId"` the second post.

`wireCases` (frames built from `Wire.encode_op/1` of the two posts, `body`/`cap` replaced in the encoded
map; each bad case is `[bad, good]`): for name values `5`, `nil`, `["x"]`, `%{}` at
`body command name`, `body argument`, `cap` (12 cases), plus `cap ["atom"]` (arity 1), `cap ["atom","post","x"]`
(arity 3), one `[good, bad]` ordering case; each `decode: "malformed_op"`, `directIngest: "refuse"`. One
control `[good, good]` with `decode: "admit"`, `directIngest: "admit"`. No delegation-name cases in the vector:
the committed-frame vocabulary scans (`wire_vocabulary_test.exs` and the TS `committedFrameNames`) read a
delegation `ops`/`roles` entry as a name; the delegation variants are covered by the ExUnit and TS unit tests.
Both scans already skip a non-string atom name; confirm they pass unchanged.

### Row 205 vector (`township_authority_non_atom_policy_key`, Elixir)

Refactor `hand_authored_policy_vector/3` into `hand_authored_policies_vector(name, policies_fun, reasons)` that
takes the whole policies map (`policies_fun.(resident)`); `hand_authored_policy_vector` calls it with
`fn r -> %{clerk: policy_fun.(r)} end`. Every existing vector must regenerate byte-identical
(vector freshness in the gate proves it). New generator `township_authority_non_atom_policy_key/0`:
policies `%{"clerk" => p, 7 => p, {:clerk} => p}` with `p = %{successor: resident.pub, dormant_ticks: 0}`,
reasons `["unauthorized_succession", "unauthorized_succession"]` (tick claim, certificate claim), the helper's
existing assertions that the clerk holder does not move. Add it to `scenarios/0` beside `township_authority_non_map_policy`.

TS needs no change and no special case: the generic `authorityQuarantine` reason-pair check and the
state/holder comparison in `conformance.ts` consume it as they do `township_authority_successorless_policy`.
A regression that coerced a binary `"clerk"` key to a role would flip the reason pair and fail it.

### Row 206 vector (`township_beacon_witnessed_high_integer_metadata`, Elixir)

Generator in the style of `township_beacon_witnessed_large_policy_integer` and
`township_beacon_witnessed_certificate_metadata`, `beacon_sim("high-integer-metadata")`. For each `v` in
`[9_007_199_254_740_993, 18_446_744_073_709_551_615]`:

- Policy rows: for `:version`, `:threshold`, `:max_epoch_step`, `:extra`, append a genesis whose `__beacon__` policy
  carries `v` in that field, `sync_all`, then a witnessed beacon (witnesses `w0`,`w1`) at the next epoch; assert
  (`assert_authority_honored!`) the genesis and the beacon are honored (the earlier policy stays in force).
- Certificate rows: with `BeaconCertificate.new/2`, mutate `claim.version`, a certificate `:extra`, a `claim`
  `:extra`, a signature-entry `:extra` to `v`, author the beacon at epoch 0 with `certificate:`, and assert
  `assert_authority_reason!(log, id, :unauthorized_beacon)`.
- A final untouched witnessed beacon, honored.

`capabilityCase`: `"case" => "witnessed_high_integer_metadata"`, `"invalidPolicyOperationIds"`,
`"rejectedCertificateOperationIds"`, `"honoredOperationId"`, and `wireCases` for the policy genesis `version`
position and the certificate `claim.version` position with inputs: control `["int",9007199254740991]` and
`["int","18446744073709551615"]` (`admit`), `["int","18446744073709551616"]` and `["int",9007199254740992]`
(`malformed_op`; no `directIngest`: direct ingest retains these by an existing pinned design, see Non-goals).

TS: add `township_beacon_witnessed_high_integer_metadata` to the scenario list in `test/conformance.ts` that
verifies raw frame hash/signature and exact-frame preservation (it is the admission pin for the non-strict
context); reason pairs come from the generic check. No `src/` change.

### Elixir unit tests (`apps/lattice_core/test/lattice2/carrier_wire_admission_parity_test.exs`, new)

Behaviour assertions on `Wire` and `Authority`, no prose pins: (209) `decode_ops` refuses `[bad, good]` and
`[good, bad]` for the five values at name, argument, cap and delegation `ops`/`roles` element, and arity 1 and 3;
(206) the four inputs plus controls at a command-argument position and a beacon-policy position (admit/refuse
table above) and `decode_value` for each; (205) the end-to-end `Sim` case for the three key shapes: wire
round-trip, genesis honored, claim `:unauthorized_succession`, holder unchanged. Production `wire.ex` and
`authority.ex` are not edited.

## Non-goals

- No change to the integer horizon, `parseCarrierInteger`, `decodeCarrierTerm`, `witnessedBeaconHorizon` or
  `@max_json_safe_integer`. Strict positions above 2^53-1 stay a documented portable-input limit.
- No change to direct ingest of other malformed shapes: `carrierOpsToSemanticOps` still retains a
  `malformed_term` op for a bad list/tuple/map/bin/int or an unknown tag (existing pinned design), while BEAM
  refuses those batches. Only atom terms move, because names are the Plan 190 admission domain.
- No `wire.ex`, `authority.ex` or `carrier.ts` edit; no server, relay, submit-path or `CarrierPeerError` change.
- No new claim about production deployment, mobile or device custody, Phase G or receipt-free W4.

## Follow-up rows to file (found by probing, not fixed here)

1. BEAM `decode_term(["int", binary])` uses `Integer.parse`, so it admits `"007"`, `"+1"`, `"-0"`, `"009007199254740992"` and
   `"018446744073709551615"` (leading-zero 2^64-1); TS refuses all of them in every context. Fix is on the BEAM side (canonical decimal
   only); it is a `wire.ex` change, so it needs the rule 3 second review.
2. Strict-position integers in (2^53-1, 2^64-1] (command argument, cap, `dormant_ticks`) are admitted by BEAM and
   refused by TS strict decode, so a TS client's pull of a log holding one throws. Operator decision (widen the
   TS range or constrain BEAM authoring), not a parity patch.
3. Direct ingest versus BEAM for non-atom malformed terms (above).
   Matrix confirmed: extra elements on every non-atom tag, bad delegation shapes and a wrong-typed or missing
   delegation `ops`/`roles`/`live` are BEAM-refused but retained by TS direct ingest. Separate line: a bare atom
   term used as a cap (`["atom","post"]`, also inside a list or map key) is BEAM-admitted and TS-retained
   (reverse direction); keep it distinct so the eventual fix does not break the admit case.
4. Delegation fields: `expires_epoch` above 2^53-1 (BEAM emits and decodes up to 2^64-1 as a raw JSON number that
   JS rounds; TS `isCarrierDelegation` requires a safe integer, so a TS pull of such a log throws),
   `expires_epoch: null`, an omitted `parent_id`, and non-canonical trailing base64 bits in the delegation sig are
   all BEAM-admitted and TS-refused. Needs an operator ruling: constrain BEAM authoring and decode (`wire.ex`,
   rule 3) or widen TS `isCarrierDelegation` (with the integer encoded as a string like int terms).
5. Term nesting deeper than `@max_decode_depth` (64) refuses the whole batch on BEAM; TS has no depth limit in
   strict decode or direct ingest, and the new atom walker has none. Add a depth cap on one side (a guard also
   prevents a stack-overflow RangeError on a very deep TS walk).

Scope note for the 206 vector: it pins admission and verdict equality, not the opaque `invalid_beacon_integer`
representation; a change that decoded the value to a Number in non-strict positions would not change a verdict,
because those integers are invalid by value in every beacon policy and certificate field.

## Gates

Run `gate.sh quick` (format check, compile with warnings as errors, vector regeneration and freshness,
carrier/township mix tests, client typecheck/conformance/carrier tests, dist rebuild) from the worktree.
Then, because `carrierOpsToSemanticOps` has direct callers, the consumers of the changed predicate:

- `mix test apps/lattice_core/test/lattice2/carrier_wire_admission_parity_test.exs apps/lattice_core/test/lattice2/wire_vocabulary_test.exs apps/lattice_core/test/lattice2/wire_atom_vocabulary_test.exs apps/lattice_core/test/township/export_vectors_test.exs`
- In `clients/lattice-client`: `npm run typecheck`, `npm run conformance`, `npm run carrier:township`,
  `npm run carrier:relay-sync`, `npm run treehouse`, `npm run township:authoring`, `npm run catalog:cutoff`,
  `npm run catalog:trust`, `npm run member:continuity`, `npm run member:continuity:codec`,
  `npm run tauri:bridge`.
- `rm -rf dist && npm run build` in `clients/lattice-client`, leave the rebuilt `dist` in the tree with the
  change, and confirm a second `rm -rf dist && npm run build` produces no further diff (CI rebuilds from
  empty and diffs against the committed `dist`).
- `git status --porcelain -- clients/lattice-client/test/vectors clients/lattice-client/src/wire_vocabulary.ts`
  lists exactly the three new vectors and nothing else (no existing vector changes).
- `treehouse-tauri-shell` consumes `dist`; its `feed.ts:233` timing flake is not a regression signal.

Policy: rule 1, claim tier core (unit suite plus vectors, both runtimes). Rule 3: the `codec.ts` diff needs the
adversarial review and the second independent review (Codex Sol 6.1 high); the Elixir side edits only the
exporter and tests, not `lib/lattice/carrier/`, `canonical.ex` or `authority.ex`. Rule 4: this file stays under
400 lines; evidence (SHAs, run ids) goes in the PR description and one index status line. Rule 5: the index
cell is one line of at most 200 characters. Rule 6: no new test asserts on prose in a plan, README or another
file's source text.

## Status

Done (PR #132); follow-ups are index rows 211 to 215.
