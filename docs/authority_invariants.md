# Authority Invariants

Lattice's flagship demo is built around one invariant:

> A realm can affect another process only through a live capability issued to
> that realm, and that capability's caveats must admit the exact operation.

## Executed In The Flagship Demo

- The planner tab receives one cap to the wallet process.
- The cap is caveated to `vendor = bookshop`, `amount <= 300`, confirmation
  required, and provenance label `wallet-consent`.
- A $199 bookshop purchase is delivered to the wallet process.
- A $425 purchase is denied before delivery.
- A wrong-vendor purchase is denied before delivery.
- A red-team tab using the planner's cap is denied before delivery.
- A replay after revocation is denied before delivery.
- Every allow, deny, and revoke is visible in `Lattice.Audit`.
- `Lattice.Graph.Snapshot` turns those decisions into allowed, denied, and
  revoked graph edges.

## Evidence Commands

```sh
mix test apps/lattice_core/test/lattice_flagship_test.exs
mix test apps/lattice_server/test/flagship_http_test.exs
npm run flagship:e2e
scripts/lattice_flagship_demo.sh 4041
```

The Playwright evidence includes a recorded `.webm` of the user path plus
`output/playwright/flagship-video-evaluation.json`, which fails the run if the
recording or final screenshot is missing or clearly unusable.

## Non-Claims

- The browser/worker realm model is simulated unless the WebSocket browser demo
  is being exercised.
- The graph inspector is an in-memory live view, not durable audit storage.
- The authority invariant is validated by tests and property-style checks, not
  by mechanized formal verification.
