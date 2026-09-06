---
priority: P1
category: security
effort: M
risk: LOW-MED
depends_on: [161 (recommended — adversarial-vector hygiene)]
planned_at: 91bb6ca6
---

# Fail closed at the wire/authority boundary: lease range, decode depth, replica marker, op kinds

## Goal

Close four input-validation gaps where attacker-controlled or malformed data either crashes
the BEAM analysis path, enables unbounded decode recursion, or lets conflicting crypto claims
coexist. Every fix follows the repo's fail-closed posture: malformed input is rejected or
quarantined with a stable reason; nothing raises out of reach of the quarantine machinery.

## Findings addressed

- **CRYPTO-01** — a wire-reachable out-of-range `expires_epoch` (any `integer >= 0` is decoded,
  but `Canonical.encode/1` raises `ArgumentError` for integers > 2^64-1) crashes
  `Lattice.Authority.analyze/1` instead of quarantining the op.
- ~~AUTHZ-02~~ (non-integer `at_tick` recorded into role timelines) — **removed from this
  plan**; the defect is owned by `plans/162-authority-root-binding.md` step 2b(e).
- **WIRE-01 / CARRIER-06** — `Lattice.Carrier.Wire.decode_term/1` recursively decodes nested
  lists/tuples/maps/mapsets with no depth bound: a deeply nested JSON frame drives deep BEAM
  recursion (stack/RSS growth) on every ingest path.
- **CRYPTO-02** — `Lattice.Authority.bind_replica/2` silently appends `#root:` markers to names
  that already contain one, and `replica_commitment/1` accepts any non-empty tag, so
  `"town#root:attacker"` produces commitment `"attacker"` while `root_claimed?/1` is false —
  an attacker-bound "root" that bypasses the genesis-binding check in `verify_chain`.
- **CRYPTO-03 / WIRE-08** — `Lattice.Op.new/6` guards only `is_atom(kind)`, so any existing atom
  (e.g. `:genesis`, `:witness`, `:beacon`) can be signed and appended as an op kind, producing
  structurally valid ops outside the four-kind type contract.

## Background

The v2 engine (`Lattice.Authority.analyze/1`, `Lattice.Carrier.Wire`, `Lattice.Canonical`) is
the security spine of the repo. Its established posture (plans 140/144/145/147/149) is:
malformed or unauthorized input never crashes reduction — it quarantines with a stable reason
atom, and the Sim-exported vector corpus + TS conformance gates prove Elixir and TypeScript
agree. These four findings are places where that posture has holes.

Environment and verification commands (see `AGENTS.md` — the `mix` on PATH is broken here):

```bash
export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
~/.asdf/shims/mix --version   # expect: Mix 1.19.5 (compiled with Erlang/OTP 28)
```

TS conformance gates live in `clients/lattice-client` (`npm ci` once, then `npm run <gate>`).

## Current state (verified against `91bb6ca6`)

### Unified R09 execution amendments — 2026-09-06

- Preparation base `7d10eca6a1cccdf9b43e3beeb03bc03e67ee547b`, tree
  `eb9bfbd8a0363ebe7cf4b386746526ffe2dd4a46`, merges exact prerequisite tips
  R07 `afe5ea250072267927b89b353e7bde1e793176b5` and R08
  `8722403f16f82fbdc883d3ed92476163c723ed82`. This is local preparation,
  not a claim that either dependency has passed hosted integration.
- Plan 162 is integrated; its tick, replica and authority semantics remain unchanged.
  `Wire.decode_op/1` already uses `Canonical.signable?/1`, so its public lease-range
  refusal passes before this packet. The RED lease defect is reproducible through
  `Delegation.valid_sig?/1` and `Authority.analyze/2` on a reconstructed in-VM log.
  The early wire guard preserves the existing public refusal as a defense in depth.
- The live generic composite arms are list, tuple, mapset and map; there are no `kv`
  or nested `op` arms. Body/cap paths each allow 64 composites, with scalars and flat
  delegation records accepted at the leaf. Unsupported shell tags remain refused.
- The flat delegation's unchecked `parent_id` could otherwise smuggle a recursive
  term into canonical analysis. The authorized decoder amendment validates nil or
  binary at `decode_delegation/1`; every other field already has scalar or flat-list
  guards. The existing TypeScript `isCarrierDelegation` enforces that parent shape.
- The source proposal's malformed tag -> `nil` change needs a fail-closed correction:
  interpreted directly, `nil` would promote a malformed claimed root to a legacy
  unbound replica and accept a previously refused genesis. The authorized amendment
  permits a private `root_commitment/1` discriminator, an explicit malformed clause
  in `root_matches?/2`, and switching `deleg_context/2` plus `verify_chain/2` to that
  discriminator. Public `replica_commitment/1` retains its tag-or-nil shape; only
  marker-free names may use the legacy unbound path. The existing shared context
  carries refusal into analyze/root/live delegation checks without changing their
  bodies or beacon semantics. `bind_replica/2` refuses any preexisting marker.
- R03 ownership is coordinated: no beacon collector/judge, witnessed policy, tick,
  TS decoder or exporter-source edits belong to this packet. The integrator alone
  owns the shared README and unified execution ledger.
- The stale TS prohibition is amended only for matching root-boundary parity:
  `authority.ts`'s private `replicaRootMatches`/`replicaRootCommitment`, `township.ts`'s
  `bindTownshipReplica`/`townshipReplicaCommitment` and its `authorTownshipGenesis`
  caller, existing public authority/authoring tests, and normally rebuilt `dist`.
  The authoring helper preserves a canonical already-bound replica only after its
  signer matches the committed root, so a later valid genesis remains possible.
  Adversarial forged-genesis fixtures use the lower-level signed operation seam.
  No witnessed-beacon or lease-authoring semantics change.
- Two existing adversarial call sites also need that fixture-only adaptation:
  `clients/lattice-client/test/live_carrier.ts` and the `authorForgedRootGenesis`
  helper in `clients/township-tauri-shell/src/township_release_root_origination_probe.ts`.
  They must still deliver their signed impostor to the real refusal boundary.
  Keep their downstream state/rejection assertions intact and run the existing
  `carrier:township:live` and `release:root-origination:contract` gates. This does
  not authorize physical-device execution or alter normal product/custody flows.
- Fable identified an existing extra-field beacon parity gap: BEAM retains but
  ignores a signed four-field beacon while TypeScript treated it as a legacy
  two-field beacon and could lapse leases. The approved narrow amendment adds
  an exact two-field guard in `carrier.ts`'s legacy beacon decoder, signed
  four-field inertness/lease controls in the existing delegation lease and
  Township authoring tests, and normal generated `dist` output. Wrong arities
  remain stored and unquarantined, with no epoch or lease effect; no BEAM
  production or historical audit semantics change. When combined with R03,
  preserve its exact three-field witnessed branch before the legacy guard and
  rerun all five R03 vectors plus its leased-authoring checks. This explicitly
  amends the earlier decoder ownership exclusion only for this arity guard.

### Unified R09 local implementation evidence — 2026-09-06

The implementation is locally complete on `codex/treehouse-r09-input-limits` in
`/Users/nicholas/develop/lattice-treehouse-r09-20260906`. Claude Fable's exact-diff
review of `7d10eca6a1cccdf9b43e3beeb03bc03e67ee547b` through
`7f984d4482cd55d06ad437e8fcf7309b8bdd606f` returned PASS with no P0/P1 findings.
Its P2 rescue-invariant comment and restore-path residual note are recorded in
this documentation-only follow-up. Shared R03 integration must still preserve
the exact-three witnessed branch before the legacy arity guard and pass all
five R03 vectors plus leased-authoring checks. Integration and hosted gates
remain integrator-owned; this evidence does not mark those gates or the
R07/R08 dependencies DONE. The follow-up changes comments/documentation only;
format and diff checks passed, preserving the runtime evidence below.

- Behavioral RED commits: `97399748` (direct/reconstructed lease overflow),
  `c25e4f39` (body/cap composite-depth matrix), `19e5d498` (root marker),
  `5b9cefe2` (recursive parent and op kind), `2d656d4f` (TS root parity and
  retained-genesis controls), and `49cb785d` (five TS failures from a signed
  four-field beacon's incorrect epoch/lease effect). Each was run before its
  implementation. The wire overflow case was already green at the preparation
  base and is a preserved control, not a claimed new RED.
- A temporary parser-only implementation of the original malformed-tag-to-nil
  proposal made public `verify_chain` and root/holder analysis accept an attacker
  genesis on `town#root:attacker`. That mutation was never committed. The private
  malformed-claim discriminator preserves refusal while public parsing returns
  nil. Valid legacy-unbound and valid-bound controls remain green in both runtimes.
- Public once-bound lifecycle controls retain two distinct, valid signed genesis
  records and apply the later policy in both runtimes. High-level TS authoring
  refuses a different signer; lower-level signed impostor fixtures still reach
  and prove the server/semantic refusal. The caller audit required no Sim source
  change and no idempotent behavior in the low-level binding helper.
- Depth controls accept 8 and 64 composites and refuse 65 for list, tuple, mapset,
  map keys and map values in both body and cap paths. A 1,000-level raw delegation
  parent is refused before canonical recursion, while nil/binary parents remain
  accepted. All four declared op kinds remain accepted.
- The BEAM signed four-field beacon is a baseline-green inertness control;
  TypeScript now matches it. It stays stored and unquarantined, leaves the leased
  post materialized and contributes no epoch. A later exact two-field beacon
  still lapses the lease and preserves the earlier causal post.
- The first full `mix check` failed in R08's scheduler-sensitive 50 ms test
  fixture; a focused rerun also failed under host BEAM contention. The integrator
  reproduced the old-client RED and supplied fixture/CI-path repair
  `a172265e8720d73410fda38213232500972fd784`, cherry-picked here as `1717f45e`.
  Production setup deadlines were unchanged. Final gates ran serially with
  `ERL_FLAGS='+S 4:4'` and the explicit OTP 28/asdf PATH, including child BEAMs.

Final local gates after the arity correction and R08 prerequisite repair:

| Gate | Observed result |
| --- | --- |
| `mix check` (format + full tests + strict Credo) | Exit 0; 694 tests + 27 properties, 3 existing exclusions; no new Credo issues |
| `MIX_ENV=test mix lattice.export_vectors --out clients/lattice-client/test/vectors` | Exit 0; all 57 tracked vector files unchanged |
| TS `typecheck`, `township:authoring`, `build` | Exit 0; normal generated outputs committed |
| TS `conformance`, `canonical`, `v01:guard` after regeneration | Exit 0 |
| TS `carrier:township`, `carrier:township:live` | Exit 0, including real peer signed-impostor refusal |
| Shell `release:root-origination:contract`, `typecheck` | Exit 0; exact lower-level adversarial fixture retained |
| Both boundary apps' `mix sobelow --exit --skip` | Exit 0; `lattice_server` has no Phoenix router surface, so its runtime boundary tests provide the relevant refusal proof |

Logs are retained locally under `/tmp/lattice-r09-final-*` and the behavioral
RED logs under `/tmp/lattice-r09-*red.log`. No push, PR, hosted CI, deployment,
packaged application, physical device or pilot result is claimed by this packet.

### CRYPTO-01 — out-of-range lease crashes analyze

Decode accepts any non-negative integer (`apps/lattice_core/lib/lattice/carrier/wire.ex:324-331`):

```elixir
defp decode_expires_epoch(epoch) when is_integer(epoch) and epoch >= 0 do
  if epoch <= @max_json_safe_integer do
    {:ok, epoch}
  else
    {:ok, epoch}
  end
end
```

`@max_canonical_integer` already exists two lines above the decode section
(`wire.ex:15`: `@max_canonical_integer 18_446_744_073_709_551_615`) and is enforced for
`["int", binary]` decode at `wire.ex:216-221` — the lease arm was simply missed.

`Lattice.Canonical.encode/1` raises for such integers
(`apps/lattice_core/lib/lattice/canonical.ex:140-145`), and `Delegation.valid_sig?/1`
(`apps/lattice_core/lib/lattice/authority/delegation.ex:108-122`) calls the local
`encode/8` (`delegation.ex:148`) without any rescue:

```elixir
@spec valid_sig?(t()) :: boolean()
def valid_sig?(%__MODULE__{} = d) do
  encoding =
    encode(d.replica, d.issuer, d.audience, d.parent_id, d.ops, d.roles, d.live, d.expires_epoch)

  hash(encoding) == d.id and Identity.verify(d.issuer, encoding, d.sig)
end
```

`analyze` → `collect_delegation_intro` (`authority.ex:348-354`) calls `valid_sig?/1`, so one
patched grant op in a pulled log crashes the caller.

### WIRE-01 — unbounded decode recursion

`decode_term/1` → `reduce_decode/1` (lists/tuples) → `decode_map/1` recurse with no depth limit
(`wire.ex:231-265`). Encoded delegations are flat (`decode_delegation/1`, `wire.ex:282-316`),
so the recursion is only reachable through generic body/cap terms — exactly what an attacker
controls.

### CRYPTO-02 — `#root:` marker confusion

```elixir
# apps/lattice_core/lib/lattice/authority.ex:15
@root_marker "#root:"

# :87-93
@spec bind_replica(String.t(), Identity.pubkey()) :: String.t()
def bind_replica(name, root_pub) when is_binary(name) and is_binary(root_pub) do
  case replica_commitment(name) do
    nil -> name <> @root_marker <> root_tag(root_pub)
    _already_bound -> name
  end
end

# :96-101
def replica_commitment(replica) when is_binary(replica) do
  case String.split(replica, @root_marker, parts: 2) do
    [_name, tag] when byte_size(tag) > 0 -> tag
    _ -> nil
  end
end
```

`root_tag/1` is `authority.ex:137-139`: sha256 → `Base.url_encode64(padding: false)` —
always exactly 43 chars of `[A-Za-z0-9_-]`. `replica_commitment/1` validates nothing about
the tag. Also `verify_chain`'s genesis-binding check (`authority.ex:177-181`) only runs
`when is_binary(commitment)`, and `root_claimed?/1` (`authority.ex:73-81`) splits on
`"#root:"` too — so `"town#root:attacker"` is *claimed-looking* to `replica_commitment`
(commitment = `"attacker"`) while `root_claimed?` is false, and `bind_replica` will happily
double-append the marker.

### CRYPTO-03 — op kind allowlist missing

`apps/lattice_core/lib/lattice/op.ex:34-35` declares the type as four atoms
(`:command | :authority | :inbox | :tombstone`) but `:55-57` guards only
`is_atom(kind)`; `Wire.decode_op/1` (`wire.ex:52`) converts via `existing_atom/1` with no
allowlist. `Log.accept/2` verifies id+sig only — the kind never gets validated anywhere.

## Proposed approach

Four independent fixes, each landed RED→GREEN with its own adversarial test. None changes
any honest-path outcome; where a fix can flip an existing Sim-exported vector, regenerate
the corpus and treat every flip as requiring an adversarial justification (plan 161 protocol).

1. **Lease range (CRYPTO-01).** Cap `decode_expires_epoch` at `@max_canonical_integer`
   (`{:error, :malformed_term}` above it), and wrap `Delegation.valid_sig?/1`'s
   encode+verify in `try/rescue ArgumentError -> false` (fail-closed for in-VM-constructed
   delegations too, e.g. via `Sim.transfer(..., expires_epoch: 2**64)`).
2. **Decode depth budget (WIRE-01).** Add `@max_decode_depth 64` and thread a remaining-depth
   counter through `decode_term`/`reduce_decode`/`decode_map`; entering a composite
   (list/tuple/map/mapset/kv/op-shell) decrements it, and exhausting it returns
   `{:error, :malformed_term}`. Honest op bodies nest ≤ ~10 levels; 64 is generous headroom.
3. **Replica marker (CRYPTO-02).** `bind_replica/2` raises `ArgumentError` when the name
   contains `@root_marker`. `replica_commitment/1` returns the tag only when it matches
   `\A[A-Za-z0-9_-]{43}\z` (the exact `root_tag/1` shape), else `nil` — an invalid tag then
   falls into the existing *unbound legacy replica* path instead of an attacker-chosen
   commitment. Residual risk (a name embedding a *valid-shaped* attacker tag still
   self-binds, and nothing stops such ops entering a raw log) is documented in Maintenance —
   the durable ingest-side pin is TS plan 163 territory.
4. **Kind allowlist (CRYPTO-03).** `Op.new/6` guards `kind in [:command, :authority, :inbox, :tombstone]`;
   `Wire.decode_op/1` rejects any other decoded kind with `{:error, :malformed_op}`.

## Conventions to follow

- Fail-closed with stable reason atoms, matching the existing `reject/4` + audit-trail
  pattern in `authority.ex`; never raise from `analyze/1`'s reach. This plan introduces no
  new reason atoms.
- TDD with the existing adversarial style: see
  `apps/lattice_core/test/lattice2/delegation_lease_test.exs`,
  `apps/lattice_core/test/lattice2/root_binding_test.exs`,
  `apps/lattice_core/test/lattice2/authority_test.exs`, and
  `apps/lattice_core/test/lattice2/carrier_wire_test.exs` for shape.
- `mix format`-clean; v2 modules carry `@moduledoc` and `@spec`.
- Vector workflow when analyze/decode behavior changes:
  `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors`
  then `cd clients/lattice-client && npm run conformance` — every diff needs a written
  adversarial justification in the PR description (plan 161 protocol).

## Dependency graph

```
plan 161 (vector hygiene) ── recommended workflow companion ──► plan 176 (this)
```

(An earlier draft of this plan, numbered 168, also claimed numbers 169/170 for follow-up
work; those numbers belong to `169-carrier-control-frames-carry-no-authority.md` and
`170-redact-private-keys-from-inspect-and-crash-reports.md`, and the claim is withdrawn.)

## Steps

### Step 1 — lease range (CRYPTO-01)

RED: add to `apps/lattice_core/test/lattice2/delegation_lease_test.exs`:
a leased grant signed correctly, then the grant op's body patched to `expires_epoch = 2**64`
(sig now invalid), appended to a log — assert `Lattice.state/2` (or `Log.append/2` + reduce)
completes and the delegation is quarantined `:bad_delegation_sig`, not raised. Add to
`carrier_wire_test.exs`: a `decode_ops` frame whose delegation map has
`"expires_epoch" => 2**64` asserts `{:error, :malformed_op}`.

GREEN:
- `wire.ex` `decode_expires_epoch/1`: upper-bound the guard —
  `when is_integer(epoch) and epoch >= 0 and epoch <= @max_canonical_integer`, plus an
  explicit out-of-range clause returning `{:error, :malformed_term}`. Re-read the whole
  function before editing; the current double-branch body collapses into the guard.
- `delegation.ex` `valid_sig?/1`: wrap the body in `try ... rescue ArgumentError -> false`.

Verify: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/delegation_lease_test.exs apps/lattice_core/test/lattice2/carrier_wire_test.exs`

### Step 2 — decode depth budget (WIRE-01)

> Tick validation (AUTHZ-02) was Step 2 in the 168-numbered draft of this plan; it is now
> owned by `plans/162-authority-root-binding.md` step 2b(e).

RED: add to `carrier_wire_test.exs`: a body term nested 1 000 levels deep
(`["list", ["list", ...]]`) asserts `{:error, :malformed_op}`; a legitimate nested op
(≈8 levels, e.g. a command with a cap term) still round-trips.

GREEN: `@max_decode_depth 64`; `decode_term/1` becomes `decode_term(term, depth \\ @max_decode_depth)`;
composite arms (`"list"`, `"tuple"`, `"map"`, `"mapset"`, `"kv"`, `"op"`) decrement before
recursing into `reduce_decode`/`decode_map`; when `depth <= 0` and the term is composite,
return `{:error, :malformed_term}`. `reduce_decode/1` and `decode_map/1` take and pass the
counter. Scalars decode at any depth.

Verify: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_wire_test.exs apps/lattice_core/test/lattice2/carrier_session_test.exs` then full `mix verify`.

### Step 3 — replica marker (CRYPTO-02)

RED: add to `root_binding_test.exs`:
- `assert_raise ArgumentError, fn -> Authority.bind_replica("town#root:x", root_pub) end`.
- `Authority.replica_commitment("town#root:attacker") == nil` and
  `replica_commitment("town#root:short") == nil`.
- valid-shaped bound name still yields its 43-char tag (existing tests cover the happy path).

GREEN:
- `bind_replica/2`: raise `ArgumentError` (message naming the marker) when
  `String.contains?(name, @root_marker)`.
- `replica_commitment/1`: after splitting, return the tag only when
  `Regex.match?(~r/\A[A-Za-z0-9_-]{43}\z/, tag)`.

Before editing, grep all `bind_replica(` callers (`apps/`, `clients/` docs excluded) — if any
caller passes an already-bound name (relying on double-append), STOP (see below).

Verify: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/root_binding_test.exs` then `mix verify`
(`replica_commitment` feeds `deleg_context` — run the full suite to catch any fixture that
uses a short fake tag; if fixtures break, fix the fixtures to use `Authority.bind_replica/2`).

### Step 4 — op kind allowlist (CRYPTO-03)

RED: add to `carrier_wire_test.exs`:
- `Op.new/6` with `kind: :witness` raises (`FunctionClauseError` or `ArgumentError`).
- a wire frame with `"kind" => "witness"` decodes to `{:error, :malformed_op}`.

GREEN:
- `op.ex`: guard `new/6` with `kind in [:command, :authority, :inbox, :tombstone]`
  (drop the bare `is_atom(kind)` guard or keep it alongside — the `in` list subsumes it).
- `wire.ex`: add `@op_kinds [:command, :authority, :inbox, :tombstone]` and a
  `true <- kind in @op_kinds` step in `decode_op`'s `with` chain after `existing_atom/1`.

Verify: `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_wire_test.exs` then full `mix verify`.

## Verification

| Command | Expected |
| --- | --- |
| `~/.asdf/shims/mix format --check-formatted` | no output, exit 0 |
| `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/` | all green incl. new adversarial tests |
| `~/.asdf/shims/mix verify` | format clean + full suite green |
| `~/.asdf/shims/mix credo --strict` | no new issues |
| `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors` | regenerates cleanly |
| `cd clients/lattice-client && npm run conformance && npm run canonical && npm run v01:guard` | all green; any vector diff is documented & adversarial-justified |

## Hard boundaries

- Do **not** change `Lattice.Canonical` encoding bytes (v2/v3 wire formats are frozen).
- Do **not** change plan-149 lease *semantics* (lapse rule, beacon authority, chain rule) —
  only the decode range and the rescue.
- Do **not** touch the TS client — codec/decode parity work is plans 163/172.
- Do **not** touch `Township.Election*`, `Lattice.Attestation.*`, or any M4 surface.
- Do **not** add server-side rate limiting, frame-size caps, or auth hardening — that is the
  separate boundary-sweep cluster (not planned in this round).
- Do not touch heartbeat/transfer tick handling at all, including the `nil`-tick skip
  semantics — tick validation left this plan with AUTHZ-02 and is plan 162 step 2b(e) territory.

## Test plan

New tests only in existing files listed per step (no new test files). Each new test must be
run RED first against the unpatched code. Existing suites that must stay green:
`succession_*`, `witnessed_succession_*`, `delegation_lease_test`, `lease_lapse_test`,
`root_binding_test`, `carrier_wire_test`, `unified_chain_test`, plus the full `mix verify`
loop and the TS conformance trio after vector regeneration.

## Maintenance notes

- The `#root:` fix is API-side only: a replica name embedding a *valid-shaped* 43-char tag
  still self-binds if such ops reach a raw log without `bind_replica`. The ingest-side pin
  (root/signer allowlists at app and TS boundaries) belongs to plan 163 / the Township app
  layer; the TS mirror of this pattern lives at
  `clients/lattice-client/src/township.ts:245-257` (`townshipReplicaRootCommitment`) and
  should gain the same 43-char shape check when plan 163 lands.
- The depth budget guards decode only; `Canonical.encode/1` and `Canonical.signable?/1` still
  recurse unboundedly over in-VM-constructed terms. Local callers are trusted code; revisit
  if untrusted terms ever bypass `Wire.decode_term/1`.
- `Op.new/6`'s guard change means dynamically computed kinds now fail at construction —
  intentional; check any metaprogramming call sites in tests if they break.
- The kind allowlist covers wire decoding and `Op.new/6`; `Log.restore` and direct
  in-VM `%Op{}` construction can still admit non-contract kinds because `Log.accept`
  validates ID/signature integrity. Closing that residual would require a separately
  reviewed broader contract; it is not claimed by this packet.

## STOP conditions

- A Sim-exported vector flips outcome/reason after any step and you cannot write the
  adversarial justification — STOP and report the diff before proceeding.
- Any legitimate op in the corpus or apps nests deeper than 64 levels — STOP; the cap choice
  needs a maintainer decision rather than silent rejection. (`@max_decode_depth` is 64;
  legitimate terms through that depth must be accepted, and composite terms beyond it return
  `{:error, :malformed_term}`.)
- A `bind_replica/2` caller passes an already-bound name (depends on double-append), or a
  test fixture relies on a short fake commitment tag in a way that can't move to
  `Authority.bind_replica/2` — STOP and report.

## Done criteria

- All four fixes landed with RED→GREEN adversarial tests; `mix verify` + `mix credo --strict`
  green; vector corpus regenerated; TS `conformance`/`canonical`/`v01:guard` green with zero
  or fully-justified diffs; `docs/` untouched except where a reason dictionary is updated.

## Drift check

- Planned against commit: `91bb6ca6`
- Key files: `apps/lattice_core/lib/lattice/carrier/wire.ex`,
  `apps/lattice_core/lib/lattice/authority/delegation.ex`,
  `apps/lattice_core/lib/lattice/authority.ex`,
  `apps/lattice_core/lib/lattice/op.ex`
- Re-verify before executing: HEAD still `91bb6ca6` (or re-read the cited regions);
  `plans/162` (also rewrites `authority.ex` regions, and owns the AUTHZ-02 tick guard via its
  step 2b(e)) has not landed — if it has, re-read `analyze`/`bind_replica` before editing.

### Accepted-base integration evidence — 2026-09-06

The earlier local snapshot above remains evidence for its frozen revision. Final
R08 review fixes were merged at `515744dc`, then accepted main through R08 merge
`9bb7b340e49be605151458134391aa16e642fc29` was integrated at
`3f17f4cc99020eca0a36aedfd07d5d4a5afd93db`. No conflicts or new R09 production
semantics were introduced by the accepted-main merge; its restored-log consumers
match that accepted source. The standalone R09 diff remains the adopted 19 paths.

At that exact integration source, `mix check` under asdf/OTP28 with
`ERL_FLAGS='+S 4:4'` passed **726 tests + 27 properties**, zero failures and three
existing exclusions. Strict Credo and formatting exited zero. The separate R08
integration focused gate passed 13 tests (4 + 1 + 8 across three suites); accepted-main restore/lifecycle probes
passed 21. TypeScript typecheck, canonical, conformance, Township authoring and
normal build also passed, leaving generated source unchanged. Logs are in
`/tmp/lattice-treehouse-execution-20260906/r09-accepted-main-*` and
`r09-final-r08-integration-focused.log`; the TS command stream is retained in
execution session 52558.

Fable's implementation/comment follow-ups remain PASS at their exact recorded
revisions. Accepted-base integration review and final hosted checks are pending;
Claude's unfinished session-limit review is not approval. R08's own exact merge
workflow must pass before dependent closure. The shared engine integration also
preserves R03's witnessed three-field branch before this plan's legacy arity guard;
that combined engine has separate review/evidence and is not part of this PR's
standalone R09 production diff. No native, device or pilot result is implied.
