# Lattice LiveOps Demo Overview

This document defines the impressive real-world demo that should drive the next phase of Lattice development.

The demo is a browser-based live operations control room for a fictional broadcast production. It is intentionally domain-specific enough for people to understand, but abstract enough to exercise the general Lattice framework properties needed for emergency response, infrastructure operations, federated compute, and multiplayer simulation.

## Core Narrative

A live production system extends itself into multiple browser tabs. Each tab becomes a constrained operational participant: producer, graphics operator, remote camera, reviewer, or observer. The server plane remains authoritative. Tabs receive no implicit authority. Every meaningful operation flows through Lattice capabilities, the Lattice gateway, audit events, and the topology graph.

The audience should see the system as a living process graph:

1. The dormant server plane is running.
2. A producer tab joins and receives limited production authority.
3. A graphics tab joins and receives only graphics-preview authority.
4. A remote camera tab joins and receives only camera-publish authority.
5. The producer grants a short-lived approval capability to publish a lower third.
6. The graphics operator previews an overlay but cannot put it on air without approval.
7. The producer approves the action.
8. The graph shows the capability edge, the operation, the audit event, and the state transition.
9. A malicious or mistaken tab attempts wrong-target, over-scope, replay-after-revoke, and expired-cap operations.
10. Each denial is visible and auditable.
11. A tab disconnects.
12. Lattice revokes tab-attached capabilities, cleans up workers, and updates the graph.
13. A replacement tab joins and receives fresh attenuated authority.
14. The production continues.

## Why This Demo

Broadcast operations are easy to understand: multiple people coordinate under time pressure; some can preview, few can publish; devices and tabs can disconnect; mistakes have consequences; auditability matters.

The domain exercises the generic Lattice substrate:

- ephemeral browser realms
- least-authority capability flow
- mediated cross-tab interaction
- supervision-oriented lifecycle cleanup
- live topology visualization
- denial evidence
- human approval gates
- short-lived delegation
- reconnect/replacement workflows
- device-like browser actors
- stress and adversarial tests

## Non-Goals

This demo must not become a full video production suite. It should simulate media payloads with small deterministic objects and visual pulses unless a later phase explicitly adds WebRTC or real media.

The demo must not expose raw Erlang distribution to browsers.

The demo must not allow browser code to call arbitrary RPC, send raw pids, register names, load code, run shell commands, introspect arbitrary processes, or bypass `Lattice.Gateway`.

## MVP Acceptance Metrics

The MVP is acceptable only when all of the following are true:

- `mix test` passes.
- Existing Lattice tests continue to pass without weakening security assertions.
- A browser E2E test opens at least three tabs with different roles.
- The E2E test proves an allowed preview operation succeeds.
- The E2E test proves publish is denied without producer approval.
- The E2E test proves publish succeeds with a valid short-lived approval capability.
- The E2E test proves stolen-cap, expired-cap, revoked-cap, wrong-role, and wrong-target operations are denied.
- The E2E test proves tab disconnect revokes tab-attached caps and removes tab-attached workers.
- The visual stage displays realms, roles, capability edges, operation pulses, denials, audit counts, and lifecycle cleanup.
- A deterministic CLI script can run the same story without manual browser interaction.
- `docs/demo/lattice_liveops_demo_acceptance.md` records every claim and the test or script that proves it.

## Real-World Readiness Definition

For this repository, "real-world ready" means demo-real, not production-secure. The demo must be deterministic, repeatable, tested, adversarially exercised, and explainable to a technical audience. It must not claim production security, durable audit, cluster failover, or safe browser Erlang distribution unless those features are actually implemented and tested.

## Expected Repository Shape

The preferred implementation path is additive:

- Keep `apps/lattice_core` as the authority kernel.
- Add demo-domain process modules under `apps/lattice_demo` or a new `apps/lattice_liveops_demo` if isolation becomes cleaner.
- Reuse `Lattice.Gateway`, `Lattice.CapStore`, `Lattice.Audit`, `Lattice.Topology`, `Lattice.Transport.WebSocket`, and existing browser demo infrastructure.
- Add browser files under `examples/liveops_demo/`.
- Add scripts under `scripts/`.
- Add Playwright tests under `tests/e2e/`.
- Add stress/adversarial cases under `apps/lattice_stress` when they test generic Lattice invariants.

## Key Design Principle

The topology is the interface. The demo must make authority, process structure, trust boundaries, failures, and human approvals visible as one changing graph. The graph is not decoration; it is the explanation of the system.
