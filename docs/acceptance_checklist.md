# Acceptance Checklist

This file maps the requested POC contract to the current repository state after removing non-runtime carrier claims from the implemented surface.

| Requirement | Status | Evidence |
| --- | --- | --- |
| New Mix umbrella repository | Done | Root `mix.exs`, `apps/lattice_core`, `apps/lattice_server`, `apps/lattice_demo`, local `.git/` |
| Core Lattice API | Done | `apps/lattice_core/lib/lattice.ex` |
| Realm, Tab, Cap data structures | Done | `Lattice.Realm`, `Lattice.Tab`, `Lattice.Cap` |
| Capability store with grant, deny, revoke, TTL, use limit, owner isolation | Done | `Lattice.CapStore`; core tests |
| Gateway as only cross-realm path | Done | `Lattice.Gateway`; WebSocket tab messages call through it |
| Audit events | Done in memory | `Lattice.Audit`; tests inspect events |
| Real WebSocket tab transport | Done | `Lattice.Transport.WebSocket`; integration tests and demo script use it |
| Bounded WebSocket resume | Done | `LatticeServer.ResumeToken`, `LatticeServer.ResumeProxy`; focused resume tests prove replay, rehydrate fallback, and one-shot JWTs |
| Browser demo page and JS client | Done | `examples/browser_demo/index.html`, `examples/browser_demo/client.js` |
| Visible server plane | Done | `LatticeServer.DemoHub` broadcasts presence, server events, and audit counts to the browser stage |
| Tab lifecycle cleanup | Done | disconnect/eject revoke caps and terminate tab workers |
| Default-deny tab topology | Done | tab-to-tab denied by default and target inbox remains empty |
| Explicit mediated bridge | Done | `Lattice.bridge/4`; allow, revoke, and expiry tests |
| Two-browser-tab story | Done | real WebSocket integration test verifies automatic A->B and B->A bridge story |
| MovableProcess prototype | Done | `Lattice.MovableProcess`, `Lattice.Demo.AdPreview` |
| Echo and secret demo servers | Done | `Lattice.Demo.EchoServer`, `Lattice.Demo.SecretServer` |
| Demo command | Done | `scripts/lattice_poc_demo.sh`; uses real WebSocket clients |
| Browser server command | Done | `scripts/lattice_browser_demo.sh` |
| LiveOps authoritative events | Done | `Lattice.LiveOps`, `LatticeServer.DemoHub`, WebSocket `liveops_action` envelopes |
| LiveOps topology UI | Done | `examples/liveops_demo/*`, stable `data-testid` selectors, `npm run liveops:e2e` |
| LiveOps roles | Done | producer, graphics operator, remote camera, observer in `Lattice.LiveOps` |
| LiveOps approval workflow | Done | request, approve, short-lived publish cap, publish, revoke/replay/expiry tests |
| LiveOps device actors | Done | `Lattice.LiveOps.Device`; camera feed, graphics renderer, tally light, preview monitor |
| LiveOps adversarial suite | Done | `apps/lattice_stress/test/liveops_adversarial_test.exs` |
| LiveOps one-command demo | Done | `scripts/lattice_liveops_demo.sh` writes `output/liveops/*` artifacts |
| LiveOps E2E | Done | `scripts/lattice_liveops_e2e.mjs`, `npm run liveops:e2e` |
| No in-process runtime tab transport | Done | Runtime tab traffic uses WebSocket; test helpers live under `test_support` only |
| No non-runnable carrier surface | Done | Raw distribution is not part of the POC |
| Docs | Done | `README.md`, `docs/unified_beam_plane_poc.md`, `docs/threat_model.md`, `docs/lattice_poc_status.md`, `docs/demo/lattice_liveops_demo_acceptance.md` |

## Explicit Limitations

- Security is POC-level and in-memory.
- Browser auth/origin hardening is not production-grade.
- Raw Erlang distribution frames are deliberately not accepted by the gateway.
- Capability and audit state are not durable or clustered.
- WebSocket resume buffers only the short-lived demo stream, not authority or durable history.
- LiveOps proves a deterministic demo workflow, not production authentication,
  durable audit, real media transport, or clustered failover.
