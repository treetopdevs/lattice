# Township POC — Agent Working Notes

This tree overlays the **Township POC** (PD-001-A) onto the existing `treetopdevs/lattice`
2.0 branch. It is meant to be dropped into that repo and driven to green. These notes tell
an agent what "done" means and what NOT to touch.

## What this is

Township is milestone **M5** in `PD-001`: one town-scale civic instance (≤10k participants)
running deliberation and roles on the Lattice substrate, with coercion-resistant election work
kept behind explicit M4 gates. This POC is the **minimal cut** of it:

- **W0–W3 run on the real 2.0 core.** They drive the genuine `Lattice.Sim` harness against
  `Township.Matter`, a civic `Replica` built only from primitives that already exist
  (`:lww` / `:causal_list` / `:or_set` CRDTs and one `authority:` field).
- **Legacy W4 is stubbed behind `Lattice.Attestation`.** The Stub proves only old demo
  plumbing and permanently reports `receipt_free? == false`. M4 is now the separate,
  multi-role `Township.Election` protocol over a dedicated board; its implemented
  foundation makes no coercion-resistance claim and is not a drop-in replacement.

## Files in this overlay

| Path | Role |
|---|---|
| `apps/lattice_core/lib/township/matter.ex` | The civic Replica (modeled on `Lattice.Demo.Thread`). |
| `apps/lattice_core/lib/lattice/attestation.ex` | Frozen legacy behaviour + non-receipt-free `Stub`; `M4Placeholder` is an empty migration tombstone. |
| `apps/lattice_core/lib/township/election*.ex` | Research-safe election facade, immutable types, pure projection, close evidence, and offline replay. |
| `apps/lattice_core/test/support/attestation_contract.ex` | Legacy Stub contract; it is not an M4 conformance contract. |
| `apps/lattice_core/test/township/workflows_test.exs` | W0–W4 as falsifiable tests. |
| `scripts/township_demo.exs` | Narrated end-to-end run (`§5` storyline). |
| `apps/township_web` | Read-oriented LiveView/Vue instrument; its optional Plan 126 projection periodically pulls a real carrier peer and publishes verified snapshots through PubSub, while Plan 130 lets a fresh projection prepare one unsigned post request for app-owned review and authoring. |
| `apps/lattice_carrier_server` | Plan 127 supervised listener, read-only by default; Plan 128 permits selected trusted realms to relay already-signed operations into a path-backed log without participant custody. |

## The retired seam wager and the M4 boundary

The M4 research verdict retired the claim that `cast_vouch/3`, `tally/2`,
`produce_alt/2`, and `receipt_free?/0` can host coercion resistance. Keep
`Lattice.Attestation.Stub` frozen and false; never implement callbacks in
`M4Placeholder`. The replacement is `Township.Election`: an authorized immutable Matter
link, a dedicated capability-gated `Township.ElectionBoard`, exact artifact bytes, pure
projection, explicit close evidence, offline replay, and structured conditional claims.

**Do not** put ballots or credentials on `Township.Matter`, and never let a voter author a
public ballot op with their ordinary Lattice identity. The Matter stores only the authorized
election-link command. The board stores service-authored public artifacts; anonymous ingress,
private registration, and the pinned cryptographic construction remain blocking gates.

## Acceptance criteria (the exit gate, PD-001-A §A5)

Drive these to green under the standard loop (`mix format` → `mix test` → the demo):

- **G2** — the four M1 properties (convergence, authority soundness, byte-identical replay,
  identical quarantine) hold over `Township.Matter`. `workflows_test.exs` asserts the first
  three directly; reuse the M1 StreamData generators for the property-level versions.
- **G3** — the legacy demo decision remains deterministic, but is not an M4 or
  receipt-freeness claim.
- **G4** — the legacy Stub contract passes with `receipt_free? == false`; the new election
  path passes its separate board, projection, close, and offline-replay contracts.
- **G5** — `scripts/township_demo.exs` narrates W0→W4 clean and emits trust-graph + audit
  artifacts an outsider can replay (reuse the V1 `mix lattice.graph.snapshot` exporters).

### G1 runs over the real BEAM carrier — read this

G1 wants W0–W3 on **two physical BEAM nodes over the real WebSocket carrier**. That carrier is
now present as the M2 substrate (`Lattice.Carrier`, `apps/lattice_node_spike`, and the
canonical/wire/session helpers), and `apps/lattice_node_spike/test/township_carrier_test.exs`
drives the Township scenario across two BEAM OS processes. The test keeps `Lattice.Sim` as
the oracle, then asserts byte-identical materialized state and identical `:not_holder`
authority quarantine for the stale clerk action after partition/heal. Do not replace this
with a Sim-only claim; G1 is the real-socket run, while `scripts/township_demo.exs` remains
the narrated Sim/W4-stub walkthrough.

Plan 126 reuses that real carrier as a strictly pull-only instrument observer. Plan 127 adds the stable read-only carrier server that the observer can reach without relying on the node-spike
fixture. It authenticates transport realms and serves frontier/missing-op pulls from one configured
signed log. It does not add server push, participant custody, or production deployment; it also
does not complete Phase G or change the Tauri onboarding, mobile secure-store, real-app
convergence, or receipt-free W4 claims.

Plan 128 adds an opt-in client-signed relay to that stable boundary. A selected transport realm
may submit one already-signed operation; the server performs structural delivery and persists a
changed path-backed log before acknowledgement, while a distinct observer continues to pull and
materialize against the Sim oracle. The server does not author operations, hold participant keys or
a separate capability store, or decide semantic authority. This request/response operation does not add `/township` write controls, server push, or participant custody, and it does not claim
production deployment, G1/Phase G completion, or receipt-free W4.

Plan 129 connects the packaged Tauri app to the stable relay without moving custody. Pairing carries
an explicit public `push`/`relay` transport mode; the desktop app uses its existing native key and
persisted delegation frames to pull, author the exact Sim operation, relay one signed frame at a
time, and compact only durable acknowledgements. A distinct fresh-BEAM
`TownshipWeb.CarrierProjection` matches Sim after the stable server restarts from the same path.
The older packaged generic-push smoke remains unchanged. This is a packaged desktop convergence
proof, not mobile relay or a new secure-store implementation, and it still adds no `/township`
write controls, server push, participant custody, production deployment, Phase G completion, or
receipt-free W4.

Plan 130 adds the first participant post handoff. A fresh carrier-backed `/township` LiveView may
prepare one versioned unsigned request from its projected replica and public post text. The paired
Tauri app treats that link as untrusted review input, preserves any existing local draft, validates
the replica against saved pairing, and requires separate Use request, Post, and Sync actions before
its existing local-cap, local-frontier, native-key, persisted-outbox, and stable-relay path runs.
Phoenix never receives participant keys, capabilities, delegation frames, dependencies, signatures,
or authoring authority. The Ubuntu flagship gate and a packaged macOS LaunchServices gate compare
the resulting operation and restarted projection with `Lattice.Sim`. This is not server push,
broader participant controls, production deployment, Phase G completion, receipt-free W4, or a new
mobile/device or secure-store result.

Plan 131 makes the packaged macOS gates mandatory in CI. A hard-failing `macos-15-intel` flagship
job builds and launches the actual app for stable-relay onboarding and LiveView action handoff,
retaining native key/KV custody, LaunchServices ingress, restart recovery, and exact Sim comparison.
The Ubuntu native-core job now provisions Tauri's official Linux build prerequisites so its real
Wry tests execute instead of failing at pkg-config. This is CI enforcement and environment repair,
not server push, broader participant controls, production deployment, mobile/device proof, Phase G
completion, or receipt-free W4.

Plan 132 replaces fast polling as the normal convergence trigger for the carrier-backed instrument.
An authenticated BEAM subscriber receives a bounded `ops_available` generation hint only after a
changed path-backed log is durably persisted, then runs the unchanged verified frontier/pull,
delivery, reduction, and Sim-comparison path. The packaged action gate proves push-triggered
convergence before its 60-second poll can run, recovers through reconnect after server restart, and
then proves the new subscription with a second pushed generation. The hint carries no operation or
semantic authority. The projection preallocates its local subscription ref before a connect worker
starts, so a first-connect or reconnect hint cannot race ref installation; an epoch-discarded worker
connection is closed.

Plan 133 adds direct TypeScript availability subscriptions to the shared
`CarrierWebSocketClient`. It allows one atomic request in flight, installs the typed notification
route before sending `subscribe`, retains at most one latest hint plus one waiting consumer, and
fails the socket and old subscription closed on malformed input, regression, error, or close. A
headless real-socket gate uses the stable server to prove first hint before pull, canonical
hash/signature verification and Sim-equal ids, duplicate silence, same-path restart replacement,
and a second pushed generation. It does not mount Vue or launch the Tauri app. Reactive app feed
consumption, broader participant controls, production deployment, mobile/device custody changes,
Phase G completion, and receipt-free W4 remain open.

## Constraints — the "do not implement" boundary (PD-001 §6)

Named and **excluded from this POC**. If one starts looking necessary, question the
requirement, not the boundary:

- **No federation / cross-town identity / universal tally** — that is M6, deliberately last.
  There is intentionally no sixth workflow.
- **No key rotation, recovery, or E2EE** — M3 (roadmap R1). `Township.Matter` assumes stable
  identities for the POC.
- **No production compaction** — the first scaling cliff; the feasibility spike and M2
  carrier acknowledgements exist, but snapshot-aware `Authority`/`Reduce` integration and
  GC coordination are not built.
- **No real coercion-resistant election profile** — M4 (roadmap R2). The legacy Stub remains
  false, and the new election foundation keeps every security claim `:not_claimed` until its
  profile, operations, independent review, conformance, and scale gates clear.

## API reality check (verified against branch `claude/beautiful-gould-6b25d2`)

Use these real signatures — do not invent parallel APIs:

- `Lattice.Op.new(identity, replica, deps, kind, body, opts)`; kinds are
  `:command | :authority | :inbox | :tombstone`.
- Replica DSL: `field :x, merge: :lww | :or_set | :causal_list` **or** `field :x, authority: :role`
  (mutually exclusive); `command :name, [:args], do: [{field, mutation}]`; mutations are
  `{:write, v} | {:add, e} | {:remove, e} | {:append, v} | {:delete, id}` (absolute, never
  relative); `ephemeral` never logs; `succession :role, to:, after: {:dormant_ticks, n}`.
- `Lattice.Sim`: `new/4`, `create_replica/2` (`policies:`), `grant/4` (`ops:`, and plan 149's
  `expires_epoch:` lease), `transfer/5` (also takes `expires_epoch:`), `succeed/4`, `request/4`,
  `command/5`, `beacon/3` (root-signed `{:beacon, epoch}` logical tick), `partition/3`, `heal/3`,
  `sync_all/1`, `state/2`, `log/2`, `holder/3`, `identity/2`, `quarantined/3` (returns `false`
  or `{true, reason}`). Lease lapse quarantines `:lease_expired`; invalid beacons quarantine
  `:unauthorized_beacon` / `:stale_beacon`. A leased delegation hashes/signs the
  `lattice-delegation-v3` canonical arm; unleased delegations keep v2 bytes verbatim.
- `Lattice.Log`: `dump/2`, `restore/1`, `op_ids/1`, `frontier/1`, `topo_ops/1`.
- `Lattice.state/2`, `Lattice.state_at/3` for materialization and time travel.

## Toolchain preference

Prefer the **latest** Elixir, Phoenix LiveView, and Vue where a choice is open. The one UI
surface (PD-001-A §A4) is a single Phoenix LiveView with five panels — reserved for the app
layer per `PD-001 §2`; Vue 3.5 only if a non-LiveView browser realm is needed as the second
device. M2 chose and hardened the WebSocket carrier substrate; the remaining browser choice is
whether the tab realm is implemented as native AtomVM/WASM or a JS/Vue client that consumes
`Lattice.Canonical` and `Lattice.Carrier.Wire`.

## First moves

1. Compile against the 2.0 branch; run `mix test apps/lattice_core/test/township/` — get W0–W4
   green on the simulated substrate.
2. Run `scripts/township_demo.exs`; confirm the narration and the quarantine/tally beats.
3. Keep the legacy Stub frozen. Continue M4 only through the gates in
   `docs/research/m4_interface_redesign_brief.md`; migrate the read/audit surface and W4 only
   after the pinned profile, operations, independent review, conformance, and scale gates pass.

## Parallel tracks — this overlay is the *application* track

Township is a downstream **consumer** of the substrate; developing Lattice itself happens in
the repo's own `plans/` directory (the **substrate** track). The two run in parallel and meet
at one seam:

- **Substrate track** — `plans/` (generated 2026-06-20). Foundation & hardening (`000`–`009`,
  e.g. 001 gates the full property suite in CI — needed before Township's M1 property claims can
  be trusted), then the direction spikes (`010`–`013`) and M2 hardening. **Plan `010` and M2 now
  provide the carrier substrate, and plan 017 adds the Township G1 BEAM-carrier acceptance
  harness.** Plan 014 remains the next determinism-hardening follow-up before broader carrier
  performance work.
- **Application track** — this overlay. W0–W4 on `Sim` now, structured so the W1/W3 assertions
  swap onto the real carrier unchanged.
- **The seam** — `plans/010-real-carrier-spike.md`, ADR 0005, and M2 are the substrate carrier
  gate in this checkout. A Township overlay may add its own `010a` acceptance plan, but that file
  is not present here. The remaining coupling is explicit: any native browser realm
  (AtomVM/WASM or JS/Vue) must implement `Lattice.Canonical` and `Lattice.Carrier.Wire` before it
  can author or verify ops without the BEAM bridge.

Run as two Fable worktrees when the Township overlay is present: worktree 1 keeps the substrate
carrier hardening green; worktree 2 keeps the overlay green and extends the G1 harness beyond
the BEAM carrier when browser/phone realms become available.
