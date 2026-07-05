# Browser BEAM Carrier — Design & Reconciliation

Date: 2026-05-22
Branch: `spike/browser-beam-carrier`
Status: reconciliation record — committed work exists; this document aligns the
intended design with reality and scopes the remaining work.

2026-07-05 sync note: M2 supersedes the old carrier-planning framing with a hardened
WebSocket carrier substrate for BEAM peers (`Lattice.Carrier`,
`Lattice.Carrier.Wire`, canonical signed bytes, session auth, batching, and browser
log-store payloads). This document remains the historical server-side distribution
boundary record; native browser/AtomVM acceptance is still separate work.

## Why this document exists

A brainstorming pass proposed a two-phase plan:

1. **Safe target (option 1):** prove "origin is not authority" by tagging the
   *existing* Cowboy JSON WebSocket envelope with an advisory `origin: :beam`
   field and asserting the membrane ignores it.
2. **Stretch (option 3):** introduce `web_socket_dist` as a carrier and prove
   raw-distribution behaviors fail closed.

On checkout, the branch already contained commit `5f1f4ab "Add browser BEAM
carrier spike"`, which **did not take the option-1 path**. It went directly to a
more complete option-3-style carrier boundary in an isolated umbrella app. This
document reconciles the two: it records what is committed, corrects assumptions
the brainstorm made, and scopes what genuinely remains.

## The invariant (unchanged)

> Authority lives in the cap + the server-side membrane, never in the origin or
> carrier of the bytes. A browser BEAM node is on the **untrusted** side of
> `Lattice.Gateway`, exactly like the JS client and exactly like a raw
> distribution peer.

This extends the existing family of "X is not authority" properties already
proven in the repo: roles are not authority (`lattice_liveops_test.exs`) and
cookie possession is not authority (`docs/threat_model.md`).

## What is committed (`5f1f4ab`)

A separate umbrella app, `apps/lattice_carrier_spike`, deliberately **not** wired
into the main JSON WebSocket demo. The clean WS resume layer stays the
production-facing surface; the carrier is explored behind a fail-closed boundary.

| Component | File | Role |
| --- | --- | --- |
| Distribution filter | `lib/lattice_carrier_spike/filter.ex` | `tcp_filter_dist` policy. Allows only a JSON logical-call frame sent to the single gateway registered name; denies `reg_send` to any other name, pid send, alias send, spawn, monitor, link, exit, group-leader, RPC-shaped, and unknown control messages (`:raw_distribution_denied` catch-all). |
| Logical gateway | `lib/lattice_carrier_spike/browser_gateway.ex` | The one allowlisted registered process. Decodes a frame and calls `Lattice.call/3` — **no `Lattice.Gateway` bypass**. Audits `:browser_beam_carrier_call` / `:browser_beam_carrier_denied`. |
| Frame parser | `lib/lattice_carrier_spike/message.ex` | JSON-only, 16 KiB cap, strict `lattice_call` schema, `safe_id?` charset/length checks. Never `binary_to_term`. |
| Listener seam | `lib/lattice_carrier_spike/runtime.ex`, `mix lattice.browser_carrier.server` | Real `web_socket_dist` listener under `-proto_dist Elixir.TCPFilter`. |
| Proof | `mix lattice.browser_carrier.proof` | Writes `output/browser_beam_carrier/browser-beam-carrier-proof.json`. |
| Tests | `test/browser_carrier_spike_test.exs` | See acceptance matrix below. |
| Echo target | `lib/lattice_carrier_spike/echo_target.ex` | Cap-gated target used to observe (non-)delivery. |
| Research notes | `docs/research/browser_beam_carrier_spike.md` | Honest "what kept Popcorn out" + next steps. |

## Corrections to the brainstorm's assumptions

1. **The option-1 "origin tag on the WS envelope" layer was not built and is
   largely redundant for the carrier.** The carrier frame is JSON-only with a
   string `cap_id`. A browser BEAM agent therefore *cannot present a
   `%Cap{}` struct, fabricated provenance, or a forged `root_id`* over the
   carrier at all — those cheats are **structurally unrepresentable**, which is a
   stronger guarantee than "the membrane ignores them." Only an opaque id
   crosses, and the server-held struct is the sole authority.

2. **The forged-cap cheat is already proven.** Committed test
   `"gateway denies forged or malformed logical calls without ambient delivery"`
   sends `cap_id: "not-a-real-cap"` and asserts `:unknown_cap`, zero target
   delivery, and a `:browser_beam_carrier_denied` audit entry.

3. **The real blockers to a full browser proof are feasibility, not threat
   model** (already documented in the research note): Popcorn is AtomVM-in-an-
   iframe with `postMessage` JSON and distributed Erlang still beta/not
   downstreamed; `web_socket_dist` / `tcp_filter_dist` are GitHub-only (not Hex);
   the browser JS carrier ships via GitHub Packages without built artifacts — so
   no reproducible, unauthenticated Playwright proof is possible today.

## Acceptance matrix

GATE rows are server-side and deterministic. ARTIFACT rows require the browser
runtime and are deferred for the feasibility reasons above.

| Claim | Layer | Evidence | State |
| --- | --- | --- | --- |
| One logical call over the carrier routes through `Lattice.Gateway` | GATE | test 1; graph shows tab/cap/target edges; `:cap_use` + `:browser_beam_carrier_call` audited | committed |
| Hostile raw-distribution shapes fail closed before delivery | GATE | test 2 (reg-name, pid send, RPC-shaped, spawn); `EchoTarget` call_count 0 | committed |
| Forged / malformed logical calls denied without ambient delivery | GATE | test 3 (`:unknown_cap`, call_count 0) | committed |
| BEAM-native struct/provenance forgery is unrepresentable over the carrier | GATE | frame schema in `message.ex` (JSON-only, string ids) | committed (implicit) |
| Replay of a used `use_limit: 1` cap over the carrier is denied | GATE | `"replay of a used single-use cap over the carrier is denied"` in `browser_carrier_spike_test.exs` (`:use_limit_exceeded`, no second delivery) | committed (`ab08264`) |
| Real Popcorn agent completes a logical call from a browser tab | ARTIFACT | — | **deferred (feasibility)** |
| Optional: `origin: :beam` on the *main* WS demo is audited, never authority | GATE | — | **optional, not started** |

## Remaining work, in priority order

1. ~~**Close the replay GATE gap.**~~ Done in `ab08264`. The same commit also
   replaced `Process.sleep`-based synchronization in the suite with a
   deterministic `GenServer.call(gateway, :state)` flush, removing an
   order-dependent flake in the forged-cap test (cold-VM module loading could
   exceed the old 20ms sleep).
2. **Pick one honest browser-side completion step** (from the research note):
   vendor/reproducibly build `@otp-interop/web-socket-dist`, add a Popcorn iframe
   agent that calls the JS carrier shim, and run the listener under
   `-proto_dist Elixir.TCPFilter` — then replay the GATE cases from a real page.
   Until this lands, describe the branch as a **server-side carrier-boundary
   proof**, not full browser-Popcorn acceptance.
3. **Optional, separate surface:** if an "origin is not authority" property is
   wanted on the main JSON WS demo (not the carrier), add an advisory `origin`
   field that is audited but never read by `Gateway`/`CapStore`, with a parity
   test. This is independent of the carrier and lower value given the carrier
   already makes forgery unrepresentable.

## Verification note

The committed GATE tests above are described from the test source, not from a
run in this session. Recommended check before relying on them:

```sh
mix test apps/lattice_carrier_spike/test
mix lattice.browser_carrier.proof
```
