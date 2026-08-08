# Plan 168: Commit the embedded delegation lease to the op hash, closing a key-free replica-divergence primitive

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- apps/lattice_core/lib/lattice/canonical.ex clients/lattice-client/src/codec.ts apps/lattice_core/test/lattice2/delegation_lease_test.exs apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex clients/lattice-client/test/vectors
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: **P0** — a network attacker with **no key material** permanently and undetectably
  diverges a target replica's authority state. This falsifies two of the four M1 acceptance
  properties (`CLAUDE.md` G2: "byte-identical replay" and "identical quarantine").
- **Effort**: S–M — the production change is ~15 lines across two files. The work is the
  falsifying tests and confirming the vector-regeneration blast radius.
- **Risk**: MED — the change alters canonical bytes (and therefore op ids) for any op that
  embeds a **leased** delegation. Step 2 makes that blast radius explicit and enumerable
  before any behavior changes. Unleased delegations must keep byte-identical output.
- **Depends on**: none. (Independent of plans 162/163/165 — see "Scope" for the boundaries.)
- **Category**: security
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Why this matters

`Lattice.Op` commits to its content by hashing the canonical encoding of
`(replica, author, deps, kind, body, cap)`. When an authority op carries a delegation — the
`{:grant, d}`, `{:genesis, d, policies}`, and `{:transfer, role, d, tick}` bodies — that
`%Lattice.Authority.Delegation{}` struct is encoded by a dedicated clause in
`Lattice.Canonical`. That clause serializes nine fields and **omits `expires_epoch`**, the
plan-149 lease.

The consequence is that `expires_epoch` is outside the op's hashed and signed bytes. Flipping
it does not change `op.id` and does not invalidate `op.sig`, so the tampered op passes
`Lattice.Op.valid?/1` — the only tamper check on the sync path — and is **accepted into the
log**. Because `Lattice.Log.accept/2` short-circuits on `has?(log, op.id)`, the honest op can
never afterwards displace it: the replica is pinned to the attacker's version forever.

Downstream, `Delegation.valid_sig?/1` *does* recompute over lease-inclusive bytes, so the
tampered delegation fails there. That is fail-closed in the narrow sense — no authority is
forged — but it fails closed **on that replica only**. Every honest replica honors the
delegation while the poisoned one quarantines it. That is exactly the divergence the
"identical quarantine" invariant exists to forbid, and it is reachable by adding or removing
one optional JSON key from a relayed carrier frame.

This was confirmed by execution, not by reading. The probe below is reproduced in step 1 as a
regression test.

## Current state

### The defect — `apps/lattice_core/lib/lattice/canonical.ex:182-194`

The `%Delegation{}` clause lists its fields explicitly; `expires_epoch` is absent:

```elixir
  defp encode(%Lattice.Authority.Delegation{} = delegation) do
    encode_tagged(@delegation_term_tag, [
      delegation.id,
      delegation.replica,
      delegation.issuer,
      delegation.audience,
      delegation.parent_id,
      Enum.sort(delegation.ops),
      Enum.sort(delegation.roles),
      delegation.live,
      delegation.sig
    ])
  end
```

`@delegation_term_tag` is `60_003` (`canonical.ex:39`).

Contrast `delegation_payload/1` at `canonical.ex:65-77`, which **does** read the field, and
`delegation_bytes/8` at `canonical.ex:117-134`, which emits the `lattice-delegation-v3` tag
with the epoch as a trailing element when the lease is set and delegates to the 7-arity v2 arm
when it is `nil`. **That `nil`-arm split is the pattern to copy.**

### Why the op-level check does not catch it — `apps/lattice_core/lib/lattice/op.ex:86-91`

```elixir
  def valid?(%__MODULE__{} = op) do
    encoding = canonical_encoding(op)
    op.id == hash(encoding) and Identity.verify(op.author, encoding, op.sig)
  rescue
    ArgumentError -> false
  end
```

`canonical_encoding/1` (`op.ex:76-78`) routes `op.body` through the clause above, so a mutated
`expires_epoch` produces identical bytes.

### Why the poisoning is permanent — `apps/lattice_core/lib/lattice/log.ex:136-161`

```elixir
  def accept(%__MODULE__{} = log, %Op{} = op) do
    cond do
      op.replica != log.replica ->
        {:rejected, log, :wrong_replica}

      has?(log, op.id) ->
        {:ok, log}
      ...
```

The second clause returns `{:ok, log}` and discards the incoming op whenever an op with that
id is already present. First writer wins.

### Why it then diverges — `apps/lattice_core/lib/lattice/authority/delegation.ex:108-122`

```elixir
  def valid_sig?(%__MODULE__{} = d) do
    encoding =
      encode(
        d.replica,
        d.issuer,
        d.audience,
        d.parent_id,
        d.ops,
        d.roles,
        d.live,
        d.expires_epoch
      )

    d.id == hash(encoding) and Identity.verify(d.issuer, encoding, d.sig)
  end
```

This recomputes **with** the lease, so the tampered delegation is rejected here — on the
poisoned replica only.

### How the attacker reaches the field — `apps/lattice_core/lib/lattice/carrier/wire.ex:281-286`

```elixir
    # Plan 149: the lease rides the wire only when set, so every unleased
    # delegation frame keeps its existing shape byte-for-byte.
    case delegation.expires_epoch do
      nil -> frame
      epoch -> Map.put(frame, "expires_epoch", epoch)
    end
```

and `wire.ex:329-331` accepts any non-negative integer on decode. Adding, removing, or changing
this one optional JSON key in a relayed frame is the entire attack.

### The TypeScript side mirrors the omission — `clients/lattice-client/src/codec.ts:290-306`

```typescript
function encodeDelegation(delegation: CarrierDelegation): Uint8Array {
  return encodeTagged(
    delegationTermTag,
    encodeArray([
      encodeBinaryString(delegation.id),
      encodeBinaryString(delegation.replica),
      encodeBytes(base64ToBytes(delegation.issuer)),
      encodeBytes(base64ToBytes(delegation.audience)),
      delegation.parent_id === null ? bytes(0xf6) : encodeBinaryString(delegation.parent_id),
      encodeArray(uniqueSorted(delegation.ops).map(encodeAtom)),
      encodeArray(uniqueSorted(delegation.roles).map(encodeAtom)),
      bytes(delegation.live ? 0xf5 : 0xf4),
      encodeBytes(base64ToBytes(delegation.sig)),
    ]),
  );
}
```

Both runtimes must change together or their canonical bytes diverge, which is a `CLAUDE.md`
STOP condition.

### The existing test passes only incidentally — `apps/lattice_core/test/lattice2/delegation_lease_test.exs:95-111`

```elixir
  test "a leased delegation embedded in an op changes the op's canonical bytes" do
    unleased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post])
    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 3)

    unleased_bytes = Canonical.term({:grant, unleased})
    leased_bytes = Canonical.term({:grant, leased})

    assert unleased_bytes != leased_bytes,
```

It compares two **independently issued** delegations, whose `id` and `sig` differ because those
are computed over lease-inclusive bytes. It therefore never exercises the mutation case. Do not
delete this test — it pins a real property. Add the mutation case alongside it.

### Repo conventions to match

- All code is `mix format`-clean; `mix verify` enforces it.
- v2 modules carry `@moduledoc` and `@spec`. `Lattice.Canonical`'s private `encode/1` clauses
  carry no specs — match that, do not add specs to private clauses.
- Elixir tests live in `apps/lattice_core/test/lattice2/`; model new cases on the existing
  structure of `delegation_lease_test.exs` (module attribute `@replica`, `issuer()`/`audience()`
  helpers defined at the bottom of the file).
- TypeScript is strict ESM with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.

## Commands you will need

Run mix through the asdf shim with the OTP 28 / Elixir 1.19 bin directories prepended — `mix`
on `PATH` is a broken mise shim (see `AGENTS.md`). Define this once per shell:

```bash
export MIXCMD="$HOME/.asdf/shims/mix"
export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
```

| Purpose | Command | Expected on success |
|---|---|---|
| Elixir format check | `$MIXCMD format --check-formatted` | exit 0 |
| Elixir full suite | `$MIXCMD test` | exit 0, 0 failures |
| Targeted suite | `$MIXCMD test apps/lattice_core/test/lattice2/delegation_lease_test.exs` | all pass |
| Credo | `$MIXCMD credo --strict` | exit 0 |
| TS typecheck | `cd clients/lattice-client && npm run typecheck` | exit 0 |
| TS canonical parity | `cd clients/lattice-client && npm run canonical` | exit 0 |
| TS conformance | `cd clients/lattice-client && npm run conformance` | exit 0 |
| TS build (regenerates `dist/`) | `cd clients/lattice-client && npm run build` | exit 0 |
| Regenerate vectors | `$MIXCMD lattice.export_vectors --out clients/lattice-client/test/vectors` | exit 0 |

Baseline at the planned-at commit: `$MIXCMD test` exits 0. If it does not on your checkout,
STOP — you have unrelated breakage and cannot attribute failures to this change.

## Scope

**In scope** (the only files you may modify):

- `apps/lattice_core/lib/lattice/canonical.ex` — the `%Delegation{}` `encode/1` clause **and** the
  `signable?/1` rescue-block broadening required by step 5 (fail-closed for malformed leases)
- `clients/lattice-client/src/codec.ts` — `encodeDelegation` only
- `apps/lattice_core/test/lattice2/delegation_lease_test.exs` — add cases
- `clients/lattice-client/test/canonical.ts` — add the TS-side parity case
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` — only if step 2 shows a vector
  needs a leased-delegation scenario added
- `clients/lattice-client/test/vectors/*.json` — regenerated output, **never hand-edited**
- `clients/lattice-client/dist/**` — regenerated by `npm run build`, **never hand-edited**
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- `apps/lattice_core/lib/lattice/carrier/wire.ex` — the wire encoder is **correct**. It already
  transports the lease and round-trips it (there is a passing test at
  `delegation_lease_test.exs:113`). The bug is that the *canonical* encoder ignores a field the
  wire faithfully carries. Do not "fix" this by removing the field from the wire.
- `apps/lattice_core/lib/lattice/log.ex` — the `has?` short-circuit at `log.ex:141` is correct
  and deliberate (content-addressed ops are idempotent). Do not change acceptance semantics.
  Once the id commits to the lease, a tampered op simply gets a different id and is quarantined
  as `:bad_signature` like any other forgery.
- `apps/lattice_core/lib/lattice/authority.ex` — **plan 162 owns this file.** If you find
  yourself needing to change authority logic, STOP: the plans have collided.
- `clients/lattice-client/src/authority.ts` — plans 162 and 163 own it.
- `apps/lattice_core/lib/lattice/authority/delegation.ex` — `valid_sig?/1` is already correct.
- Any change to the `lattice-delegation-v2` / `-v3` *payload* tags. Those are the delegation's
  own signing bytes and are correct. This plan changes only the **embedded term** encoding
  (tag `60_003`).

## Git workflow

- Branch: `codex/168-embedded-delegation-lease-commitment`
- Conventional commits, matching `git log` style — e.g.
  `test(canonical): add RED embedded-lease tamper regression`, then
  `fix(canonical): commit embedded delegation lease to op bytes`.
- Commit the RED test separately from the fix so the regression signal is reviewable.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing (RED) regression test first

Add to `apps/lattice_core/test/lattice2/delegation_lease_test.exs`, immediately after the
existing `"a leased delegation embedded in an op changes the op's canonical bytes"` test:

```elixir
  test "mutating an embedded delegation's lease changes the op id" do
    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 5)
    op = Lattice.Op.new(issuer(), @replica, [], :authority, {:grant, leased})

    tampered = %{op | body: {:grant, %{leased | expires_epoch: 99}}}

    refute Lattice.Op.canonical_encoding(tampered) == Lattice.Op.canonical_encoding(op),
           "the embedded lease must be inside the op's hashed content"

    refute Lattice.Op.valid?(tampered),
           "a lease-tampered op must fail the sync-path tamper check"
  end

  test "a lease-tampered op cannot poison the honest op's id in a log" do
    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 5)
    op = Lattice.Op.new(issuer(), @replica, [], :authority, {:grant, leased})
    tampered = %{op | body: {:grant, %{leased | expires_epoch: 99}}}

    log = Lattice.Log.new(@replica)

    assert {:quarantined, log, :bad_signature} = Lattice.Log.accept(log, tampered)
    assert {:ok, log} = Lattice.Log.accept(log, op)

    assert {:ok, stored} = Lattice.Log.fetch(log, op.id)
    assert {:grant, %Delegation{expires_epoch: 5}} = stored.body
  end
```

**Verify**: `$MIXCMD test apps/lattice_core/test/lattice2/delegation_lease_test.exs`
→ **both new tests FAIL** (the first on the `canonical_encoding` refute, the second because
`accept/2` returns `{:ok, log}` rather than `{:quarantined, ...}`). Every pre-existing test in
the file still passes. If the new tests pass before you change `canonical.ex`, STOP — the
defect is already fixed and this plan is stale.

### Step 2: Measure the blast radius before changing anything

The fix changes canonical bytes only for delegations with a non-`nil` lease. Find out whether
any committed vector or fixture contains one:

```bash
grep -rln "expires_epoch" clients/lattice-client/test/vectors/ || echo "NO LEASED VECTORS"
grep -rn "expires_epoch" apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex || echo "NO LEASED EXPORT SCENARIO"
```

Record both results in your final report. Interpretation:

- **`NO LEASED VECTORS` and `NO LEASED EXPORT SCENARIO`** — expected at the planned-at commit.
  The fix is byte-neutral for the whole existing corpus; no regeneration is needed, and step 6
  becomes a confirmation rather than a change. Proceed.
- **Any hit** — the fix will change those vectors' op ids. Proceed, but in step 6 you must
  regenerate and report the exact per-vector id diff rather than eyeballing it.

**Verify**: both commands run and you have recorded their output. No files changed yet.

### Step 3: Fix the Elixir canonical encoder

In `apps/lattice_core/lib/lattice/canonical.ex`, replace the single `%Delegation{}` clause with
a `nil`-lease split that mirrors `delegation_bytes/7,8`. The unleased arm must emit the
**existing nine-element array verbatim**; the leased arm appends the epoch as a tenth element.
The array length prefix makes the two forms unambiguous, so the tag stays `60_003`.

```elixir
  defp encode(%Lattice.Authority.Delegation{expires_epoch: nil} = delegation) do
    encode_tagged(@delegation_term_tag, delegation_term_fields(delegation))
  end

  defp encode(%Lattice.Authority.Delegation{expires_epoch: expires_epoch} = delegation)
       when is_integer(expires_epoch) and expires_epoch >= 0 do
    encode_tagged(
      @delegation_term_tag,
      delegation_term_fields(delegation) ++ [expires_epoch]
    )
  end

  defp delegation_term_fields(delegation) do
    [
      delegation.id,
      delegation.replica,
      delegation.issuer,
      delegation.audience,
      delegation.parent_id,
      Enum.sort(delegation.ops),
      Enum.sort(delegation.roles),
      delegation.live,
      delegation.sig
    ]
  end
```

Place `delegation_term_fields/1` with the other private helpers near the bottom of the module
(next to `encode_tagged/2`), not between the `encode/1` clauses — Elixir warns on non-contiguous
clauses of the same function, and `mix credo --strict` will flag it.

Note the guard on the leased arm: a `%Delegation{}` carrying a non-integer or negative
`expires_epoch` now matches **no** clause and raises `FunctionClauseError` rather than
`ArgumentError`. That is why step 5 exists.

**Verify**: `$MIXCMD test apps/lattice_core/test/lattice2/delegation_lease_test.exs`
→ all tests pass, including both new ones from step 1.

### Step 4: Mirror the fix in the TypeScript encoder

In `clients/lattice-client/src/codec.ts`, change `encodeDelegation` so the lease is appended
when present. Read the surrounding file first to confirm how `CarrierDelegation` declares
`expires_epoch` (it is an optional field on the decoded frame type) and match the existing
style — `uniqueSorted`, `encodeBinaryString`, `bytes(0xf6)` for nil, and `encodeUint` (or
whichever helper the file already uses for non-negative integers; find it by reading how the
`"int"` term case is encoded and reuse that exact function).

The required shape:

```typescript
function encodeDelegation(delegation: CarrierDelegation): Uint8Array {
  const fields = [
    encodeBinaryString(delegation.id),
    encodeBinaryString(delegation.replica),
    encodeBytes(base64ToBytes(delegation.issuer)),
    encodeBytes(base64ToBytes(delegation.audience)),
    delegation.parent_id === null ? bytes(0xf6) : encodeBinaryString(delegation.parent_id),
    encodeArray(uniqueSorted(delegation.ops).map(encodeAtom)),
    encodeArray(uniqueSorted(delegation.roles).map(encodeAtom)),
    bytes(delegation.live ? 0xf5 : 0xf4),
    encodeBytes(base64ToBytes(delegation.sig)),
  ];

  if (delegation.expires_epoch !== undefined && delegation.expires_epoch !== null) {
    fields.push(/* the same non-negative-integer encoder the "int" term case uses */);
  }

  return encodeTagged(delegationTermTag, encodeArray(fields));
}
```

Both the `undefined` and `null` checks are required: `exactOptionalPropertyTypes` distinguishes
them, and the wire decoder may produce either depending on whether the key was absent or
explicitly null.

**Verify**: `cd clients/lattice-client && npm run typecheck` → exit 0.

### Step 5: Make out-of-domain leases fail closed rather than crash

`Lattice.Canonical.signable?/1` (`canonical.ex:139-145`) rescues only `ArgumentError`. After
step 3, a `%Delegation{}` with a malformed `expires_epoch` raises `FunctionClauseError`, which
escapes. `Lattice.Carrier.Wire.encode_op/1` calls `signable?/1` as its malformed-op gate
(`wire.ex:55-56`), so this must not become a crash.

Broaden the rescue in `signable?/1` only:

```elixir
  def signable?(value) do
    _bytes = encode(value)
    true
  rescue
    _ -> false
  end
```

Do **not** touch the rescue in `Lattice.Op.valid?/1` — that is a separate call site with its own
callers, and changing it is out of scope for this plan.

Add a case to `delegation_lease_test.exs`:

```elixir
  test "a malformed embedded lease is unsignable rather than raising" do
    leased = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], expires_epoch: 5)

    refute Canonical.signable?({:grant, %{leased | expires_epoch: -1}})
    refute Canonical.signable?({:grant, %{leased | expires_epoch: "5"}})
  end
```

**Verify**: `$MIXCMD test apps/lattice_core/test/lattice2/` → all pass.

### Step 6: Regenerate vectors and prove cross-runtime parity

```bash
$MIXCMD lattice.export_vectors --out clients/lattice-client/test/vectors
git diff --stat clients/lattice-client/test/vectors
```

If step 2 reported `NO LEASED VECTORS`, this diff must be **empty**. A non-empty diff means the
unleased arm is not byte-identical — STOP and report, because that breaks every existing
signature.

If step 2 found leased vectors, the diff is expected. Enumerate exactly which op ids changed
and include that list in your final report.

Then rebuild and run the TS gates:

```bash
cd clients/lattice-client && npm run build && npm run canonical && npm run conformance
```

**Verify**: all three exit 0, and `git diff --stat clients/lattice-client/test/vectors` matches
the expectation from step 2.

### Step 7: Add the TypeScript-side parity assertion

In `clients/lattice-client/test/canonical.ts`, add a case that encodes a leased delegation term
and a lease-mutated copy and asserts the bytes differ. Read the file first and follow its
existing assertion helper and reporting style — it is a `tsx` script, not a framework test, so
match how neighbouring checks report pass/fail.

**Verify**: `cd clients/lattice-client && npm run canonical` → exit 0, and the new check appears
in the output.

### Step 8: Full green

```bash
$MIXCMD format --check-formatted
$MIXCMD test
$MIXCMD credo --strict
cd clients/lattice-client && npm run typecheck && npm run conformance && npm run canonical && npm run township:authoring
```

**Verify**: every command exits 0.

## Test plan

New Elixir cases, all in `apps/lattice_core/test/lattice2/delegation_lease_test.exs`, modeled
on the existing tests in that file:

1. `"mutating an embedded delegation's lease changes the op id"` — the core regression: mutated
   `expires_epoch` must change `Op.canonical_encoding/1` and must fail `Op.valid?/1`.
2. `"a lease-tampered op cannot poison the honest op's id in a log"` — the consequence: the
   tampered op quarantines as `:bad_signature`, and the honest op still lands with
   `expires_epoch: 5`.
3. `"a malformed embedded lease is unsignable rather than raising"` — step 5's fail-closed case.
4. The existing `"carrier wire round-trips the lease and omits it when nil"` test
   (`delegation_lease_test.exs:113`) must continue to pass unchanged — it is the proof that the
   unleased arm stayed byte-identical.

New TypeScript case in `clients/lattice-client/test/canonical.ts`: leased vs lease-mutated
delegation terms encode to different bytes.

Verification: `$MIXCMD test` → exit 0 with 3 new Elixir tests passing;
`npm run canonical` → exit 0 with the new check reported.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `$MIXCMD format --check-formatted` exits 0
- [ ] `$MIXCMD test` exits 0, 0 failures
- [ ] `$MIXCMD credo --strict` exits 0
- [ ] `$MIXCMD test apps/lattice_core/test/lattice2/delegation_lease_test.exs` passes, and the
      file contains the three new tests named in the test plan
- [ ] Step 5's fail-closed `signable?/1` rescue is in place: `Canonical.signable?/1` returns `false`
      (not raises) for a malformed embedded lease, per the step-5 test case
- [ ] `cd clients/lattice-client && npm run typecheck && npm run conformance && npm run canonical && npm run township:authoring` — all exit 0
- [ ] `git diff --stat clients/lattice-client/test/vectors` matches the step-2 expectation
      (empty if step 2 reported `NO LEASED VECTORS`)
- [ ] `git status --porcelain` lists no file outside the in-scope list
- [ ] `plans/README.md` status row for 168 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The step-1 tests **pass before** you change `canonical.ex` — the defect is already fixed and
  this plan is stale.
- `$MIXCMD test` is not green at the planned-at commit before you start.
- Step 6's vector diff is non-empty when step 2 reported `NO LEASED VECTORS`. That means the
  unleased encoding arm is not byte-identical, which would invalidate every existing signature.
  Do not regenerate your way past it.
- The fix appears to require editing `apps/lattice_core/lib/lattice/authority.ex`,
  `clients/lattice-client/src/authority.ts`, or
  `apps/lattice_core/lib/lattice/carrier/wire.ex`. Those belong to plans 162/163 or are
  deliberately out of scope; a collision means the plans need reconciling first.
- You discover that `%Delegation{}` structs are embedded in a signed term anywhere this plan
  did not anticipate (search: `grep -rn "Canonical.term\|op_bytes" apps clients --include=*.ex --include=*.ts | grep -v _build`)
  and that site needs different handling.
- `npm run conformance` fails after the TS change. That is a genuine BEAM↔TS divergence and is a
  `CLAUDE.md` STOP condition, not something to paper over by editing a vector.

## Maintenance notes

For the human or agent who owns this next:

- **What a reviewer should scrutinize**: that the unleased arm emits byte-identical output. The
  whole backward-compatibility story rests on it, and the cheapest proof is the empty vector
  diff in step 6 plus the untouched round-trip test at `delegation_lease_test.exs:113`.
- **The general lesson, worth applying beyond this plan**: any struct with a hand-written
  field list in `Lattice.Canonical.encode/1` will silently drop fields added to that struct
  later. `%Delegation{}` is currently the only such clause. If another struct gains one, it
  needs the same treatment, and a test that adds a field and asserts the bytes change.
- **Interacting future work**: plan 162 changes `authority.ex`'s delegation validation and plan
  163 changes the TS ingest path. Neither touches canonical encoding, but all three plans
  regenerate vectors — land them one at a time and regenerate between, or the vector diffs
  become impossible to attribute.
- **Explicitly deferred**: this plan does *not* address the general class of "a peer can tamper
  with a relayed frame in a way the op hash does not cover." It closes the one instance found.
  A property test that round-trips arbitrary `%Delegation{}` structs through
  `Wire.encode_op |> Wire.decode_op` and asserts `Op.valid?` iff the struct is unmodified would
  close the class; that is a reasonable follow-on and is not in scope here.
- **Not a forgery**: be precise in any writeup. This defect does not let an attacker *gain*
  authority — `Delegation.valid_sig?/1` still fails closed. It lets an attacker *destroy*
  authority on a chosen replica, undetectably and permanently. The claim it falsifies is
  identical-quarantine and byte-identical-replay, not authority soundness.
