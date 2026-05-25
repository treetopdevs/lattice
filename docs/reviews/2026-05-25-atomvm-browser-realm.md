# Adversarial Review: AtomVM Browser Realm

**Date:** 2026-05-25
**Design:** [docs/designs/2026-05-25-atomvm-browser-realm.md](../designs/2026-05-25-atomvm-browser-realm.md)
**Reviewers:** Skeptic, Pragmatist, Adversary (3× sonnet, independent contexts)

## Summary

The approach (A′ — prebuilt AtomVM-WASM behind the unchanged gateway) **survives** review: the server-side capability boundary is genuinely strong and correctly untouched, and the reviewers found no flaw that invalidates the thesis. However, the design ships **two critical issues** — a security invariant that must be stated before any bridge code (the `run_script` eval/injection surface), and a set of **materially wrong library claims** (the AtomVM web bundle is a *prerelease* with different file names; OTP-28 support is alpha-only). Both are fixable by editing the design, not by changing the approach. Verdict: **ITERATE**.

## Cost/Benefit Analysis (confirmed findings)

| # | Finding | Severity | Cost to Fix | Cost to Ignore | Verdict |
|---|---------|----------|-------------|----------------|---------|
| 1 | `run_script` eval → JS-injection if envelope bytes are interpolated | Critical | Low (state invariant + Phase-0 security gate) | Arbitrary JS in tab origin; JWT/cap exfiltration | **MUST FIX** |
| 2 | AtomVM web bundle is prerelease/alpha; wrong asset names; OTP-28 alpha-only; fallback ≠ simple pin | Critical | Low (correct deps/risks/phasing text) | Spike stalls on missing files; misleading risk posture | **MUST FIX** |
| 3 | `client_id`/resume interface gap (Realm `hello` needs shell-owned `client_id`) | Important | Low (add `Bridge.start/…` startup channel) | Resume silently breaks → every reconnect rehydrates | **SHOULD FIX** |
| 4 | `mix atomvm.packbeam` web path + co-loaded `atomvmlib.avm` unverified | Important | Low (one explicit Phase-0 gate) | Phase 1 skeleton blocked on packaging surprise | **SHOULD FIX** |
| 5 | "Denial still denies" untested for the BEAM tab; scheduled too late (Phase 4) | Important | Med (write WS-driven denial tests at Phase 2) | Core thesis unproven for the WASM path at ship | **SHOULD FIX** |
| 6 | `max_frame_size` unset → giant-frame memory exhaustion | Important | Low (`max_frame_size: 65_536`) | OOM via one oversized frame (pre-existing, tab-agnostic) | **SHOULD FIX** |
| 7 | Bridge threading: `run_script([main_thread])` blocks; gate lacks failure def; native WS alt unexamined | Important | Low (sharpen Phase-0 threading gate) | UI/scheduler stalls or deadlock under load | **SHOULD FIX** |
| 8 | "~100-line shell" unrealistic (client.js = 459) | Minor | Low (drop line target → decision-point criterion) | Weakens auditability narrative only | **ACCEPT (reframe)** |
| 9 | `tab_render_result.result` forwarded unvalidated | Minor | Med (shape/size guard) | Pre-existing; AtomVM doesn't worsen it | **DEFER (note)** |
| 10 | Vendoring WASM binary in git / size unverified | Minor | Low (fetch-by-URL+sha256 in build) | Repo bloat; manual upgrades | **ACCEPT (reframe)** |
| 11 | Opt-in CI job underspecified (`atomvm_packbeam` native tool) | Minor | Low (sketch job steps) | Phase-4 CI friction | **ACCEPT (defer to Phase 4)** |
| 12 | `cap.ex:112` `String.to_existing_atom` crash path | Minor | Low (try/rescue) | Not browser-reachable today | **ACCEPT RISK** |

## Critical Issues (Must Fix)

### Issue 1: The BEAM→JS bridge is an `eval` surface — server-influenced bytes must never enter the script string
- **Found by:** Adversary (corroborated by Skeptic's read of `libs/avm_emscripten/src/emscripten.erl`)
- **Evidence:** The design names the BEAM→Shell mechanism as "e.g. `emscripten:run_script/2`" ([design:64](../designs/2026-05-25-atomvm-browser-realm.md)). Emscripten's `run_script` family executes its argument via JS `eval`. AtomVM's `emscripten` module exports `run_script/1,2` with `run_script_opt() :: main_thread | async`. If `latticeShell.send(jsonString)` is realized as `run_script("latticeShell.send(" <> json <> ")")`, the JSON — which originates from server-sent envelopes — can break out and inject arbitrary JS into the tab's origin.
- **Impact:** Arbitrary JS execution in the AtomVM tab origin: exfiltration of the resume JWT / `sessionStorage`, forged envelopes, pivot to same-origin `/api/session-token`. This would also *break the least-authority thesis* (a path to ambient authority inside the tab).
- **Recommended fix:** Add a **security invariant** to the design: the Realm may only invoke **pre-registered shell functions** with structured/typed arguments; it must **never** interpolate codec/envelope bytes into a `run_script` string (prefer AtomVM's structured call/registered-function mechanism over `run_script` string-building for any data path). Promote this to **Phase-0 criterion 1b (security)**: prove the chosen bridge passes data out-of-band, not via eval-string.

### Issue 2: The AtomVM web bundle is a *prerelease* with different filenames, and OTP-28 support is alpha-only
- **Found by:** Skeptic + Pragmatist + Adversary (independently)
- **Evidence (`gh release view`, verified):**
  - v0.7.0-alpha.1 and v0.7.0-alpha.0 are both **`Pre-release`**; **v0.6.6** is the latest **stable**.
  - v0.7.0-alpha.1 web assets are **`AtomVM-web-v0.7.0-alpha.1.js`** + **`AtomVM-web-v0.7.0-alpha.1.wasm`** — **not** `AtomVM.mjs`/`AtomVM.wasm` as the design states ([design:14,31,157](../designs/2026-05-25-atomvm-browser-realm.md)). There is **no separate `*.worker.js` asset**.
  - A **stable** web bundle exists (`AtomVM-web-v0.6.6.js/.wasm`) but the v0.6.x line predates OTP 28; **OTP-28 bytecode support is only in the v0.7.0-alpha line / main**.
  - The umbrella requires `elixir: "~> 1.19"` and CI runs OTP 28 ([flagship.yml](../../.github/workflows/flagship.yml)). The "pin `apps/lattice_tab`'s compiler via `.tool-versions`" fallback is therefore **not a simple pin**: a single umbrella's shared `_build`/`mix.lock` cannot compile one app under a different OTP — it needs a **separate build context** (e.g. an asdf-shimmed standalone `mix` invocation).
- **Impact:** As written, the spike's "copy the vendored bundle" step references files that don't exist; the design implies a stable, low-risk artifact when the only OTP-28-capable browser bundle is **alpha** ("APIs may change without warning"); and the bytecode-fallback is undersold.
- **Recommended fix:** In **Dependencies**, name the real assets (`AtomVM-web-<ver>.js` + `.wasm`), mark them **prerelease/alpha**, and pin an exact tag **+ sha256** (the releases ship `.sha256` files; add a CI hash check). Note that a stable v0.6.6 web bundle exists but is OTP ≤27. **Re-rank** the bytecode/version risk to **High likelihood**. In **Risks/Phasing**, replace "`.tool-versions` pin" with "separate build context for `apps/lattice_tab`" and state the alpha-pin explicitly.

## Important Issues (Should Fix)

### Issue 3: `client_id` lives in the shell but `hello` is Realm-built → resume breaks
- **Evidence:** `clientId` is read/generated in `sessionStorage` ([client.js:36-44](../../examples/browser_demo/client.js:36)) and carried in `hello` ([client.js:84-88](../../examples/browser_demo/client.js:84)); the server keys the resume proxy on it ([web_socket.ex:108-136,388-427](../../apps/lattice_server/lib/lattice/transport/web_socket.ex:388)). The design's Bridge contract only specifies inbound `deliver/1` + outbound `send/render` — no channel for the shell to hand `client_id` to the Realm. A Realm that invents its own `client_id` per boot makes `ResumeProxy.resume/2` return `:not_found` every reconnect → perpetual `rehydrate`.
- **Impact:** The "resume stays in the shell" non-goal is silently violated; reconnect continuity is lost.
- **Recommended fix:** Add a startup channel — `Bridge.start(client_id, last_seq)` — so the shell supplies the opaque session identity and the Realm composes `hello` with it. (Alternative: the shell owns the `hello→welcome→resume` handshake entirely — consistent with resume already being shell-owned — then hands `{tab_id, session_id, client_id}` to the Realm.) Add this to the Interfaces section.

### Issue 4: `mix atomvm.packbeam`'s browser output (and `atomvmlib.avm` co-load) is unverified
- **Evidence:** ExAtomVM/`atomvm-tooling` documents `mix atomvm.packbeam` for ESP32/STM32/RP2/Unix; no documented web/WASM path. The releases ship a separate **`atomvmlib-<ver>.avm`** (the standard library) alongside app `.avm`s (`hello_world-<ver>.avm`), implying the runtime loads **both**.
- **Impact:** If the web runtime needs `atomvmlib.avm` co-loaded, or expects a different `.avm` structure than the MCU path produces, the Phase-1 skeleton is blocked.
- **Recommended fix:** Add an explicit **Phase-0 gate**: "the `.avm` from `mix atomvm.packbeam` (built on the repo toolchain) loads in the pinned web runtime, with `atomvmlib-<ver>.avm` co-loaded as required." Vendoring then includes `atomvmlib.avm`.

### Issue 5: "Denial still denies against the BEAM tab" is currently untested and scheduled too late
- **Evidence:** `red_team/sandbox.ex` uses server-local `Lattice.Demo.LocalTab` ([sandbox.ex:6,10-11](../../apps/lattice_core/lib/lattice/red_team/sandbox.ex:6)), not the WebSocket boundary; the browser E2E asserts the fake-cap denial for the **JS** tab only. The design schedules the AtomVM-tab denial variants in **Phase 4** — i.e. the central thesis is unproven for the WASM path until the very end.
- **Impact:** A half-booted Realm emitting a stale-but-live `cap_id`, or malformed envelopes, could pass before any test catches it; "identical containment" ships as an assertion, not a result.
- **Recommended fix:** Move the **over-the-WebSocket** forged-cap + revoke-then-denied test into the **Phase-2 acceptance gate** (reuse `LatticeStress.WebSocketAbuseTest` infra as template), so "no new server trust" is evidence-backed before user-visible code ships.

### Issue 6: `max_frame_size` is unset → single-frame memory exhaustion
- **Evidence:** `Envelope.parse/1` caps inbound at 65 536 bytes *after* Cowboy assembles the frame ([envelope.ex:11](../../apps/lattice_server/lib/lattice/transport/web_socket/envelope.ex:11)); the Cowboy opts at [lattice_server.ex:38-47](../../apps/lattice_server/lib/lattice_server.ex:38) set no `max_frame_size` (verified: none in `apps/`), so the default is `infinity` — Cowboy buffers an arbitrarily large frame before the parser can reject it.
- **Impact:** Any tab (JS or AtomVM) can OOM the server with one giant frame. Pre-existing and tab-agnostic, but the design's threat-model-parity update should own it.
- **Recommended fix:** Set `max_frame_size: 65_536` in the Cowboy protocol opts; add it to the Phase-4 threat-model update and a stress test.

### Issue 7: Bridge threading gate has no failure definition; native WebSocket alternative unexamined
- **Evidence:** AtomVM's `run_script/2` default runs JS in the *worker* thread (no DOM); reaching the DOM/`ws.send` requires `[main_thread]`, which **blocks** the BEAM worker until the main thread completes — directly in tension with the design's "shell must not block UI thread" ([design:96](../designs/2026-05-25-atomvm-browser-realm.md)). AtomVM also ships a native `websocket` module (`libs/avm_emscripten/src/websocket.erl`), so BEAM could own the socket directly.
- **Impact:** High message rates → scheduler stalls or main-thread jank; the design treats "shell owns WebSocket" as a necessity when it is a choice.
- **Recommended fix:** Make Phase-0 criterion 1 (threading) measurable — a latency budget and a no-deadlock demonstration under load — and add a Phase-0 comparison of BEAM-owned WebSocket (`websocket:new`/`send_utf8`) vs shell-mediated sends. Name the shell-owns-WS decision explicitly rather than as an invariant.

## Minor Issues (Accept / Reframe)

- **8 — "~100-line shell":** client.js is **459 lines**; the shell retains WS+reconnect+resume+sessionStorage+multi-file WASM boot+bridge. Replace the line-count target with an inspection criterion: *"the shell has zero branches on envelope `type`/`cap_id`/`result`."* Authority-blindness is a logic property, not a line count.
- **9 — unvalidated `result`:** [web_socket.ex:305-318](../../apps/lattice_server/lib/lattice/transport/web_socket.ex:305) forwards `result` to the caller without a schema check. **Pre-existing** (the JS worker stub does the same); AtomVM does not worsen it. Optional hardening: add a shape/size guard. Deferred.
- **10 — vendoring the WASM binary:** prefer fetching the pinned release asset by URL + verifying `.sha256` in the build/CI step over committing the binary; confirm actual `.wasm` size in Phase 0 (the "~190 KB" is the *VM*, the web `.wasm` may differ).
- **11 — opt-in CI job:** sketch the steps in Phase 4, including how the `atomvm_packbeam` tooling is obtained (Hex/GitHub/escript). Defer detail to Phase 4.
- **12 — `cap.ex:112` `String.to_existing_atom`:** real, but **not reachable** from browser input today (ops come from server-config `grant_targets`, [web_socket.ex:177](../../apps/lattice_server/lib/lattice/transport/web_socket.ex:177)). Accept risk; optional `try/rescue` as defense-in-depth.

## Invalid Findings (Dismissed)

| Finding | Reason Dismissed |
|---------|-----------------|
| Browser bundle is **three files** incl. a vendored `AtomVM.worker.js` (Pragmatist F2) | `gh` shows the v0.6.6 **and** v0.7.0-alpha.1 web releases ship only `AtomVM-web-<ver>.js` + `.wasm` — no separate `*.worker.js` asset. The real correction (right filenames, prerelease status) is captured in Critical #2. |
| `cap.ex` `String.to_existing_atom` is an active crash/DoS vector | Not reachable from browser input; ops are server-configured. Kept as Minor #12 defense-in-depth only. |

## Design Verdict

- [x] **APPROVED** — after revision (see Resolution below)
- [ ] ITERATE

## Resolution (2026-05-25, same session)

The design was revised in place to address every Critical and Important finding (owner chose **alpha v0.7.0-alpha.1 + repo toolchain** for Issue 2). Mapping:

| # | Issue | Resolved in design by |
|---|-------|----------------------|
| 1 | `run_script` eval/injection | 🔒 **Security invariant** in Interfaces + Bridge; new **Phase-0 criterion 1b**; risk row; constraint row |
| 2 | Prerelease/alpha + wrong asset names + OTP-28 + fallback | Approach + Components + Dependencies corrected (`AtomVM-web-v0.7.0-alpha.1.{js,wasm}` + sha256 pin); risk re-ranked **High** + alpha-instability risk; mix.exs "separate build context" |
| 3 | `client_id`/resume gap | `Bridge.start(client_id, last_seq)` in Interfaces + Shell-keeps + constraint row + Phase 1 |
| 4 | packbeam web path / `atomvmlib.avm` | **Phase-0 gate (b)**; mix.exs co-load; Dependencies; open question 5 |
| 5 | Denial parity untested / too late | Moved to **Phase-2 acceptance gate**; testing item 4 rewritten (uses `WebSocketAbuseTest`) |
| 6 | `max_frame_size` unset | `max_frame_size: 65_536` in route-wiring hardening + risk + constraint rows |
| 7 | Threading gate / native WS | Bridge component: measurable threading gate + native `websocket` alternative; risk row; open question 1 |
| 8, 10 | Shell line count; vendoring binary | Reframed to a zero-envelope-branch criterion; fetch-by-URL + sha256 |
| 9, 11, 12 | result validation; CI sketch; `normalize_op` | Noted/deferred/accepted (pre-existing or not browser-reachable) |

**Re-verification:** done by doc inspection + a consistency grep (no stale `AtomVM.mjs`, no `~100-line` target, fallback wording corrected), **not** by re-dispatching the three reviewer agents. A fresh adversarial pass on the revised doc is available on request.
