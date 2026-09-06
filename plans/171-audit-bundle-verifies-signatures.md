# Plan 171: Give every unverified `Log.restore/1` consumer a policy — audit bundles and the Registry

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- apps/lattice_core/lib/township/audit_bundle.ex apps/lattice_core/lib/lattice/log.ex apps/lattice_core/lib/lattice/registry.ex apps/township_web/lib/township_web/instrument_source/bundle.ex apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Adopted R06 execution amendment — 2026-09-06

The unified Treehouse program authorizes this packet from proposal commit
`641cbbd78bf1338a4a245e5a670ad425aa79be1b`. The integration owner adopted the following
bounded amendment after inspection found a second read of `matter.log` inside
`TownshipWeb.InstrumentSource.Bundle`, after directory verification had finished. Merely
checking the second log's signatures would still permit its projection and provenance to
refer to different file versions. R06 requires the consumer to use the exact verified input.

- Keep `Log.restore/1`, `Log.dump/2`, persisted formats, canonical bytes and authority rules
  unchanged. Add `Log.restore_verified/1`: capture one file read, safely decode and upgrade
  its existing structs, run `verify_authenticity/1`, and return that log together with the
  captured bytes' SHA-256 fingerprint. Malformed serialized collections/ops fail before a
  consumer installs any state; they cannot normalize into an empty replacement log.
- Add `AuditBundle.load_verified/1` returning the verified log and the captured, validated
  manifest metadata. Preserve `AuditBundle.verify/1`'s `:ok | {:error, [String.t()]}` contract
  as a wrapper. The instrument consumes this snapshot without re-reading the directory and
  records `verification: :bundle_signatures`.
- Route Registry restore through the same staged `restore_verified/1` policy, then require
  the requested replica match. Signature/structural refusal returns `:invalid_log`; an
  authentic different replica returns `:wrong_replica`. A refused restore preserves prior
  live state and leaves an unknown realm uninstalled.
- Expand in-scope tests to `apps/lattice_core/test/lattice2/log_authenticity_test.exs` and
  `apps/lattice_core/test/lattice2/registry_restore_test.exs`, and record this amendment in
  this plan. Preserve the existing protected Plan 121 status/build-map assertions in
  `audit_bundle_test.exs` exactly. The integration owner updates the shared index/roadmap.
- The full-suite gate exposed an existing lifecycle fixture that hosted and restored a
  root-bound `Sim` log under an unbound replica alias. The integration owner explicitly
  adopted the narrow `lifecycle_test.exs` correction: use `Sim.replica(sim)` consistently
  for Registry keys and event expectations, retaining all behavior 11–14 assertions and
  strict production replica equality. No authority or Registry-host policy changes follow.
- Add a deterministic instrument consumer regression using a local FIFO projection: once
  verification has captured its log and opened the projection, replace `matter.log`, then
  finish the projection. The displayed model, frontier and fingerprint must still describe
  the captured verified log. No sleeps, timing race or production test callback is needed.

These details supersede the direct-call wiring in steps 3/5/6 and their final grep criteria:
`verify_authenticity` must appear in `log.ex`; `restore_verified` must appear in `log.ex`,
`audit_bundle.ex` and `registry.ex`; the instrument must call `AuditBundle.load_verified`.
All original signature, wrong-replica, quarantine, full-suite, static-analysis, demo and
protected-contract gates still apply. The old unverified restore contract is explicitly
covered by a compatibility test.

The drift check found changes only in `Holder` among the original reference files; its
`validate_log/1` predicate remains the plan's exemplar. `Health` is an additional production
restore caller and already applies `Holder.validate_log/1`; it needs no change. The carrier
policy and frozen election/attestation code remain outside this packet. Duplication between
the new authenticity predicate and `Holder.validate_log/1` remains deliberate under that
boundary. Authenticity still makes no claim that retained history is complete.

### Local execution evidence — 2026-09-06

- RED: a forged post with regenerated projections verified `:ok`; a forged Registry restore
  installed successfully; an authentic other-replica restore installed under the requested
  key; malformed serialized ops crashed the Registry; the deterministic file-replacement
  test displayed the substituted post after verifying the original. Each corresponding
  public-seam regression passed after the implementation.
- GREEN: `mix check` under the prescribed OTP 28/asdf toolchain exited 0: 677 tests and
  27 properties across the default umbrella suite, with the existing three exclusions.
  Formatting and strict Credo passed; Credo still reports its non-failing baseline
  suggestions. The three protected contract suites passed and the Plan 121 protected
  assertion block was compared unchanged against the proposal base.
- GREEN: both prescribed per-app Sobelow commands exited 0. `lattice_server` retained its
  existing missing-Phoenix-router notice; the Township boundary scan completed cleanly.
- GREEN: the Township demo narrated W0–W3 and the explicitly non-receipt-free legacy W4,
  wrote to a fresh temporary artifact directory, and its emitted bundle independently
  passed `mix lattice.township.verify_bundle`. The sole committed `matter.log` fixture,
  `artifacts/township/matter.log`, independently verified and remained byte-identical.
- Preservation: the `Log.restore/1` and `Log.dump/2` implementations, Holder validation,
  authority/canonical source, persisted formats and the existing committed bundle were
  unchanged. This is local implementation evidence; the integration owner records final
  review and the shared roadmap/index status separately.

## Status

- **Priority**: P1 — the artifact the project offers to outside auditors is presented as
  "verified" while no operation signature is ever checked. This is the exit-gate claim G5.
- **Effort**: M — the verification logic already exists and is proven elsewhere in the repo; the
  work is wiring it in and honestly re-labelling what the instrument asserts.
- **Risk**: MED — every existing fixture bundle must pass the new gate. A bundle that
  legitimately contains structurally-quarantined ops needs the `verified_quarantine` shape
  honoured rather than rejected.
- **Depends on**: none.
- **Category**: security
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Why this matters

`CLAUDE.md` states acceptance criterion **G5**: the demo emits "trust-graph + audit artifacts an
outsider can replay". `Township.AuditBundle.verify/1` is that replay check, and
`TownshipWeb.InstrumentSource.Bundle` renders its verdict to the user as a verified-snapshot
badge with `verified: true`. This is the **default** `/township` source.

What `verify/1` actually proves is that the bundle's six projection files match a re-derivation
from `matter.log`. It never proves that `matter.log` is authentic. `Lattice.Log.restore/1`
deserialises straight into a `%Log{}` and bypasses `accept/2` — the only place `Op.valid?/1`
runs — and nothing in the read path (`ReadModel.observe/2`, `Authority.analyze/2`,
`Lattice.Reduce`) re-checks it.

So an attacker who edits `matter.log` and regenerates the projections passes. `Authority.analyze`
does verify *delegation* signatures, so forged delegation chains are caught — but plain
`:command` ops are attributed purely by `op.author`, an attacker-controlled field on an op whose
signature nobody checks. Forged posts, titles, summaries, and roster changes attributed to the
real clerk verify clean and render behind the verified badge.

The same gap exists a second time, with a second defect layered on it.
`Lattice.Registry`'s `{:restore, ...}` clause also materializes a restored log with no
authenticity check — **and** it never compares the restored `log.replica` against the `replica`
the caller asked to restore under. The registry key is built from the caller's argument while
the log comes from an arbitrary path, so an entirely authentic dump for replica A can be
installed under replica B's key and served from there forever. Authenticity would not catch
that: a log for A is perfectly self-consistent, it is simply not the log anyone requested. Both
consumers, and both assertions, are fixed here.

The contrast inside the repo makes it clear this is an oversight rather than a decision. Two
other consumers of `Log.restore/1` do it correctly:
`LatticeCarrierServer.Holder.validate_log/1` re-verifies every op, and
`Township.Election.Projector` does the same. The live carrier projection is also genuinely
verified — it routes ops through `Sync.deliver` → `Log.accept` → `Op.valid?` and labels itself
`verification: :arrival`, which is accurate. The bundle path is the one that labels itself
verified without doing the work.

## Current state

### The restore that skips verification — `apps/lattice_core/lib/lattice/log.ex:240-251`

```elixir
  @doc "Restore a log previously written with `dump/2`."
  @spec restore(Path.t()) :: {:ok, t()} | {:error, term()}
  def restore(path) do
    with :ok <- ensure_dump_vocabulary(),
         {:ok, bin} <- File.read(path),
         {:ok, term} <- safe_binary_to_term(bin),
         {:lattice_log_dump_v1, %__MODULE__{} = log} <- term do
      {:ok, upgrade_structs(log)}
    else
      {:error, _} = err -> err
      _ -> {:error, :corrupt_dump}
    end
  end
```

`[:safe]` blocks atom creation from a tampered dump, which is a real protection — but it is
structural, not cryptographic. No `Op.valid?/1`.

### What `verify/1` actually checks — `apps/lattice_core/lib/township/audit_bundle.ex:59-87`

```elixir
  def verify(dir) when is_binary(dir) do
    dir = Path.expand(dir)

    with {:ok, names} <- list_bundle(dir),
         :ok <- validate_file_set(names),
         {:ok, manifest_doc, manifest_bytes} <- read_manifest(dir),
         {:ok, labels} <- validate_manifest(manifest_doc),
         :ok <- preload_lattice_core(),
         {:ok, log} <- Log.restore(Path.join(dir, "matter.log")),
         {:ok, expected, known_fingerprints} <- rederive(log, labels) do
      expected = Map.put(expected, "manifest.json", json(manifest_doc))

      errors =
        expected
        |> Enum.flat_map(fn {file, bytes} ->
          case read_projection(dir, file, manifest_bytes) do
            {:ok, ^bytes} -> []
            ...
```

Restore, then compare re-derived projections against stored projections. Internal consistency,
not authenticity.

### What the instrument claims — `apps/township_web/lib/township_web/instrument_source/bundle.ex:14-17` and `:36-45`

```elixir
    case AuditBundle.verify(bundle_dir) do
      :ok -> load_verified(bundle_dir)
      {:error, errors} -> {:error, {:bundle_unverified, errors}}
    end
```

```elixir
         provenance: %{
           source: :bundle,
           freshness: :snapshot,
           verification: :bundle,
           ...
           verified: true,
```

### The exemplar that does it right — `apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex:337-376`

```elixir
  @spec validate_log(Log.t()) :: :ok | {:error, :invalid_log_structure}
  def validate_log(%Log{
        replica: replica,
        ops: ops,
        referenced: %MapSet{} = referenced,
        quarantine: quarantine
      })
      when is_binary(replica) and byte_size(replica) > 0 and is_map(ops) and is_list(quarantine) do
    expected_referenced =
      Enum.reduce(ops, MapSet.new(), fn {_id, op}, acc ->
        MapSet.union(acc, MapSet.new(op.deps))
      end)

    valid_ops? =
      Enum.all?(ops, fn
        {id, %Op{id: op_id, replica: ^replica, deps: deps} = op} when is_binary(id) ->
          op_id == id and is_list(deps) and Enum.all?(deps, &Map.has_key?(ops, &1)) and
            Op.valid?(op)

        _invalid ->
          false
      end)

    with true <- valid_ops?,
         true <- MapSet.equal?(referenced, expected_referenced),
         {:ok, _verified} <- Log.verified_quarantine(%Log{...}) do
      :ok
    else
      _invalid -> {:error, :invalid_log_structure}
    end
  rescue
    _error -> {:error, :invalid_log_structure}
  end
```

This checks: key/id agreement, replica agreement, dep closure, `Op.valid?` per op, `referenced`
consistency, and quarantine verification. It is exactly the missing check, already written and
already under test.

### Existing tests only tamper with projections

`apps/lattice_core/test/township/audit_bundle_test.exs:78` and
`apps/township_web/test/township_web/instrument_source_test.exs:61` corrupt `audit.json` /
`state.json`. Neither forges an op inside `matter.log`, which is why the gap survived a green
suite.

### Repo conventions to match

- `mix format`-clean; v2 modules carry `@moduledoc` and `@spec`.
- Township tests live in `apps/lattice_core/test/township/`; `township_web` tests in
  `apps/township_web/test/township_web/`.
- Error returns from `AuditBundle.verify/1` are `{:error, [String.t()]}` — a sorted list of
  human-readable strings. Match that shape exactly; the instrument renders them.

## Commands you will need

```bash
export MIXCMD="$HOME/.asdf/shims/mix"
export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
```

| Purpose | Command | Expected on success |
|---|---|---|
| Format check | `$MIXCMD format --check-formatted` | exit 0 |
| Full suite | `$MIXCMD test` | exit 0, 0 failures |
| Credo | `$MIXCMD credo --strict` | exit 0 |
| Bundle tests | `$MIXCMD test apps/lattice_core/test/township/audit_bundle_test.exs` | all pass |
| Instrument tests | `$MIXCMD test apps/township_web/` | all pass |
| Demo (regenerates artifacts) | `$MIXCMD run scripts/township_demo.exs` | narrates clean, exit 0 |

Baseline at the planned-at commit: `$MIXCMD test` exits 0.

## Scope

**In scope**:

- `apps/lattice_core/lib/lattice/log.ex` — add a public verification function (see step 2);
  **do not change `restore/1`'s return contract**
- `apps/lattice_core/lib/township/audit_bundle.ex` — call the new verification inside `verify/1`
- `apps/lattice_core/lib/lattice/registry.ex` — the `{:restore, ...}` clause only (see step 5)
- `apps/township_web/lib/township_web/instrument_source/bundle.ex` — the provenance labelling
- `apps/lattice_core/test/township/audit_bundle_test.exs` — add the forged-op case
- `apps/lattice_core/test/lattice2/` — add the Registry restore cases (see test plan)
- `apps/township_web/test/township_web/instrument_source_test.exs` — add the corresponding case
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- **`Lattice.Log.restore/1`'s own behaviour and return contract.** Do not make `restore/1`
  itself verify. It is called by `Holder.restore_path/1`, `Election.Projector`, and
  `Registry`, and the first two already apply their own validation policy; changing the shared
  primitive would silently alter them. Add a *separate* function and call it from the consumers
  that currently lack a policy — which, after this plan, means `AuditBundle` and `Registry`
  only. **`Registry` is in scope as a caller; the restore primitive is not.**
- `apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex` — already correct. You may
  *read* `validate_log/1` as the reference, and you may extract it, but do not weaken it.
- `apps/township_web/lib/township_web/carrier_projection.ex` — the carrier path is genuinely
  verified and its `verification: :arrival` label is accurate. Leave it.
- `Township.Election` / `Lattice.Attestation` — frozen per `CLAUDE.md`.
- The bundle *format*. Adding fields to a bundle is a separate change; this plan verifies what
  is already there.

## Git workflow

- Branch: `codex/171-audit-bundle-verifies-signatures`
- Conventional commits matching `git log`, e.g.
  `test(audit): add RED forged-op bundle regression`, then
  `fix(audit): verify op signatures before reporting a bundle verified`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing (RED) regression first

Add to `apps/lattice_core/test/township/audit_bundle_test.exs`, following the existing
tamper-test structure in that file (read it first — it already has helpers for writing a bundle
to a tmp dir):

A test that (a) writes a valid bundle, (b) restores `matter.log`, (c) splices in a **forged**
`:command` op — same `replica`, `author` set to a legitimate participant's public key, a
plausible body, and an `id`/`sig` the attacker cannot produce honestly — (d) re-dumps
`matter.log`, (e) regenerates the six projections from the tampered log so the internal
consistency check still passes, and (f) asserts `AuditBundle.verify/1` returns `{:error, _}`.

The critical detail is (e): if you skip it, the test passes for the wrong reason (projection
mismatch, which `verify/1` already catches). The test must prove that a **self-consistent**
tampered bundle is rejected. Build the forged op with `Lattice.Op.new/6` under a *different*
identity, then overwrite the `author` field to the victim's public key — that produces a
structurally well-formed op whose signature does not verify against its declared author, which
is exactly the attack.

**Verify**: `$MIXCMD test apps/lattice_core/test/township/audit_bundle_test.exs`
→ **the new test FAILS** (verify returns `:ok` today). Every pre-existing test still passes. If
it passes before you change source, STOP — already fixed, plan stale.

### Step 2: Give `Lattice.Log` a public authenticity check

`Holder.validate_log/1` is the check we need, but it lives in the carrier server app, which
`lattice_core` cannot depend on (the dependency runs the other way).

Add a public function to `apps/lattice_core/lib/lattice/log.ex` — suggested name
`verify_authenticity/1`, returning `:ok | {:error, [String.t()]}` — implementing the same
predicate as `Holder.validate_log/1`: per-op key/id agreement, replica agreement, dep closure,
`Op.valid?`, `referenced` consistency, and `Log.verified_quarantine/1`.

Return the **error list** shape rather than a single atom, so `AuditBundle.verify/1` can fold
the reasons into its existing `errors` list. Name each failing op id in its message — an
auditor needs to know *which* op failed, not just that one did.

Give it a `@moduledoc`-quality `@doc` stating plainly what it proves and what it does not: it
proves every stored op is internally consistent and signed by its declared author; it does not
prove the log is *complete*, and it cannot detect an op that was never included.

Do **not** change `restore/1`.

Do **not** edit `apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex` — it is out of
scope (see the Out-of-scope list). Its `validate_log/1` is the reference shape for the new
function; leave it alone even after the extraction, and note any residual duplication as a
follow-up in your final report rather than weakening the exclusion.

**Verify**: `$MIXCMD test apps/lattice_core/` → exit 0.

### Step 3: Call it from `AuditBundle.verify/1`

Insert the check into the `with` chain immediately after `Log.restore/1` and **before**
`rederive/2` — there is no point re-deriving projections from a log that is not authentic.

Fold its error list into the existing sorted `errors` list so the return shape is unchanged.

**Verify**: `$MIXCMD test apps/lattice_core/test/township/audit_bundle_test.exs` → all pass,
including the step-1 test.

### Step 4: Confirm every committed bundle fixture still verifies

The new gate applies to existing fixtures. Find and check them:

```bash
find . -name "matter.log" -not -path "./_build/*" -not -path "./deps/*"
$MIXCMD test apps/lattice_core/test/township/ apps/township_web/
```

If a fixture fails, do **not** regenerate it reflexively. Determine why first:

- **Contains a genuinely invalid op as part of a quarantine demo** → the fix belongs in
  `verify_authenticity/1`, which must honour `Log.verified_quarantine/1` for structurally
  quarantined entries rather than rejecting them. Adjust the function, not the fixture.
- **Contains an op that simply does not verify** → that is a real finding about the fixture.
  STOP and report it.

**Verify**: both commands exit 0, and you have recorded which fixtures were checked.

### Step 5: Close the second unverified restore consumer — `Lattice.Registry`

`AuditBundle` is not the only caller that materializes a restored log without a policy.
`apps/lattice_core/lib/lattice/registry.ex:265-273`:

```elixir
  def handle_call({:restore, identity, module, replica, path}, _from, st) do
    key = {identity.realm_id, replica}

    case Log.restore(path) do
      {:ok, log} ->
        {:reply, :ok, put_entry(st, key, new_entry(identity, module, log))}

      {:error, _} = err ->
        {:reply, err, st}
    end
  end
```

Two separate defects live in those eight lines, and **both must be fixed**:

1. **No authenticity check.** Same gap as `AuditBundle` — call the step-2 function.
2. **No binding between the restored log and the requested key.** `key` is built from the
   *caller's* `replica` argument, while `log` comes from an arbitrary `path`. Nothing compares
   `log.replica` to `replica`. A perfectly authentic dump for replica A can therefore be
   installed under the registry key for replica B, and every later read through that key returns
   another replica's state under the wrong identity.

The second is **not** implied by the first. `verify_authenticity/1` proves every op belongs to
`log.replica`; it says nothing about whether `log.replica` is the replica anyone asked for.
Both assertions are required.

Add both to the `{:restore, ...}` clause, returning distinct errors so a caller can tell them
apart — `{:error, :invalid_log}` for a failed authenticity check and `{:error, :wrong_replica}`
for the mismatch. Reuse the `:wrong_replica` atom already used by `Log.accept/2`
(`log.ex:138-139`) so the vocabulary stays consistent across the codebase.

Do not change the arity or the success return of the clause; `{:reply, :ok, ...}` on success
stays as it is.

**Verify**: `$MIXCMD test apps/lattice_core/` → exit 0, including the two new Registry cases
from the test plan.

### Step 6: Make the instrument's claim match what was checked

In `apps/township_web/lib/township_web/instrument_source/bundle.ex`, the provenance map now
tells the truth about signatures — but `verified: true` is still a bare boolean where the
carrier path carries a meaningful `verification: :arrival`.

Keep `verified: true` (the badge and its template binding depend on it) and make
`verification:` specific — `:bundle_signatures` rather than `:bundle` — so the two sources are
distinguishable in the UI and in any future audit output. Update the template/LiveView only if
it pattern-matches on the old atom; check with:

```bash
grep -rn "verification" apps/township_web/lib apps/township_web/test | grep -v _build
```

Also update the `@moduledoc` of `Township.AuditBundle` to state what `verify/1` now proves —
the current wording claims re-derivation only.

**Verify**: `$MIXCMD test apps/township_web/` → exit 0.

### Step 7: Full green, including the demo that emits the artifacts

```bash
$MIXCMD format --check-formatted && $MIXCMD test && $MIXCMD credo --strict
$MIXCMD run scripts/township_demo.exs
```

**Verify**: all exit 0 and the demo narrates clean through W0→W4.

## Test plan

1. `apps/lattice_core/test/township/audit_bundle_test.exs` — a **self-consistent** bundle whose
   `matter.log` contains a forged `:command` op (valid structure, `author` overwritten to a
   victim's pubkey, projections regenerated to match) is rejected by `verify/1`. This is the
   core regression.
2. Same file — an untampered bundle still verifies `:ok` (guards against over-rejection).
3. Same file — the error message names the offending op id.
4. `apps/township_web/test/township_web/instrument_source_test.exs` — loading a bundle with a
   forged op returns `{:error, {:bundle_unverified, _}}` rather than a `verified: true`
   provenance.
5. `apps/lattice_core/test/lattice2/` — `Registry.restore/5` with a dump containing a forged op
   returns `{:error, :invalid_log}` and installs **nothing** under the key (assert a subsequent
   read through that key still fails or returns the prior entry — the failed restore must not
   partially populate the registry).
6. Same file — `Registry.restore/5` with an authentic dump whose `log.replica` differs from the
   requested `replica` returns `{:error, :wrong_replica}` and installs nothing. This is the case
   `verify_authenticity/1` alone would let through, so it is the one that proves the second
   assertion is load-bearing.

Model 1–4 on the existing tamper tests in those files (`audit_bundle_test.exs:78`,
`instrument_source_test.exs:61`), and 5–6 on the existing Registry tests — find them with
`grep -rln "Registry.restore\|Lattice.Registry" apps/lattice_core/test`.

Verification: `$MIXCMD test` → exit 0 with 6 new tests passing.

## Done criteria

Machine-checkable. ALL must hold:

- [x] `$MIXCMD format --check-formatted` exits 0
- [x] `$MIXCMD test` exits 0, 0 failures
- [x] `$MIXCMD credo --strict` exits 0
- [x] `$MIXCMD run scripts/township_demo.exs` exits 0 and narrates W0→W4
- [x] Adopted helper wiring: `verify_authenticity` in `log.ex`, `restore_verified` in `log.ex`/`audit_bundle.ex`/`registry.ex`, and `AuditBundle.load_verified` in the instrument
- [x] `rg -n "wrong_replica" apps/lattice_core/lib/lattice/registry.ex` returns a match
- [x] The 6 tests named in the test plan exist and pass
- [x] `git status --porcelain` lists no file outside the in-scope list
- [x] `plans/README.md` status row for 171 updated

### Hosted closure — 2026-09-06

Claude Fable passed final implementation `41ace37b50439f83393eda427dc55a9ef650f899`.
PR61 tip run 34036773840 passed, and merge
`15ea1c37b2a134725ae6d820752a9ef8f105da8d` passed its exact workflow 34045534524.
The checked criteria use the adopted execution amendment and recorded local
format/test/Credo/demo evidence above. The integrator updates row171 to DONE.
This closes the verified-input consumer contract, not an unseen-history or
native/physical completeness claim.

## STOP conditions

Stop and report back (do not improvise) if:

- The step-1 test passes before you change source — already fixed, plan stale.
- A committed bundle fixture fails the new gate for a reason other than a deliberate quarantine
  demo (step 4). That means a fixture contains an op that does not verify, which is its own
  finding.
- `verify_authenticity/1` cannot be written without changing `Log.restore/1`'s contract or
  without `lattice_core` depending on `lattice_carrier_server`. Either would mean the extraction
  is wrong; report and stop.
- The demo script fails after the change. The demo emits the artifacts an outsider replays, so a
  demo failure means the artifacts it produces do not pass their own gate — a significant
  finding, not a test to adjust.
- You find a **third** consumer of `Log.restore/1` that materializes state without verification
  (search: `grep -rn "Log.restore" apps --include=*.ex | grep -v _build`). Report it; do not
  expand scope.

## Maintenance notes

For the human or agent who owns this next:

- **What a reviewer should scrutinize**: that the step-1 test regenerates the projections from
  the tampered log. Without that, the test passes for the wrong reason and the gate it claims to
  pin is not actually pinned.
- **Be precise about what this fixes.** After this plan, a bundle is proven *authentic* — every
  op it contains is signed by its declared author. It is still not proven *complete*: a bundle
  that silently omits ops (a revocation, say) verifies clean. Completeness against a signed
  frontier is a genuinely harder problem and is explicitly out of scope. Say so in any writeup
  of G5, and consider stating it in the `AuditBundle` moduledoc alongside the new guarantee.
- **The general lesson**: `Op.valid?/1` runs in exactly one place on the ingest path
  (`Log.accept/2`). Any code path that constructs a `%Log{}` by another route bypasses it. After
  this plan all four `Log.restore/1` consumers have an explicit policy — `Holder` and
  `Election.Projector` already did, and `AuditBundle` and `Registry` gain one here. **When a
  fifth restore consumer appears, it needs one too**; the cheapest guard is a grep in review
  (`grep -rn "Log.restore" apps --include=*.ex | grep -v _build`) against the list of callers
  that call `verify_authenticity/1`.
- **Two assertions, not one.** The Registry fix is deliberately two checks. Authenticity proves
  a log is internally consistent and signed; the replica-key binding proves it is the log the
  caller asked for. A reviewer should confirm test 6 exists and fails without the second check —
  it is the one that would be quietly dropped as redundant, and it is not.
- **Interacting future work**: plan 168 changes canonical encoding for ops embedding leased
  delegations. If 168 lands first, any pre-existing bundle fixture containing such an op gets a
  new op id and must be regenerated — sequence the two and regenerate between them.
