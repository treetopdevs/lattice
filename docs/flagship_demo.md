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

Open `http://localhost:4041`.

## What To Click

1. `Connect realms`
2. `Issue caveated cap`
3. `Approve $199 bookshop`
4. `Attempt $425`
5. `Attempt wrong vendor`
6. `Steal cap from red-team tab`
7. `Revoke cap`
8. `Replay revoked cap`

The same path can be run at once with `Run full story`.

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
