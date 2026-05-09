# Lattice

Lattice is a greenfield proof of concept for a least-authority process plane on the BEAM. It treats server BEAM processes and browser tab realms as participants in one OTP-shaped topology, while forcing every cross-realm operation through explicit, revocable capabilities.

The core thesis is simple: a tab gets zero implicit authority. It cannot use raw node membership, raw pids, registered names, RPC, or cookie possession as authorization. A tab can only use a capability issued to that tab, for a specific target and operation, while the gateway enforces ownership, expiry, revocation, use limits, topology rules, and audit logging.

## What This POC Proves

- A runnable umbrella project with `lattice_core`, `lattice_server`, and `lattice_demo`.
- Explicit grants, denies, revocation, TTL/expiry, use limits, and per-tab isolation.
- A Cowboy WebSocket boundary that accepts safe JSON envelopes from browser-like tab clients.
- A real WebSocket deterministic demo, not an in-process transport shortcut.
- A live browser stage that shows tab realms, the server plane, capability events, denied attempts, and mediated tab-to-tab bridge pulses.
- Tab lifecycle cleanup for caps and tab-attached workers.
- Default-deny tab topology with explicit mediated bridges.
- A minimal `Lattice.MovableProcess` prototype that routes server-side and tab-side operations through one logical handle.
- Browser demo files plus a server task.

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
```

For the browser demo:

```sh
scripts/lattice_poc_demo.sh 4040
```

Then open [http://localhost:4040](http://localhost:4040).

Open the same URL in a second browser tab to trigger the automatic mediated bridge story. The tabs never talk directly; the server opens short-lived capabilities and routes the visual pulse through `Lattice.Gateway`.

`scripts/lattice_browser_demo.sh 4040` is kept as an alias for the browser-server path.

## Architecture

`apps/lattice_core` owns:

- `Lattice` public facade.
- `Lattice.Realm`, `Lattice.Tab`, and `Lattice.Cap` data structures.
- `Lattice.CapStore`, `Lattice.Gateway`, `Lattice.Topology`, and `Lattice.Audit`.
- `Lattice.MovableProcess`.

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

## Browser Realm

The browser demo is the real tab-realm boundary for V0. It connects over WebSocket, requests an echo capability, performs an allowed call, and performs a denied call. The deterministic demo command also uses the WebSocket boundary.

When two browser tabs are connected, the demo server makes the server side visible: it broadcasts presence, capability events, denials, bridge openings, bridge returns, and audit counts to the page. The center server node and lower ledger update from server-pushed events.

For a requirement-by-requirement status map, see [docs/acceptance_checklist.md](docs/acceptance_checklist.md).

## Dependencies

The core app is plain OTP. The server app adds only:

- `cowboy` for the WebSocket and HTTP boundary.
- `jason` for safe JSON envelopes.

No browser code stores long-lived secrets, and no tab-facing code exposes arbitrary RPC, `:os.cmd`, code loading, process introspection, raw pids, or global registration.
