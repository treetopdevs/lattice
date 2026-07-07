# Design: Really Adding AtomVM to the Browser Side

Date: 2026-05-23
Status: Validated design, not yet implemented. M2 has since landed the shared carrier
prerequisites (`Lattice.Canonical`, `Lattice.Carrier.Wire`, session auth, and browser
log-store payloads), but this AtomVM/WASM tab realm itself is still future work.

## Problem

At design time, a Lattice "tab realm" was ~450 lines of JavaScript
(`examples/*/client.js`) that connected to the Cowboy WebSocket at `/ws` and exchanged
strict JSON envelopes through the capability gateway. The browser only ever
*described* a process; no BEAM ran in the tab. This design makes the tab realm a
**real BEAM process** running AtomVM compiled to WebAssembly, without weakening the
least-authority thesis.

## Decisions taken (the three forks)

1. **Cap-preserving, not distributed.** The tab runs real BEAM bytecode but
   keeps the JSON-envelope-over-WebSocket capability boundary. We **deliberately
   do NOT enable AtomVM's 2025 distribution protocol.** The browser BEAM is a
   guest in a sandbox, not a node in the cluster. That non-choice is itself a
   thesis statement: even a genuine browser-side BEAM cannot escape the gateway.
2. **Spike both toolchains first.** Raw AtomVM-WASM vs Popcorn is decided by a
   timeboxed bake-off with hard go/no-go gates before any realm code is written.
3. **Full tab realm in BEAM (north star).** AtomVM owns the entire tab state
   machine; JS shrinks to a pure I/O shim. Reached via a focused first milestone
   (the `tab_call` handler).

## Section 1 — Architecture: the tab as a sandboxed BEAM realm

The trust boundary **does not move**. The server's `Lattice.Transport.WebSocket`
handler and the gateway are untouched.

```
 BROWSER TAB                                    SERVER (unchanged)
┌─────────────────────────────────────┐       ┌──────────────────────┐
│ Shell (JS, thin I/O)  ~100 lines     │       │ Lattice.Transport.   │
│  • owns WebSocket to /ws             │◄─ws──►│   WebSocket + Gateway │
│  • owns DOM + animation              │       │ • cap ownership/expiry│
│  • owns sessionStorage resume        │       │ • revocation/use-limit│
│  • makes ZERO authority decisions    │       │ • audit + topology    │
└──────────────┬──────────────────────┘       └──────────────────────┘
   cast(frame) │ ▲ run_script(frame | render-intent)
┌──────────────▼──────┴───────────────┐
│ Bridge (AtomVM emscripten port)      │  ← exact API verified in spike
├──────────────────────────────────────┤
│ Realm (BEAM in AtomVM-WASM)          │
│  Lattice.Tab.Realm  (gen_server)     │
│  • holds tab_id, held cap_ids, peers │
│  • builds hello/grant_request/call   │
│  • consumes welcome/grant/snapshot…  │
│  • handles tab_call → tab_render_result (REAL handler, was fake setTimeout) │
└──────────────────────────────────────┘
```

- **Shell (JS):** ferries bytes only (socket frame → BEAM, BEAM → socket) and
  applies render-intents to the DOM. Deliberately authority-blind.
- **Realm (BEAM):** the same Elixir that could run server-side, now executing in
  the tab. Owns tab state and speaks the protocol.

Why this is the strongest proof: the thing on the other end of the gateway is now
a real BEAM runtime, and it **still** has zero ambient authority — it cannot mint
a cap, address a raw pid, or speak distribution.

## Section 2 — Build pipeline & the spike bake-off (Phase 0)

A timeboxed bake-off with hard gates before any realm code.

**Candidate A — Raw AtomVM-WASM.** Install emscripten SDK → build AtomVM's
emscripten target → `AtomVM.js` + `AtomVM.wasm`. Compile tab Elixir → `.beam` →
bundle with `packbeam` into a `.avm`. Artifact ~190 KB VM + small `.avm`. Full
control of JS host + bridge.

**Candidate B — Popcorn (Software Mansion).** Add as a mix dep; its bundler
produces WASM + packed bytecode and ships a JS interop package. Constraints to
verify: pins **Elixir 1.17.3 / OTP 26.0.2**, artifacts **>3 MB**, **no
bitstrings / ETS / big integers**. Faster to first light; heavier, more
constrained.

**Gate — the spike must prove four things for each candidate:**

1. **Builds** reproducibly on this machine.
2. **Loads** AtomVM in a tab served by the existing `static_handler.ex`.
3. **Round-trips one message** JS→BEAM→JS across the bridge.
4. **Parses/produces one real JSON envelope** in BEAM (consume a fake `welcome`,
   emit a `hello`) — flushes the JSON-codec maturity risk, not just byte passing.

**Decision rubric:** pick the candidate that loads + round-trips reliably, keeps
payload acceptable, lets us write idiomatic-enough Elixir, and does not force
features AtomVM lacks. **Tie-break → Raw AtomVM-WASM** for control and
defensibility (matches the repo's "no shortcut / authoritative" ethos); choose
Popcorn only if it *dramatically* de-risks.

**Guardrail:** the WASM build is an **optional, isolated** target behind its own
script/flag. `mix test` and existing demos keep working with zero new required
toolchain.

## Section 3 — Message contract & data flow

```
INBOUND   ws.onmessage → JSON.parse → cast(realm, frame) → Realm.handle
OUTBOUND  Realm builds envelope → bridge → JSON.stringify → ws.send
RENDER    Realm decides semantic UI state → bridge → shell paints DOM/animation
```

**Load-bearing decision: the shell does JSON *syntax*; the Realm owns 100% of
*semantics*.** JSON (de)serialization is a codec, not an authority decision —
analogous to the server using Jason as a library. The shell never inspects
`type`, never decides to send a `call`, never picks a `cap_id`, never chooses how
to answer a `tab_call`. It is a dumb pipe plus a dumb painter. Whether the bytes
crossing the bridge are the raw JSON string (BEAM decodes) or a pre-decoded
structure (JS parses syntax, BEAM still decides everything) is **settled by spike
criterion 4** — both variants keep the shell authority-blind.

**Realm protocol responsibilities** (maps to the envelope types handled in
`apps/lattice_server/lib/lattice/transport/web_socket.ex` and
`.../web_socket/envelope.ex`):

| Direction | Envelope | Realm behavior |
|---|---|---|
| out | `hello`, `resume`, `state_request` | builds on connect |
| out | `grant_request`, `call`, `cast` | constructs; chooses held `cap_id` |
| in  | `welcome` | stores `tab_id`, `session_id` |
| in  | `grant` | stores the issued `cap_id` |
| in  | `snapshot` / `presence` / `server_event` | updates state → render-intent |
| in  | `call_result` / `cast_result` | updates state → render-intent |
| **in** | **`tab_call`** | **runs REAL handler → emits `tab_render_result`** (was the fake `setTimeout` in `worker-client.js` / `client.js`) |
| in  | `tab_cast`, `error`, `disconnect_result` | handled in-realm |

The `tab_call` row is the heart of the proof: a genuine BEAM process in the
browser answering a capability-mediated call. The existing
`examples/browser_demo/worker-client.js` `renderWorkerResult()` is the precedent
being replaced by BEAM.

## Section 4 — Phasing & code layout

| Phase | Deliverable | Done when |
|---|---|---|
| **0 · Bake-off** | Chosen toolchain; throwaway tab loads AtomVM + round-trips a JSON envelope | Go/no-go gate passes for A or B |
| **1 · Skeleton** | Build target wired (Elixir→`.beam`→`.avm` or Popcorn bundle), served by `static_handler.ex`; empty `Lattice.Tab.Realm` boots in-tab; bridge wired both ways | Tab sends real `hello`, receives `welcome`, shell shows "connected" |
| **2 · Focused milestone** | `Realm` answers `tab_call` with a **real computed** `tab_render_result` (kills the fake `setTimeout`) | Mediated-bridge pulse flows through actual BEAM; E2E proves it |
| **3 · Full tab realm** (north star) | `Realm` owns the whole state machine — lifecycle, held caps, building `grant_request`/`call`/`cast`, consuming all inbound, driving render-intents; shell ~100 lines of pure I/O | Behavior parity with the JS demo; **all** protocol logic is BEAM |
| **4 · Evidence & hardening** | Playwright E2E for the AtomVM tab; denial cases still deny against the BEAM tab; docs move AtomVM "future work" → "implemented (narrow)"; verify-script + CI wiring | Reproducible evidence artifact in `output/` |

**Code layout (spike confirms):** a dedicated compilation unit
`apps/lattice_tab/` whose Elixir compiles to a packed `.avm` (kept minimal so it
never drags server-only deps into AtomVM's OTP subset), plus
`examples/atomvm_tab/` for the JS shell + HTML + built artifacts (mirrors
`examples/browser_demo/`).

**YAGNI / safety calls:**

- **Resume/reconnect (seq + JWT) stays in the shell** — it is transport-session
  continuity, not capability authority. The Realm just re-`hello`s and rebuilds
  state on reconnect.
- **The JS tab keeps working.** End state runs a JS tab *and* an AtomVM tab
  against the same gateway — both equally contained. Strong evidence artifact;
  existing demos never break.

## Section 5 — Risks, threat model, testing, the proof

**Top risks, ranked:**

| Risk | Mitigation |
|---|---|
| emscripten build fragility / version pinning (Popcorn pins Elixir 1.17.3/OTP 26) | Phase 0 spike; build optional + isolated from `mix test` |
| AtomVM OTP-subset gaps (no ETS, bitstring limits, JSON maturity) | Realm kept minimal; shell-does-JSON-syntax; spike criterion 4 |
| Payload size (Popcorn >3 MB vs raw ~190 KB) | Acceptable for a research demo; a factor in the bake-off rubric |
| Bridge async semantics (main-thread vs worker, blocking) | Spike pins exact API + threading model |
| E2E flakiness from WASM load time | Explicit "AtomVM ready" signal before any assertion |

**Threat-model impact (update `docs/threat_model.md`):** shipping a real BEAM
runtime into the tab adds attack surface, so the design re-confirms *zero new
server trust* — the gateway treats AtomVM-tab bytes **identically** to JS-tab
bytes: untrusted JSON, never `binary_to_term` (`envelope.ex` already forbids
this), no distribution, `.avm` is static content. The `Lattice.RedTeam.Sandbox`
/ `lattice_stress` lab gains an **AtomVM-tab variant** of the existing attacks
(fake cap, replay-after-revoke, malformed envelope) to prove the BEAM tab is
contained *identically* to the JS tab.

**Testing — the key leverage:** `Lattice.Tab.Realm` is **plain Elixir**, so its
protocol state machine is unit-testable on the server BEAM with ExUnit, **no
WASM required**. Most logic is verified natively; only the thin bridge needs the
browser. Then: a guarded WASM smoke test (`.avm` loads + round-trips); a
Playwright E2E mirroring `scripts/lattice_browser_e2e.mjs` (connect → grant →
allowed call → denied fake cap → `tab_call`→render → revoke-then-denied); plus
the "JS tab + AtomVM tab both contained" scenario; wired into the verify-script +
CI evidence path.

**The proof, restated:** a real AtomVM/BEAM runtime executes the tab's *entire*
protocol logic in the browser, and **every capability invariant that held for the
JS tab still holds** — fake caps denied, revoked caps denied, no raw
pid/dist/ambient authority — demonstrated by native unit tests + browser E2E,
with docs and threat model updated.

## Open questions the spike resolves

- Exact AtomVM emscripten JS↔BEAM bridge API names and the async/threading model
  (main thread vs worker).
- Whether JSON decode happens in BEAM (raw string crosses the bridge) or in JS
  (decoded structure crosses) — both keep the shell authority-blind.
- Final code placement (`apps/lattice_tab/` vs a source dir packed into `.avm`).
- Whether AtomVM's in-WASM process support is rich enough to later attempt the
  "tab-side OTP topology" stretch (supervisor + link/monitor in-tab), which was
  explicitly deferred.

## References

- AtomVM — Tiny Erlang VM, supports browsers/Node via WebAssembly (emscripten):
  https://github.com/atomvm/AtomVM and https://doc.atomvm.org/main/
- AtomVM 2025 Year in Review (distribution protocol, epmd):
  https://medium.com/@Bettio/atomvm-2025-year-in-review-c669597d396c
- Popcorn — Elixir in the browser on AtomVM-WASM (Software Mansion):
  https://swmansion.com/blog/popcorn-bringing-elixir-to-the-browser-8993a58a00be/
- Key existing source: `apps/lattice_server/lib/lattice/transport/web_socket.ex`,
  `.../web_socket/envelope.ex`, `examples/browser_demo/worker-client.js`,
  `scripts/lattice_browser_e2e.mjs`.
