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
- Resume token endpoint to WebSocket `resume` envelope.
- LiveOps browser role controls to the authoritative `Lattice.LiveOps` server
  plane and device actors.

## Attacker Model

The attacker can control browser JavaScript in a tab realm, send arbitrary WebSocket JSON, replay observed cap ids from the same tab until revoked or exhausted, attempt to use another tab's cap, forge unknown cap ids, request unknown targets, and disconnect or reconnect tabs. The POC does not model a compromised server.

For resume, an attacker may replay an observed resume JWT or ask for an old sequence window. Resume JWTs are short-lived and one-shot through ETS-backed JTIs; old sequence windows return `rehydrate` instead of unbounded replay.

For LiveOps, an attacker may claim any browser role label, try to publish before
approval, steal a publish cap from another tab, replay an already-used publish
cap, use an expired approval, forge a target override, send malformed envelopes,
disconnect during approval or publish, and reconnect with stale caps.

## Erlang Distribution Risks In A Browser Context

Raw Erlang distribution is broad authority. If exposed carelessly, a browser node could attempt arbitrary pid messaging, registered name messaging, RPC, code loading, global name registration, atom creation, process introspection, or denial-of-service through mailbox pressure.

This POC does not accept raw Erlang distribution frames.

The `spike/browser-beam-carrier` research branch narrows this into an isolated
experiment: `tcp_filter_dist` must reject every distribution control message
except a JSON logical-call frame addressed to a single carrier gateway process.
That gateway still routes through `Lattice.Gateway`; possession of a
distribution cookie is not treated as Lattice authority.

## Why Cookie Possession Is Insufficient

An Erlang distribution cookie authenticates admission to a distribution fabric. It does not express least authority for individual targets and operations. Cookie possession does not answer whether a tab may call a specific process, send to another tab, load code, register names, or create atoms.

## Capability Mitigation

Lattice treats caps as the authority unit. A cap is unguessable, issued to one tab, scoped to a target and operation set, optionally time-limited, optionally use-limited, revocable, and audited. A cap issued to tab A cannot be used by tab B.

In the LiveOps demo, roles are policy context, not authority by themselves. The
server issues role-specific caps, and `Lattice.LiveOps` checks both the
authorized cap provenance and the server-owned role context before changing
production state. Producer approval grants a short-lived, use-limited publish
cap to the graphics operator; successful publish revokes that cap after use.
Device actors are spawned under the tab lifecycle and are reachable only through
device-specific caps.

## Remaining Gaps

- In-memory cap and audit state only.
- No production authentication or CSRF/origin policy.
- Resume replay protection is in-memory and node-local.
- No cluster replication or failover.
- WebSocket demo is intentionally small.
- Raw Erlang distribution frames are deliberately not accepted by the gateway.
- Browser BEAM carrier work is isolated to a research spike until the Popcorn
  and browser `web_socket_dist` toolchain is reproducibly runnable.
- LiveOps media devices are simulated actors, not real camera/video transport.
