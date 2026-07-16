# Plan 014: Property-test the M2 carrier's determinism invariants (canonical / wire / batch / session)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Toolchain**: run mix locally as `~/.asdf/shims/mix` — the `mix` on `PATH`
> is a broken mise shim (see `AGENTS.md`). In GitHub Actions, plain `mix` works.
>
> **Drift check (run first)**:
> `git diff --stat 6b2cfe5..HEAD -- apps/lattice_core/lib/lattice/canonical.ex apps/lattice_core/lib/lattice/carrier/wire.ex apps/lattice_core/lib/lattice/carrier/batch.ex apps/lattice_core/lib/lattice/carrier/session.ex apps/lattice_core/test/lattice2/`
> If any of those files changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests (with one tiny drive-by correctness fix)
- **Planned at**: commit `6b2cfe5`, 2026-07-07

## Why this matters

Determinism is the entire thesis of Lattice 2.0: "the same op set reduces to
byte-identical state on every realm." The M2 carrier layer
(`Lattice.Canonical`, `Lattice.Carrier.Wire`, `Lattice.Carrier.Batch`,
`Lattice.Carrier.Session`) is where cross-runtime bytes are produced, parsed,
split, and authenticated — so a determinism bug here silently breaks
convergence and signature verification across the wire.

Today these modules are covered **only by example-based tests** (fixed inputs).
There is no property that says "encode is deterministic for *any* signable
term", "wire encode→decode is an identity that preserves signature validity for
*any* op", or "chunk then flatten returns the original list for *any* batch".
During this audit two separate reviewers mistakenly believed the wire path
broke signature verification for map-bodied ops — a single round-trip property
test would have answered that definitively. This plan adds those properties so
the crown-jewel invariant is machine-checked against thousands of generated
inputs, and fixes one real (currently harmless) non-determinism in delegation
wire encoding uncovered along the way.

## Current state

Relevant files and their roles:

- `apps/lattice_core/lib/lattice/canonical.ex` — the single canonical encoder
  (`Canonical.term/1`, `Canonical.op_payload/1`, `Canonical.signable?/1`). Maps
  are sorted by encoded-key bytes (lines 132–139), so encoding is
  order-independent by construction.
- `apps/lattice_core/lib/lattice/carrier/wire.ex` — JSON-safe wire frames.
  `encode_op/1` (line 20) / `decode_op/1` (line 35); `encode_term/1` (line 162)
  / `decode_term/1` (line 202); `chunk`-report helpers. Signature is **not**
  decided here; integrity is re-checked by `Lattice.Log.accept/2` via
  `Op.valid?/1`, which recomputes canonical bytes from the decoded term.
- `apps/lattice_core/lib/lattice/carrier/batch.ex` — `chunk/2` (splits a list of
  `{encoded, bytes}` entries under `max_ops` / `max_bytes`) and `merge_reports/1`.
- `apps/lattice_core/lib/lattice/carrier/session.ex` — signed challenge/response
  session auth; `challenge/3` generates a nonce via
  `:crypto.strong_rand_bytes(32)`.

The **drive-by correctness fix** — non-deterministic delegation wire encoding
(`apps/lattice_core/lib/lattice/carrier/wire.ex:259-271`), current code:

```elixir
defp encode_delegation(%Delegation{} = delegation) do
  %{
    "id" => delegation.id,
    "replica" => delegation.replica,
    "issuer" => Base.encode64(delegation.issuer),
    "audience" => Base.encode64(delegation.audience),
    "parent_id" => delegation.parent_id,
    "ops" => Enum.map(delegation.ops, &Atom.to_string/1),      # <-- ops is a MapSet; unsorted
    "roles" => Enum.map(delegation.roles, &Atom.to_string/1),  # <-- roles is a MapSet; unsorted
    "live" => delegation.live,
    "sig" => Base.encode64(delegation.sig)
  }
end
```

`delegation.ops` and `delegation.roles` are `MapSet`s (see `decode_delegation/1`
at line 300: `ops: MapSet.new(ops)`). `Enum.map` over a `MapSet` iterates in an
order that is not guaranteed stable across OTP versions, so the wire JSON's
`ops`/`roles` arrays can differ run-to-run for the same delegation. This is
**currently harmless** (decode rebuilds a `MapSet`, and the signature is carried
verbatim and verified over `Canonical.delegation_bytes`, which sorts) — but it
violates the "wire bytes are deterministic" property this plan asserts, so fix
it in the same pass. `Lattice.Canonical` already sorts these fields
(`canonical.ex:66-67`, `Enum.sort(ops)` / `Enum.sort(roles)`); match that.

**Repo conventions for property tests** (match these exactly):

- Property tests use `use ExUnit.Case, async: true` + `use ExUnitProperties`,
  and `check all(...)` blocks. Exemplar: `apps/lattice_core/test/lattice2/crdt_property_test.exs`
  (read it — lines 1–40 show the generator + `check all` style).
- Generators are small private `defp *_gen` functions returning `gen all(...)`
  or `StreamData` combinators; keep `max_length`/range bounds small (≤12) so
  runs stay fast.
- Existing example tests to extend, not replace:
  `apps/lattice_core/test/lattice2/canonical_encoding_test.exs`,
  `apps/lattice_core/test/lattice2/carrier_wire_test.exs`,
  `apps/lattice_core/test/lattice2/carrier_batch_test.exs`,
  `apps/lattice_core/test/lattice2/carrier_session_test.exs`.
- Op construction uses `Lattice.Op.new(identity, replica, deps, kind, body, opts)`
  with `opts` like `cap: %{...}`; identities via `Lattice.Identity.from_seed(name, ctx)`
  (deterministic — see `canonical_encoding_test.exs:28,51`). `Op.valid?/1`,
  `Op.canonical_encoding/1`, and `Op.recompute_id/1` exist and are used there.

`stream_data` availability: it is already a dependency used by the property
suites above, so no manifest change is needed. Confirm with Step 0.

## Commands you will need

| Purpose   | Command                                                                                 | Expected on success |
|-----------|-----------------------------------------------------------------------------------------|---------------------|
| Compile   | `~/.asdf/shims/mix compile`                                                              | exit 0              |
| New tests | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/` (from repo root)               | all pass            |
| One file  | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_wire_test.exs`           | all pass            |
| Format    | `~/.asdf/shims/mix format --check-formatted`                                             | exit 0              |
| Full gate | `~/.asdf/shims/mix verify`                                                               | format ok + all pass|

## Scope

**In scope** (the only files you should modify):
- `apps/lattice_core/lib/lattice/carrier/wire.ex` — the delegation-sort fix only (Step 1).
- `apps/lattice_core/test/lattice2/canonical_encoding_test.exs` — add properties.
- `apps/lattice_core/test/lattice2/carrier_wire_test.exs` — add properties.
- `apps/lattice_core/test/lattice2/carrier_batch_test.exs` — add properties.
- `apps/lattice_core/test/lattice2/carrier_session_test.exs` — add properties.

**Out of scope** (do NOT touch, even though they look related):
- `apps/lattice_core/lib/lattice/canonical.ex` — the encoder is correct; only
  test it. Do not "optimize" or change its output shape (that would break every
  existing signature).
- `apps/lattice_core/lib/lattice/carrier/batch.ex`, `session.ex`, `log.ex`,
  `op.ex` — no source changes; tests only.
- Any change to wire frame field names or the `@version` constant — peers depend
  on the exact shape.

## Git workflow

- Branch: `advisor/014-carrier-determinism-properties`
- Commit style matches the repo's conventional commits (see `git log`), e.g.
  `test(carrier): property-test canonical/wire/batch determinism` and
  `fix(carrier): sort delegation ops/roles in wire encoding`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix non-deterministic delegation wire encoding

In `apps/lattice_core/lib/lattice/carrier/wire.ex`, in `encode_delegation/1`,
sort `ops` and `roles` before mapping to strings so the wire bytes are stable:

```elixir
"ops" => delegation.ops |> Enum.sort() |> Enum.map(&Atom.to_string/1),
"roles" => delegation.roles |> Enum.sort() |> Enum.map(&Atom.to_string/1),
```

(`Enum.sort/1` over a `MapSet` of atoms yields a deterministic list; this mirrors
`Lattice.Canonical.delegation_bytes/7` at `canonical.ex:66-67`.)

**Verify**: `~/.asdf/shims/mix compile` → exit 0, no warnings about `encode_delegation`.

### Step 2: Add canonical-encoding properties

In `apps/lattice_core/test/lattice2/canonical_encoding_test.exs`, add
`use ExUnitProperties` to the top (next to `use ExUnit.Case, async: true`) and a
small generator for **signable** terms — the domain `Canonical` accepts: `nil`,
booleans, non-negative integers `0..(2^64-1)`, binaries, atoms, and lists/maps of
those. Then add:

- `property "canonical encoding is deterministic"` — for a generated signable
  term `t`, `Canonical.term(t) == Canonical.term(t)` **and** re-encoding a map
  with reshuffled key order yields identical bytes. (Reshuffle by building the
  map from `Enum.shuffle/1` of its pairs — but note `Date.now`/random are
  unavailable in some contexts; use `StreamData` to generate two maps with the
  same pairs in different orders instead, or `Map.new(Enum.reverse(pairs))`.)
- `property "canonical encoding is injective on distinct generated terms"` — for
  two generated terms `a` and `b`, `a == b or Canonical.term(a) != Canonical.term(b)`.
  (This is the no-collision guarantee that op-ids rely on.)

Keep generators bounded (`max_length: 6`, integers `0..1000`). Model the block
structure on `crdt_property_test.exs`.

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/canonical_encoding_test.exs` → all pass (existing + 2 new properties).

### Step 3: Add wire round-trip properties

In `apps/lattice_core/test/lattice2/carrier_wire_test.exs`, add `use ExUnitProperties`
and a generator that builds a **valid signed op** with a randomized signable
body/cap (use `Op.new/6` with `Identity.from_seed/2`; vary body across atoms,
tuples, maps, mapsets, binaries, small ints). Then add:

- `property "encode_op |> decode_op is an identity that preserves validity"` —
  for a generated valid op `op`:
  - `{:ok, decoded} = Wire.decode_op(Wire.encode_op(op))`
  - `assert decoded.body == op.body and decoded.cap == op.cap`
  - `assert Op.valid?(decoded)` (signature still verifies after round-trip)
  - `assert Lattice.Canonical.op_payload(decoded) == Lattice.Canonical.op_payload(op)`
- `property "wire delegation round-trip is deterministic and validity-preserving"` —
  build a signed `Lattice.Authority.Delegation` (see `canonical_encoding_test.exs:60-83`
  for construction), wrap it in an `:authority` op body `{:grant, delegation}`,
  and assert: encoding the op **twice** yields identical `encode_op` maps
  (this is what Step 1 fixed), and the decoded op is `Op.valid?`.

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_wire_test.exs` → all pass.

### Step 4: Add batch split/merge properties

In `apps/lattice_core/test/lattice2/carrier_batch_test.exs`, add `use ExUnitProperties`
and generators for a list of `{term, size}` entries (sizes `1..50`). Then add:

- `property "chunk then flatten preserves order and identity"` — for generated
  entries and `max_ops`/`max_bytes` at least as large as the biggest single
  item, `{:ok, batches} = Batch.chunk(entries, ...)` and
  `List.flatten(batches) == entries` (order preserved, nothing dropped).
- `property "every produced batch respects the bounds"` — each batch has
  `length <= max_ops` and total `size <= max_bytes` (except a batch may hold a
  single item at/under `max_bytes`; if any single item exceeds `max_bytes`,
  `chunk` returns `{:error, {:oversized_item, _, _}}` instead — assert that arm
  when you generate an oversized item).
- `property "merge_reports concatenation is order-preserving"` — merging a list
  of reports yields, per field, the in-order concatenation of that field across
  reports (mirror the existing example test at `carrier_batch_test.exs:40`).

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_batch_test.exs` → all pass.

### Step 5: Add session nonce/auth properties

In `apps/lattice_core/test/lattice2/carrier_session_test.exs`, add tests that:

- `test "consecutive challenges have distinct nonces"` — generate 100 challenges
  via `Session.challenge/3` and assert all nonces are unique (guards against the
  nonce generator ever degenerating to a constant, which would enable replay).
  This need not be a `property` — a simple `for`-comprehension collecting nonces
  into a `MapSet` and asserting size 100 is enough.
- `property "a response only verifies against its own challenge"` (if the public
  API supports it cleanly) — sign a response to challenge A, and assert
  `Session.verify_response/2` on challenge B (different nonce) rejects it. Model
  on the existing rejection tests in this file. If the current API shape makes
  this awkward, skip this second property and note it in your report rather than
  contorting the test.

**Verify**: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_session_test.exs` → all pass.

### Step 6: Full gate

**Verify**: `~/.asdf/shims/mix verify` → format clean, entire suite passes
(the new properties included). Then update `plans/README.md` status row for 014.

## Test plan

- New tests live in the four existing `apps/lattice_core/test/lattice2/*_test.exs`
  files named above; each already has example tests — add `property`/`test`
  blocks alongside them. Structural pattern to follow: `crdt_property_test.exs`.
- Cases to cover (named above): canonical determinism + injectivity; wire op
  round-trip identity + validity preservation + delegation determinism; batch
  chunk/flatten identity + bounds + oversized-item error; session nonce
  uniqueness.
- Verification: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/` → all
  pass, including the ≥8 new property/test blocks.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix compile` exits 0 with no new warnings.
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/` exits 0; new
      properties for canonical, wire, batch, and session exist and pass.
- [ ] `grep -n "Enum.sort" apps/lattice_core/lib/lattice/carrier/wire.ex` shows
      the delegation `ops`/`roles` sort added in Step 1.
- [ ] `~/.asdf/shims/mix format --check-formatted` exits 0.
- [ ] `~/.asdf/shims/mix verify` exits 0.
- [ ] `git status` shows only the five in-scope files modified.
- [ ] `plans/README.md` status row for 014 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- Any new property **fails** on generated input (e.g. the wire round-trip
  identity does not hold, or canonical encoding is not deterministic). That is a
  real bug in production code — report the shrunk counterexample; do NOT weaken
  the property to make it pass, and do NOT change `canonical.ex`/`batch.ex`/
  `session.ex` source to force green.
- The delegation-sort change in Step 1 makes any **existing** test fail — that
  would mean something depends on the old unsorted wire order; report it.
- `Op.valid?/1`, `Op.canonical_encoding/1`, `Identity.from_seed/2`, or
  `Session.challenge/3` do not exist with the signatures used here (API drift
  since commit `6b2cfe5`).
- A property run is flaky (passes/fails across runs) — report it rather than
  adding retries; flakiness itself is a finding.

## Maintenance notes

- These properties are the guardrail for any future change to the wire format,
  the canonical encoder, or batching. A reviewer of such a change should expect
  these tests to fail loudly if determinism regresses — that is the point.
- If a browser/AtomVM realm is later added (per `docs/plans/2026-05-23-atomvm-browser-design.md`),
  the same round-trip properties should be run against *its* `Lattice.Canonical`
  / `Lattice.Carrier.Wire` implementation to prove cross-runtime byte-identity.
- Deferred out of this plan: fuzzing the wire decoder against *adversarial*
  malformed frames beyond the existing example tests (that is a security-hardening
  task, not a determinism property). Noted for a future round.
