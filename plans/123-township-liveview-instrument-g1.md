# Plan 123: Township LiveView instrument (G1)

## Status

DONE.

## Objective

Create the first actual Phase G application surface: a dedicated Phoenix 1.8.9 / LiveView 1.1.32
umbrella app whose connected `/township` route renders the five PD-001-A section A4 instrument
panels and causal evidence from the Plan 122 read model over the integrity-verified Plan 121 bundle.

Planned at commit `2c128bd`.

## Architecture

- Add `apps/township_web` as a dedicated UI-layer OTP app depending on `lattice_core` only.
- Keep Phoenix, LiveView, Bandit, HTML, asset, and browser-test dependencies out of `lattice_core`,
  `lattice_server`, and the carrier/spike apps.
- Keep `lattice_server` as the raw Cowboy carrier/demo boundary; do not graft a Phoenix endpoint
  onto its lifecycle.
- Run a real `TownshipWeb.Endpoint`, LiveView socket, router, PubSub process, and esbuild-generated
  JS/CSS asset path.
- Treat `artifacts/township/matter.log` as the default authoritative source only after
  `Township.AuditBundle.verify/1` accepts the complete bundle.

## Public seams

### Source

`TownshipWeb.InstrumentSource.load/1` returns either:

```elixir
{:ok, %{read_model: Township.ReadModel.t(), provenance: map()}}
{:error, reason}
```

The default bundle source verifies first, then restores `matter.log`, loads manifest display labels,
and calls `Township.ReadModel.observe/2`. It supplies the same three caller-held W4 stub vouches as
the narrated demo without placing vouches or coercion tokens in the Matter log.

### HTTP and LiveView

- `GET /township` returns the dead-rendered instrument document.
- `Phoenix.LiveViewTest.live(conn, "/township")` establishes a connected LiveView.
- `GET /` aliases the same instrument rather than introducing a landing page.
- A failed source verification renders an explicit unavailable/unverified state and no authoritative
  panel values.

## Rendered contract

- **Threads**: title, summary, posts, and clerk-locked status.
- **Roles**: holder fingerprints, authority quarantine, reasons, and audit events.
- **Members**: current members plus denied membership mutations; the tracked bundle honestly renders
  an explicit empty state because its only quarantined op is the stale clerk action.
- **Attest**: deterministic approve/reject tally, visibly labeled `W4 · stubbed`, with
  `receipt_free? == false`.
- **Trust graph**: delegation identities and edges as an accessible, bounded visual evidence surface.
- **Op · DAG**: replica, op count, frontier, honored/quarantined counts, and compact operation rail.
- **Provenance**: verified schema, source path, and deterministic `matter.log` digest.

The visual grammar comes from the supplied Duality Canvas, Realm Constellation, and Adversary
Console prototypes: gridded paper, compact mono labels, serif evidence text, strong structural rules,
and restrained teal/orange/violet/red status accents. It remains a dense civic instrument, not a
marketing page.

## Scope

- Add the trimmed no-Ecto Phoenix umbrella app, endpoint, router, layouts, source boundary, LiveView,
  assets, tests, and run aliases needed for the route.
- Pin Phoenix to `1.8.9` and LiveView to `1.1.32`.
- Build a real LiveSocket client bundle through esbuild; do not call server-rendered HTML alone a
  connected application.
- Add a Playwright smoke that observes the connected LiveSocket in a real browser and captures
  desktop and mobile screenshots without layout overlap.
- Add the app to the repo health gate automatically through the umbrella.

## Non-goals

- No write controls, transfer/admit/vouch actions, scrubber, partition/heal control, PubSub/carrier
  feed, auto-refresh, or mutable instrument session.
- No Vue graph/canvas island yet; the server-rendered trust evidence is the bounded first visual.
- No change to `Township.Matter`, `Township.ReadModel`, `Lattice.Sim`, authority, attestation, carrier,
  or audit-bundle semantics.
- No receipt-freeness claim; W4 remains explicitly stubbed.
- No Phase G/G1 completion claim, mobile/iOS/cross-device/physical-device claim, or production TLS
  claim.

## STOP conditions

- Stop if `township_web` needs a dependency on `lattice_server`, `lattice_node_spike`,
  `lattice_carrier_spike`, or `lattice_stress`.
- Stop if any Phoenix/LiveView dependency enters `lattice_core`.
- Stop if the UI reads claimed JSON as authoritative, skips `AuditBundle.verify/1`, falls back to a
  hand-authored model after verification failure, or renders authoritative panels while degraded.
- Stop if display labels can alter state, authority, membership, attestation, or op-DAG values.
- Stop if vouch bodies enter `Township.Matter` or `matter.log`.
- Stop if any byte under `artifacts/township/` changes.
- Stop if connectedness is claimed from `Phoenix.LiveViewTest` without a real browser observing the
  LiveSocket.
- Stop if the docs call this the complete production instrument or say Phase G/G1 is done.

## TDD plan

1. FRAMEWORK SETUP: add only the trimmed application/endpoint/router test boundary required to run
   behavior tests; keep `/township` absent.
2. SOURCE RED/GREEN: test a verified tracked bundle, missing bundle, and corrupted bundle through
   `TownshipWeb.InstrumentSource`; implement the refuse-on-failure source.
3. ROUTE RED/GREEN: test dead and connected `/township` renders, five panel anchors, honest W4 and
   member empty states, graph/op-DAG evidence, and a degraded source with no panels; implement the
   LiveView and layouts.
4. BROWSER RED/GREEN: add a Playwright test that fails until the esbuild app bundle connects the
   LiveSocket, then prove the route and responsive layout in Chromium at desktop and mobile sizes.
5. DOCS RED/GREEN: require Plan 123, the plan index, app inventory, exact version/boundary claims,
   and the remaining live-control/Vue/feed nonclaims in the build map.
6. VERIFY: focused source/LiveView/browser tests, asset build, `mix verify`, `mix check`, Sobelow for
   the new Phoenix boundary, the Plan 121 bundle verifier, mobile readiness, artifact hashes, and
   `git diff --check`.
7. REVIEW: obtain Claude Code reviews at architecture, RED, implementation, browser, and final diff
   checkpoints before commit.

## TDD evidence

- FRAMEWORK SETUP: the no-Ecto umbrella app compiled with the endpoint, router, PubSub, and test
  support present while `/township` still returned 404.
- SOURCE RED: the first focused source contract failed with `UndefinedFunctionError` for
  `TownshipWeb.InstrumentSource.load/1`. Claude required an independent literal digest before
  proceeding, so the test pins
  `df911bb13013abefab7af103992fd1413eb754989ecf74f26cedb9e8ef6d17d3` rather than deriving its
  expectation through the implementation.
- SOURCE GREEN: the default source verifies the complete Plan 121 bundle, restores only
  `matter.log`, derives the Plan 122 read model, and returns typed refusal errors for missing or
  corrupted evidence; 2 focused tests passed.
- ROUTE RED: `GET /township` returned 404. Claude rejected the first degraded-state negative
  contract as too weak, so it was strengthened to forbid the title, fingerprints, authority
  reasons, tally values, schema, and digest while the source is unverified.
- ROUTE GREEN: dead and connected LiveView tests passed with independent assertions for provenance,
  holder identity, resident membership, operation counts, W4 honesty, and refusal behavior.
- BROWSER RED: after correcting the test origin to the endpoint's configured `localhost`, a real
  LiveSocket connected but stale assets left desktop panels ungridded and the mobile page 760 px
  wide. Claude accepted the seam and requested a positive mobile-grid assertion.
- BROWSER GREEN: `mix assets.build` plus a server restart produced the intended desktop grid and
  single-column mobile layout; both Playwright cases passed with a connected LiveSocket, no
  browser errors, no horizontal overflow, and no panel overlap.
- DOCS RED/GREEN: the plan contract failed while this plan/index remained `IN PROGRESS` and the
  build map retained the unrendered-instrument claim; the bounded Plan 123 app, route, and remaining
  Phase G work are now named explicitly.
- SECURITY RED: Sobelow rejected the browser pipeline because Phoenix's default response contained
  only `base-uri` and `frame-ancestors`, not an explicit `default-src`/`connect-src` policy. The
  first HTTP-header test failed for an unimported helper; after qualifying `Plug.Conn`, the intended
  RED pinned the incomplete response policy.
- SECURITY GREEN: the browser pipeline now emits a self-hosted CSP with no `unsafe-inline` or
  `unsafe-eval`; the response test, Sobelow, and both real-browser LiveSocket cases pass. Two
  low-confidence traversal reports are auditable Sobelow skips because `bundle_dir` is supplied
  only by application config/internal tests and both filenames are literals.
- UMBRELLA DOCS RED/GREEN: the first full `mix verify` found Plan 121/122 tests coupled to the prior
  cumulative marker and the now-false global `unrendered` status. Their shared marker advanced to
  `plans 023-123`; the obsolete global-status assertions were removed because Plan 123's contract
  is now the sole owner of the rendered-but-incomplete status.

## Second opinion

- Claude Code rejected coupling Phoenix into the raw Cowboy `lattice_server` boundary and selected
  a dedicated app with one-way `township_web -> lattice_core` dependencies.
- Claude required verification-before-restore, refusal to render authoritative data on corruption,
  both dead and connected LiveView tests, and a real-browser LiveSocket observation before any
  connected-app claim.
- Architecture verdict: `VERDICT: PROCEED`.
- Source RED verdict: `VERDICT: PROCEED` after pinning the independent `matter.log` digest.
- Route RED verdict: `VERDICT: REVISE`; the degraded-state assertions were expanded before
  implementation, then the same behavioral seam passed.
- Browser RED verdict: `VERDICT: PROCEED`; its requested positive mobile-grid assertion is in the
  retained Playwright contract.
- Visual implementation verdict: `VERDICT: PROCEED`. Claude found one medium accessibility issue
  and three low issues: the trust graph used a leaf `role="img"`, verification metadata was
  hardcoded, generated README text survived, and one trust node had an unlabeled initial. All four
  were corrected before the final gate.
- Security verdict: `VERDICT: REVISE`. Claude independently classified the missing CSP as real,
  selected the endpoint response plus browser LiveSocket seams, and classified the two
  application-config-only file warnings as documented false positives; the requested revision is
  implemented and green.
- Umbrella docs verdict: Claude first returned `VERDICT: PROCEED` for advancing the cumulative
  marker, then corrected itself to `VERDICT: REVISE` when the focused rerun exposed the stale
  global `unrendered` assertion. Its revised single-owner contract is implemented and green.
- Final implementation review found no blockers and returned `VERDICT: SHIP IT`. Claude explicitly
  cleared dependency direction, supervision, refuse-before-render behavior, CSP/runtime config,
  lock-update regression coverage, LiveSocket and geometry assertions, server teardown, test
  independence, and every Phase G/G1 non-claim. It left three optional low follow-ups: narrow or log
  the source's broad rescue, make verification and rendering consume one immutable bundle snapshot,
  and rotate the development signing salts before any production/write-capable surface.

## Verification

- `~/.asdf/shims/mix test apps/township_web/test` — 6 tests, 0 failures.
- `PATH=/opt/homebrew/bin:$PATH npm run township:instrument:e2e` — 2 Chromium cases, 0 failures;
  desktop/mobile LiveSockets connected with no console errors, overflow, or panel overlap.
- `~/.asdf/shims/mix verify` — 283 tests and 24 properties across the umbrella, 0 failures.
- `~/.asdf/shims/mix check` — full verification plus strict Credo, exit 0; only the existing
  advisory set outside this diff remains.
- `~/.asdf/shims/mix sobelow --exit --skip` in `apps/township_web` and `apps/lattice_server` —
  clean; the raw Cowboy app retains its expected no-Phoenix-router notice.
- `~/.asdf/shims/mix lattice.township.verify_bundle --dir artifacts/township` — verified.
- `npm --prefix clients/township-tauri-shell run mobile:tauri-readiness` — passed.
- SHA-256 checks for all seven `artifacts/township/*` files match the Plan 121/122 baseline, and
  `git diff --exit-code -- artifacts/township` is clean.
- `~/.asdf/shims/mix format --check-formatted` and `git diff --check` — clean.

## Completion claim

Plan 123 adds a connected, read-only, integrity-gated first LiveView instrument surface at
`/township`. Phoenix 1.8.9, LiveView 1.1.32, the LiveSocket asset, dead/connected ExUnit coverage,
and `npm run township:instrument:e2e` make the rendered snapshot an executable application boundary.

It does not add live write controls, carrier/PubSub feeds, the Vue graph island, a real receipt-free
W4 primitive, mobile/physical-device proof, or production TLS. This bounded instrument does not close Phase G or G1.
