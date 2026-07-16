# Plan 109: Android release browser-backed onboarding child grant (E1)

## Status

DONE

## Objective

Prove Android release browser-backed onboarding can compose an app-originated
post-only child grant in the same non-debuggable release APK, paired namespace,
and session that receives pairing from a browser-loaded page.

The browser page request is observed before the onboarding namespace saves
pairing. After that paired config is persisted, the app pulls the bootstrap
post-only cap, authors a child `post` grant under that pulled cap, authors the
valid post plus unauthorized summary, cold-reloads the pending outbox with grant
evidence intact, pushes all three frames, and observes peer
`grant_authority_accepted=true` alongside `post_materialized=true` and
`bad_authority_reason=operation_not_granted`.

## Scope

- Add `tauri:android:build:release:onboarding-grant-probe`,
  `tauri:android:release:browser-onboarding-grant:smoke`, and
  `tauri:android:release:browser-onboarding-grant`.
- Use a dedicated `township:release-onboarding-grant-probe` namespace and
  `township-release-onboarding-grant-resident` key id.
- Keep peer URL, peer realm, peer pubkey, and replica out of build-time env; the
  peer config comes only from the browser-delivered `township://pairing`
  handoff.
- Reuse the existing onboarding probe plus the existing release author
  `phase=grant` path by passing a public grant-audience config through the
  onboarding env.
- Assert the browser page request is observed before `phase=pairing
  outcome=saved`.
- Assert `phase=grant`, `grant_ops=post`, app-grant evidence in local
  ops/delegation evidence, pending reload `outbox_frame_count=3`, push
  `accepted_count=3`, and peer `grant_authority_accepted=true`.
- Relaunch after the drained push and assert the final report is report-only,
  with no second `phase=grant outcome=authored` or `phase=author
  outcome=authored`.

## Non-Goals

This does not prove authority origination.
This does not prove chooser UI.
This does not prove browser/chooser-backed or cross-device pairing state
exchange.
full mobile onboarding remains unproven.

- No root or issuer authority is minted by the app device; the child grant is
  attenuated under the onboarding-pulled post-only bootstrap grant.
- No QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo
  proof, production remote TLS, or full mobile onboarding.
- No claim that the fixed Plan 109 probe-only state is an unforgeable
  production challenge.

## STOP Conditions

- Stop if the app-authored child grant requests any operation outside `["post"]`.
- Stop if the child grant is authored without the onboarding-pulled bootstrap
  cap as parent.
- Stop if peer URL, peer realm, peer pubkey, or replica are baked into build-time
  env instead of coming from the browser-delivered pairing handoff.
- Stop if the flow uses a separate APK/session for pairing, pull, grant, author,
  and push instead of the shared onboarding grant namespace.
- Stop if the browser page request cannot be observed before the onboarding
  namespace saves pairing.
- Stop if the final drained relaunch re-authors the grant, post, or summary.
- Stop if the smoke relies on WebView CDP, `run-as`, debug APKs, or native KV
  inspection.
- Stop if docs claim authority origination, chooser UI, browser/chooser-backed
  or cross-device state exchange, production challenge security, QR camera,
  LAN, physical-device behavior, iOS, production TLS, or full mobile onboarding.

## TDD Evidence

- RED: `npm run release:onboarding:contract` failed because the onboarding probe
  env did not parse or forward
  `VITE_TOWNSHIP_RELEASE_ONBOARDING_PROBE_GRANT_AUDIENCE_PUBKEY`.
- GREEN: `npm run release:onboarding:contract` passes after the onboarding probe
  forwards the public grant audience into the existing release author probe.
- RED: `npm run mobile:tauri-readiness` failed because the Plan 109 browser
  onboarding child-grant smoke and plan file were missing.
- GREEN: `npm run mobile:tauri-readiness` validates the package scripts, source
  contract, Plan 109 smoke, docs, build map, and plan index.
- GREEN: `npm run tauri:android:release:browser-onboarding-grant` rebuilds the
  non-debuggable Android release APK and proves browser-backed onboarding child
  grant composition in the dedicated namespace.

## Second Opinion

Claude Code agreed this is the best bounded next slice after Plan 108 because it
closes the explicit composition gap between Plan 102's app-originated child
grant proof and Plan 108's browser-backed onboarding convergence proof. Claude
warned to keep the browser page request before pairing save, preserve peer
`post_materialized=true` and `bad_authority_reason=operation_not_granted`, assert
three pushed frames, and avoid any authority-origination, chooser,
cross-device, QR, LAN, physical-device, iOS, production TLS, or full-onboarding
claim.

## Verification

- `cd clients/township-tauri-shell && npm run release:onboarding:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run tauri:android:release:browser-onboarding-grant`
- `git diff --check`

## Remaining Work

- Authority origination remains unproven.
- Chooser UI behavior remains unproven.
- Browser/chooser-backed or cross-device cryptographic state exchange remains
  unproven.
- QR camera onboarding, LAN discovery, physical-device behavior, iOS/Expo proof,
  production remote TLS, and full mobile onboarding remain separate bounded
  plans.
