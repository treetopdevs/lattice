# Agent Guide

Read this before running anything. It covers the one local footgun (the toolchain), how
to verify the repo is healthy, where things live, and which commands are safe to run.

## Toolchain (read first)

**Invoke mix and elixir as `~/.asdf/shims/mix` and `~/.asdf/shims/elixir`.** On this
machine, `mix` on `PATH` resolves to a **broken mise shim**: mise's global config pins
Erlang 27 (the project needs OTP 28), and its asdf-plugin-backed `mix` shim leaks flags
like `-noshell`/`--version` into `mise exec` and errors out. The full analysis and the
scoped fix (`disable_tools = ["erlang", "elixir"]`) live in `.mise.toml` at the primary
checkout root — note that file is untracked and machine-local, so fresh clones and git
worktrees do not carry it; the asdf-shim rule is the reliable invocation everywhere.

- **Required versions**: Erlang/OTP 28, Elixir 1.19.5-otp-28 — provided by asdf via
  `~/.tool-versions` (erlang 28.3.1, elixir 1.19.5-otp-28).
- **Sanity check**: `~/.asdf/shims/mix --version` → `Mix 1.19.5 (compiled with Erlang/OTP 28)`.
- **CI is different**: GitHub Actions uses `erlef/setup-beam@v1`, so plain `mix` works
  there. The asdf rule is local-only.

## Verify the repo is healthy

```sh
~/.asdf/shims/mix verify                          # format --check-formatted + full test suite
~/.asdf/shims/mix check                           # verify + credo --strict
~/.asdf/shims/mix test                            # full suite only
~/.asdf/shims/mix run scripts/lattice2_demo.exs   # narrated Lattice 2.0 end-to-end demo
```

Sobelow is **per-app** (it targets each HTTP boundary app, not the umbrella), so it is not part of
`mix check`. Run it in both boundary apps:

```sh
cd apps/lattice_server && ~/.asdf/shims/mix sobelow --exit --skip
cd apps/township_web && ~/.asdf/shims/mix sobelow --exit --skip
```

All tests must pass and formatting must be clean before considering any change done.

## Layout

| Path | What it is |
|------|------------|
| `apps/lattice_core` | v1 capability plane (caps, gateway, topology, audit) + the Lattice 2.0 replica-on-op-log engine |
| `apps/lattice_web_socket` | Reusable WebSocket client and real carrier adapter; no listener or supervision tree |
| `apps/lattice_server` | Cowboy WebSocket/HTTP boundary over the shared JSON envelope codec |
| `apps/township_web` | Phoenix/LiveView read-only Township instrument with a Vue 3.5 causal-replay island over the verified bundle or optional pull-only carrier projection |
| `apps/lattice_demo` | Demo servers, tab workers, and the deterministic/browser demo mix tasks |
| `apps/lattice_stress` | Adversarial stress lab: races, WS abuse, load/soak, property tests, `mix lattice.stress` |
| `apps/lattice_carrier_spike` | Spike code for a real (non-simulated) carrier |
| `apps/lattice_node_spike` | Real second-process Cowboy peer fixtures and Township/Thread convergence scenarios |

## Where the docs are

- `docs/lattice2_design.md` — the Lattice 2.0 design (replicas on a capability-attested op log)
- `docs/adr/` — architecture decision records (canonical encoding, hash-DAG causality, quarantine, succession)
- `docs/threat_model_v2.md` — the v2 threat model
- `docs/path_to_real.md` — POC-to-real gap analysis
- `docs/lattice_poc_status.md` — requirement-by-requirement POC status
- `plans/` — the advisor plan index (self-contained improvement plans; read `plans/README.md` first)
- `CLAUDE.md` — working notes for the Township POC overlay (the application track on top of the 2.0 core)

## Safe vs. heavy commands

**Safe / local-only** (no network, no extra tooling):

- `~/.asdf/shims/mix compile`
- `~/.asdf/shims/mix test`
- `~/.asdf/shims/mix format`
- `~/.asdf/shims/mix run scripts/lattice2_demo.exs`
- `PHX_SERVER=true PORT=4100 ~/.asdf/shims/mix run --no-halt`

**Heavy / external dependencies** (need Node + Playwright, bind a port; run only when asked):

- `npm run browser:e2e`, `npm run browser:worker:e2e`, `npm run flagship:e2e`, `npm run e2e`
- `npm run township:instrument:e2e`, `npm run township:instrument:live-e2e`
- `scripts/lattice_poc_demo.sh`, `scripts/lattice_research_demo.sh`,
  `scripts/lattice_liveops_demo.sh`, `scripts/lattice_flagship_demo.sh` (the flagship
  one additionally needs ffmpeg for the recording evaluation)
- `mix lattice.stress` — a load harness, not a test; it hammers the local node

## Conventions

- All code is `mix format`-clean (`mix verify` enforces this).
- v2 (Lattice 2.0) modules carry `@moduledoc` and `@spec`.
- Tests live in `apps/*/test/`; the v2 engine tests are under
  `apps/lattice_core/test/lattice2/`, Township POC tests under
  `apps/lattice_core/test/township/`.
