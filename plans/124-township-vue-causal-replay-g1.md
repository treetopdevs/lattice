# Plan 124: Township Vue causal replay island (G1)

## Status

DONE.

## Objective

Close the Vue-island portion of the current Phase G frontier by progressively enhancing the
verified `/township` snapshot with a Vue 3.5 causal-replay canvas. Every replay frame, authority
verdict, edge, and field attribution must come from the Elixir log/reducer path; the browser may
select, scrub, lay out, and draw that evidence, but it must not reimplement Township reduction.

Planned at commit `c5ccbc2`.

## Why this increment

- Plan 123 already provides an authoritative server-rendered instrument and accessible op rail.
- `Lattice.state_at/3` already reduces a dependency-closed frontier through the real
  `Authority.quarantine` and `Reduce` paths.
- The Duality Canvas prototype's strongest interaction is state-to-op provenance plus causal
  replay, but its hand-authored JavaScript reducer cannot become production truth.
- A static-bundle PubSub store would have no real producer, and promoting the spike WebSocket
  carrier is a larger subsequent boundary extraction. This island gives that future feed a real
  consumer without calling the current snapshot live.
- Participant signing keys and capabilities remain in the Tauri/TS client. Phoenix write controls
  are out of bounds until a client-signs/server-relays protocol exists.

## Architecture

### Server projection

Add `Township.ReadModel.replay/1`, a pure Township-specific projection over `Lattice.Log`:

```elixir
%{
  schema: "township-causal-replay-v1",
  nodes: [%{id:, kind:, label:, status:, reason:, height:, author:, field:}],
  edges: [%{from:, to:, kind:}],
  frames: [%{index:, head:, visible_ids:, frontier:, state:, holders:, quarantine:}],
  fields: [%{id:, label:, writers:}]
}
```

- Node order and graph edges reuse `Lattice.Graph.ReplicaSnapshot`.
- Frames are indexed `0..N-1`; frame zero contains the genesis op, blank Matter defaults, and the
  genesis-established clerk holder. There is no implicit empty pre-genesis frame.
- Each frame is defined by the canonical `Log.topo_ops/1` prefix through that index. Its frontier
  and explicit sorted `visible_ids` come from a dependency-closed sub-log, and its state must come
  from `Lattice.state_at/3`. Vue never infers visibility by node order or graph traversal.
- Frame-local quarantine is a `%{op_id => reason_string}` map. The canvas must not project a final
  node verdict backward into an earlier frame.
- Field attribution invokes the Replica DSL's pure `Township.Matter.__apply_command__/2` with the
  operation's structured command arguments and extracts mutation target fields. It never parses a
  rendered label. Authority and unknown operations map to `nil` rather than being guessed.
- A shared JSON-safe state/holder projector is reused by `observe/2` and replay. The final frame is
  still computed through the slice path and compared with the independent full-log `observe/2`
  path; it must not be special-cased to reuse the full result.
- Prefix recomputation is explicitly POC-scale and occurs once per verified bundle load. At `N`
  ops it performs `N` slice reductions/authority analyses (roughly cubic overall); the tracked
  bundle has 13 ops, and this is not a compaction or large-log performance claim.

### Verified source boundary

Extend the successful `TownshipWeb.InstrumentSource` payload with `causal_replay`. The default
bundle source computes it from the same restored log used for `Township.ReadModel.observe/2`, only
after `Township.AuditBundle.verify/1` succeeds. Verification failure exposes neither frames nor
canvas bootstrap data.

### LiveView and Vue boundary

- Keep the server-rendered op rail as the authoritative no-JavaScript/accessibility fallback.
- Emit the replay payload on a hook container only in the verified branch.
- Mount a plain-JavaScript Vue 3.5 app through a LiveView hook. Use composition/render APIs rather
  than the runtime template compiler.
- Mark Vue-owned children `phx-update="ignore"`; the hook owns scrub selection locally. The
  versioned payload leaves a future LiveView-event seam without claiming or registering a feed now.
- Use `@dagrejs/dagre` only for node positioning. Server-provided nodes, edges, order, statuses,
  frames, and attribution remain causal truth.
- Draw the primary DAG on a real `<canvas>`, with field/op selection, keyboard-operable controls,
  a frontier scrubber, a textual selected-op explanation, and a server-rendered fallback.

## Public seams

### Elixir

`Township.ReadModel.replay/1` is deterministic for a supplied `Lattice.Log` and returns only
JSON-safe values. The final frame must agree with `Township.ReadModel.observe/2` for state, holders,
and authority quarantine. `Jason.encode!/1` followed by decode must preserve the complete payload.

### HTML and hook

- Verified `/township` includes `#causal-replay-island[phx-hook="TownshipCausalReplay"]` with a
  versioned JSON payload and retains `#op-dag-panel .op-rail`.
- Degraded `/township` includes neither the island nor replay payload.
- JavaScript-disabled rendering still exposes the authoritative op rail and panel values.

### Browser

- Vue marks the island mounted only after parsing a valid v1 payload and painting nonblank canvas
  pixels.
- Scrubbing changes the displayed server-derived frame and never sends a LiveView event.
- Selecting a field highlights its server-attributed writers; selecting an op exposes its status,
  author, and field plus its reason from the current frame's quarantine map.
- The canvas remains bounded and usable at desktop and 390 px mobile widths.

## Scope

- Add the replay projection and focused ExUnit/property coverage in `lattice_core`.
- Extend the verified source and LiveView contracts in `township_web`.
- Add Vue 3.5 and `@dagrejs/dagre` only to the root browser-asset toolchain.
- Add the hook, canvas island, interaction styling, and Playwright coverage.
- Update the plan index, build map, AGENTS commands, and mobile-readiness documentation contract.

## Non-goals

- No live carrier, polling, PubSub producer, auto-refresh, or mutable instrument session.
- No Phoenix write/transfer/admit/vouch controls and no server-held participant keys or caps.
- No client-side reducer, authority judge, quarantine decision, canonical ordering, or edge
  derivation.
- No removal of the server-rendered op rail or verified refusal state.
- No receipt-freeness, Phase G/G1 completion, carrier convergence, production scaling, mobile,
  cross-device, physical-device, or production TLS claim.

## STOP conditions

- Stop if Vue derives state, order, edges, authority, quarantine, or field attribution.
- Stop if any replay value is built from display labels or claimed JSON rather than the restored
  verified log.
- Stop if replay is emitted after bundle verification fails.
- Stop if scrubbing requires a server round trip or stores mutable per-session replay state.
- Stop if Vue/dagre dependencies enter `lattice_core` or another umbrella app.
- Stop if `phx-update` can let LiveView and Vue mutate the same child DOM.
- Stop if the canvas becomes the only evidence surface or lacks keyboard/text equivalents.
- Stop if the work is described as live, a feed, write-capable, scalable, or G1-complete.

## TDD plan

1. PROJECTION RED/GREEN: pin genesis-frame semantics, explicit visibility, canonical frames,
   final-state agreement, quarantine timing, pure-command field attribution, JSON round-trip
   safety, and arrival-order determinism before implementing replay. The determinism test must
   reconstruct logs by shuffled delivery and compare both deep values and encoded bytes.
2. SOURCE RED/GREEN: require verified payloads to carry replay and corrupted bundles to return no
   payload.
3. LIVEVIEW RED/GREEN: require the hook/payload plus retained fallback in verified renders and
   complete absence in degraded renders.
4. BROWSER RED/GREEN: require Vue mount, nonblank canvas pixels, local scrub behavior, field/op
   selection, JS-disabled fallback, reduced-motion behavior, and desktop/mobile geometry before
   implementing the island.
5. DOCS RED/GREEN: advance the plan/index/build-map/mobile-readiness contracts while retaining the
   carrier/feed/write-control and G1 nonclaims.
6. VERIFY: focused Elixir/browser tests, asset build, `mix verify`, `mix check`, both Sobelow
   boundaries, bundle verifier, mobile readiness, artifact hashes, formatting, and diff checks.
7. REVIEW: obtain Claude Code reviews at architecture, projection RED, browser RED, implementation,
   and final diff checkpoints before commit.

## TDD evidence

- PROJECTION RED: the focused causal-replay suite failed because
  `Township.ReadModel.replay/1` did not exist. GREEN: 2 examples plus 1 shuffled-delivery property
  prove genesis-only frame zero, explicit visibility/frontiers, final-state agreement, frame-local
  quarantine, structured field attribution, JSON round trips, and byte-identical replay output.
- SOURCE RED: the verified bundle payload lacked `causal_replay`. GREEN: the successful source
  carries the projection from its restored verified log and the corrupt-bundle path returns no
  payload.
- LIVEVIEW RED: the verified render lacked the versioned replay hook. GREEN: connected/dead renders
  include the ignored Vue host and retain all 13 server-rendered operation nodes, while degraded
  renders expose neither host nor payload.
- BROWSER RED/GREEN proceeded in five observable slices: mount/nonblank pixels, local frame scrub,
  field/op provenance, JavaScript-disabled fallback, and stable live-region/reduced-motion polish.
  The final Playwright gate has 6 passing cases across desktop, 390 px mobile, JavaScript-disabled,
  and reduced-motion contexts with no console errors, overflow, or panel overlap.
- DOCS RED: the Plan 124 contract failed on `IN PROGRESS` and the `023-123` cumulative marker before
  the plan index, build map, agent guide, and mobile-readiness contract advanced to Plan 124.

## Second opinion

- Claude Code ranked this Vue replay island first because `Lattice.state_at/3` already supplies the
  real dependency-closed reducer seam, while a static PubSub layer has no producer and the current
  WebSocket carrier remains spike-grade.
- Claude rejected Phoenix write controls before a client-signs/server-relays protocol because key
  and cap custody intentionally lives in the Tauri/TS client.
- Claude required server-derived replay frames, a retained authoritative fallback, local-only
  scrubbing, `phx-update="ignore"`, no client reducer, and explicit POC-scale/non-live wording.
- Architecture verdict: `VERDICT: PROCEED`.
- Claude's plan-schema review returned `VERDICT: REVISE`: frames lacked explicit visible ids and
  frame-local reasons, which would have forced Vue to infer causality or project terminal verdicts
  backward. The schema now supplies both, pins genesis-only frame zero, shares JSON-safe state
  projection, and requires a real shuffled-delivery determinism test.
- Live inspection corrected two details from that review: genesis already establishes the clerk
  holder, and the Replica DSL's pure `Matter.__apply_command__/2` output provides exact mutation
  fields without a hand-maintained table or new DSL metadata.
- Claude's projection implementation review found no trust-boundary blocker and returned
  `VERDICT: PROCEED`.
- Claude's complete browser review verified the strict CSP/runtime-only Vue build, root dependency
  placement, server-only causality/authority boundary, LiveView/Vue lifecycle, keyboard fallback,
  and mobile geometry, then returned `VERDICT: PROCEED`. Its non-blocking reduced-motion and
  live-region findings were converted into a final red-green polish slice.
- Claude's final release-style diff review independently reran the decisive core/web tests, found
  no trust-boundary, refusal-path, CSP, lifecycle, documentation, or Tauri-claim blocker, and
  returned `VERDICT: SHIP IT`. Its remaining notes are bounded follow-ups for a future multi-field
  command guard, corrupt-bootstrap browser coverage, and replay-payload scaling beyond 13 ops.

## Verification

- Focused replay/read-model/audit coverage: 6 examples and 1 property passed together.
- Focused source/LiveView coverage: 5 examples passed together.
- `npm run township:instrument:e2e`: 6 browser cases passed.
- `npm install` reported 0 vulnerabilities with exact `vue` 3.5.39 and `@dagrejs/dagre` 3.0.0
  development dependencies.
- `~/.asdf/shims/mix verify`: 286 tests and 25 properties passed across the umbrella.
- `~/.asdf/shims/mix check`: full verification plus strict Credo exited 0; only the existing
  advisory set outside this diff remains.
- `~/.asdf/shims/mix sobelow --exit --skip` exited 0 in both HTTP boundary apps; the raw Cowboy
  app retained its expected no-Phoenix-router notice.
- `~/.asdf/shims/mix lattice.township.verify_bundle --dir artifacts/township` verified the tracked
  bundle, all seven SHA-256 values remain on the Plan 121/122 baseline, and
  `git diff --exit-code -- artifacts/township` is clean.
- `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness` passed.
- `~/.asdf/shims/mix format --check-formatted` and `git diff --check` passed; desktop and 390 px
  screenshots were visually inspected after the final browser run.

## Completion claim

DONE. Plan 124 delivers a server-derived causal replay of one verified static bundle through a
Vue-enhanced, read-only canvas with server-rendered evidence fallback. It is not live, write-capable,
scalable, receipt-free, or G1-complete; carrier/PubSub feeds and write controls still remain.
