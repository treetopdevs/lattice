# Plan 153 — Packaged bundle variant preflight classifier

- **Status:** DONE (local gates; hosted wiring deliberately deferred to Plan 146 Seam 11)
- **Track:** governance-probe (`township/governance-probe`)
- **Priority / size:** P2 / S
- **Depends on:** 146 Seams 6 and 9 (the feature-gated test-presence provider and its marker
  literal), 131 (packaged smokes as hard CI gates)
- **Implementation tip:** `ae5ecc92` (`test(township): add packaged bundle variant preflight
  classifier`)

## Objective

Every packaged smoke consumes one shared
`clients/township-tauri-shell/src-tauri/target/release/bundle/macos/Township.app`, and the
`TOWNSHIP_SKIP_*_APP_BUILD` no-build steps trust whatever variant a previous step left there.
Plan 146 Seam 10 introduces a second build variant (`township-dev-trace` +
`township-governance-test-presence`) sharing that path with the dev-trace-only variant every
v1-v6 smoke assumes. This plan gives the harness a static, launch-free way to know which
variant a bundle actually is, so a no-build consumer can fail fast instead of silently running
against the wrong custody provider. The hazard is real, not hypothetical: at authoring time the
shared bundle in the integration checkout was a test-presence build while every no-build v1-v6
smoke assumed dev-trace-only.

## What landed

- `clients/township-tauri-shell/test/support/packaged_bundle_variant.ts` —
  `classifyPackagedBundleVariant(appBundlePath)` returns `"test_presence"` or
  `"dev_trace_only"`, and `assertPackagedBundleVariant(appBundlePath, expected)` fails with the
  actual variant named. Classification reads only the executable declared by
  `CFBundleExecutable` in `Contents/Info.plist` (helpers never decide), resolves the bundle and
  executable canonically and rejects an executable that resolves outside the bundle, rejects
  universal (fat) Mach-O headers until per-slice classification exists, requires the
  unconditional carrier keyring service literal (`dev.treetop.lattice.township.carrier`) as the
  recognition control, and decides the variant by the presence of the runtime-reachable
  test-presence trace literal (`governance-test-presence:authorized`). Both markers were
  verified against real optimized binaries; the previously proposed ordinary-custody service
  and alias literals are eliminated by release optimization and are deliberately not used.
- `clients/township-tauri-shell/test/packaged_bundle_variant.ts` — the standalone contract:
  fourteen synthetic-bundle cases covering both classifications, helper-binary noise,
  missing/undeclared/unsafe/absent executables, missing `Info.plist`, fat Mach-O refusal,
  symlinked-bundle acceptance after canonical resolution, escape-symlink refusal, and the
  mismatch error naming the actual variant. Run with
  `node_modules/.bin/tsx test/packaged_bundle_variant.ts` from `clients/township-tauri-shell`.

## Gate

The contract runs green locally, `vue-tsc --noEmit` is clean, and the classifier correctly
labels real bundles of both variants (verified against a paired test-presence build and a
dev-trace-only rebuild).

## Non-claims and deferred wiring

- No packaged smoke, npm script, workflow step, or `app:convergence` entry changes here.
  Consumer enforcement is Plan 146's: Seam 10 asserts `test_presence` before the governance
  ceremony smoke consumes its bundle, and Seam 11 wires the ordering
  (build test-presence → governance smoke → rebuild dev-trace-only → v1-v6 no-build chain) plus
  the shared-harness assertion as part of its own RED for absent entries. This plan must not
  front-run that RED.
- The classifier makes no claim about code signature validity, entitlements, notarization, or
  runtime behavior; it is a harness preflight, not a security control.
- Mixed-architecture (fat) bundles are refused, not classified; per-slice support is future
  hardening if a universal build ever becomes real.
- The `plans/README.md` index row for this plan is intentionally deferred: the table region is
  carried in another track's uncommitted CD1 draft (plans 150-152), and adding the row now
  would conflict; add the 153 row when that table next lands.
