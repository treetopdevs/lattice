# Lattice LiveOps Agent Prompt Series

This file contains the implementation prompt sequence for LLM agents working inside the Lattice repository.

Each prompt assumes:

- The agent can read the repository.
- The agent must preserve existing Lattice invariants.
- The agent may add tests, scripts, docs, and implementation code.
- The agent must never weaken security guarantees to make the demo easier.
- The agent must not remove adversarial tests.
- The agent must not expose raw Erlang distribution to browser tabs.
- The agent must not bypass `Lattice.Gateway`.

---

# Prompt 01 — Topology Stage Upgrade

Goal:

Upgrade the browser stage into a visually compelling operational topology view.

Required Capabilities:

- Distinct realm nodes.
- Distinct role labels.
- Animated capability edges.
- Animated operation pulses.
- Denial visualization.
- Lifecycle cleanup visualization.
- Audit counters.
- Server plane visualization.
- Capability expiry countdowns.
- Revocation animation.

Acceptance Criteria:

- Browser stage updates live from server events.
- Multiple tabs appear simultaneously.
- Topology updates deterministically.
- E2E tests validate node appearance/disappearance.
- No client-side authority assumptions.

Constraints:

- Do not move authority into browser state.
- Browser UI must remain observational.
- Gateway remains authoritative.
- No direct tab-to-tab messaging.

Failure States To Avoid:

- Browser becomes source of truth.
- Topology divergence.
- Unsynchronized capability state.
- Hidden denials.

---

# Prompt 02 — Role-Based Browser Realms

Goal:

Add explicit operational roles.

Roles:

- producer
- graphics_operator
- remote_camera
- observer

Required Behavior:

- Role-specific capabilities.
- Role-specific UI.
- Role-specific denials.
- Role-specific topology coloring.

Acceptance Criteria:

- Wrong-role operations denied.
- Denials audited.
- Producer approval required for publish.
- Tests prove role isolation.

Constraints:

- Roles are not sufficient authority.
- Capability possession remains required.
- No implicit escalation.

Failure States To Avoid:

- Role-only authorization.
- Shared mutable role state.
- Hidden privilege inheritance.

---

# Prompt 03 — Human Approval Workflow

Goal:

Implement explicit approval gates.

Workflow:

1. Graphics operator requests publish.
2. Producer receives approval request.
3. Producer grants short-lived publish capability.
4. Graphics operator performs publish.
5. Capability expires or revokes immediately after use.

Acceptance Criteria:

- Publish denied before approval.
- Publish allowed after approval.
- Replay-after-revoke denied.
- Expired approval denied.
- All operations audited.

Constraints:

- Approval capability must be attenuated.
- Approval capability must be scoped.
- Approval capability must be revocable.
- Approval capability must be short-lived.

Failure States To Avoid:

- Permanent publish authority.
- Shared producer capabilities.
- Missing audit provenance.

---

# Prompt 04 — Browser Device Actors

Goal:

Add supervised browser-side device abstractions.

Initial Simulated Devices:

- camera feed
- graphics renderer
- tally light
- preview monitor

Required Behavior:

- Devices represented as Lattice-managed actors.
- Devices tied to tab lifecycle.
- Devices visible in topology graph.
- Device operations capability-gated.

Acceptance Criteria:

- Disconnect destroys attached device actors.
- Unauthorized device operations denied.
- Device events visible in stage.

Constraints:

- Simulate media payloads initially.
- Avoid real media complexity until topology model stabilizes.

Failure States To Avoid:

- Orphan device actors.
- Device authority surviving disconnect.
- Untracked device state.

---

# Prompt 05 — Adversarial Operations Suite

Goal:

Extend `lattice_stress` with demo-specific attacks.

Required Attacks:

- stolen publish cap
- replay-after-revoke
- expired approval
- wrong-role publish
- forged target
- malformed envelope
- disconnect during approval
- disconnect during publish
- reconnect with stale caps

Acceptance Criteria:

- Every attack denied or safely cleaned up.
- No unauthorized operation reaches target.
- Audit events emitted.
- Topology remains coherent.

Constraints:

- Existing stress lab conventions remain intact.
- Add deterministic assertions.

Failure States To Avoid:

- Silent failures.
- Partial authorization.
- Race-condition bypass.
- Orphan capability edges.

---

# Prompt 06 — Deterministic Demo Script

Goal:

Create a single deterministic command that stages the full narrative.

Command:

```bash
scripts/lattice_liveops_demo.sh
```

The script should:

- boot server
- open browser stage
- simulate joins
- simulate approval flow
- simulate attacks
- simulate disconnect/replacement
- generate topology exports
- generate audit exports
- generate verification summary

Acceptance Criteria:

- One-command execution.
- Repeatable output.
- CI-compatible.
- Produces evidence artifacts.

Constraints:

- Avoid nondeterministic timing.
- Avoid hidden manual steps.

Failure States To Avoid:

- Demo requiring live operator intervention.
- Timing-sensitive flakes.
- Missing evidence artifacts.

---

# Prompt 07 — Final Integration Pass

Goal:

Integrate all demo systems into one coherent operational narrative.

Required Final State:

- Browser stage visually explains topology.
- Capabilities visibly flow.
- Denials visibly occur.
- Audit visibly increments.
- Disconnect cleanup visibly occurs.
- Human approval visibly mediates authority.
- No direct browser trust exists.

Required Outputs:

- updated README sections
- architecture diagram
- threat-model update
- acceptance checklist update
- demo screenshots or recordings
- Playwright E2E
- stress validation

Acceptance Criteria:

- New contributors can run the demo in under 10 minutes.
- Demo survives repeated reconnect/disconnect cycles.
- Demo survives adversarial tests.
- Existing tests continue passing.
- Repository claims match implementation.

Constraints:

- Do not exaggerate security guarantees.
- Do not claim production distribution support.
- Do not weaken Lattice's explicit-authority thesis.

Final Failure States To Avoid:

- Demo devolves into generic websocket app.
- Browser gains implicit authority.
- Capability semantics become decorative.
- Topology graph stops representing actual runtime state.
