# AtomVM Browser Realm — Phase-0 Spike Results

**Date:** 2026-06-20
**Branch:** `feat/atomvm-browser-realm`
**Runtime pinned:** AtomVM **v0.7.0-alpha.1** (prerelease)
**Toolchain:** repo Elixir 1.19.5 / OTP 28 (asdf), Node 22 (driver), headless Chromium (Playwright)
**Harness:** `spike/atomvm/` (throwaway; binaries gitignored, hashes + scripts committed)

## Verdict: 🟢 GREEN — all gates pass. Proceed with the deferred build on the repo toolchain.

The single highest-risk gate (C2: does OTP-28 bytecode run in the alpha AtomVM?) **PASSES**.
No toolchain fork is needed; **Popcorn is not required**. Every Phase-0 unknown is resolved.

## Gate results

| Gate | Result | Evidence |
|---|---|---|
| **C1** fetch + verify + locate stdlib | ✅ PASS | web+node `.js`/`.wasm` sha256-verified; stdlib **not** shipped/embedded → built from source |
| **C2** bytecode gate (OTP-28 `.beam` in alpha) | ✅ **PASS** | `mix atomvm.packbeam` on 1.19/OTP-28 → `.avm` ran in the node bundle: printed `hello_from_atomvm` and `[1,2,3]` |
| **C3** boot in browser under COOP/COEP | ✅ PASS | web bundle booted in headless Chromium; `window.crossOriginIsolated === true`; BEAM ready-beacon fired |
| **C4** round-trip + security (no eval) | ✅ PASS | `Module.call('realm', welcome)` → BEAM-built `hello` returned via `promise_resolve` (structured result; **zero** `run_script` on the data path) |
| **C5** threading / latency | ✅ PASS | 300 call round-trips: **p50 0.14 ms, p99 0.63 ms, max 1.66 ms**; page responsive after burst (no deadlock) |
| **C6** JSON in BEAM | ✅ PASS | BEAM `json:decode` + `json:encode` (estdlib): `client-abc-123` round-tripped into a real `hello` envelope |

Raw machine evidence: [`browser-gates.json`](./browser-gates.json). Clean boot — empty BEAM stdout/stderr.

## Design "Open Questions" 1–6 — answered

1. **JS↔BEAM bridge API + threading.**
   - **JS→BEAM (inbound, structured, no eval):** `Module.cast(name, msg)` → `{emscripten, {cast, Msg}}`; `await Module.call(name, msg)` → `{emscripten, {call, Promise, Msg}}` — delivered to the process `register/1`'d under `name`.
   - **BEAM→JS (outbound):** `emscripten:promise_resolve(Promise, iodata())` returns a value to a `Module.call` (the clean data path); `emscripten:run_script(iodata(), [main_thread | async])` for DOM (eval — constant scripts only).
   - **Threading:** the COOP/COEP page is cross-origin isolated (SharedArrayBuffer/pthreads). Measured p99 0.63 ms with no main-thread stall over 300 round-trips.
2. **Bridge security (criterion 1b) — SATISFIED.** The data path uses `promise_resolve` (structured return); envelope/codec bytes are **never** interpolated into a `run_script` string. `run_script` is used only for constant DOM scripts (the ready beacon). The injection sink (Design Issue 1) is avoidable by construction and avoided here.
3. **JSON location — decide BEAM.** AtomVM ships `json` in estdlib (Erlang, OTP-27-style `decode/1`,`encode/1`) and `json.ex` in exavmlib (Elixir). Decoding in BEAM works; the raw JSON string crosses the bridge (strongest shell-blindness). → **Codec lives in BEAM.**
4. **OTP-28 bytecode — YES.** `.avm` compiled on the repo toolchain ran in the alpha. **Decision: stay on repo Elixir 1.19 / OTP 28.** No separate build context, no Popcorn.
5. **packbeam output + stdlib co-load — RESOLVED.** `mix atomvm.packbeam` produces a loadable `.avm` containing only the app. The standard library is **not embedded in the bundle and not shipped as a release asset** → it must be **built from AtomVM source** (`cmake -G Ninja .. && ninja atomvmlib exavmlib`, all host tools present) and **co-loaded**: `atomvmlib.avm` (estdlib + eavmlib: `json`/`maps`/`lists`/`gen_server`) plus `exavmlib.avm` for Elixir. The `emscripten`/`websocket` modules live in `avm_emscripten` (also **not** in the bundle) and must be compiled + packed into the app `.avm`.
6. **In-WASM process richness (non-goal stretch).** Opportunistic: `register/1` + `receive` work in-browser; estdlib includes `gen_server`/`gen_statem`/`supervisor`. Full OTP-topology validation remains out of scope (unmeasured).

## "Evaluate both" outbound paths (user-requested fork)

| Path | Status | Eval risk | Notes |
|---|---|---|---|
| **A — promise bridge** (shell `Module.call` → BEAM `promise_resolve`) | ✅ **measured** (p99 0.63 ms) | **none** (structured return) | Simplest secure default. Server bytes never touch a JS string. |
| **B — BEAM-owned WebSocket** (`websocket:new` / `send_utf8/2`) | ✅ **available** — `websocket:is_supported() === true` in-browser; API confirmed from source | **none** (BEAM owns the socket; bytes bypass JS entirely) | Full live `send_utf8` latency bench **deferred to the build** (needs a WS endpoint; not run here). |

**Recommendation:** neither path requires the `run_script`-eval data sink. Use **Path B (BEAM-owned `websocket`)** for the `/ws` transport so server bytes never enter the JS context at all; keep `run_script` for **constant** DOM scripts only. Path A is the proven fallback/bridge for non-socket JS↔BEAM calls. This **revisits Design Issue 7** with evidence: "shell owns the WebSocket" is no longer the default — the BEAM can own it.

## Integration gotchas discovered (inputs for the deferred build)

1. **Bundle hardcodes `AtomVM.wasm`.** Override in-browser via `var Module = { locateFile: p => p.endsWith('.wasm') ? 'AtomVM-web-…wasm' : p }` set **before** the `<script>` tag. (Node: provide the generic name on disk; `globalThis.Module` is shadowed by the bundle's hoisted `var`.)
2. **Browser init model:** `var Module = { arguments: ['app.avm','atomvmlib.avm'], locateFile, print, printErr }` then `<script async src="AtomVM-web-….js">`. `arguments` are `.avm` URLs fetched at boot (app first, stdlib second).
3. **Repo `package.json` has `"type": "module"`** → the **node** bundle must be run as `.cjs` (browser unaffected). Only relevant if a node-side smoke test is wanted.
4. **Stdlib + emscripten/websocket beams must be produced from AtomVM source** and co-loaded/packed (see OQ5). The build script `spike/atomvm/build-libs.sh` is the reproducible recipe.

## Pinned asset hashes (for the CI hash-check)

```
sha256  AtomVM-web-v0.7.0-alpha.1.js    9edcea61e0a7470d8b39d7920840f7b45cd6209610dd5fbb3f881179c43fc1e6
sha256  AtomVM-web-v0.7.0-alpha.1.wasm  cb5df6a7963e1a10a3d3492f4d1113b4a4324ee2107320683614832478658aa5
sha256  AtomVM-node-v0.7.0-alpha.1.js   5df0b0ce39e8f50518be34c8c50286bdeca435083252699f90ab3e3de3145d20
sha256  AtomVM-node-v0.7.0-alpha.1.wasm 966d6121f1f32cbcc306ce0e4cd0918763bf4e224e886f6a731f6e0887ec8075
```
Payload sizes: web `.wasm` ≈ 1.05 MB, web `.js` ≈ 145 KB (the design's "~190 KB VM" was the MCU VM, not the web build).

## Reproduce

```sh
# C1: fetch + verify
gh release download v0.7.0-alpha.1 --repo atomvm/AtomVM --pattern 'AtomVM-web-*' --pattern 'AtomVM-node-*' --dir spike/atomvm/vendor
cd spike/atomvm/vendor && shasum -a 256 -c *.sha256 && cd -

# stdlib + bridge libs from source (cmake/ninja)
bash spike/atomvm/build-libs.sh

# C2 (node bytecode gate)
cd spike/atomvm/hello && ~/.asdf/shims/mix deps.get && ~/.asdf/shims/mix atomvm.packbeam && cd -
cp spike/atomvm/vendor/AtomVM-node-v0.7.0-alpha.1.{js,wasm} /tmp/ 2>/dev/null
~/.nvm/versions/node/v22.15.1/bin/node spike/atomvm/vendor/AtomVM-node-v0.7.0-alpha.1.cjs \
  spike/atomvm/hello/hello.avm spike/atomvm/AtomVM-src/build/libs/atomvmlib.avm

# C3–C6 (browser gates)
~/.asdf/shims/erlc -o spike/atomvm/beams \
  spike/atomvm/AtomVM-src/libs/avm_emscripten/src/{emscripten,websocket}.erl spike/atomvm/spike.erl
~/.asdf/shims/escript spike/atomvm/AtomVM-src/build/tools/packbeam/packbeam create \
  spike/atomvm/spike.avm spike/atomvm/beams/{spike,emscripten,websocket}.beam
~/.nvm/versions/node/v22.15.1/bin/node spike/atomvm/driver.mjs   # writes output/atomvm_spike/browser-gates.json
```

## Unblocked deferred work (re-run `/atomic-plan` on these)

- **`Lattice.Tab.Bridge`** — inbound `{emscripten,{cast,_}}`/`{emscripten,{call,Promise,_}}`; outbound `promise_resolve` (data) + constant `run_script` (DOM). Prefer Path B `websocket` for `/ws`.
- **`Lattice.Tab.Realm`** — `register/1` + receive loop wrapping `Protocol`; `Bridge.start(client_id,last_seq)`.
- **`Lattice.Tab.Codec`** — JSON in BEAM (estdlib `json`).
- **`Lattice.Tab.Main` (`start/0`)** + **`mix.exs` ExAtomVM wiring** — packbeam app `.avm`; build script stages vendored VM (sha256) + builds/co-loads `atomvmlib.avm`/`exavmlib.avm` + packs `emscripten`/`websocket`.
- **Shell `shell.js`** — global `Module` init (arguments + locateFile); ready beacon; authority-blind.
- **WASM smoke test + Playwright E2E** — generalize `spike/atomvm/driver.mjs`.
- **Phase-2 over-WebSocket denial parity** — now feasible (live AtomVM tab) via Path B against the real `/ws`.
- **Opt-in CI job** — `bash build-libs.sh` + `mix atomvm.packbeam` + `node driver.mjs`; OTP 28 (same as default CI).
