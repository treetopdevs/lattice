# Design: AtomVM Browser Realm (a real BEAM tab behind the capability gateway)

**Date:** 2026-05-25
**Source plan:** [docs/plans/2026-05-23-atomvm-browser-design.md](../plans/2026-05-23-atomvm-browser-design.md)
**Status:** Approved · passed adversarial review 2026-05-25 ([review](../reviews/2026-05-25-atomvm-browser-realm.md))
**Method:** Produced via first-principles design — every constraint classified, every library claim verified against live docs (May 2026) and the actual codebase.

## Goal

Make the Lattice "tab realm" a **real BEAM process** running AtomVM-compiled-to-WebAssembly in the browser tab, executing the tab's protocol semantics itself, **without weakening the least-authority thesis** — the in-tab BEAM remains a sandboxed guest behind the unchanged server-side capability gateway.

## Approach

**Prebuilt raw AtomVM-WASM (Candidate A′).** Pin a prebuilt AtomVM **prerelease** web bundle (`AtomVM-web-v0.7.0-alpha.1.js` + `AtomVM-web-v0.7.0-alpha.1.wasm`, pinned by tag **+ sha256**); compile the tab's Elixir to `.beam` and pack it into a `.avm` with `mix atomvm.packbeam` (ExAtomVM); write our own thin, authority-blind JS host/bridge. **No emscripten SDK enters the toolchain.** Popcorn is retained only as a documented fallback if the bytecode-compatibility gate (below) fails.

**Why this over the plan's "build-from-source" Candidate A and over Popcorn:**

- AtomVM ships prebuilt browser WASM bundles as **release assets** (verified via `gh release view`): the web pair `AtomVM-web-<ver>.js` + `.wasm`. Pinning them **eliminates the plan's #1 risk** (emscripten build fragility) — we never run the emscripten SDK. **Caveat (Critical-2 from review):** the only OTP-28-capable web bundle is the **prerelease** `v0.7.0-alpha.1` ("APIs may change without warning"); a *stable* web bundle exists at v0.6.6 but predates OTP 28. We deliberately pin the alpha to keep `apps/lattice_tab` on the repo's Elixir 1.19 / OTP 28, betting (and Phase-0-gating) that the alpha accepts OTP-28 bytecode.
- Popcorn pins **Elixir 1.17.3 / OTP 26.0.2** ([Software Mansion](https://swmansion.com/blog/popcorn-bringing-elixir-to-the-browser-8993a58a00be/)), which diverges from this repo's **Elixir ~> 1.19 / OTP 28** ([mix.exs](../../mix.exs), [flagship.yml](../../.github/workflows/flagship.yml)); its bundle is **>3 MB**; and a prior attempt in *this repo* already logged Popcorn as a *"research blocker"* ([browser-beam-carrier-proof.json](../../output/browser_beam_carrier/browser-beam-carrier-proof.json)).
- A′ keeps us in control of the JS↔BEAM bridge, which matters for the thesis (we can prove the shell is authority-blind because we wrote it) and matches the repo's "no-shortcut / authoritative" ethos.

**The forced premise (validated, not assumed):** full BEAM/OTP cannot compile to WASM (size + NIF-heavy runtime). AtomVM is the only BEAM that runs in a browser today. "Real in-browser BEAM" therefore *requires* AtomVM-WASM — this is a validated truth, not an inherited preference.

## Architecture

### Components

| Component | New/Existing | Location |
|---|---|---|
| **Shell** (thin JS I/O shim) | New | `examples/atomvm_tab/shell.js`, `index.html` |
| **AtomVM runtime** (pinned prebuilt **alpha**) | New (staged, sha256-checked) | `examples/atomvm_tab/vendor/AtomVM-web-v0.7.0-alpha.1.{js,wasm}` + `atomvmlib-v0.7.0-alpha.1.avm` |
| **Realm** (in-tab BEAM process) | New | `apps/lattice_tab/lib/lattice/tab/realm.ex` |
| **Protocol** (pure state reducer) | New | `apps/lattice_tab/lib/lattice/tab/protocol.ex` |
| **Codec** (JSON in BEAM) | New | `apps/lattice_tab/lib/lattice/tab/codec.ex` |
| **Bridge** (BEAM side of JS interop) | New | `apps/lattice_tab/lib/lattice/tab/bridge.ex` |
| **Main** (`start/0` packbeam entry) | New | `apps/lattice_tab/lib/lattice/tab/main.ex` |
| **`.avm` packaging** | New | `apps/lattice_tab/mix.exs` (ExAtomVM) |
| **Static serving** (COOP/COEP + wasm MIME) | Extend | `apps/lattice_server/lib/lattice_server/static_handler.ex` |
| **Route wiring** | Extend | `apps/lattice_server/lib/lattice_server.ex` |
| **Gateway / envelope / WebSocket** | **Untouched** | `apps/lattice_core/.../gateway.ex`, `.../web_socket.ex`, `.../envelope.ex` |

**Authority split (the load-bearing distinction):**

- **Shell** ferries bytes (socket frame ↔ BEAM) and paints render-intents to the DOM. Makes **zero** authority decisions; never inspects `type`, never chooses a `cap_id`, never decides how to answer a `tab_call`.
- **Realm/Protocol** owns **100% of protocol semantics** *for the core demo* (see scope carve-out below).

### Data flow

```
INBOUND   ws.onmessage(json) → Bridge.deliver(bytes) → Realm receive
          → Codec.decode → Protocol.handle(state, env)
          → {state', [outbound], [render_intent]}
OUTBOUND  Protocol emits envelope → Codec.encode → Bridge → shell.send(json) → ws.send
RENDER    Protocol emits render_intent → Bridge → shell.render(intent) → DOM/animation
```

`Protocol.handle/2` is a **pure function**: `(state, inbound_envelope) -> {state', outbound_envelopes, render_intents}`. This is where every semantic decision lives, and it is trivially host-unit-testable with ExUnit (no WASM). The `Realm` process is a thin loop that owns the mutable state and the bridge glue.

### Interfaces

**Bridge contract (implementation-agnostic; exact AtomVM API names are Phase-0 criterion 1):**

- **Startup (Shell → BEAM):** `Bridge.start(client_id, last_seq)` — at boot the shell hands the Realm the opaque session identity it reads from `sessionStorage`. `client_id`/`last_seq` are transport-session values, not authority, so this keeps the shell authority-blind. The Realm composes `hello` using the provided `client_id` (without this channel, the Realm would invent a fresh `client_id` each reconnect and resume would perpetually `rehydrate` — see Review Issue 3).
- **Shell → BEAM (per frame):** `Bridge.deliver/1` receives raw inbound bytes, routed to the registered `Realm` process (via AtomVM's JS→BEAM mechanism, e.g. a `Module.cast`-style call).
- **BEAM → Shell:** `Realm` invokes **pre-registered** shell functions through AtomVM's BEAM→JS mechanism:
  - `latticeShell.send(jsonString)` → `ws.send`
  - `latticeShell.render(intentJson)` → DOM op
- **🔒 Security invariant (load-bearing — Review Issue 1):** the BEAM→JS path MUST pass data as **arguments to pre-registered functions**, never by building a JavaScript source string. The Realm must never interpolate envelope/codec bytes into an `emscripten:run_script/2` (eval) string — that would be a JS-injection sink in the tab origin (JWT/cap exfiltration) and a breach of the least-authority thesis. Proven by **Phase-0 criterion 1b (security)**.
- **Server protocol:** unchanged. The Realm produces/consumes exactly the envelopes already defined at the WebSocket boundary; to the server, the AtomVM tab is just another `{:tab, id}` target ([gateway.ex](../../apps/lattice_core/lib/lattice/gateway.ex)).

**Render-intent contract:** the Realm emits *semantic* intents (e.g. `%{kind: "pulse", ...}`, `%{kind: "ledger_event", ...}`, `%{kind: "status", text: "connected"}`); the shell holds a dumb `intent.kind → DOM op` map (mirroring the pulse animation at [client.js:381-411](../../examples/browser_demo/client.js:381)). No semantics in the shell.

## Detailed design

### Protocol scope (carve-out)

"Realm owns 100% of semantics" applies to **core-demo parity**:

- **Realm builds (tab→server):** `hello`, `grant_request`, `call`, `cast`, `state_request`, and the `tab_render_result` response.
- **Realm consumes (server→tab):** `welcome`, `grant`, `snapshot`, `presence`, `server_event`, `call_result`, `cast_result`, `tab_call`, `tab_cast`, `error`.
- **Shell keeps (transport-session continuity, not authority):** `resume` + `resume_ok` + `rehydrate` + the seq/JWT sessionStorage logic ([client.js:36-45,110-114,227-231](../../examples/browser_demo/client.js:36)), and transport-level `disconnect`. The shell also reads `client_id`/`last_seq` from `sessionStorage` and passes them to the Realm via `Bridge.start/2` (Review Issue 3), so the Realm-built `hello` carries the persistent `client_id`.
- **Out of scope:** `liveops_action` / `liveops_result` (a separate authority surface; not part of the demo being ported).

This reconciles against the real inbound whitelist frozen at [envelope.ex:9](../../apps/lattice_server/lib/lattice/transport/web_socket/envelope.ex:9): `hello resume state_request grant_request call cast liveops_action disconnect tab_render_result`.

### `Lattice.Tab.Protocol` — `apps/lattice_tab/lib/lattice/tab/protocol.ex`
- **Pattern:** pure reducer module (no process, no I/O). Mirrors how the server keeps decode separate from effect.
- **Behavior:** `handle(state, envelope)` returns `{state, [outbound], [render_intent]}`. Holds `tab_id`, `session_id`, held `cap_id`s, peers, demo state. Chooses which held `cap_id` to use when building a `call`/`cast`. **Stays inside AtomVM's subset** (no bitstrings, no big integers, no ETS).

### `Lattice.Tab.Realm` — `apps/lattice_tab/lib/lattice/tab/realm.ex`
- **Pattern:** a registered process running a `receive` loop (upgraded to `gen_server` only if Phase 0 confirms AtomVM's `gen_server` is adequate — the pure reducer makes this choice non-load-bearing).
- **Behavior:** on boot, builds `hello` and sends via Bridge. On each delivered frame, calls `Codec.decode` → `Protocol.handle` → emits outbound + render-intents through Bridge. Owns the single mutable `state`.

### `Lattice.Tab.Codec` — `apps/lattice_tab/lib/lattice/tab/codec.ex`
- **Behavior:** JSON encode/decode in BEAM. **Phase-0 criterion 4 decides** whether JSON is decoded in BEAM (raw string crosses the bridge — strongest shell-blindness) or in JS (shell parses *syntax* only, decoded structure crosses; BEAM still decides everything). Default lean: decode in BEAM; fall back to JS-parses-syntax if AtomVM's JSON support is immature. Both keep the shell authority-blind.

### `Lattice.Tab.Bridge` — `apps/lattice_tab/lib/lattice/tab/bridge.ex`
- **Behavior:** BEAM-side wrapper over the AtomVM JS-interop API. Registers `Realm` to receive JS→BEAM casts; exposes `start/2`, `send/1`, `render/1` that invoke **pre-registered** shell functions (never an eval-string — see the Security invariant above).
- **Threading (Phase-0 criterion 1):** `emscripten:run_script/2` runs JS in the worker thread by default; reaching the DOM/`ws.send` needs `[main_thread]`, which **blocks** the BEAM worker until the main thread completes — in tension with "don't block the UI thread." The COOP/COEP requirement confirms the web build uses SharedArrayBuffer/threads. The threading gate must be **measurable**: a send-latency budget (e.g. p99 < target) and a no-deadlock demonstration under load — not just "round-trip completes."
- **Alternative to evaluate in Phase 0 (Review Issue 7):** AtomVM ships a native `websocket` module (`websocket:new`, `send_utf8/2`), so the **BEAM could own the socket directly**, removing the outbound bridge hop and its threading hazard. "Shell owns the WebSocket" is a *choice* (it keeps resume/sessionStorage in JS), not a necessity — name the fork explicitly and decide on Phase-0 evidence.

### `Lattice.Tab.Main` — `apps/lattice_tab/lib/lattice/tab/main.ex`
- **Behavior:** exports `start/0` (packbeam entry point — the first module with `start/0` is the app entry) which boots `Realm`.

### `apps/lattice_tab/mix.exs`
- **Pattern:** minimal umbrella app, kept lean so it never drags server-only deps into AtomVM's OTP subset. Compiles on the umbrella's Elixir 1.19 / OTP 28 (the alpha-accepts-OTP-28 bet — Phase-0 bytecode gate). **If that gate fails,** `apps/lattice_tab` moves to a **separate build context** (e.g. an asdf-shimmed older Elixir/OTP invocation) — *not* a shared-`_build` `.tool-versions` pin, which a single umbrella cannot honor (Review Issue 2).
- **Behavior:** adds `:exatomvm` as a **build-only** dep; `mix atomvm.packbeam` produces `lattice_tab.avm`. A build script **fetches the pinned AtomVM web assets by release URL and verifies their published `.sha256`** (rather than committing the binary into git — Review Issue 10), then stages `lattice_tab.avm` + `atomvmlib.avm` + the VM into `examples/atomvm_tab/`.

### Shell — `examples/atomvm_tab/shell.js` + `index.html`
- **Pattern:** mirrors `examples/browser_demo/` structure; authority-blind.
- **Behavior:** owns the `/ws` WebSocket, the DOM/animation, and sessionStorage resume; reads `client_id`/`last_seq` and passes them via `Bridge.start/2`; loads `AtomVM-web-v0.7.0-alpha.1.js` with `lattice_tab.avm` (+ co-loaded `atomvmlib.avm`); wires Bridge both ways; emits an **"AtomVM ready"** beacon to the DOM once boot + first `welcome` complete (for deterministic E2E).
- **Authority-blindness criterion (replaces the ~100-line target — Review Issue 8):** the shell must have **zero branches on envelope `type`, `cap_id`, or `result`**. Authority-blindness is a logic property verified by inspection, not a line count (the JS demo's `client.js` is 459 lines; this shell will not be trivially smaller given WASM boot + resume + bridge).

### Static serving — `apps/lattice_server/lib/lattice_server/static_handler.ex`
- **Pattern:** preserve the existing **explicit-whitelist** `file_for/1` security property (it already rejects `..` and serves only named files). `File.read` already returns a binary, so `.wasm`/`.avm` bodies serve correctly as-is.
- **Behavior (edits):**
  1. Extend `content_type/1`: `.wasm → "application/wasm"`, `.js → "text/javascript; charset=utf-8"` (the AtomVM bundle ships as `.js`, not `.mjs`), `.avm → "application/octet-stream"`.
  2. Add explicit `file_for/1` entries for the atomvm_tab assets (`shell.js`, `AtomVM-web-v0.7.0-alpha.1.js`, `AtomVM-web-v0.7.0-alpha.1.wasm`, `lattice_tab.avm`, `atomvmlib.avm`, reuse `index.html`/`styles.css`).
  3. Accept an `isolate?` opt; when set, add `cross-origin-opener-policy: same-origin`, `cross-origin-embedder-policy: require-corp`, and `cross-origin-resource-policy: same-origin` to the reply at [static_handler.ex:23-28](../../apps/lattice_server/lib/lattice_server/static_handler.ex:23). Required by AtomVM's web build ([AtomVM docs](https://doc.atomvm.org/latest/getting-started-guide.html)).

### Route wiring + transport hardening — `apps/lattice_server/lib/lattice_server.ex`
- **Behavior:** add one route **before** the catch-all at [lattice_server.ex:31](../../apps/lattice_server/lib/lattice_server.ex:31):
  `{"/atomvm_tab/[...]", LatticeServer.StaticHandler, %{static_dir: atomvm_tab_dir, isolate?: true}}`, with `atomvm_tab_dir` defaulting to `examples/atomvm_tab`. The COOP/COEP headers are thus **scoped to the AtomVM page**, leaving the JS demo at `/` untouched.
- **Hardening (Review Issue 6 — applies to both tab types):** set `max_frame_size: 65_536` in the Cowboy protocol opts ([lattice_server.ex:38-47](../../apps/lattice_server/lib/lattice_server.ex:38)). It is currently unset (default `infinity`), so the [envelope.ex:11](../../apps/lattice_server/lib/lattice/transport/web_socket/envelope.ex:11) 65 536-byte cap is enforced only *after* Cowboy buffers the whole frame — a single oversized frame can exhaust memory. This closes a pre-existing, tab-agnostic gap and strengthens the "contained identically" claim.

## Constraint satisfaction

| Requirement | How satisfied | Verified by |
|---|---|---|
| Trust boundary does not move | Gateway, `envelope.ex` whitelist, JSON-only path all untouched; tab is a `{:tab}` target | Native red-team + stress parity; code diff review |
| Real BEAM runs the protocol | `Protocol`/`Realm` execute in AtomVM-WASM | WASM smoke test + Playwright E2E |
| No distribution | AtomVM dist deliberately not enabled; bytes are JSON over `/ws` | E2E + no dist deps in `.avm` |
| JSON-only, never `binary_to_term` | Codec uses JSON; server side already forbids it ([envelope.ex:6](../../apps/lattice_server/lib/lattice/transport/web_socket/envelope.ex:6)) | malformed-envelope test |
| WASM toolchain optional/isolated | `:exatomvm` build-only; prebuilt VM vendored; default CI job unchanged | `mix test` green with no new toolchain |
| COOP/COEP + wasm MIME | `static_handler` `isolate?` + new content types | E2E loads the VM successfully |
| Bridge passes no eval-string (no JS injection) | Pre-registered shell fns only; never interpolate bytes into `run_script` | Phase-0 security gate (1b) + shell/Bridge code inspection |
| Inbound frames bounded | `max_frame_size: 65_536` in Cowboy opts | oversized-frame stress test |
| Resume continuity preserved | `Bridge.start` supplies `client_id` to the Realm | reconnect E2E (no spurious `rehydrate`) |
| Realm host-unit-testable | Pure `Protocol` reducer | ExUnit on host BEAM |
| JS + AtomVM tabs coexist | Both are `{:tab}` targets; separate routes | "both contained" E2E scenario |
| Realm scope = core-demo parity | Carve-out above | parity E2E vs JS demo |

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **BEAM bytecode incompat** — alpha AtomVM rejects OTP-28 `.beam` | **High** | High | **Phase-0 bytecode gate.** If it fails, move `apps/lattice_tab` to a separate older-toolchain build context (not a shared-`_build` pin), or fall back to Popcorn |
| **Bridge eval / JS-injection** — server bytes reach a `run_script` string | Low (if invariant held) | **Critical** | Security invariant (pre-registered fns only); **Phase-0 criterion 1b** proves the bridge is not eval-string |
| **Alpha runtime instability** — prerelease "APIs may change without warning" | Med | Med | Pin exact tag **+ sha256**; CI hash check; revisit when v0.7.0 stabilizes |
| AtomVM OTP-subset gaps (no ETS/bitstrings/big-int, JSON maturity) | Med | Med | Pure `Protocol` kept minimal & subset-safe; shell-does-JSON-syntax fallback; criterion 4 |
| Bridge threading — `run_script([main_thread])` blocks the worker | Med | Med | Measurable Phase-0 threading gate (latency budget + no-deadlock); evaluate BEAM-owned `websocket` module |
| `.avm` packaging — `mix atomvm.packbeam` web path / `atomvmlib.avm` co-load unproven | Med | Med | Explicit Phase-0 packaging gate (loads in the web runtime with `atomvmlib.avm`) |
| Unbounded WebSocket frame → memory exhaustion | Med | Med | `max_frame_size: 65_536` (tab-agnostic; also closes a pre-existing gap) |
| emscripten build fragility | **Low** (was the plan's #1) | Med | **Retired** by using prebuilt assets — no SDK |
| Payload size (web `.wasm`, not just the ~190 KB VM) | Low | Low | Confirm actual size in Phase 0; fetch-by-URL keeps it out of git |
| E2E flakiness from WASM load time | Med | Low | Explicit "AtomVM ready" beacon before any assertion |
| Host tests pass but WASM fails (subset drift) | Med | Med | Native tests are necessary-not-sufficient; the guarded WASM smoke test is mandatory before claims |

## Non-goals preserved

- **No AtomVM distribution protocol** — the tab is a guest, not a node.
- **No new server trust** — gateway treats AtomVM-tab bytes identically to JS-tab bytes.
- **No ambient authority in the tab** — cannot mint a cap, address a raw pid, or speak dist.
- **JS tab keeps working** — end state runs both against one gateway.
- **Resume stays in the shell** — not pulled into WASM.
- **No LiveOps port; no in-tab OTP topology** (the supervisor/link/monitor stretch stays deferred).

## Dependencies

- **AtomVM web bundle** — **prerelease**, pinned to `v0.7.0-alpha.1`: `AtomVM-web-v0.7.0-alpha.1.js` + `AtomVM-web-v0.7.0-alpha.1.wasm` + `atomvmlib-v0.7.0-alpha.1.avm`, fetched by release URL and **verified against the published `.sha256`** (CI hash check). Asset names + prerelease status confirmed via `gh release view`. Note: a *stable* web bundle exists at v0.6.6 but predates OTP 28 — the alpha is required for the OTP-28-on-repo-toolchain bet.
- **`:exatomvm`** (ExAtomVM Mix plugin) — build-only dep; provides `mix atomvm.packbeam` (which invokes the `atomvm_packbeam` tool — the opt-in CI job must install it). — [verified](https://github.com/atomvm/exatomvm).
- **Existing:** `:cowboy ~> 2.12`, `:jason ~> 1.4`. Unchanged.
- **Popcorn** — *not added* unless A′ fails; would pin Elixir 1.17.3 / OTP 26.0.2 (a divergent toolchain).

## Testing strategy

1. **Host unit tests (ExUnit, no WASM)** — `Lattice.Tab.Protocol`: every transition (hello build, welcome/grant/snapshot consume → render-intent, call/cast build with cap selection, **tab_call → computed tab_render_result**, error handling). Bulk of the logic verified natively.
2. **Guarded WASM smoke test** — build `.avm`, load AtomVM, round-trip one envelope + the fake-`welcome`→emit-`hello` flow. Behind a tag; **excluded from default `mix test` and the default CI job**.
3. **Playwright E2E** (`scripts/lattice_atomvm_tab_e2e.mjs`, mirroring [lattice_browser_e2e.mjs](../../scripts/lattice_browser_e2e.mjs)) — connect → grant → allowed call → **denied fake cap** → `tab_call`→render → **revoke-then-denied**, gated on the AtomVM-ready beacon; plus the "JS tab + AtomVM tab both contained" scenario.
4. **Adversarial parity — a Phase-2 acceptance gate, not Phase-4 (Review Issue 5).** The existing red-team lab uses server-local `LocalTab` ([sandbox.ex:6-11](../../apps/lattice_core/lib/lattice/red_team/sandbox.ex:6)), so it does **not** exercise the WebSocket boundary. Add **over-the-WebSocket** denial tests driven from an AtomVM-tab session (forged cap, replay-after-revoke, malformed/oversized envelope), using `LatticeStress.WebSocketAbuseTest` as the template. **"No new server trust" may not be claimed until these pass.**
5. **CI** — a **separate opt-in job** that installs the AtomVM toolchain, builds the `.avm`, runs the guarded smoke + AtomVM E2E, and uploads to `output/`. The default [flagship.yml](../../.github/workflows/flagship.yml) stays green with zero new required toolchain.

## Phasing (adopting A′)

| Phase | Deliverable | Done when |
|---|---|---|
| **0 · Spike A′** (Popcorn = fallback) | Gates: **(a)** the pinned **alpha** bundle loads in a COOP/COEP page; **(b) bytecode** — `mix atomvm.packbeam` on the **repo toolchain (1.19/28)** yields a `.avm` that loads in `v0.7.0-alpha.1` *with* `atomvmlib.avm`; **(c)** JS↔BEAM round-trip; **(d) security (1b)** — the BEAM→JS path uses pre-registered functions, not an eval-string; **(e) threading** — measured send latency + no deadlock; **(f)** fake `welcome` → emit `hello` (JSON) | All gates pass for A′ (else separate build context, or fall back to Popcorn) |
| **1 · Skeleton** | `apps/lattice_tab` compiles + packs; `examples/atomvm_tab` served via new route + COOP/COEP + `max_frame_size`; empty `Realm` boots; `Bridge.start` supplies `client_id`; bridge wired both ways | Tab sends real `hello` (shell-supplied `client_id`), gets `welcome`, shell shows "connected" |
| **2 · Focused milestone + containment proof** | `Realm` answers `tab_call` with a **real computed** `tab_render_result` (replaces the **synchronous** stub at [worker-client.js:110-121](../../examples/browser_demo/worker-client.js:110)); **over-the-WebSocket denial tests pass** (forged cap, revoke-then-denied) | Mediated pulse flows through real BEAM; **denial parity proven over the WS boundary** (Issue 5) |
| **3 · Full tab realm** | `Protocol` owns the whole core-demo state machine; shell is thin I/O (zero envelope-content branches) | Behavior parity with the JS demo; all core-demo protocol logic is BEAM |
| **4 · Evidence & hardening** | Playwright E2E; "JS tab + AtomVM tab both contained"; docs move AtomVM "future work" → "implemented (narrow)"; opt-in CI job (installs AtomVM toolchain + `atomvm_packbeam`, sha256-checks the staged VM) + `output/` artifact | Reproducible evidence artifact in `output/` |

## Documentation to update (Phase 4)

Move the "AtomVM is future work" disclaimers → "implemented (narrow)" in: [docs/research/architecture.md](../research/architecture.md), [docs/authority_invariants.md](../authority_invariants.md), [docs/research/paper_skeleton.md](../research/paper_skeleton.md), [docs/stress_lab.md](../stress_lab.md), and [docs/threat_model.md](../threat_model.md) (the 5th doc, whose current disclaimer ties the carrier work to the *Popcorn* toolchain — to be rewritten for A′).

## Open questions resolved by the Phase-0 spike

1. Exact AtomVM JS↔BEAM bridge API names + **threading model** (worker vs `[main_thread]` blocking), held to a **measurable** latency/no-deadlock bar (criterion 1).
2. **Bridge security (criterion 1b):** confirm the BEAM→JS path is a structured/registered-function call, **not** an eval-string, and that no codec bytes are ever interpolated.
3. JSON decode location — BEAM (raw string) vs JS (decoded structure). Both keep the shell authority-blind.
4. Whether the **alpha** AtomVM (`v0.7.0-alpha.1`) accepts **OTP-28** bytecode on the repo toolchain, or `apps/lattice_tab` needs a separate older-toolchain build context.
5. Whether `mix atomvm.packbeam` output loads in the web runtime, and which stdlib `.avm` (`atomvmlib.avm`) must be co-loaded.
6. Whether AtomVM's in-WASM process support is rich enough for the later deferred "in-tab OTP topology" stretch.
