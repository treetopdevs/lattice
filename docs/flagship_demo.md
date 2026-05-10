# Flagship Demo

The flagship path turns the research pieces into one runnable story:

```text
wallet tab consent
  -> caveated cap held by planner tab
  -> wallet process
  -> allowed purchase
  -> denied overreach
  -> live graph and audit explanation
  -> exportable claims table
```

Run it:

```sh
scripts/lattice_flagship_demo.sh 4041
```

Open `http://localhost:4041`. The demo listener binds to loopback by default.

## What To Click

Use the controls rendered by the live snapshot's `actions` list. The same path
can be run at once with the primary action, `Run full story`.

## What To Inspect

- The graph shows tabs, gateway, cap store, audit, wallet process, graph
  inspector, capability nodes, allowed invokes, denied attempts, and revoked
  edges.
- The wallet ledger proves only the allowed purchase reached the target process.
- The audit trail explains every allow and deny.
- The claims table separates implemented, simulated, and future-work claims.
- The export links expose JSON, Mermaid, and DOT from the same snapshot source
  used by the UI.

## Validation

```sh
scripts/lattice_verify_flagship.sh
mix test apps/lattice_core/test/lattice_flagship_test.exs
mix test apps/lattice_server/test/flagship_http_test.exs
npm run flagship:e2e
```

`npm run flagship:e2e` is CI-shaped: it runs the Playwright test in
`tests/e2e/flagship.spec.mjs`, records a browser video for the full scenario,
and then evaluates the recording. The split commands are available for CI jobs
that want separate artifact and quality-gate steps:

```sh
npm run flagship:e2e:test
npm run flagship:e2e:evaluate
```

Artifacts are written under `output/playwright/`:

- `test-results/**/video.webm` records the user-visible E2E steps.
- `flagship-demo.png` captures the final page state.
- `flagship-video-evaluation.json` records the acceptability checks for video
  presence, size, duration if `ffprobe` is installed, resolution, and screenshot
  evidence.

`scripts/lattice_verify_flagship.sh` mirrors the CI path from a fresh checkout:
it installs dependencies unless skipped, checks formatting, runs the flagship
Mix tests, runs flagship browser E2E, evaluates the video, validates claim
evidence paths, and writes graph evidence.

Additional verification artifacts are written under `output/flagship/`:

- `flagship-snapshot.json` contains the populated flagship snapshot after
  `Lattice.Flagship.run_all/0`.
- `flagship-graph.json` contains the graph source used by the UI.
- `flagship-graph.mmd` contains the Mermaid graph export.
- `flagship-graph.dot` contains the Graphviz export.
- `claims.json` contains the code-owned claims table from
  `Lattice.Flagship.Claims`.

GitHub Actions runs the same evidence path in
`.github/workflows/flagship.yml` and uploads `output/playwright/` plus
`output/flagship/` as the `lattice-flagship-evidence` artifact.

## Presenter Notes

The story panel is deliberately deterministic: reset clears live authority,
each step has a number, and the presenter card names the current invariant and
next action. During a talk or review, the key checkpoints are:

- after `Connect realms`, the graph has actors but no wallet authority;
- after `Issue caveated cap`, one caveated authority edge exists;
- after `Approve $199 bookshop`, the wallet ledger increments exactly once;
- after each denial, the selected edge and audit trail explain the reason;
- after `Revoke cap`, replay stays denied and the revoked edge remains visible.

## Claims Source

The claims table is generated from `Lattice.Flagship.Claims`, exposed at
`/api/flagship/claims`, embedded in the live snapshot, and exported by the
verification script as `output/flagship/claims.json`. That keeps implemented,
simulated, and future-work claims tied to runnable evidence instead of copied
into independent prose.
