# Browser BEAM Carrier Spike

Branch target: `spike/browser-beam-carrier`.

Acceptance target:

> Popcorn browser agent sends one Lattice logical call over a WS/dist carrier, gateway authorizes it, graph/audit shows it, and hostile raw-distribution behaviors fail closed.

## Current Result

This branch lands the safe carrier boundary that target requires before a browser
BEAM node is allowed anywhere near Lattice authority:

- `apps/lattice_carrier_spike` is an isolated umbrella app for carrier research.
- `LatticeCarrierSpike.Filter` is a `tcp_filter_dist` allowlist that accepts only
  JSON logical-call frames sent to `:lattice_browser_gateway`.
- `LatticeCarrierSpike.BrowserGateway` decodes that frame and still calls
  `Lattice.call/3`; it does not bypass `Lattice.Gateway`.
- `LatticeCarrierSpike.Runtime` and `mix lattice.browser_carrier.server` provide
  the actual `web_socket_dist` listener seam when the VM is launched with
  `-proto_dist Elixir.TCPFilter`.
- Focused tests prove one logical call reaches a capability-authorized target,
  audit records it, graph edges show the tab/cap/target path, and hostile
  registered-name, pid-send, RPC-shaped, and spawn-shaped distribution traffic
  is rejected before target delivery.
- `mix lattice.browser_carrier.proof` writes
  `output/browser_beam_carrier/browser-beam-carrier-proof.json`.

This is intentionally not wired into the main browser demo. The clean JSON
WebSocket resume layer stays the production-facing demo surface while this
branch explores the carrier behind a fail-closed boundary.

## What Kept Popcorn / web_socket_dist Out Of The Main Stack

Popcorn is not yet a drop-in browser Erlang-distribution node for this use case.
Its current documentation describes the browser runtime as AtomVM in an iframe,
with JavaScript interop crossing `postMessage()` as JSON-serializable values, and
lists distributed Erlang as not yet downstreamed / beta in AtomVM. That means a
Popcorn agent can be part of the browser-side control plane, but today it needs
to call a JavaScript carrier shim rather than owning the distribution stack
itself.

`web_socket_dist` and `tcp_filter_dist` are usable as GitHub dependencies and
compile in this repo when pinned, but they are not published Hex packages. The
browser JavaScript package used by the upstream example is published through
GitHub Packages, and the source checkout does not include the built
SwiftWasm package artifacts. That makes an unauthenticated, reproducible
Playwright browser proof unsuitable for the main demo branch today.

The bigger reason is authority: raw Erlang distribution plus a shared cookie is
ambient node authority. Without `tcp_filter_dist`, a browser node could attempt
registered-name sends, pid sends, spawn requests, monitor/exit traffic, or
GenServer-shaped calls to server processes. Lattice's authority unit is the cap,
so the carrier must be narrowed to one logical message shape before `Lattice.call/3`.

## How To Run

```sh
mix test apps/lattice_carrier_spike/test
mix lattice.browser_carrier.proof
```

To start the experimental WS/dist server half:

```sh
elixir --erl "-proto_dist Elixir.TCPFilter" -S mix lattice.browser_carrier.server 5000
```

## Next Acceptance Step

The honest browser-side completion step is one of:

- Vendor or reproducibly build `@otp-interop/web-socket-dist` so Playwright can
  load the real browser carrier without private package auth.
- Add a Popcorn browser agent that invokes that JavaScript carrier shim from the
  iframe and sends the same `lattice_call` JSON string across `web_socket_dist`.
- Run the carrier listener with `--erl "-proto_dist Elixir.TCPFilter"` and the
  `LatticeCarrierSpike.Filter` policy, then assert the same positive and hostile
  cases from a real browser page.

Until that lands, this branch should be described as a server-side carrier
boundary proof, not full acceptance of browser Popcorn over WS/dist.

## References

- Popcorn introduction: https://hexdocs.pm/popcorn/introduction.html
- Popcorn limitations: https://hexdocs.pm/popcorn/limitations.html
- `web_socket_dist`: https://github.com/otp-interop/web_socket_dist
- `tcp_filter_dist`: https://github.com/otp-interop/tcp_filter_dist
