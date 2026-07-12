# Plan 129: Packaged Tauri stable-relay convergence (toward G1)

## Status

DONE.

## Objective

Make the real packaged desktop Tauri application drive the durable write boundary completed in
Plan 128. A pairing explicitly identifies the stable server as a one-op relay target; the app uses
its native device key and persisted capability state to pull, author offline, relay signed frames,
and drain only durably acknowledged outbox entries. After a real server OS-process restart, a
different pull-only observer must materialize the exact Sim result.

This closes the current protocol split: all existing Tauri onboarding and app-convergence proofs
submit generic bulk `push` to the node-spike fixture, while `lattice_carrier_server` intentionally
refuses `push` and accepts only explicit one-op `relay`. The packaged app must reach the stable
server without moving participant custody or authority into BEAM.

Planned at commit `48fbfbab`.

## Why this increment

- Plan 128 creates a real durable source-change producer, but only the Elixir carrier client can
  call it. The TypeScript `CarrierWebSocketClient` has no relay request.
- `syncTownshipOutbox/1` always calls generic `push`, so a paired Tauri app receives `read_only`
  from the stable server. Existing desktop, packaged, and Android convergence gates therefore prove
  the node-spike fixture protocol, not the stable write boundary.
- Server push remains premature until a real application can produce durable changes through the
  production-shaped boundary. The current pull projection already observes changes correctly.
- `/township` participant controls would either duplicate the Tauri shell or tempt Phoenix/server
  custody before the native-key app path reaches the server.
- TLS/release deployment would package a boundary the chosen app still cannot write through.
- Tauri onboarding/cap persistence, the mobile secure-store strategy, and real app convergence are
  already deep, tested tracks. This plan connects them to Plan 128 rather than replacing or
  reopening them.

## Critical trust separation

Four facts remain independent:

1. The packaged app's native key signs carrier sessions and Township operations. Private key bytes
   never enter JavaScript storage, pairing payloads, logs, or the server.
2. Pairing submission mode selects a transport verb. `relay` authorization permits spending server
   resources to deliver signed bytes; it is not civic authority.
3. The operation's embedded author, signature, replica, dependencies, capability, and causal state
   determine structural acceptance and downstream semantic authority.
4. The stable server identity authenticates the endpoint and never authors a Township operation.

The server retains only its transport identity, trusted transport public keys, and the signed log.
The app retains its native key handle, public pairing config, local semantic log, public delegation
frames, and pending signed outbox frames through the existing Tauri seams.

## Architecture

### Explicit pairing submission mode

Extend `TownshipCarrierPeerConfig` with an optional public field:

```ts
submission?: "push" | "relay";
```

- Omitted means `push`, preserving all Plans 054-120 configs, handoffs, fixtures, and installed
  state without migration.
- A stable-server pairing persists and exports `submission: "relay"` explicitly.
- Unknown values fail validation. No try-relay/fallback-to-push probing is allowed.
- Environment config, manual pairing UI, imported handoffs, QR/deep-link/discovery drafts, equality,
  confirmation, and persisted config carry the public mode consistently.
- Imported relay mode remains subject to the existing explicit fingerprint/save confirmation. It
  grants no authority and contains no key, capability secret, or device-local identity material.
- The UI uses an option control labeled by the transport action, not by an authority claim.
- `townshipCarrierPeerConfigsEqual` includes the effective submission mode, so replacing a saved
  push pairing with relay cannot hit the save function's equal-config early return.
- Export and every ingress parser explicitly carry `submission`; an export/import round trip is a
  required contract because the packaged onboarding handoff is compiled into the app.

The pairing handoff stays backward-compatible: old payloads omit the field and normalize to push;
new relay payloads carry the field. Do not bump or duplicate the pairing format unless live parser
tests prove an incompatible wire change is necessary.

### TypeScript one-op relay

Add `CarrierWebSocketClient.relay(frame)` and a narrow relay-capable interface. The method sends:

```text
{"type":"relay","op":<one CarrierOpFrame>}
```

It requires `relay_result`, decodes the same four-list report shape used by `push_result`, and
returns a `CarrierPushReport`. It remains blocking request/response; no unsolicited frame queue,
subscription, or demultiplexer is added.

Malformed replies and coarse peer errors fail the sync without mutating local persistence. The
client does not infer semantic authority from accepted or quarantined transport reports.

### Relay-aware outbox drain

`syncCarrierOnce` and `syncTownshipOutbox` receive the explicit submission mode through an additive,
optional argument that defaults to push. Existing library and shell call sites compile and behave
unchanged when they omit it. In relay mode:

1. advertise and pull exactly as today;
2. remove frames already advertised by the peer from the submission set and mark those ids safe to
   compact;
3. place the remaining local outbox frames in stable causal order using their `deps` edges, with
   original order as the deterministic tie-breaker;
4. submit exactly one frame per relay request without adaptive retry or fallback;
5. aggregate each relay report into the existing `CarrierPushReport` shape; and
6. compact only accepted ids or ids independently confirmed present by peer advertisement.

The all-empty report is the Plan 128 duplicate acknowledgement, but it is not sufficient by itself
to delete local data. Re-advertise after an all-empty report and compact that frame only if its id is
now present. This closes the response-loss/racing-duplicate case without treating an empty report
as semantic success.

Quarantined, rejected, and pending frames remain in the outbox and remain visible in the existing
sync result fields. A structurally quarantined frame is persisted by the server for audit but is not
advertised as an accepted op, so it is not silently compacted. A pending frame is held for a later
drain. Static causal ordering sends available in-outbox dependencies before their children but does
not loop or reorder reactively after a pending result.

If a later relay request fails after earlier requests were persisted, the whole local drain returns
failure and leaves the current outbox file intact. On retry, the initial advertisement confirms the
already-persisted prefix and compacts it safely before resubmitting the remainder. No local success
is reported before both server acknowledgement and local persistence updates complete.

### Packaged desktop convergence proof

Keep `tauri_packaged_onboarding_smoke.ts` unchanged as the packaged generic-push regression for
Plans 118-120. Add a separate TS-hosted `tauri_stable_relay_onboarding_smoke.ts`; it reuses the
existing macOS app build/launch/trace/KV/quit mechanics but orchestrates these explicit subprocesses:

1. A test-support Elixir fixture generator calls
   `LatticeNodeSpike.TownshipOnboardingScenario.base_sim/0`. That scenario already includes the
   resident's preceding `set_summary("Needs traffic study")` and is immediately before the separate
   packaged-app `post("resident: posted while offline")`. The generator takes the clerk log at that
   point, writes it through public `Lattice.Log.dump/2` to a temporary `matter.log`, applies exactly
   that `:post` command in Sim, and writes a JSON oracle containing replica, expected op id, op ids,
   read model, causal replay, and author facts. No TS-authored approximation is the oracle.
2. The TS harness launches the production `apps/lattice_carrier_server/priv/server_node.exs` in its
   eight-argument relay form from that path, with the resident realm as the one relay realm and a
   distinct instrument realm as read-only observer. A support helper owns only process lifecycle,
   stdout readiness parsing, and OTP-safe code paths.
3. The harness packages and launches the actual macOS Tauri app with native key custody and an
   explicitly confirmed relay-mode pairing handoff. Initial sync pulls the resident delegation,
   the app authors the known offline post through its normal cap-select/sign/persist workflow, and
   final sync relays and drains it.
4. The harness inspects the real Tauri key-value file to prove persisted relay mode, cap/log state,
   empty accepted outbox, and absence of private key/seed material.
5. The harness kills the server OS process and restarts the same production entrypoint from the
   same path.
6. The TS harness launches a second test-support Elixir verifier process. That process starts
   `TownshipWeb.CarrierProjection` through its public API as the distinct instrument realm,
   refreshes once from the restarted server, compares the payload with the fixture's Sim oracle,
   verifies the server key is not an op author, prints one bounded success marker, and exits.

The TS process is the sole terminal-gate orchestrator; the fixture generator and observer verifier
are Elixir subprocesses because Sim, `Log.dump/2`, and `CarrierProjection` are Elixir boundaries.
They exchange only temporary public fixture paths, endpoint/public-key config, and bounded JSON or
readiness markers. They do not inspect holder state or replace the production server entrypoint.

The app-authored frame must be byte/id-equal to the Sim-generated expected operation. The server
transport public key must not appear as an operation author.

A focused real-socket TypeScript relay case also submits one Sim-generated, validly signed but
authority-invalid command. The stable server reports structural acceptance; the distinct BEAM
observer places it only in the expected materialization quarantine. The packaged UI need not expose
an authority-invalid action merely to repeat this trust-boundary proof.

### Dependency graph

- `lattice-client` gains request/response relay and submission-mode drain logic, with no Tauri,
  Phoenix, listener, or server dependency.
- `township-tauri-shell` carries the public pairing mode and selects the drain path; native signing
  and storage command surfaces remain unchanged.
- `lattice_carrier_server` gains no participant custody, semantic policy, generic push, or runtime
  Tauri dependency. Test support may reuse its public server entrypoint.
- `township_web` remains pull-only and gains no write path or runtime dependency on Tauri.
- Existing source-level xref cycles remain the baseline.

## Public TDD seams

Only public boundaries are test surfaces:

1. `CarrierWebSocketClient.relay/1`: one frame produces the decoded report; malformed/error replies
   fail; `push` remains unchanged.
2. Pairing normalize/save/export/import/UI: omitted mode remains push-compatible, explicit relay
   survives every public ceremony, unknown mode fails, and persisted/handed-off data stays public.
3. `syncCarrierOnce` / `syncTownshipOutbox`: causal one-op relay order, report aggregation,
   accepted/known/confirmed-duplicate compaction, retained quarantine/reject/pending, and
   response-loss retry safety are observable through public clients and stores.
4. Real stable server: the TS client cannot relay as an observer, cannot generic-push as a relay
   realm, and cannot drain against relay mode until the realm is explicitly allowlisted.
5. Packaged app and projection: actual Tauri native commands, persisted files, server restart, and
   public observer payload prove the end-to-end result. Tests do not inspect holder state or bypass
   the app authoring workflow.

## Scope

- Add the TypeScript one-op relay request and focused wire tests.
- Add explicit push/relay pairing mode through env, persistence, handoff, import surfaces, and UI.
- Add relay-aware outbox drain with causal ordering and acknowledged-only compaction.
- Add real-socket refusal, idempotency, partial-failure, and authority-boundary tests against
  `lattice_carrier_server`.
- Add a separate packaged desktop stable-relay convergence gate with restart plus distinct-observer
  Sim comparison; keep the existing packaged generic-push smoke unchanged as a regression.
- Preserve and rerun onboarding/cap persistence, mobile secure-store strategy, frontend, both
  packaged app paths, and full app-convergence contracts.
- Update the plan index, build map, architecture/status docs, and cumulative readiness contracts.

## Non-goals

- No server push, unsolicited frame, subscription, WebSocket demultiplexer, holder broadcast, or
  autonomous browser feed change.
- No `/township` participant write control, Phoenix/server private key, cap store, command builder,
  semantic authority policy, or server-authored operation.
- No generic `push` enablement on the stable server and no relay-to-push fallback probing.
- No new native key command, secure-store implementation, key export, capability secret, or change
  to the mobile secure-store strategy. Existing Tauri native custody remains the implementation.
- No Android release/iOS/device/camera/LAN/cross-device probe; all section-4a parked boundaries stay
  parked. This plan proves packaged desktop use, not mobile relay deployment.
- No server TLS/public ingress/release packaging, rate limiting, fsync/power-loss durability,
  database, multi-writer transaction, backup, or production deployment claim.
- No receipt-free primitive, W4 change, G1/Phase G completion, or `receipt_free? = true` claim.

## STOP conditions

- Stop if submission mode is inferred from a `read_only` error or any relay/push fallback is added.
- Stop if omitted legacy mode no longer behaves exactly as generic push for Plans 054-120.
- Stop if `submission` is absent from effective pairing equality, persisted config, handoff export,
  or any public handoff ingress, or if switching a saved peer from push to relay takes the
  equal-config no-write path.
- Stop if the new `syncCarrierOnce` argument is not optional/default-push or any existing omitted
  call site changes behavior.
- Stop if relay submits a child before an available in-outbox dependency, adaptively reshuffles a
  pending graph, or batches more than one frame into a relay request.
- Stop if pending, rejected, or quarantined frames are compacted without independent accepted-op
  advertisement, or if an all-empty report alone deletes an outbox frame.
- Stop if partial network/persistence failure can lose a locally pending frame or double-author an
  operation.
- Stop if the terminal gate uses `LatticeNodeSpike.WsHandler` instead of
  `lattice_carrier_server` for the app's write boundary.
- Stop if the existing packaged generic-push smoke is repointed or removed instead of retained
  alongside the new stable-relay smoke.
- Stop if the terminal TS harness substitutes a TS-only observer for the required public
  `TownshipWeb.CarrierProjection` verifier, or if either Elixir helper inspects holder internals.
- Stop if the server signs/authors an op, stores a participant private key or separate cap
  inventory, or decides Township authority.
- Stop if private key/seed bytes enter JS storage, pairing/handoff/QR/deep-link data, traces, or
  observer output.
- Stop if `township_web` gains custody or a write path, or if request/response relay is called server
  push.
- Stop if the work adds another parked mobile/device probe or claims mobile relay, deployment,
  G1/Phase G, or W4 completion.

## TDD plan

1. TS RELAY RED/GREEN: call absent `CarrierWebSocketClient.relay`; add only the one-op request and
   shared report decoding, with malformed/error and existing-push regression cases.
2. PAIRING RED/GREEN: require explicit relay mode to survive normalize/save/export/import and the
   pairing UI while omitted legacy configs remain byte/behavior compatible with push.
3. DRAIN RED/GREEN: require causal one-frame order, report aggregation, accepted/advertised and
   confirmed-empty duplicate compaction, retained quarantine/reject/pending, and partial-failure
   retry safety; implement no fallback.
4. REAL SERVER RED/GREEN: connect the TS client to `lattice_carrier_server`; first observe generic
   push/read-only failure, then prove authorized relay, observer refusal, duplicate/restart recovery,
   and authority-invalid materialization through public sockets.
5. FIXTURE/HOST RED/GREEN: add the Elixir Sim-to-path/oracle generator, the TS production-server
   process helper, and the Elixir projection verifier with bounded file/marker contracts. Keep the
   production server entrypoint and projection public API as the only runtime boundaries.
6. PACKAGED APP RED/GREEN: add a separate packaged stable-relay onboarding smoke; require native
   key reuse, cap pull, offline authoring, durable outbox drain, public persisted config, no secret
   leakage, and keep the existing generic-push packaged smoke green and unchanged.
7. OBSERVER RED/GREEN: within the same TS-hosted smoke, kill/restart the production server and run
   the distinct Elixir `TownshipWeb.CarrierProjection` verifier against the Sim oracle, including
   op ids/read model/replay and exclusion of the server key from authors.
8. DOCS RED/GREEN: add Plan 129 contracts and advance current markers while retaining server-push,
   `/township` write, custody, deployment, mobile, parked-area, G1, and W4 non-claims.
9. VERIFY: run TS typecheck/unit/conformance, focused shell sync/onboarding/pairing/frontend tests,
   stable-server and packaged-app gates, mobile readiness/strategy, browser instrument gates, bundle
   immutability, forced compilation, xref/Sobelow, `mix verify`, `mix check`, formatting, and diff
   checks.
10. REVIEW: obtain Claude Code reviews for this written plan, every RED/GREEN checkpoint, outbox
   failure semantics, packaged-app/observer proof, docs, and the exact release diff.

## TDD evidence

- TS RELAY: `carrier:relay` first failed because `CarrierWebSocketClient.relay` did not exist. The
  GREEN sends exactly one `{type: "relay", op}` request, requires `relay_result`, shares strict
  report decoding, rejects peer errors/wrong tags, and leaves generic push unchanged.
- PAIRING: env and UI contracts first failed because relay mode was ignored and the selector was
  absent. The GREEN carries explicit relay through normalize/save/equality/handoff/QR/deep-link/
  discovery/UI while omitted or explicit push keeps the legacy persisted/wire shape. Claude then
  found a stale-draft edge; a new RED proved legacy handoff import returned `undefined`, and the
  shared parser now emits explicit push so every ingress overwrites stale relay state.
- DRAIN: the library and shell REDs both failed with `generic push fallback called`. The GREEN adds
  optional/default-push submission, stable causal one-op relay order, aggregate reports,
  advertisement-confirmed empty duplicates, accepted/known-only compaction, and no fallback.
  A later relay failure leaves the entire persisted outbox unchanged; retry advertises the
  persisted prefix and relays only the remainder.
- REAL SERVER: the TS contract first failed because no stable-server helper existed. The GREEN
  spawns the production eight-argument server entrypoint with pinned OTP 28, proves observer relay
  and relay-realm generic-push refusal, idempotent one-op relay, authority-invalid structural
  acceptance, path/port restart, and distinct public projection convergence.
- FRESH BEAM: the first separate verifier returned `{:unavailable, :malformed_op}`. Loading only
  `Township.Matter` remained red; loading both the trusted `Lattice.Authority` and
  `Township.Matter` schemas before the first projection pull made the production lifecycle green
  without test-local preloading.
- PACKAGED APP: the separate release-mode macOS gate builds and launches the actual app with an
  explicit relay handoff. It proves native key reuse, cap pull, exact full Sim frame equality,
  empty accepted outbox, no seed material in KV/traces, server kill/restart, and fresh-BEAM
  post-only oracle equality. The existing generic-push packaged smoke remains unmodified and green.
- DOCS: cumulative contracts first failed on the absent Plan 129 map/status markers. The GREEN
  advances plans 023-129, records the desktop proof, preserves Plan 128's historical non-claim,
  and retains every mobile, custody, server-push, deployment, G1/Phase G, and W4 non-claim.

## Second opinion

- Claude ranked packaged Tauri stable-relay convergence ahead of server push, `/township` writes,
  and deployment after inspecting the live TS and server clients.
- Claude found the production-shaped write boundary unreachable by the real app: only the Elixir
  client implements relay, while every existing Tauri convergence gate uses generic push against
  the node-spike fixture.
- Claude required explicit persisted push/relay pairing mode, one-op causal drain, unchanged
  accepted-only compaction semantics, no fallback probing, and a packaged desktop plus
  second-observer Sim/restart exit gate.
- Claude kept the mobile secure-store strategy proven but unchanged, and kept every section-4a
  device area parked.
- Claude's first written-plan review returned `VERDICT: REVISE`: the terminal gate named TS,
  packaged macOS, stable-server, Sim, and Elixir projection boundaries without selecting a runtime
  host or cross-runtime handoff. It also required the source-log producer, preservation of the old
  packaged push smoke, optional/default-push call compatibility, and pairing equality/export/import
  to be load-bearing constraints. The plan now pins a TS-hosted orchestrator, two bounded Elixir
  helpers, the production server entrypoint, parallel packaged smokes, and explicit STOP conditions
  for every requested compatibility edge.
- Claude's revised-plan review returned `VERDICT: PROCEED`, confirming all five requested revisions
  and every outbox/trust/non-claim boundary. Its one minor wording note treated the onboarding
  scenario's preceding resident `set_summary` as the later packaged `post`; live code confirms the
  scenario is pre-`:post`, and the fixture wording now names both commands explicitly.
- Claude's pairing review returned `VERDICT: PROCEED`, then identified legacy handoff mode retention
  as a non-blocking edge. After the parser-level RED/GREEN, its follow-up returned
  `VERDICT: PROCEED` and confirmed every ingress now normalizes omitted mode to push.
- Claude's relay-drain review returned `VERDICT: PROCEED`. It identified missing flagship wiring
  and a shell mixed-outcome integration case; both were added, and the follow-up returned
  `VERDICT: PROCEED` with the gaps closed.
- Claude's production-socket review returned `VERDICT: PROCEED` after independently confirming the
  fresh-VM existing-atom failure and the load-bearing schema preload. Its claim that the Authority
  preload might be redundant was rejected by the recorded RED: Matter-only still failed, while
  Authority plus Matter passed.
- Claude's packaged terminal review returned `VERDICT: PROCEED`; its only actionable finding was
  that the fast trust-boundary socket contract was not aggregated. `app:convergence` now includes
  both `stable:relay:contract` and the separate packaged relay smoke.
- Claude's documentation review returned `VERDICT: REVISE` solely because this plan and index still
  said pending while the now-proven summary docs used completion tense. The full verification below
  passed before status was advanced to DONE, resolving that contradiction.
- Claude's exact-release review returned `VERDICT: PROCEED` with no blocking correctness,
  security, durability, lifecycle, test-proof, generated-artifact, documentation, or accidental
  scope finding. Its residual notes are explicit non-goals or efficiency/test-robustness concerns:
  macOS-only packaged execution, safe retention of nonaccepted frames, duplicate-confirmation
  round trips, and fixed-port restart reuse.

## Verification

- `clients/lattice-client`: fresh build, strict typecheck, conformance, canonical parity, Township
  authoring, Tauri bridge, generic carrier vector/live carrier, relay wire, and relay-drain scripts
  all pass. The two new relay scripts are enumerated in flagship CI.
- `clients/township-tauri-shell`: typecheck plus frontend, native, action, pairing, deep-link,
  QR/camera, discovery, sync, onboarding, live-peer, mobile strategy/readiness, and stable-socket
  contracts pass. The full `app:convergence` chain passes, including browser click-through,
  launched app, unchanged generic-push packaged onboarding, packaged stable-relay onboarding, and
  installed deep-link smoke.
- Browser gates pass serially: six static Township instrument cases, the real-carrier live
  projection, stable-server fresh/stale/fresh recovery, and the shared browser carrier E2E.
- `mix lattice.township.verify_bundle --dir artifacts/township` passes and the tracked bundle is
  unchanged. Forced `MIX_ENV=test` and `MIX_ENV=prod` warnings-as-errors compilation both pass.
- `mix xref graph --format cycles` reports the unchanged five-cycle baseline. Sobelow exits zero in
  both `apps/lattice_server` and `apps/township_web`.
- Pinned-OTP-28 `mix verify` and `mix check` each pass the complete umbrella: 331 tests and 25
  properties, with strict Credo exiting zero. `mix format --check-formatted` and
  `git diff --check` pass.
- The focused production proof passes both `stable:relay:contract` and
  `tauri:stable-relay:onboarding:smoke`; the latter compares the app-authored full carrier frame to
  the Sim fixture before a distinct fresh-BEAM projection compares op ids, read model, and replay
  after server OS-process restart.

## Completion claim

Complete for this scoped increment. The actual packaged desktop Tauri onboarding ceremony uses
native custody and persisted capability state to author the exact Sim operation through the stable
durable relay; acknowledged outbox state survives server OS-process restart; and a distinct fresh
pull-only observer matches Sim. Generic push compatibility, failure/retry safety, trust separation,
mobile secure-store strategy, and all custody, mobile, server-push, deployment, G1/Phase G, and W4
non-claims remain proven. Server push, `/township` participant write controls, production
deployment, mobile relay, receipt-free W4, and complete G1/Phase G remain subsequent build-map work.
