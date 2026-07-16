# Plan 018: Add structured logging + telemetry to the real carrier (connect / auth / sync)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise. When
> done, update the status row in `plans/README.md`.
>
> **Toolchain**: run mix locally as `~/.asdf/shims/mix` (the `mix` on `PATH` is a
> broken mise shim — see `AGENTS.md`). CI uses plain `mix`.
>
> **Drift check (run first)**:
> `git diff --stat 6b2cfe5..HEAD -- apps/lattice_core/lib/lattice/carrier.ex apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex`
> If any changed since this plan was written, re-read the "Current state"
> excerpts before proceeding; on a material mismatch, STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW–MED (must not perturb the deterministic byte-identity tests)
- **Depends on**: none (naturally paired with 017 — multi-node runs are where this pays off)
- **Category**: dx
- **Planned at**: commit `6b2cfe5`, 2026-07-07

## Why this matters

The M2 carrier now runs across two OS processes over real sockets, but it emits
**nothing** observable: there is no `Logger` call and no `:telemetry` event
anywhere in `apps/lattice_core/lib/lattice/carrier/**`,
`apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex`, or its
`ws_handler.ex`. When a connection fails auth, a peer disconnects, or a sync
transfers an unexpected count, an operator has no signal — debugging means adding
ad-hoc `IO.inspect` and re-running. This finding was deferred in a prior audit
("revisit before longer-running multi-node demos"); the real carrier now exists,
so it is actionable. Adding a small, well-named telemetry surface (with `Logger`
attached to those events) makes multi-node runs and the plan-017 G1 harness
debuggable, and gives CI/soak harnesses something to assert on — without changing
any sync semantics.

## Current state

- `apps/lattice_core/lib/lattice/carrier.ex` — the transport-independent `sync/4`
  driver (lines 88–106). It composes `advertise` → `push` → `pull` → `Sync.deliver`
  and returns `stats` (`sent`, `received`, `pushed`, `pulled`). **No logging or
  telemetry.** This is the single choke point where every sync — over any carrier
  — passes through, so it is the natural place for one telemetry span.
- `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex` —
  `connect/1` (line 30) and `authenticate/2` (line 154): connection setup and the
  signed challenge/response. No logging on success/failure.
- `apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex` —
  `handle_challenge/2` (line 60) emits `{:error, reason}` on auth failure but logs
  nothing; `terminate/3` (line 52) is the disconnect/partition signal and is
  silent; `authenticated_msg/3` rejects pre-auth messages silently (line 78).

Convention check: `Logger` is already an `extra_application` in the relevant apps
(`grep -n extra_applications apps/lattice_node_spike/mix.exs apps/lattice_core/mix.exs`),
so no manifest change is needed. `:telemetry` is a well-known BEAM library; verify
whether it is already available transitively (`grep -n telemetry mix.lock`). If
`:telemetry` is **not** already in the dependency tree, prefer a plain `Logger`
implementation (Step 2 alternative) rather than adding a new dependency for a
POC — do not add `:telemetry` to the manifest without checking with the operator.

## Commands you will need

| Purpose            | Command                                                                          | Expected            |
|--------------------|----------------------------------------------------------------------------------|---------------------|
| Compile            | `~/.asdf/shims/mix compile`                                                       | exit 0              |
| Dep check          | `grep -n "telemetry" mix.lock`                                                    | present or absent   |
| Node-spike tests   | `~/.asdf/shims/mix test apps/lattice_node_spike/`                                 | all pass            |
| Carrier tests      | `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_test.exs`         | all pass            |
| Format             | `~/.asdf/shims/mix format --check-formatted`                                      | exit 0              |
| Full gate          | `~/.asdf/shims/mix verify`                                                        | format ok + all pass|

## Scope

**In scope**:
- `apps/lattice_core/lib/lattice/carrier.ex` — emit one telemetry event (or a
  `Logger.debug`) per completed `sync/4` with `%{sent, received}` measurements.
- `apps/lattice_node_spike/lib/lattice_node_spike/ws_carrier.ex` — log
  connect success and auth outcome.
- `apps/lattice_node_spike/lib/lattice_node_spike/ws_handler.ex` — log auth
  failure (with reason), disconnect/partition (`terminate/3`), and pre-auth
  rejection.
- Optionally a new test `apps/lattice_node_spike/test/carrier_telemetry_test.exs`
  (only if you implement telemetry events — attach a handler and assert emission).

**Out of scope** (do NOT touch):
- The sync/reconciliation *logic* in `carrier.ex` and `Lattice.Sync` — add
  observation only; the returned values and control flow must be byte-for-byte
  identical.
- `Lattice.Canonical`, `Lattice.Carrier.Wire/Batch/Session` — no logging inside
  the hot encode/verify path (it would spam and could perturb timing-sensitive
  tests).
- Any change that writes to stdout in a way the existing tests parse — see the
  warning below.

## Git workflow

- Branch: `advisor/018-carrier-observability`
- Commit: `feat(carrier): add telemetry + logging on connect/auth/sync`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Check telemetry availability and pick the mechanism

Run `grep -n "telemetry" mix.lock`. If `:telemetry` is present in the tree, use
`:telemetry.execute/3` events (Step 2). If absent, use `Logger` only (Step 2
alternative) and do **not** add a dependency. Record which path you took in the
commit message.

**Verify**: `~/.asdf/shims/mix compile` → exit 0.

### Step 2: Instrument the carrier

**If telemetry is available**, emit these events (metadata keys illustrative —
keep them small and non-sensitive; never log op bodies, signatures, or keys):

- `[:lattice, :carrier, :sync, :stop]` from `carrier.ex` `sync/4` on success —
  measurements `%{sent: length(to_push), received: length(pulled)}`, metadata
  `%{carrier: carrier}`.
- `[:lattice, :carrier, :connect]` from `ws_carrier.ex` after a successful
  `authenticate/2` — metadata `%{realm: session.realm, peer_realm: session.peer_realm}`.
- `[:lattice, :carrier, :auth_failure]` from `ws_handler.ex` `handle_challenge/2`
  on the `{:error, reason}` arm — metadata `%{reason: reason}`.
- `[:lattice, :carrier, :disconnect]` from `ws_handler.ex` `terminate/3` when the
  socket was authenticated — metadata `%{realm: ...}` if available.

Attach a default `Logger` handler for these in the node-spike app start (or a
small module) so they surface as logs by default.

**Alternative if telemetry is absent** — same four moments, but as direct
`Logger` calls: `require Logger` at the top of each module, then
`Logger.info("carrier sync sent=#{s} received=#{r}")`, `Logger.info("carrier connected realm=...")`,
`Logger.warning("carrier auth failed reason=#{reason}")`,
`Logger.debug("carrier disconnected")`. Use `:info` for connect/sync, `:warning`
for auth failure, `:debug` for disconnect.

**CRITICAL — do not break the peer handshake**: `apps/lattice_node_spike/priv/peer_node.exs`
prints `PEER_READY <port>` to **stdout** and the GATE test parses stdout to learn
the port. `Logger` writes to stderr by default (safe), but confirm you are not
adding any `IO.puts`/stdout writes in the peer process path. Keep log level such
that the default test run is not flooded (prefer `:debug` for per-sync noise, or
gate sync logging behind telemetry only).

**Verify**: `~/.asdf/shims/mix compile` → exit 0, no warnings.

### Step 3: Confirm the byte-identity GATE and carrier tests are unaffected

The whole risk is perturbing deterministic tests. Run:

**Verify**:
- `~/.asdf/shims/mix test apps/lattice_node_spike/` → all pass (the `PEER_READY`
  stdout parsing and byte-identity assertions must be untouched).
- `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_test.exs` → all pass.

### Step 4: (If telemetry) add an emission test

If you implemented telemetry events, add
`apps/lattice_node_spike/test/carrier_telemetry_test.exs` that attaches a handler
via `:telemetry.attach/4`, runs a sync (over `SimNet` is fine — no real socket
needed to test emission), and asserts the `[:lattice, :carrier, :sync, :stop]`
event fires with `sent`/`received` measurements. Detach in an `on_exit`. If you
went the `Logger`-only route, skip this step (asserting on log output is brittle;
note the choice in your report instead).

**Verify**: `~/.asdf/shims/mix test apps/lattice_node_spike/test/carrier_telemetry_test.exs` → passes.

### Step 5: Full gate

**Verify**: `~/.asdf/shims/mix verify` → format clean + entire suite passes.
Update `plans/README.md` status row for 018.

## Test plan

- If telemetry: one new test (`carrier_telemetry_test.exs`) asserting the sync
  event fires with correct measurements, over `SimNet` (no socket needed).
- Regression guard: `apps/lattice_node_spike/` suite (byte-identity + `PEER_READY`
  parsing) must remain green — that is the proof observation did not change
  behavior.
- Verification: new test passes; node-spike + carrier suites stay green.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `~/.asdf/shims/mix compile` exits 0, no new warnings.
- [ ] `grep -rn "Logger\.\|:telemetry.execute" apps/lattice_node_spike/lib apps/lattice_core/lib/lattice/carrier.ex`
      shows instrumentation at connect, auth-failure, disconnect, and sync.
- [ ] `~/.asdf/shims/mix test apps/lattice_node_spike/` exits 0.
- [ ] `~/.asdf/shims/mix test apps/lattice_core/test/lattice2/carrier_test.exs` exits 0.
- [ ] No new runtime dependency was added to any `mix.exs` unless the operator
      approved it (`git diff -- '**/mix.exs' 'mix.lock'` shows no dep additions,
      or only ones you were told to add).
- [ ] `~/.asdf/shims/mix verify` exits 0.
- [ ] `plans/README.md` status row for 018 updated.

## STOP conditions

Stop and report back if:

- Any `apps/lattice_node_spike/` test fails — especially anything about
  `PEER_READY` or byte-identity; that means your instrumentation changed
  observable behavior. Revert the offending log/emit and report.
- Implementing telemetry would require adding `:telemetry` (or any library) to a
  `mix.exs` — STOP and ask; use the `Logger`-only path instead unless approved.
- You find you need to log inside `Lattice.Canonical` / `Wire` / `Batch` /
  `Session` to get useful signal — that is out of scope (hot path); report what
  signal is missing rather than instrumenting the encoder.

## Maintenance notes

- Event names are a small public surface: once a soak/CI harness attaches to
  `[:lattice, :carrier, :sync, :stop]`, renaming it is a breaking change. A
  reviewer should sanity-check the names before merge.
- Never add op bodies, signatures, identities, or session nonces to log/telemetry
  metadata — that would leak the exact material the canonical/signature design
  protects. Metadata is counts and realm ids only.
- If plan 017 (Township over the real carrier) lands, its GATE test is a good
  consumer of the sync telemetry for asserting transfer counts.
