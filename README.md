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

## Architecture

`apps/lattice_core` owns:

- `Lattice` public facade.
- `Lattice.Realm`, `Lattice.Tab`, and `Lattice.Cap` data structures.
- `Lattice.CapStore`, `Lattice.Gateway`, `Lattice.Topology`, and `Lattice.Audit`.
- `Lattice.MovableProcess`.
- `Lattice.Flagship` and `Lattice.Graph.*` for the canonical live graph demo.
- `Lattice.LiveOps` and `Lattice.LiveOps.Device` for the staged LiveOps
  authority demo.

`apps/lattice_server` owns:

- `Lattice.Transport.WebSocket`.
- `Lattice.Transport.WebSocket.Client`, a minimal real WebSocket client used by tests and the deterministic demo.
- JSON envelope parsing.
- A lightweight Cowboy HTTP/WebSocket server.

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
