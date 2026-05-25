# QA Report: AtomVM Browser Realm (Phase 0 + spike-independent foundation)

**Date:** 2026-05-25
**Build:** [docs/plans/2026-05-25-atomvm-browser-realm.md](../plans/2026-05-25-atomvm-browser-realm.md)
**Branch:** `feat/atomvm-browser-realm`
**Files checked:** 9 (the build's changed feature files)

Four checks ran in parallel, each in an isolated subagent context.

## Summary

| Check | Status | Findings |
|-------|--------|----------|
| Denoise (dead code / artifacts) | ✅ | 0 debug artifacts, 0 dead code, 0 stray TODOs. 3 minor notes → 1 fixed, 2 folded into Style/accepted. |
| Style & convention | ✅ (after fix) | format clean; credo not in project. **1 important** (JS MIME inconsistency) → **fixed**; ~5 minor → accepted w/ rationale. |
| Documentation freshness | ✅ (after fix) | `@moduledoc`/`@doc` accurate; no pre-existing staleness. **2 minor design-doc inaccuracies** → **both fixed**. |
| **Security** | ✅ | **0 Critical / High / Medium.** 2 Low observations + 1 test-coverage suggestion → accepted/tracked. |

## Issues fixed (this QA pass)

1. **[Important] JS MIME inconsistency** — `static_handler.ex` served the existing demo's JS as `application/javascript` but new JS (`shell.js`, the `.js` fall-through) as `text/javascript`. Normalized the **new** clauses to `application/javascript; charset=utf-8` to match the established convention — the working JS demo's served type is unchanged; the handler is now internally consistent. (Both MIME types execute identically in browsers; MIME does not affect COEP.)
2. **[Minor] Hard-coded `"echo"` cap key** — `protocol.ex` `grant` handler stores the cap under a fixed `"echo"` key, which read like a latent bug. Added a comment documenting it as the single-cap **demo scope** (Phase 3 generalizes to multiple named caps).
3. **[Minor docs] Design components-table path** — the table listed `examples/atomvm_tab/vendor/...AtomVM-web....{js,wasm}` + `atomvmlib-v0.7.0-alpha.1.avm`, contradicting the rest of the design and the built `static_handler` whitelist (root-level `examples/atomvm_tab/`, `atomvmlib.avm`). Corrected the table to match what was built.
4. **[Minor docs] Protocol struct description** — design said the Protocol "Holds … peers, demo state," but the built (and planned) struct is `client_id`/`tab_id`/`session_id`/`caps`/`status` (no `peers`/`demo state` — pruned during design). Corrected the description.

## Remaining issues (accepted / tracked, none blocking)

| Item | Severity | Disposition |
|------|----------|-------------|
| `content_type/1` `true ->` returns `text/html` for unknown ext | Minor | **Accept** — the explicit whitelist guarantees only known files reach it; the only files hitting the fall-through are `.html`, for which `text/html` is correct. |
| `mix.exs` prose comments; single-line `@doc` vs heredoc; `init/1` missing `@doc`; `# --- … ---` divider comments | Minor | **Accept** — stylistic nits, no convention violation that matters. The higher `@spec` density and `describe` blocks were judged deliberate/improvements by the style reviewer. |
| `safe_file?/1` checks whitelist output (always a bare filename), not raw input — redundant by design | Low (security) | **Accept** — not a vulnerability; the literal whitelist is the real control. Left in as defense-in-depth. |
| `file_for/1` couples JS-demo + AtomVM whitelists in one function | Low (security) | **Accept** — cowboy route precedence prevents cross-dir confusion; splitting is cosmetic. |
| No tests for percent-encoded traversal / null-byte on the static route | Low (security) | **Track** — fold into the deferred Phase-2 adversarial-parity / E2E test work (the whitelist architecture makes this low-risk; cowboy normalizes + the whitelist 404s). |

## Verification after fixes
- `mix format --check-formatted` — clean
- `mix compile --warnings-as-errors` — clean
- `mix test` (full umbrella) — **131 tests + 1 property, 0 failures** (lattice_core 41, lattice_server 19, lattice_carrier_spike 4, lattice_demo 3, lattice_stress 52+1prop, lattice_tab 12); exit 0, no regressions

## Verdict

- [x] **QA PASSED** — zero critical security findings, zero dead/debug artifacts, format/compile/tests green, documentation aligned with the implementation. The one important issue (MIME) is resolved; remaining items are accepted-minor or tracked into the deferred Phase-2 work.
