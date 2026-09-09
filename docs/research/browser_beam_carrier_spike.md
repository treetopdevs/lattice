# Browser BEAM Carrier Spike

Historical branch target: `spike/browser-beam-carrier`.

The September 2026 browser path supersedes the WS/distribution acceptance target
below; see “Current browser acceptance path”.

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

## Historical AtomVM / web_socket_dist assessment (May 2026)

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

## Current browser acceptance path (September 2026)

Popcorn `0.4.0-next.0` uses OTP/BEAM in Wasm and deliberately removes
Erlang distribution, native sockets, OS spawning, and dynamic native loading.
The older discussion above describes the AtomVM release line only. Do not wait
for, vendor, or enable `web_socket_dist` as the next browser milestone.

The primary candidate is now **Popcorn OTP/crypto behind the existing JSON
WebSocket Gateway**. `apps/lattice_popcorn_spike` contains the optional proof;
see its [runbook](../../apps/lattice_popcorn_spike/README.md). The legacy server
carrier proof remains separate research, with its existing tests intact.

Browser acceptance requires an actual Worker run, native verification of the
same canonical signed bytes, capability allow/deny/expiry, and server cleanup
following hard Worker termination. Source code or a successful bundle alone
does not establish these claims. Production readiness is explicitly excluded:
the prerelease bridge needs `unsafe-eval`, COOP/COEP, and a compatible host OTP.

## References

- Popcorn introduction: https://hexdocs.pm/popcorn/introduction.html
- Popcorn limitations: https://hexdocs.pm/popcorn/limitations.html
- `web_socket_dist`: https://github.com/otp-interop/web_socket_dist
- `tcp_filter_dist`: https://github.com/otp-interop/tcp_filter_dist
