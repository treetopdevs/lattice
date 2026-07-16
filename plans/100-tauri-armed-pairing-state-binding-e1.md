# Plan 100: Tauri armed pairing state binding (E1)

## Status

DONE

## Objective

Strengthen the app-controlled OS pairing-link import ceremony from "armed" to
"armed for this state": when the real app enables `township://pairing` import,
it creates a crypto-generated local state token, and a valid OS-delivered
pairing link must carry that matching `state` query parameter before the draft
handoff is loaded.

This is an app-local state binding for the armed import window. It is not a
browser/chooser proof, Android release armed-delivery proof, remote peer
challenge protocol, cross-device authenticated exchange, or full onboarding
proof.

## Scope

- Extend the shared pairing deep-link parser so successful parses carry the
  optional URL `state` value.
- Extend the one-shot import gate so arming returns a crypto-generated state
  token and accepting a valid link requires that exact state.
- Keep invalid armed links observable without consuming the arm.
- Block valid links with missing or mismatched state without consuming the arm.
- Keep the packaged macOS smoke's positive path state-bound by reading the
  dev-trace-only armed state and delivering a matching LaunchServices URL.
- Surface the state in the app while the import window is armed.

## Non-Goals

- No browser or chooser automation.
- No remote peer nonce challenge, signed challenge, or cross-device protocol.
- No Android release armed OS delivery.
- No production remote TLS, QR camera onboarding, LAN discovery, physical-device
  smoke, app-originated grants, authority origination, or full onboarding.

## STOP Conditions

- Stop if a valid `township://pairing` link without matching state can load a
  draft while the gate is armed.
- Stop if a mismatched valid link consumes the armed window.
- Stop if invalid links consume the armed window.
- Stop if docs call this browser/chooser coverage, Android release armed
  delivery, cross-device cryptographic pairing, or full onboarding.

## TDD Evidence

- RED: `deeplink:contract` failed because successful pairing deep-link parses did
  not expose `state`.
- GREEN: `deeplink:contract` now proves the parser returns state, the one-shot
  gate emits a state token, missing/mismatched-state valid links are blocked
  with `state_mismatch` without consuming the arm, invalid links still surface
  parse errors without consuming the arm, a matching-state valid link applies
  once and disarms, and a second matching link is blocked as unarmed.
- GREEN: `frontend:contract` pins the Vue state display, dev-trace-only state
  emission used by the packaged smoke, and state-bound positive delivery in the
  installed-app smoke harness.

## Second Opinion

Claude Code was asked twice to evaluate this slice before implementation and
once after implementation. All three review prompts stalled without returning a
verdict and were interrupted; no Claude approval is claimed for this plan. The
slice was kept intentionally small and verified at the public
`deeplink:contract` and Vue source-contract seams.

## Verification

- `cd clients/township-tauri-shell && npm run deeplink:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run tauri:cold-deep-link:smoke`
- `git diff --check`

## Remaining Work

- Add browser/chooser coverage if product requirements demand it.
- Add a real cross-device challenge/response or signed nonce exchange if the
  pairing ceremony must bind a remote peer interaction rather than only the
  app-local armed import window.
- Add Android release real-app armed OS delivery, QR camera onboarding, LAN
  discovery, physical-device, iOS/Expo, app-originated grant,
  authority-origination, and full onboarding proofs as separate plans.
