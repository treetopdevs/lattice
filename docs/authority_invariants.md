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
- The browser Worker proof connects two real `Worker` realms, denies a direct
  tab cap without a bridge, then delivers the same payload through an explicit
  mediated bridge.

## Evidence Commands

```sh
mix test apps/lattice_core/test/lattice_flagship_test.exs
mix test apps/lattice_server/test/flagship_http_test.exs
npm run flagship:e2e
node scripts/lattice_browser_worker_e2e.mjs
scripts/lattice_verify_flagship.sh
scripts/lattice_flagship_demo.sh 4041
```

The Playwright evidence includes a recorded `.webm` of the user path plus
`output/playwright/flagship-video-evaluation.json`, which fails the run if the
recording or final screenshot is missing or clearly unusable.

The verification script also exports `output/flagship/claims.json` from
`Lattice.Flagship.Claims` after validating its evidence paths, so the claims
table is generated from code and can be uploaded as CI evidence alongside the
graph JSON, Mermaid, DOT, screenshot, and video.

## Non-Claims

- Browser Worker realms are real Web Workers in the focused WebSocket bridge
  proof. M2 adds the real carrier substrate and shared wire/canonical schemas, but a
  native AtomVM/WASM browser tab realm remains future work.
- The graph inspector is an in-memory live view, not durable audit storage.
- The authority invariant is validated by tests and property-style checks, not
  by mechanized formal verification.
