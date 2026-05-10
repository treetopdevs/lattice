# Lattice Research Architecture

Status: working research demonstrator with explicitly labeled simulations.

Lattice explores a unified BEAM-shaped process plane where browser tabs, server
processes, tab-owned workers, bridges, and future AtomVM-WASM nodes are treated
as realms in one actor topology. The core claim is not that a browser becomes a
trusted Erlang node. The claim is that cross-realm authority can be expressed as
object capabilities that preserve OTP-like lifecycle semantics across an
asymmetric trust boundary.

## Thesis Object

The novel object is the four-way intersection of:

- object-capability security,
- OTP supervision, link, monitor, and fault semantics,
- location-transparent actor messaging across asymmetric trust boundaries,
- browser tabs and eventual AtomVM-WASM nodes as first-class process realms.

## What Is Implemented

The working implementation is in `apps/lattice_core`.

- `Lattice.Cap`, `Lattice.CapStore`, and `Lattice.Gateway` enforce capability
  ownership, target, operation, revocation, expiry, use limits, payload caveats,
  typed contracts, and session transitions before forwarding.
- `Lattice.Cap.Attenuation`, `Lattice.Cap.Caveat`,
  `Lattice.Cap.Macaroon`, `Lattice.Cap.Delegation`, and
  `Lattice.Cap.Membrane` model PID-as-capability authority and child caps.
- `Lattice.Topology` records tabs, workers, and explicit tab-to-tab bridges.
- `Lattice.Graph.*` snapshots the process graph as a trust graph and validates
  invariants.
- `Lattice.Causality` builds a hash-linked capability-attested trace.
- `Lattice.IFC` implements a dynamic information-flow-control prototype.
- `Lattice.MovableProcess.effects/0` exposes realm/effect annotations.
- `Lattice.Demo.*` modules provide executable wallet, agent-tool,
  introspection, and federated-worker scenarios.
- `Lattice.RedTeam.Sandbox` runs repeatable adversarial attempts.

## What Is Simulated

- Browser-worker federation in `Lattice.Demo.FederatedWorkers` uses in-process
  tab transports. It models bridge semantics but is not AtomVM/WASM.
- The AI-agent demo is a simulated agent realm making tool calls. It does not
  call an LLM or external AI API.
- The macaroon module presents a caveat-bearing token shape. Runtime authority
  remains server-side in `Lattice.CapStore`; this is not a production macaroon
  verifier.
- Causality attestations are hash-chain prototypes, not durable distributed
  consensus.
- Dynamic IFC is runtime label checking, not a static information-flow type
  system.

## What Is Future Work

- Real AtomVM-WASM transport and distribution experiments.
- Formal operational semantics mechanized in a proof assistant.
- Durable replicated capability/audit state.
- Production authentication, origin policy, CSRF protection, and persistence.
- Cluster-aware supervision and replay-resistant causality across nodes.

## Trust Boundary

Browser/tab realms have zero ambient authority. They cannot address raw pids,
registered names, arbitrary RPC, process introspection, code loading, or global
registration through Lattice. A tab can only present an unforgeable capability
id issued to that tab. The gateway authorizes the operation and payload, then
forwards to the target process or mediated bridge.

## Supervision as Trust Topology

`Lattice.Topology` treats tab connections, tab-attached workers, bridges, and
capabilities as graph edges with lifecycle state. `Lattice.Graph.Policy` checks:

- no live cap from a dead tab,
- no bridge without a matching explicit cap policy,
- no child cap with more authority than its parent,
- no restricted cap held outside its allowed realm,
- no live tab-to-tab edge unless a bridge policy exists,
- no allowed sensitive label flow to a public realm.

## Executable Entry Points

```sh
mix test apps/lattice_core/test
mix lattice.research.demo
mix lattice.graph.snapshot --format json
mix lattice.graph.snapshot --format dot
mix lattice.graph.snapshot --format mermaid
scripts/lattice_research_demo.sh
```

