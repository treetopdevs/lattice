# Paper Skeleton: Capability-Gated OTP Across Browser Realms

Working title: **Lattice: An Object-Capability Process Plane for OTP-Shaped
Browser Realms**

## Abstract

We present Lattice, a research demonstrator that treats browser tabs, server
BEAM processes, and tab-owned workers as participants in one OTP-shaped actor
topology while preserving least authority through object capabilities. Lattice
uses attenuated PID-as-capability tokens, typed/session runtime checks, graph
policy validation, causality attestations, and dynamic IFC prototypes to show
how fault topology and authority topology can be made visible as one structure.

## Contributions

- PID-as-capability model with macaroon-style caveats and delegation.
- OTP-inspired lifecycle topology for browser/tab realms.
- Location-transparent actor messaging without ambient pid/name authority.
- Process graph as trust graph inspector with invariant checks.
- Executable prototypes for causality, IFC, agent tools, wallet processes, live
  introspection, federated worker simulation, and red-team sandboxing.

## System Model

Lattice has a trusted server-side gateway and untrusted tab realms. Tabs do not
receive raw pids, registered names, RPC, distribution cookies, or process
introspection. All cross-realm operations present a cap id to the gateway.

## Related-Work Matrix

| Area | Examples | Relation To Lattice |
| --- | --- | --- |
| Object capabilities | E, Caja, Joe-E, Pony references | Lattice uses unforgeable server-side caps as authority units. |
| Macaroons | Google macaroons, bearer-token caveats | Lattice prototypes attenuation and caveats but does not implement production macaroon verification. |
| Actors | Erlang/OTP, Akka, Orleans | Lattice keeps actor messaging but removes ambient location authority at tab boundaries. |
| OTP supervision | Supervisors, links, monitors | Lattice exposes lifecycle edges as trust graph edges. |
| Browser isolation | Same-origin policy, Web Workers, iframes | Lattice models tabs/workers as realms with explicit bridge policies. |
| Distributed Erlang | EPMD, cookies, node mesh | Lattice deliberately avoids raw distribution exposure to tabs. |
| IFC | Decentralized label model, LIO, Jif | Lattice includes runtime label checks as an executable prototype. |
| Capability-safe UI agents | Tool-use policies, least-authority agents | Lattice demos agent tools as cap-gated processes. |

## Evaluation Plan

- Unit tests for authority preservation and denial behavior.
- Graph invariant tests for topology/policy consistency.
- Demo scripts for wallet, agent, introspection, federation, and red-team flows.
- Stress lab from existing `lattice_stress` app for lifecycle and abuse cases.

## Explicit Non-Claims

- No real AtomVM/WASM distribution is implemented.
- No formal verification is claimed.
- No production authentication, persistence, or cluster replication is claimed.
- No LLM API is invoked by the simulated AI-agent demo.

## Future Work

- Mechanize the operational semantics.
- Replace local-tab simulation with AtomVM-WASM browser nodes.
- Add durable cap/audit replication and replay protection.
- Explore UI consent ceremonies for live process introspection.

