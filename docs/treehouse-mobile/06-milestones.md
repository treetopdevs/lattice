# 6. Milestones and open decisions

Supersedes the milestone table in Plan 296. Each slice is small enough for one agent and one
PR, names its gate and names the highest evidence tier it may claim. Status lives in
[PROGRESS.md](PROGRESS.md), not here. Files, signatures, named tests, gate commands and the
exact build order for each slice are in [07-implementation-plan.md](07-implementation-plan.md).

## Sequence

```
M0 finish ─► M1 foundation ─► M1 chat ─► M2 people ─► M3 polish ─► M4 Android
                                  ▲           ▲
                     G-3 shared layer    G-1 relay access   (substrate track, parallel)
```

## M0: shell and relay link (finish)

M0 was committed with its simulator proof not run.

| Slice | Scope | Gate | Tier |
|---|---|---|---|
| M0.1 | Boot on the iOS Simulator with a development build; exercise real SecureStore and SQLite | app launches, connects as a demo identity, posts, restarts, post is still there | Simulator |
| M0.2 | Replace the trust-card copy with the approved hosting sentence | string test | Core |
| M0.3 | Try the device-key identity against the demo relay and record the result | done 2026-11-25: refused, `unauthenticated` (G-1). Remaining: the M0 screen should say "this phone has no relay access" instead of offering a Keychain mode that cannot connect | Core |

## M1a: foundation (no visible change)

Build the layers in [03](03-application-layer.md) under the M0 screen, then delete the M0 host.
M1a.1 is a tracer: one thread read and one post through the new layers, visible in the app,
before the layers are widened.

| Slice | Scope | Gate | Tier |
|---|---|---|---|
| M1a.0 | Core test harness: Sim vector loader, group fixture, local BEAM relay fixture; public-relay gate becomes an opt-in smoke | Node tests | Core |
| M1a.1 | Ports and memory adapters; `TreehouseSession`; tracer: thread timeline and `postMessage` through the session, shown in the M0 screen | Node tests; simulator relaunch | Core |
| M1a.2 | `ReplicaStore` on SQLite with per-frame append, append-only checks, verify on open | Node tests on memory; adapter test on simulator | Simulator |
| M1a.3 | `LocalStore`: petnames, drafts, read markers, first-seen times | Node tests | Core |
| M1a.4 | Read models: `GroupSummary`, `LinkStatus`, `ThreadList`, `ThreadTimeline`, `Abilities` (using `memberCapability`), `Roster`, `AuditView`, `SessionStatus` | Node tests against Sim vectors and the local relay | Core |
| M1a.5 | Remaining thread commands on the pipeline with typed outcomes; strings table with exhaustive reason mapping | Node tests incl. every refusal | Core |
| M1a.6 | Demo bootstrap moved to `src/demo/`, excluded from release builds; covers M0.2 and the rest of M0.3 | Node tests | Core |
| M1a.7 | Navigation skeleton (three tabs, pushed thread screen), lifecycle (foreground, background) | simulator run | Simulator |
| M1a.8 | CI job: typecheck, Core tests, progress check | job green | Core |

## M1b: chat loop on iOS

| Slice | Scope | Gate | Tier |
|---|---|---|---|
| M1b.1 | Threads tab with unread and waiting marks | simulator + browser starter, two identities | Simulator |
| M1b.2 | Thread screen: timeline, grouping, composer, drafts, delivery marks | offline post, heal, restart | Simulator |
| M1b.3 | Edit and delete with confirmations and placeholders | Sim-compared result | Simulator |
| M1b.4 | Arrived-later marks and unread by id | scripted partition and heal | Core + Simulator |
| M1b.5 | Not-counted and relay-refused states; cannot-post reasons | forced quarantine case | Core |
| M1b.6 | Archived thread: banner, read-only, moderator archive action | Sim-compared | Simulator |
| M1b.7 | Group tab: relay, safety, my key, Verify & audit (read-only), export | simulator run | Simulator |

Exit: iOS Simulator and the browser starter converse over the demo relay in both directions,
through an offline period, with results equal to Sim. Demo identities only.

## M2: people and invitations

The ceremony can be built and tested now: the local BEAM relay used by the test fixtures
admits any key written into its manifest. G-1 blocks only the public demo relay and real use.

| Slice | Scope | Gate | Tier |
|---|---|---|---|
| M2.0 | G-1 option (b) on the public demo relay, or a recorded decision to use manual admission (substrate track; not needed for M2.1 to M2.5 against a local relay) | device key connects to the public demo | Core |
| M2.1 | Onboarding: welcome, trust card, key creation, choose | simulator | Simulator |
| M2.2 | Ceremony saga, both sides, text artifacts via paste and share | Node test of the full saga incl. crash at every step | Core |
| M2.3 | QR show and scan for request, single-thread offer, acceptance | two simulators or one phone and one simulator | Simulator |
| M2.4 | People tab: roster, petnames, key check, invitations in progress, revoke | simulator | Simulator |
| M2.5 | Remove member, change moderator, transfer admin with confirmations; removed and problem screens | Sim-compared | Simulator |

Exit: a fresh install with its own key joins a Group on a local relay through the app alone
and posts. Doing the same on the public demo relay additionally needs M2.0.

## M3: iOS polish and first real phones

| Slice | Scope | Tier |
|---|---|---|
| M3.1 | Dark mode, dynamic type, VoiceOver labels, haptics, keyboard behaviour | Simulator |
| M3.2 | Thread health and continue-in-new-thread (needs G-2, else prompt only) | Simulator |
| M3.3 | Lease expiry and lapsed-grant messaging | Core |
| M3.4 | TestFlight build; two iPhones over `wss://`; in-person ceremony | Physical |

## M4: Android parity

Keystore custody, camera permission flow, back gesture, insets, APK. Exit: an iPhone and an
Android phone complete the ceremony in person and chat through an offline period. Tier:
Physical.

## Parallel substrate work

| Item | Unblocks | Owner track |
|---|---|---|
| G-1 relay access from the Space log | M2 for real, removal | substrate; needs its own plan |
| G-2 self-service replica provisioning | Start a group, New thread, rollover | substrate; builds on Plan 224 |
| G-3 shared application layer in shell-kit | less duplication with Tauri | substrate; can follow M1a |
| G-4 enrollment limits | groups above 3 threads, moderator admission | lattice-client |
| G-5 durable refusal | stable "relay did not accept" | shell-kit |

## Open decisions

Each has a default the work proceeds on. They are assumptions made under delegation, to be
confirmed or changed by the operator; changing one means editing the doc that owns it.

| # | Decision | Assumed default | Why | Owner doc |
|---|---|---|---|---|
| O-1 | Lift the Tauri workflow into shell-kit, or write a mobile-only session? | Mobile-only session in M1a behind ports shaped for lifting; lift after M1b | Lifting first stalls the app on a refactor of working Tauri code | 02 |
| O-2 | One Group per install, or many? | One | The Tauri shell and shell-kit assume one anchor; many adds a switcher and per-group custody questions | 04 |
| O-3 | Expo Router or hand-rolled navigation? | Expo Router, as `AGENTS.md` already directs | Deep links for `treehouse://` artifacts come with it | 02 |
| O-4 | Offer hand-off above one thread | Share sheet text; multi-part QR only if in-person testing shows the need | 2.7 KB is at the edge of one QR; 8.2 KB is past it | 03 |
| O-11 | Which phone may admit when Threads have their own keys? | Only the phone that created the Threads (in practice the root's phone); the app says so | Thread keys do not move between devices and no key transfer exists | 03 |
| O-5 | How does a device key reach the demo relay for M2? | G-1 option (b), labelled demo scaffolding | Smallest change that makes the join flow real | 05 |
| O-6 | Persist relay refusals? | Not in M1; show last-sync state only | Needs a shell-kit change; low frequency | 03 |
| O-7 | Plan 180 puts iOS after E1; Plan 296 is iOS first | 296 runs as a parallel demo track with no E1 claim; record in the plan index | The operator started 296 directly | 05 |
| O-8 | Show first-seen time on messages? | Day separators and message details only, never per-bubble clock times | A per-bubble time reads as a send time, which does not exist | 03 |
| O-9 | Enforce the PROGRESS rule in CI? | Local script now; CI job when the mobile client gets its own workflow | No mobile CI job exists yet | README |
| O-10 | Message length limit | 4,000 characters, refused locally with `text_too_long` | No domain limit is pinned upstream; 4,000 characters is well under the relay's 64,000-byte socket frame | 03 |
