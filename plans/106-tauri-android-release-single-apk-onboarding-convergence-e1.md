# Plan 106: Single-APK Android release onboarding convergence (E1)

## Status

DONE

## Objective

Prove a single-APK Android release onboarding convergence path: one non-debuggable Android release APK, in one dedicated probe
namespace, can receive OS pairing, persist the paired carrier config, pull the
bootstrap post-only cap, author a post with that pulled cap, push/drain the
outbox, verify the BEAM peer report, and relaunch with the paired state and
local evidence still present.

## Scope

- Add `tauri:android:build:release:onboarding-probe` and
  `tauri:android:release:onboarding:smoke`.
- Use a dedicated namespace `township:release-onboarding-probe`.
- Keep peer URL, peer realm, peer pubkey, and replica out of the build-time
  probe env. The peer config comes only from the OS-delivered pairing handoff.
- Reuse the existing release pairing probe and release author probe against one
  shared native workflow, key id, and storage namespace.
- The same APK/session pulls the bootstrap post-only cap from the BEAM peer, authors one post with the
  pulled cap, push both the valid post and deliberate unauthorized summary
  frame, and assert `post_materialized=true` plus
  `bad_authority_reason=operation_not_granted`.
- Force-stop/relaunch after authoring and before push to prove the paired
  config, pulled cap evidence, valid post frame, rejected summary frame, and
  pending outbox survive cold start.
- Force-stop/relaunch and assert the paired config, local post/rejected frame
  evidence, and drained outbox remain observable without authoring a second
  post/rejected-frame pair.

## Non-Goals

This does not prove browser/chooser-backed state exchange.
This does not prove app-originated child grant composition in the same
single-APK onboarding flow.

- No app-originated child grant composition in the single-APK flow; Plan 102
  proves that separately in the author probe.
- No cross-device authenticated state exchange or unforgeable production
  challenge.
- No authority origination, QR camera onboarding, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, or full
  mobile onboarding.

## STOP Conditions

- Stop if the onboarding probe bakes peer URL, peer realm, peer pubkey, or
  replica into build-time env.
- Stop if the flow uses the release sync, author, and pairing probes as
  separate APKs or namespaces instead of one shared workflow/namespace.
- Stop if the post is authored without the pulled bootstrap cap.
- Stop if docs call this browser/chooser coverage, production challenge
  exchange, authority origination, phone-grade equivalence, or full onboarding.
- Stop if the proof relies on WebView CDP, `run-as`, debug APKs, or native KV
  inspection.

## TDD Evidence

- RED: `npm run mobile:tauri-readiness` failed because the Plan 106 source,
  smoke, scripts, docs, and plan file were missing.
- GREEN: the release onboarding probe config rejects forbidden peer env, logs
  with `township-release-onboarding-probe`, composes pairing and author probes
  through one shared workflow, and keeps the paired peer config as the only peer
  source.
- GREEN: the release author probe now treats pushed metadata as report-only on
  relaunch, so the final drained onboarding relaunch cannot author a second
  post/rejected-frame pair.
- GREEN: `tauri:android:release:onboarding:smoke` passed against a
  non-debuggable Android release APK: pairing, cap pull, post authoring,
  pre-push pending reload, push/drain, peer report, final drained reload, and
  no second authoring were all observed.

## Second Opinion

Claude Code agreed this is the best next bounded slice after Plan 105. It
warned to keep peer config out of env, use a dedicated namespace, and split
app-originated child grant composition into a later slice so this flow's cap
semantics stay clear.

## Verification

- `cd clients/township-tauri-shell && npm run mobile:tauri-readiness`
- `cd clients/township-tauri-shell && npm run release:author:contract`
- `cd clients/township-tauri-shell && npm run release:onboarding:contract`
- `cd clients/township-tauri-shell && npm run typecheck`
- `cd clients/township-tauri-shell && npm run mobile:strategy`
- `cd clients/township-tauri-shell && npm run frontend:contract`
- `cd clients/township-tauri-shell && npm run tauri:android:build:release:onboarding-probe`
- `cd clients/township-tauri-shell && npm run tauri:android:release:onboarding:smoke`
- `git diff --check`

## Remaining Work

- App-originated child grant composition in the same single-APK onboarding flow
  remains separate follow-up work.
- Browser/chooser-backed state exchange remains unproven.
- full mobile onboarding remains unproven.
- Authority origination, QR camera onboarding, LAN discovery,
  physical-device behavior, iOS/Expo proof, production remote TLS, and full
  mobile onboarding remain separate bounded plans.
