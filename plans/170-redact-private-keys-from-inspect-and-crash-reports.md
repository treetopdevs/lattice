# Plan 170: Redact Ed25519 private keys from `inspect/1`, crash reports, and config dumps

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- apps/lattice_core/lib/lattice/identity.ex apps/township_web/lib/township_web/carrier_projection.ex
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Execution**: DONE — unified R05; reviewed source, PR60 tip and exact merge-result gates passed.
- **Priority**: P1 — a live Ed25519 signing key is written to plaintext logs by any crash in a
  process that holds one. Cheapest high-value fix in the current backlog.
- **Effort**: S — two small changes plus tests.
- **Risk**: LOW — diagnostic-only. The one real hazard is a test that asserts on inspected
  output; step 2 finds those before you change anything.
- **Depends on**: none.
- **Category**: security
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Why this matters

`Lattice.Identity` holds the private half of a realm's Ed25519 keypair in a plain struct field
with no `Inspect` protection. Anything that inspects a term containing an identity — a
`GenServer` crash report, `Logger` output, `:sys.get_status/1`, an `Application.get_all_env/1`
dump, an ExUnit failure diff — renders the raw private key bytes.

This is not hypothetical for one specific process. `TownshipWeb.CarrierProjection` stores
`connect_opts` in its `GenServer` state, and the carrier client *requires* that keyword list to
contain `:identity`. The projection implements no `format_status/2`, so any crash — an
unreachable peer, a malformed subscription, a downed worker, all reachable failure modes in
that module — emits the full state including the key. The same state is copied into a refresh
`Task` closure, so a crash there does it too.

The codebase already knows this matters and solved it twice, in the *other* app:
`LatticeCarrierServer.Holder` implements `format_status/1` specifically to redact the identity,
with a comment saying crash reports "must never render the private key", and
`LatticeCarrierServer.Secret` is an opaque wrapper with a custom `Inspect` implementation for
exactly this purpose. `township_web` holds the same class of secret and uses neither.

The right fix is at the root rather than per-consumer: make the struct itself unprintable, so
every present and future holder is protected by default.

**Scope of the exposure — be precise about this in any writeup.** The key at risk in
`CarrierProjection` is a *transport realm* key, not a participant's authoring key. Participant
key custody is genuinely correct: it lives in the Tauri Rust layer and never crosses the
`invoke` boundary. This plan is about a real secret in plaintext logs, not about a break in the
custody model.

## Current state

### The unprotected struct — `apps/lattice_core/lib/lattice/identity.ex:14-18`

```elixir
  @enforce_keys [:realm_id, :pub, :priv]
  defstruct [:realm_id, :pub, :priv]

  @type pubkey :: binary()
  @type t :: %__MODULE__{realm_id: String.t(), pub: pubkey(), priv: binary()}
```

No `@derive {Inspect, ...}`, no `defimpl Inspect`. `inspect(identity)` prints `priv` in full.

### The exposed holder — `apps/township_web/lib/township_web/carrier_projection.ex:63`

```elixir
            connect_opts: Keyword.fetch!(opts, :connect_opts),
```

`connect_opts` is required to carry `:identity` — see
`apps/lattice_web_socket/lib/lattice/carrier/web_socket.ex:345-350`, where `session_opts/1`
does `required_opt(opts, :identity)`. `grep -n "format_status" apps/township_web/lib/township_web/carrier_projection.ex`
returns nothing.

### The exemplar to copy — `apps/lattice_carrier_server/lib/lattice_carrier_server/holder.ex:96-107`

```elixir
  # Crash reports and `:sys.get_status/1` must never render the private key:
  # replace the identity's priv bytes in any formatted state.
  @impl GenServer
  def format_status(status) do
    Map.new(status, fn
      {:state, %{identity: %Identity{} = identity} = state} ->
        {:state, %{state | identity: %{identity | priv: :redacted}}}

      other ->
        other
    end)
  end
```

Note this is the **OTP 27+ single-argument `format_status/1`** callback, not the deprecated
`format_status/2`. Match this arity.

### Repo conventions to match

- All code is `mix format`-clean; `mix verify` enforces it.
- v2 modules carry `@moduledoc` and `@spec`.
- Elixir tests live under `apps/*/test/`; v2 engine tests under
  `apps/lattice_core/test/lattice2/`, `township_web` tests under
  `apps/township_web/test/township_web/`.

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
| Targeted | `$MIXCMD test apps/lattice_core/test/lattice2/` | all pass |

Baseline at the planned-at commit: `$MIXCMD test` exits 0.

## Scope

### Unified R05 execution amendment — 2026-09-06

The adopted unified roadmap authorizes one additional test-only change in
`apps/lattice_carrier_server/test/secret_test.exs`: replace the existing assertion that
inspected status includes `:redacted` with a structural assertion that the running Holder's
raw status identity has `priv: :redacted`. Retain the inspected private-key absence check
and assert that its public identity fields survive. The struct-level derive intentionally
omits `priv`, including the placeholder, so its rendered marker is no longer observable.
This amendment preserves the independent Holder status guarantee without modifying carrier
production code or weakening its existing redaction. All other carrier files remain excluded.

Projection verification uses `apps/township_web/test/`: the original app-root argument
`apps/township_web/` silently selected no tests in the umbrella runner.

**In scope**:

- `apps/lattice_core/lib/lattice/identity.ex` — the `@derive` attribute **and** the one-sentence
  `@moduledoc` extension recording the inspect-redaction (required by step 3)
- `apps/township_web/lib/township_web/carrier_projection.ex` — add `format_status/1` only
- `apps/lattice_core/test/lattice2/` — one new test file or an added case (see test plan)
- `apps/township_web/test/township_web/` — one added case
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- `apps/lattice_carrier_server/**` — already correct. Do not "unify" it onto the new derive;
  its `format_status/1` and `Secret` wrapper are defence in depth and should stay.
- `clients/township-tauri-shell/src-tauri/**` — participant key custody is correct and is a
  different mechanism entirely (the key never leaves Rust).
- **Any change to how keys are generated, stored, or loaded.** This plan changes *rendering*
  only. If you find yourself editing `Identity.generate/1`, `from_seed/2`, `sign/2`, or
  `verify/3`, STOP.
- `Lattice.Identity.fingerprint/1` — it deliberately renders a truncated **public** key and is
  the correct thing to log. Leave it.
- Log scrubbing, `Logger` filters, or telemetry redaction. Different mechanism, different plan.

## Git workflow

- Branch: `codex/170-redact-private-keys-from-inspect`
- Conventional commits matching `git log`, e.g.
  `test(identity): add RED private-key inspect regression`, then
  `fix(identity): redact priv from inspect and projection status`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing (RED) regression first

Create `apps/lattice_core/test/lattice2/identity_redaction_test.exs`:

```elixir
defmodule Lattice.IdentityRedactionTest do
  use ExUnit.Case, async: true

  alias Lattice.Identity

  test "inspecting an identity never renders private key bytes" do
    identity = Identity.from_seed("redaction", "identity-redaction-probe")
    rendered = inspect(identity)

    refute rendered =~ inspect(identity.priv),
           "inspect/1 must not render the private key"

    assert rendered =~ "redaction", "the realm id should still be visible for debugging"
  end

  test "an identity nested in a larger term is still redacted" do
    identity = Identity.from_seed("redaction", "identity-redaction-probe")
    rendered = inspect(%{connect_opts: [identity: identity, replica: "r"]})

    refute rendered =~ inspect(identity.priv)
  end
end
```

`refute rendered =~ inspect(identity.priv)` is the reliable assertion: it compares against the
same binary rendering `inspect/1` would produce, rather than guessing at the byte formatting.

**Verify**: `$MIXCMD test apps/lattice_core/test/lattice2/identity_redaction_test.exs`
→ **both tests FAIL**. If they pass, STOP — the defect is already fixed and this plan is stale.

### Step 2: Find every test that depends on the current rendering

Deriving `Inspect` changes output everywhere. Find what depends on it before you change it:

```bash
grep -rn "inspect(.*identity\|inspect(.*Identity" apps --include=*.exs | grep -v _build
grep -rn "priv:" apps --include=*.exs | grep -v _build | head -20
```

Record the hits. Most will be unrelated (`priv:` also appears in Mix path config). Any test
asserting on a full inspected identity must be updated in step 3 — and each one is worth
reporting, because it is a place a key was already being rendered.

**Verify**: you have recorded the output. No files changed yet.

### Step 3: Redact the struct at the root

In `apps/lattice_core/lib/lattice/identity.ex`, add the derive immediately above
`@enforce_keys`:

```elixir
  # A realm's private key must never reach a log, a crash report, an ExUnit diff, or a
  # config dump. Deriving Inspect here protects every holder of the struct by default;
  # `LatticeCarrierServer.Holder.format_status/1` and `LatticeCarrierServer.Secret` are
  # the belt-and-braces equivalents on the carrier server's own path.
  @derive {Inspect, except: [:priv]}
  @enforce_keys [:realm_id, :pub, :priv]
  defstruct [:realm_id, :pub, :priv]
```

Also extend the `@moduledoc` with one sentence recording that the struct is inspect-redacted
and that `priv` is reachable only by direct field access — the module's docs currently describe
the key material without mentioning its handling.

Update any test found in step 2 that asserted on the old rendering.

**Verify**: `$MIXCMD test apps/lattice_core/test/lattice2/identity_redaction_test.exs` → both
pass. Then `$MIXCMD test` → exit 0 with no new failures.

### Step 4: Redact the projection's GenServer status

`@derive Inspect` covers `inspect/1`, which is what `Logger` and crash reports use. It does
**not** cover `:sys.get_status/1`, which returns raw terms. Add the same protection
`LatticeCarrierServer.Holder` has.

In `apps/township_web/lib/township_web/carrier_projection.ex`, add a `format_status/1`
callback modeled on the holder's, redacting the identity inside `connect_opts`. The shape
differs — the identity is nested in a keyword list rather than a top-level state key — so
adapt rather than copy verbatim:

```elixir
  # Crash reports and `:sys.get_status/1` must never render the private key.
  @impl GenServer
  def format_status(status) do
    Map.new(status, fn
      {:state, %{connect_opts: connect_opts} = state} when is_list(connect_opts) ->
        {:state, %{state | connect_opts: redact_identity(connect_opts)}}

      other ->
        other
    end)
  end

  defp redact_identity(connect_opts) do
    case Keyword.fetch(connect_opts, :identity) do
      {:ok, %Lattice.Identity{} = identity} ->
        Keyword.put(connect_opts, :identity, %{identity | priv: :redacted})

      _other ->
        connect_opts
    end
  end
```

Read the module first to confirm the state is a map with a `:connect_opts` key and to place
the callback with the other `@impl GenServer` functions.

**Verify**: `$MIXCMD test apps/township_web/test/` → exit 0.

### Step 5: Prove the projection redaction with a test

Add a case to the existing `township_web` projection test file (find it with
`ls apps/township_web/test/township_web/`; if there is no projection test file, create
`carrier_projection_redaction_test.exs` following the conventions of its neighbours).

Start a projection with a real identity, call `:sys.get_status(pid)`, and assert the rendered
status does not contain `inspect(identity.priv)`. If starting a full projection needs a live
carrier peer, call `TownshipWeb.CarrierProjection.format_status/1` directly with a synthetic
status map instead — a direct unit test of the callback is sufficient and much cheaper.

**Verify**: `$MIXCMD test apps/township_web/test/` → exit 0 with the new case passing.

### Step 6: Full green

```bash
$MIXCMD format --check-formatted && $MIXCMD test && $MIXCMD credo --strict
```

**Verify**: all three exit 0.

## Test plan

1. `apps/lattice_core/test/lattice2/identity_redaction_test.exs` — `inspect/1` on a bare
   identity does not render `priv`; the realm id remains visible.
2. Same file — an identity nested inside a map/keyword structure is still redacted (this is the
   shape that actually appears in crash reports).
3. `apps/township_web/test/township_web/` — `CarrierProjection.format_status/1` redacts the
   identity inside `connect_opts`.

Verification: `$MIXCMD test` → exit 0 with 3 new tests passing.

## Verified closure — 2026-09-06

The planned-at diagnosis, source excerpts, RED instructions and STOP conditions are retained
as execution history. The checklist records verification of the original R05 packet, not a demand
to reproduce RED against the now-fixed source or to keep this later documentation worktree clean.
The source-scope criterion includes the explicitly adopted `secret_test.exs` amendment above.

- Reviewed source: `4c88f41ec7757158a8fce94b44194debf87c22a7`, [PR60](https://github.com/treetopdevs/lattice/pull/60).
  Actual Claude Fable passed the original repair and its final post-refresh regression.
- Local `mix check`: **666 tests + 27 properties, zero failures**, three existing exclusions;
  formatting and strict Credo passed. Final focused checks passed **58/58**. Tests cover bare and
  nested inspection, raw projection status before and after refresh, unchanged live identity,
  and the independent Holder redaction guarantee.
- Exact source-tip [workflow 34036748317](https://github.com/treetopdevs/lattice/actions/runs/34036748317)
  passed at that SHA. Merge `2f83cc1ea5fdd2fdd5a4a7500b467cebaf392c1a` passed its own
  [workflow 34038896331](https://github.com/treetopdevs/lattice/actions/runs/34038896331).
- Reconciliation rechecked the `Inspect` derive, redaction moduledoc and projection
  `format_status/1` in the current tree, the original packet's changed-file scope, and the
  shared [plan index](README.md), which records Plan170 DONE. These are read-only checks;
  no new runtime or custody claim is added.

## Done criteria

Machine-checkable. ALL must hold:

- [x] `$MIXCMD format --check-formatted` exits 0
- [x] `$MIXCMD test` exits 0, 0 failures
- [x] `$MIXCMD credo --strict` exits 0
- [x] `grep -n "@derive {Inspect, except: \[:priv\]}" apps/lattice_core/lib/lattice/identity.ex` returns a match
- [x] `grep -n "inspect-redacted\|redacted" apps/lattice_core/lib/lattice/identity.ex` returns a match in the `@moduledoc` (step 3's documentation requirement)
- [x] `grep -n "format_status" apps/township_web/lib/township_web/carrier_projection.ex` returns a match
- [x] The 3 tests named in the test plan exist and pass
- [x] `git status --porcelain` lists no file outside the in-scope list
- [x] `plans/README.md` status row for 170 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The step-1 tests pass before you add the derive — already fixed, plan is stale.
- Step 2 finds a test that asserts on a **rendered private key** as its expected value. That is
  a second finding (a key in a committed fixture); report it rather than quietly updating the
  expectation.
- Adding `@derive {Inspect, except: [:priv]}` breaks something other than an inspect
  expectation — e.g. code that pattern-matched on inspected output, or a serializer that used
  `inspect/1` as an encoder. That would mean `inspect/1` output is load-bearing somewhere,
  which is a design problem worth reporting.
- You discover another struct in the tree that holds private key material without redaction
  (search: `grep -rn "priv\b" apps/*/lib --include=*.ex | grep -i "defstruct\|@type t" `).
  Report it; do not expand scope.

## Maintenance notes

For the human or agent who owns this next:

- **What a reviewer should scrutinize**: that `@derive {Inspect, except: [:priv]}` is on the
  struct and not merely on one consumer. The value of this fix is that it is default-safe — a
  future module that holds an identity inherits the protection without knowing it needs to.
- **The residual gap this does not close**: `scripts/township_live_instrument_server.exs:19-31`
  puts `connect_opts` — identity included — into the application environment via
  `Application.put_env/3`. `@derive Inspect` protects `Application.get_all_env/1` output when it
  is *inspected*, but the key is still a live term reachable by any process in the VM. That is
  a script-level design issue (the dev instrument server), not a library one, and is
  deliberately out of scope here. Worth its own look if that script ever runs outside dev.
- **Interacting future work**: if a `Lattice.Identity.Secret`-style opaque wrapper is ever
  introduced (mirroring `LatticeCarrierServer.Secret`), this derive becomes redundant but
  harmless — keep it as the default-safe floor.
- **Rotation**: if any captured log or crash dump from a deployed instrument is known to
  contain a rendered identity, the affected transport realm key should be rotated. There is no
  evidence in the repo either way; treat it as an operational question for whoever runs an
  instrument, not a code change.
