# Threat Model

## Assets

- Server OTP process state.
- Capability store and capability ids.
- Per-tab session identity.
- Audit events.
- Tab-attached worker lifecycle.

## Trust Boundaries

- Browser tab to server WebSocket boundary.
- Tab-originated envelope to `Lattice.Gateway`.
- Capability store to target process forwarding.

## Attacker Model

The attacker can control browser JavaScript in a tab realm, send arbitrary WebSocket JSON, replay observed cap ids from the same tab until revoked or exhausted, attempt to use another tab's cap, forge unknown cap ids, request unknown targets, and disconnect or reconnect tabs. The POC does not model a compromised server.

## Erlang Distribution Risks In A Browser Context

Raw Erlang distribution is broad authority. If exposed carelessly, a browser node could attempt arbitrary pid messaging, registered name messaging, RPC, code loading, global name registration, atom creation, process introspection, or denial-of-service through mailbox pressure.

This POC does not accept raw Erlang distribution frames.

## Why Cookie Possession Is Insufficient

An Erlang distribution cookie authenticates admission to a distribution fabric. It does not express least authority for individual targets and operations. Cookie possession does not answer whether a tab may call a specific process, send to another tab, load code, register names, or create atoms.

## Capability Mitigation

Lattice treats caps as the authority unit. A cap is unguessable, issued to one tab, scoped to a target and operation set, optionally time-limited, optionally use-limited, revocable, and audited. A cap issued to tab A cannot be used by tab B.

## Remaining Gaps

- In-memory cap and audit state only.
- No production authentication or CSRF/origin policy.
- No durable replay protection beyond use limits and revocation.
- No cluster replication or failover.
- WebSocket demo is intentionally small.
- Raw Erlang distribution frames are deliberately not accepted by the gateway.
