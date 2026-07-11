# Lattice

Lattice is a greenfield proof of concept for a least-authority process plane on the BEAM. It treats server BEAM processes and browser tab realms as participants in one OTP-shaped topology, while forcing every cross-realm operation through explicit, revocable capabilities.

The core thesis is simple: a tab gets zero implicit authority. It cannot use raw node membership, raw pids, registered names, RPC, or cookie possession as authorization. A tab can only use a capability issued to that tab, for a specific target and operation, while the gateway enforces ownership, expiry, revocation, use limits, topology rules, and audit logging.

## What This POC Proves

- A runnable umbrella project with `lattice_core`, `lattice_server`, and `lattice_demo`.
- Explicit grants, denies, revocation, TTL/expiry, use limits, and per-tab isolation.
- Macaroon-style attenuated capabilities with caveats, delegation provenance,
  runtime typed/session checks, and parent-child revocation semantics.
- A process graph as trust graph snapshot/inspector with JSON, DOT, and
  Mermaid exports.
- A browser-visible flagship demo where wallet consent creates one caveated
  authority edge, allowed purchase traffic reaches the wallet process, and
  over-budget, wrong-vendor, stolen-cap, and replay-after-revoke attempts are
  denied with live graph and audit evidence.
- Executable research demos for wallet-as-process, capability-gated agent tool
  use, consent-gated live introspection, a real browser Worker bridge proof,
  capability-attested causality, dynamic IFC, and a red-team sandbox.
- A Cowboy WebSocket boundary that accepts safe JSON envelopes from browser-like tab clients.
- A real WebSocket deterministic demo, not an in-process transport shortcut.
- A live browser stage that shows tab realms, the server plane, capability events, denied attempts, and mediated tab-to-tab bridge pulses.
- A staged LiveOps broadcast-control demo with producer, graphics operator,
  remote camera, and observer roles; scoped approval caps; device actors; visible
  denials; disconnect cleanup; and Playwright evidence.
- Tab lifecycle cleanup for caps and tab-attached workers.
- Default-deny tab topology with explicit mediated bridges.
- A minimal `Lattice.MovableProcess` prototype that routes server-side and tab-side operations through one logical handle.
- Browser demo files plus a server task.
- An adversarial `lattice_stress` lab that attacks caps, lifecycle races,
  WebSocket envelopes, process crashes, load, soak, and two-browser UI behavior.

## What It Does Not Prove

- Production security.
- Safe use of raw Erlang distribution in a browser.
- Durable audit storage, clustered state, multi-node failover, or production authentication.
- A full framework API beyond the narrow proof paths covered by tests.

## Toolchain / Prerequisites

Requires Erlang/OTP 28 and Elixir 1.19.5-otp-28 (matches CI; asdf pins them via
`~/.tool-versions`). On the primary dev machine, `mix` on `PATH` is a broken mise shim
(mise's global config pins OTP 27 and its `mix` shim leaks flags) — invoke mix as
`~/.asdf/shims/mix` instead. The scoped fix and full explanation live in `.mise.toml`
at the repo root (untracked, machine-local); see `AGENTS.md` for the agent-facing
command map. The commands below are written as plain `mix`; locally, run them via
`~/.asdf/shims/mix`.

## Run It

```sh
mix deps.get
mix test
scripts/lattice_poc_demo.sh
scripts/lattice_research_demo.sh
scripts/lattice_flagship_demo.sh
```

For the stress lab:

```sh
mix lattice.stress --tabs 500 --caps 2000 --calls 50000 --bridges 1000
npm install
npm run browser:e2e
npm run browser:worker:e2e
```

For the browser demo:

```sh
scripts/lattice_poc_demo.sh 4040
```

Then open [http://localhost:4040](http://localhost:4040).

Open the same URL in a second browser tab to trigger the automatic mediated bridge story. The tabs never talk directly; the server opens short-lived capabilities and routes the visual pulse through `Lattice.Gateway`.

`npm run browser:worker:e2e` runs the focused Web Worker proof: two browser
Workers connect as tab realms, a direct tab cap is denied, and an explicit
bridge delivers exactly one mediated payload.

`scripts/lattice_browser_demo.sh 4040` is kept as an alias for the browser-server path.

For the LiveOps demo:

```sh
LATTICE_SKIP_DEPS=1 LATTICE_SKIP_PLAYWRIGHT_INSTALL=1 scripts/lattice_liveops_demo.sh
mix lattice.liveops 4042
```

The one-command script runs a deterministic WebSocket proof, runs the Playwright
multi-tab stage, and writes topology, audit, summary, screenshot, and optional
recording artifacts under `output/liveops/`. For the interactive stage, open
`http://localhost:4042/?role=producer`, `?role=graphics_operator`,
`?role=remote_camera`, and `?role=observer` in separate tabs.

For the research demonstrator:

```sh
scripts/lattice_flagship_demo.sh 4041
mix lattice.research.demo
mix lattice.graph.snapshot --format json
mix lattice.graph.snapshot --format dot
mix lattice.graph.snapshot --format mermaid
scripts/lattice_verify_flagship.sh
npm run flagship:e2e
```

The flagship E2E is Playwright test code in `tests/e2e/flagship.spec.mjs`.
It records the browser run and writes an acceptability report to
`output/playwright/flagship-video-evaluation.json`, so the same path can be
added to CI later with artifact upload around `output/playwright/`.
The local verification script mirrors the GitHub Actions workflow, stays scoped
to the flagship evidence path, and writes populated graph and claims artifacts
under `output/flagship/`.

Research notes:

- [docs/flagship_demo.md](docs/flagship_demo.md)
- [docs/demo/lattice_liveops_demo_acceptance.md](docs/demo/lattice_liveops_demo_acceptance.md)
- [docs/authority_invariants.md](docs/authority_invariants.md)
- [docs/research/architecture.md](docs/research/architecture.md)
- [docs/research/operational_model.md](docs/research/operational_model.md)
- [docs/research/paper_skeleton.md](docs/research/paper_skeleton.md)

## Lattice 2.0 — Replicas on a Capability-Attested Log

Alongside the v1 capability plane above, this repo contains a fully implemented
**Lattice 2.0** POC: a **Replica** is a process whose identity is a durable, signed
op-log; its materializations are ephemeral BEAM processes that are pure reductions of
that log. The log is the truth; the connection is the cache.

Headline guarantees (all asserted by tests):

- **Offline-convergent state** — CRDT fields (`:lww`, `:or_set`, `:causal_list`)
  converge deterministically after partition and sync.
- **Serialized authority** — one writer role per authority field, held via a
  transferable, revocable signed delegation chain; stale holders are quarantined
  identically on every realm.
- **One chain, two uses** — the same in-log delegation authorizes both a log append
  and a live ephemeral message through the v1 Gateway; a single in-log revoke kills both.
- **Determinism** — the same op set reduces to byte-identical state on every realm,
  regardless of delivery order or partition schedule.
- **Durable messaging** — inbox ops and promises survive dormancy; `await` resolves
  after the target rematerializes.

The code lives in `apps/lattice_core/lib/lattice/` (`Op`, `Log`, `Sync`, `Net`,
`Clock`, `Crdt`, `Replica`, `Reduce`, `Authority`, `Registry`, `Materializer`,
`Promise`, `Live`, `Sim`), with the public facade on `Lattice` (`materialize/2`,
`state_at/3`, `send_durable/3`, `await/2`, ...) and `Lattice.Registry`. For a single
coherent v2 surface use `Lattice.V2` (`materialize/2`, `dormant/2`, `send/3`,
`call/4` + `await/2`, ...); its `@moduledoc` carries the v1 ↔ v2 verb table. Run it:

```sh
mix run scripts/lattice2_demo.exs
mix test apps/lattice_core/test/lattice2/
```

The original v2 proof runs on simulated realms, and M2 now adds a hardened real
WebSocket carrier substrate for BEAM peers: canonical cross-runtime signed bytes,
shared carrier wire frames, signed session authentication, bounded batches,
partial sync shapes, and browser log-store payloads. This is still a POC: no
encryption, no key rotation, no production log compaction, and no native
AtomVM/WASM browser tab realm yet. Design docs:
[docs/lattice2_design.md](docs/lattice2_design.md), the ADRs in
[docs/adr/](docs/adr/), [docs/threat_model_v2.md](docs/threat_model_v2.md),
[docs/path_to_real.md](docs/path_to_real.md), and
[docs/lattice_poc_status.md](docs/lattice_poc_status.md).
Module docs render via ex_doc: `cd apps/lattice_core && mix docs`.

## Architecture

`apps/lattice_core` owns:

- `Lattice` public facade.
- `Lattice.Realm`, `Lattice.Tab`, and `Lattice.Cap` data structures.
- `Lattice.CapStore`, `Lattice.Gateway`, `Lattice.Topology`, and `Lattice.Audit`.
- `Lattice.MovableProcess`.
- `Lattice.Flagship` and `Lattice.Graph.*` for the canonical live graph demo.
- `Lattice.LiveOps` and `Lattice.LiveOps.Device` for the staged LiveOps
  authority demo.

`apps/lattice_web_socket` owns:

- `Lattice.Transport.WebSocket.Client`, the minimal real WebSocket client used by
  carrier, test, and demo callers.
- `Lattice.Transport.WebSocket.Envelope`, the safe JSON codec and browser-boundary
  inbound vocabulary.
- `Lattice.Carrier.WebSocket`, the reusable real carrier client adapter.

`apps/lattice_carrier_server` owns:

- A supervised read-only Cowboy carrier listener for one configured signed log.
- Trusted-transport-realm authentication plus bounded `frontier` and missing-op
  `pull` requests; every other authenticated request is read-only/unsupported.
- Fail-closed path loading and source-preserving supervisor restart behavior.
- A realm transport identity, not a participant identity, capability issuer, or
  Township operation author.
- No inbound push, server-push subscription, TLS/public ingress, or deployment
  packaging. This is a stable server boundary, not a production deployment.

`apps/lattice_server` owns:

- `Lattice.Transport.WebSocket`.
- A lightweight Cowboy HTTP/WebSocket server.

`apps/township_web` owns:

- The read-only Phoenix LiveView instrument at `/township` and its Vue causal-replay
  island.
- `TownshipWeb.CarrierProjection`, an optional supervised observer that periodically
  pulls an authenticated WebSocket peer, validates received operations through the
  shared log/reducer path, and publishes fresh or stale snapshots through PubSub.
- No participant key, capability, write path, server-push feed, or listener ownership;
  the optional peer is supplied by another boundary such as `lattice_carrier_server`.

`apps/lattice_demo` owns:

- `Lattice.Demo.EchoServer`.
- `Lattice.Demo.SecretServer`.
- `Lattice.Demo.TabWorker`.
- Mix tasks for the deterministic and browser demos.

`apps/lattice_stress` owns:

- `LatticeStress.ProbeServer`, `LatticeStress.ProbeTab`, and
  `LatticeStress.Barrier`.
- Adversarial, race, property, WebSocket abuse, failure, load/soak, and browser
  E2E tests.
- `mix lattice.stress`, the repeatable local load harness.

## Browser Realm

The browser demo is the real tab-realm boundary for V0. It connects over WebSocket, requests an echo capability, performs an allowed call, and performs a denied call. The deterministic demo command also uses the WebSocket boundary.

When two browser tabs are connected, the demo server makes the server side visible: it broadcasts presence, capability events, denials, bridge openings, bridge returns, and audit counts to the page. The center server node and lower ledger update from server-pushed events.

The LiveOps stage uses the same boundary. Role tabs receive only server-issued
capabilities for their role and devices. A graphics operator cannot publish
until a producer grants a short-lived, scoped publish cap; replay, expiry,
wrong-role, stolen-cap, forged-target, malformed-envelope, disconnect-race, and
stale-reconnect paths are covered by tests and the demo script.

For a requirement-by-requirement status map, see [docs/acceptance_checklist.md](docs/acceptance_checklist.md).
For adversarial validation details, see [docs/stress_lab.md](docs/stress_lab.md).

## Dependencies

The core app is plain OTP. The server app adds only:

- `cowboy` for the WebSocket and HTTP boundary.
- `jason` for safe JSON envelopes.
- `stream_data` in the stress app test environment for property-based authority
  checks.
- `@playwright/test` for browser E2E validation and the flagship recording.

No browser code stores long-lived secrets, and no tab-facing code exposes arbitrary RPC, `:os.cmd`, code loading, process introspection, raw pids, or global registration.
