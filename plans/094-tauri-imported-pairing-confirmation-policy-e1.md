# Plan 094: Tauri imported pairing confirmation policy (E1)

## Status

DONE

## Objective

Close the production-facing part of the Plan 093 caveat: a public pairing handoff
that reaches the real Tauri app by handoff text, deep link, QR image, QR camera,
or discovery must not commit to the saved carrier peer config until the user
explicitly confirms the save. The same policy must also protect replacement of
an already-saved carrier pairing, while preserving same-config idempotency and
the env-gated Plan 093 release probe namespace.

This is a real-app save policy and confirmation ceremony. It is not a new
Android release OS-intent proof.

## Scope

- Add a shared TypeScript save-policy seam around `saveTownshipCarrierPeerConfig`.
- Track pairing draft origin as `manual`, `handoff`, `deep_link`, `qr_image`,
  `qr_camera`, `discovery`, or `release_probe`.
- Require explicit confirmation before imported first-save writes, before any
  different saved peer config is replaced, and before manual replacement of an
  existing config.
- Preserve same-config idempotency without requiring confirmation.
- Reject invalid drafts before reading or mutating stored peer config.
- Surface a typed `confirmation_required` result and a Vue checkbox that starts
  unchecked, resets when draft material changes, and shows current/draft peer
  fingerprints for replacement.
- Keep the Plan 093 release probe explicitly opted into its dedicated probe
  behavior rather than relying on the real app's default save path.
- Update the build map, mobile secure-store strategy, and plan index without
  claiming nonce/state binding, chooser coverage, or full onboarding.

## Non-Goals

- No state/nonce binding, browser chooser proof, Chrome navigation proof, QR
  camera release smoke, LAN discovery release smoke, or physical-device smoke.
- No app-originated grant issuance, authority origination, or new mobile
  delegation ceremony.
- No private key, seed, local key id, or local realm in public handoffs.
- No claim that a checkbox alone is the final anti-hijack ceremony.

## STOP Conditions

- Stop if a deep-link query parameter such as `confirm=1` can unlock saving.
- Stop if imported first-save can persist a peer config with no explicit app
  confirmation.
- Stop if replacing an existing different peer config can save without explicit
  confirmation.
- Stop if invalid drafts mutate or erase the stored peer config.
- Stop if the release probe and real app save paths share an unparameterized
  implicit overwrite behavior.

## TDD Evidence

- RED: `peer:contract` failed because an imported deep-link first save returned
  `ok: true` and wrote storage without confirmation.
- GREEN: the carrier peer contract now requires `confirmation_required` for
  unconfirmed imported first saves and replacements, preserves same-config
  idempotency, rejects invalid drafts before mutation, and proves
  `township://pairing?...&confirm=1` does not bypass the explicit save option.
- RED: `frontend:contract` failed because the Vue shell had no draft origin,
  confirmation checkbox, current/draft fingerprint copy, or release-probe
  opt-in assertion.
- GREEN: the Vue source contract now requires the real app to pass pairing
  origin and confirmation state into the shared save policy and to mark every
  import path with its provenance.

## Second Opinion

Claude Code recommended this slice after Plan 093: the invariant should be
"no deep-link-originated write to the real carrier peer config commits without
explicit human confirmation, first write included." It also advised treating
confirmation as app-controlled provenance rather than a link parameter, keeping
nonce/state binding as a later ceremony, testing non-mutation behavior rather
than source-grep alone, and ensuring the release probe does not silently share
the real app's default save behavior.

## Verification

- `cd clients/township-tauri-shell && npm run peer:contract`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run release:pairing:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `git diff --check`
- `~/.asdf/shims/mix check`

## Remaining Work

- Add state/nonce binding or an equivalent anti-hijack ceremony for production
  pairing.
- Add browser/chooser coverage beyond adb-delivered OS intents.
- Add QR camera, LAN discovery, physical-device, iOS/Expo, app-originated grant,
  authority-origination, and full onboarding proofs as separate plans.
