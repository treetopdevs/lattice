# Treehouse Mobile: progress

The monitoring document for Plan 296. It records what is built and what evidence exists.
Design lives in the numbered docs beside it.

## How to update this file

Update it **in the same commit** as any change under `clients/treehouse-mobile/` or
`docs/treehouse-mobile/`. `scripts/check_treehouse_mobile_progress.sh` fails otherwise.

1. Add one entry at the top of the **Log**: date, commit subject, what changed, what was run
   and its result, and the evidence tier. A commit cannot name its own hash, so entries are
   keyed by date and subject.
2. Update the **Status board** row for the slice you touched.
3. Update **Known gaps** and **Next up** if they changed.
4. Report failures and skipped checks as plainly as passes. "Not run" is a valid result.

Evidence tiers: **Core** (Node, memory adapters), **Simulator** (iOS Simulator or Android
Emulator with real native modules), **Physical** (real phones). A row claims the highest tier
that actually ran, nothing higher.

Status values: `todo`, `doing`, `done`, `blocked (reason)`.

## Snapshot

| | |
|---|---|
| As of | 2026-11-25 |
| Milestone | M0.1 self-check passed on the simulator (sqlite) after a Hermes SHA-256 shim; M1a.0 and M1a.1 done at Core; M1a.2 replica store at Simulator for its contract on expo-sqlite (not wired into the app); M1a.3 local store, M1a.4 read models, M1a.5 command pipeline and M1a.6 demo fence at Core; M1a.8 CI job written, never run |
| Highest evidence tier reached | Simulator |
| Works today | On the iPhone 17 Pro simulator (iOS 26.5): self-check passes (custody, storage sqlite, crypto with subtle SHA-256); read-only sync from the demo relay stays live and shows the welcome post, also after relaunch and again after M1a.5 (launch smoke only); the trust card shows the approved hosting sentence and the demo-keys notice; the `SqliteReplicaStore` contract passes 6/6 on real expo-sqlite. Core: verify-on-open (`verifyHeld`) and gated merge, carry-over of the M0 snapshot outbox, local store (petnames, drafts, read markers, settings), demo code fenced behind `__DEV__`/`EXPO_PUBLIC_TREEHOUSE_DEMO=1`, no-relay-access status against the local relay; the session's read models (status, group, link pill, threads, timelines, abilities, roster, audit) checked against Sim vectors and the judge; edit, delete, moderator remove, archive, petname, draft, mark-read, goOnline, goOffline and syncNow on `TreehouseSession`; all copy in `src/ui/strings.ts` |
| Does not work today | the app still runs on the M0 host bridge and the M0 screen, so the replica store, carry-over, local store, the new read models and the new commands are not used by the running app (verify-on-open does run at launch over the M0 snapshot, and a failure stops sync with a history_invalid notice, Core evidence only); building the judged view costs about 5 s at 4,000 ops in Node (quadratic, Hermes not measured); post, force-quit and relaunch never run on a simulator; a phone's own key on the relay (no in-app path dials with the device key now that Keychain mode is gone); invitations; edit, delete, archive from the UI; people management; the CI job has never executed |

## Status board

| Slice | Status | Tier | Evidence |
|---|---|---|---|
| M0 scaffold, typecheck, Hermes bundle | done | Core | `tsc --noEmit` clean; `expo export --platform ios` bundled 708 modules (2026-11-25) |
| M0 live relay gate | done | Core | `npm test` against `lattice-demo-wss.fly.dev` passed with `MemoryKeyStore` and `MemoryMobileStorage` (2026-11-25), as `test/m0_wss_gate.mts`. Since M1a.0 that script is `test:smoke` (`test/smoke/demo_relay.mts`, imports rewired) and has not been rerun after the move; `npm test` now runs the Core suite |
| M0.1 simulator boot with real SecureStore and SQLite | doing (post/relaunch step not run) | Simulator | iPhone 17 Pro, iOS 26.5, Xcode 27.2: self-check custody, storage `sqlite`, crypto all pass (screenshots `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m01_selfcheck_subtle.png`, `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m01_selfcheck.png`, `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m01_selfcheck_after_m1a2.png`); read-only sync live and same after relaunch (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m01_threads_live.png`, `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m01_threads_relaunch.png`). Post, force-quit, relaunch not run (no loopback relay pointer) |
| M0.2 trust-card copy | done | Simulator | approved hosting sentence from 01, now in `src/ui/strings.ts` (re-exported by `src/ui/trust_card.ts`); `demo_fence.test.mts` and `strings.test.mts` assert it. Seen on the Relay & Safety tab in the dev build during the M1a.5 launch smoke, read from the accessibility tree (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a5_trust_card.png`) |
| M0.3 device-key identity against the relay | doing | Core | refused Space route gives `no_relay_access` and 04's copy against the local relay (`demo_fence.test.mts`). No in-app path dials with the device key, so the screen copy cannot appear for this case yet |
| M1a.0 test harness and fixtures | done | Core | 4 named tests pass in the 18/18 Core suite; `tsc --noEmit` clean (2026-11-25). Needs `MIX_ENV=test mix compile` for the local relay tests. Smoke script not run |
| M1a.1 ports, session and post tracer | done | Core | 9 named tests pass in the Core suite (68/68 on 2026-11-25). Simulator: read-only sync and relaunch seen through the app (M0.1 row); the post and relaunch scenario not run |
| M1a.2 SQLite replica store | doing (not wired into the app) | Simulator | contract 6/6 on expo-sqlite in the dev build (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a2_replica_store_green.png`; RED control 4/5 `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a2_red_control.png`). Verify-on-open, gated merge and carry-over: Core only. Force-quit relaunch not run |
| M1a.3 local store | done | Core | `local_store.test.mts` 10/10 (memory and node:sqlite adapters). `openExpoLocalStore` never ran on a device |
| M1a.4 read models | done (not wired into the screen; 150 ms budget met by the projection only) | Core | 11 named tests plus more in the Core suite (108/108 after the review fix round, 2026-11-25); Sim vectors and real-signed judge authoring as references; 4,000-op projection about 9 ms (asserted under 150 ms), a whole replica change about 4.7 s (asserted under a measured 15 s ceiling; the 150 ms budget is unmet there). App.tsx does not read the new models |
| M1a.5 command pipeline | done (not wired into the screen) | Core | 9 named tests plus extra checks in the Core suite (108/108 after the review fix round, 2026-11-25). Dev build still launches with the new session (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a5_threads_live.png`), launch evidence only; no command ran on a simulator |
| M1a.6 demo bootstrap fenced | done | Core | `demo_fence.test.mts` 5/5 (refused and admitted against the local relay); release `expo export --platform ios` holds 0 `lattice-demo-wss` strings (rechecked after M1a.5). The demo-keys notice and trust card were seen in the dev build during the M1a.5 launch smoke (`m1a5_trust_card.png`); the demo bar's role switcher was not exercised |
| M1a.7 navigation and lifecycle | todo | - | |
| M1a.8 CI job | doing (never run) | - | `treehouse_mobile` job in `flagship.yml`; actionlint adds no findings; steps dry-run on macOS only. Needs the first hosted run |
| M1b.1 to M1b.7 chat loop | todo | - | |
| M2.0 public demo relay access for device keys | blocked (G-1) | - | |
| M2.1 to M2.5 people and invitations | todo | - | testable against a local relay without M2.0 |
| M3 polish and first phones | todo | - | |
| M4 Android | todo | - | |

## Known gaps

| Gap | Effect | Tracked in |
|---|---|---|
| G-1 relay admits only manifest realms | a self-made key cannot connect (confirmed 2026-11-25); join flow cannot complete | 05 |
| Mobile custody holds one key | cannot create bounded Threads or grant them to new members | M1a.1, O-11 |
| G-2 no self-service replica provisioning | no Start a group, New thread or rollover | 05 |
| No loopback relay pointer in the dev build | the app only knows the public demo relay's manifest, seeds and routes and goes online at every launch, so the post, force-quit and relaunch scenario (M0.1, M1a.1, M1a.2) cannot run without writing to the public relay. M1a.5 found `scripts/demo_ecosystem_relay.sh` runs `pilot_node.exs` on loopback and writes `demo-endpoints.json`, but nothing local serves the `/demo-endpoints.json` and `/demo-seed/<role>` routes the demo code fetches, so this needs new seed-serving code | M1a.7 |
| Replica store, carry-over and local store not wired | carried from M1a.4 (it conflicted with that slice's file list and Core tier). The running app still reads and writes the M0 host's snapshot through `host_session_ports.ts`; `session.open()` verifies that snapshot at launch and App.tsx stays offline with a history_invalid notice on failure, but the host's own merges are not gated by the session, no export or re-sync action exists yet (04), and the history_invalid notice has not been seen on a simulator | M1a.7 |
| Carry-over must run before `storage.ts` goes | `carryOverLegacyProfiles` exists (Core) but nothing calls it; deleting `src/native/storage.ts` first would strand unsynced posts. `storage.ts` and `treehouse_mobile_host.ts` stay while the host and selfcheck import them | M1a.7 |
| Judged view cost grows quadratically; 150 ms budget unmet end to end | `replica_view.ts` builds one decode and judge per replica change from lattice-client's decode plus two materializes: 48+49 ms at 500 ops, 153+143 ms at 1,000, 522+525 ms at 2,000, about 2.5+2.5 s at 4,000 in Node, run synchronously by the session on every frame that arrives. The 4,000-op test asserts 150 ms on the projection only (about 9 ms) and a measured 15 s ceiling on a whole replica change (about 4.7 s), so it catches regressions but does not claim the budget. Needs a lattice-client change (incremental judged view); not measured on Hermes | M1a.4 budget test, lattice-client |
| Gated merge re-verifies every held replica | signatures are cached, but each merge re-hashes and re-materializes all held frames; not measured in M1a.4 | M1a.7 |
| Hermes has no WebCrypto | `src/polyfills_crypto.ts` installs SHA-256 only for `crypto.subtle.digest`; `lattice-client/src/treehouse_offline_enrollment.ts:28` calls `crypto.subtle` unguarded, so any other algorithm throws on a phone. M1a.4 and M1a.5 add no new `crypto.subtle` use (only `canonicalHash` SHA-256) | M2 |
| New read models and commands not on screen | App.tsx is still the M0 screen with the M0 capability picker and per-render reduction; it does not read `Abilities`, `ThreadList`, `Roster` or `AuditView`, has no edit, delete, remove or archive controls, and keeps inline copy (its `DELIVERY_LABEL` duplicates `strings.deliveryLabel`). The enlarged session ran on Hermes only as a launch smoke | M1a.7 |
| Ability probes the judge with a synthetic op | closed in the review fix round: the archive list is gone and `abilities.ts` asks `treehouseCommandOpStatus` about a probe op targeting a probe post of this key's own. The probe depends on the judge checking a target before the archive rule; an exported per-command policy query in lattice-client would be cleaner. The delegation match is pinned to `memberCapability` by a Core test | lattice-client |
| 4,000-op ceiling headroom | the whole-change ceiling (15 s) is about 3x the 4.7 s measured on this Mac; the Linux CI job has never run, so it may need adjusting there | M1a.8 |
| identity_mismatch copy has one line | `phaseCopy.identity_mismatch` says the key "doesn't match the saved group" even for a locked key with nothing held (`key_unavailable`); the screen should branch on `reason` | M1a.7 |
| Pipeline signs before the pre-judge | a former role holder (`not_holder`) or a command on an archived Thread is signed, then refused by the pre-judge and discarded; nothing is saved, but with a biometric Keychain this would prompt for a signature that is thrown away. Deferred from the review (agy minor) | M1a.7 |
| Winning edit id grouped in the app | `thread_timeline.ts` groups honored edit effects by root to ask lattice-client's `lww` for the winning edit id, because `causalListEntries` returns the winning value but not its op id. Not a reducer (the winner is upstream's), but an exported winner id would remove the grouping | lattice-client |
| Read model limits | `relay_refused` lasts for the last sync only (O-6); removal-pending and relay access are known only for this phone's own key; audit grants show only live or not_live (lattice-client does not export revoked versus lapsed); "joining" is inferred from an honored, unrevoked invitation until a ceremony store exists; `lastSyncMs` is a session stamp because `FeedState` has no timestamp or sync counter: it moves when every route is live and compared and either a relay result moved or a `syncNow` completed, so a feed-driven sync that changes nothing does not move it; a key the held Space neither admits nor invites, with no other key's outbox, is `key_only` | M1b, M2 |
| Replica store device check lives in `App.tsx` | the dev-only "Replica store check" card is the simulator gate's entry point; M1a.7 must carry it over | M1a.7 |
| `CI=1 expo start` does not watch files | a stale bundle is served after edits; restart Metro with `--clear` | - |
| M1a.8 job never ran | `npm ci` for Expo/RN deps and the Core suite have never run on Linux; the Core tests need Node 22.13+ for `node:sqlite` | M1a.8 |
| Demo bar role switcher not exercised on screen | the trust card and demo-keys notice were seen in the M1a.5 launch smoke; switching roles was not tried | M1a.7 |
| Doc 06's M1a.3 row says "first-seen times" | stale; 03 names `ReplicaStore.firstSeenMs` as owner and LocalStore holds none | 06 |
| M0 host re-reduces per render and rewrites the whole snapshot per save | will not scale past small threads; the session's projections replace it once the screen reads them | M1a.7 |
| M0 capability picker ignores required roles | may offer an action the judge then refuses; the session's `Abilities` model fixes this but App.tsx does not read it | M1a.7 |
| M0 screen's LocalStore is in memory | `local` is now a required session port; `App.tsx` passes `openMemoryLocalStore()` explicitly, so petnames, drafts, read markers and the sync setting do not persist across launches until M1a.7 wires `openExpoLocalStore`. The M0 screen calls no local command | M1a.7 |
| `src/lib/host_session_ports.ts` is a temporary bridge | the session reads and writes the M0 host's identity-scoped snapshot so no queued post is stranded; its `firstSeenMs` returns undefined, its link `start`/`stop` do nothing (the host still owns online/offline), so the session's new `goOnline`/`goOffline` do not drive the running app, and its `syncNow` only forwards the post nudge to the host while online | M1a.7 |
| Local relay fixture borrows a Tauri shell script | `test/support/local_relay.ts` runs `clients/treehouse-tauri-shell/test/support/treehouse_enrollment_fixture.exs` by path to create empty logs | M1a.8 |
| `test:smoke` `DEMO_WSS_WRITE=1` branch never run | the moved smoke script is typechecked only; without the flag it does not relay | M1a.0 |
| Plan 180 orders iOS after E1 | plan index does not yet say 296 is a parallel track | O-7 |

## Next up

Follow the build order in [07-implementation-plan.md](07-implementation-plan.md):

1. M1a.8: push the junctures and get the `treehouse_mobile` job green on Linux.
2. M1a.7 per 07, plus the items carried from M1a.4: switch the app from `createHostBridge` to `SqliteReplicaStore`, call `carryOverLegacyProfiles` first, then delete `src/native/storage.ts` and `treehouse_mobile_host.ts` (its demo code has moved to `src/demo/`); gate the host's merges through the session; add the export / re-sync recovery action (04); put the read models, commands and `strings.ts` copy on screen; keep the Replica store check card.
3. Add a dev-build pointer to a loopback relay (with local serving of `/demo-endpoints.json` and `/demo-seed/<role>`) without widening release behaviour, then run the post, force-quit and relaunch scenario on the simulator (M0.1, M1a.1, M1a.2) and look at the history_invalid notice.
4. Ask for a lattice-client change that makes the judged view incremental, and measure `replica_view` on Hermes.

## Log

Newest first.

### 2026-11-25 · feat(treehouse-mobile): M1a.4 read models and M1a.5 command pipeline

Screenshots are in the session scratchpad
`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/`.

- **M1a.4 read models (Core only; nothing ran on the simulator or Hermes for this slice).**
  - New pure projections under `src/session/projections/`: `replica_view` (one shared decode and
    judge per replica change; live delegations computed on first read), `abilities`,
    `group_summary`, `link_status` (takes over `relayAccess`; `trust_card.ts` re-exports it),
    `roster`, `session_status`, `thread_list` and `audit_view`.
  - `thread_timeline` extended: delivery saved, sending, on_relay, relay_refused, stopped;
    standing and the not-counted reason from the judge; lineage ref, edited flag, removed
    placeholder (by author or moderator); first-seen time, unread, arrivedLate, unreadCount and
    thread health (ops and bytes).
  - `TreehouseSession` publishes status, group, linkStatus, threads, abilities, roster and audit
    beside the existing timelines, link and history; unchanged models stay identical and an
    untouched thread is not re-projected. `SessionPorts` gains an optional `local: LocalStore`
    (defaults to an empty memory store so the host bridge still typechecks). `App.tsx` gained two
    delivery labels only because `Record<Delivery, string>` grew.
  - Decisions under delegation, recorded in 03: pill precedence offline, relay_refused,
    reconnecting, live, partly_connected, connecting; arrivedLate is positional (unread and sorted
    above a read id; LocalStore keeps no viewed time); my own, removed and not-counted messages are
    never unread; my not-counted posts follow the counted timeline, other people's appear in the
    audit view only; audit grants are live or not_live; `threadSlots.total` is
    `TREEHOUSE_LITE_THREAD_CAP` (3); custody unavailable with history present is
    identity_mismatch (`key_unavailable`); "joining" is inferred from an honored, unrevoked
    invitation; `lastSyncMs` is stamped by the session.
  - App-side logic weighed against STOP condition 1, none re-implements a reducer: abilities
    composes `liveTreehouseDelegations`, `treehouseCommandRoles`, `authorityRole` and the
    materialized holder, as the Tauri snapshot does, and hard-codes the archive-blocked commands
    (`post`, `author_edit`, `author_tombstone`) mirroring `archiveStatus` (new Known gap); removed
    placeholders use `causalListEntries` over honored post effects without deletes; the winning
    edit is lattice-client's `lww`.
  - References: Sim vectors (Space state, holders, members, roster; thread order and winning
    text; quarantine reasons verbatim in the audit view; every Sim command op checked against
    abilities over its own causal past); the judge through real-signed authoring over 3 states ×
    4 keys × 9 commands; shell-kit's real `createFeedController` over FakeRelay for delivery
    (`test/support/fake_feed_link.ts`, plus `test/support/authoring.ts`).
  - RED: 18 new tests, 0 pass (module not found, undefined `phase`, assertion failures, and the
    4,000-op test at 5,267.8 ms). Mutation check: removing the holder rule from `abilities.ts`
    failed "abilities match the judge"; restored.
  - Tests changed after RED: the 4,000-op test asserts the 150 ms budget on the app's projection
    over the shared judged view only (about 10 ms); the standing test pins the judge's verdict
    (both posts `revoked_capability`); edit-lineage asserts added; the abilities property gained a
    "roles moved to alice" state so `not_holder` is exercised; the delivery test asserts
    `lastSyncMs`. M1a.1's `session_tracer.test.mts` now filters removed placeholders.
  - FAILED budget end to end: building the judged view (decode plus two materializes) costs about
    2.5 s + 2.5 s at 4,000 ops in Node and grows quadratically (48+49 ms at 500, 153+143 ms at
    1,000, 522+525 ms at 2,000). Measured and printed, not asserted; needs a lattice-client change;
    not measured on Hermes. The carried "gated merge re-verifies every held replica" was not
    measured.
  - NOT DONE, carried to M1a.7 (they conflict with the slice file list and Core tier, and an
    unverified storage swap is the stranded-posts risk of defect (a)): switching the app to
    `SqliteReplicaStore`, calling `carryOverLegacyProfiles`, deleting `src/native/storage.ts` and
    `src/lib/treehouse_mobile_host.ts`, gating the host's merges, the export / re-sync action (04),
    seeing the history_invalid notice on a simulator, and moving the screen off the M0 capability
    picker and per-render reduction.
- **M1a.5 commands and strings (Core).**
  - New commands under `src/session/commands/`, all through `pipeline.ts` (ability, author,
    pre-judge, save, nudge): `edit_message.ts` (`author_edit`; target is the held lineage's latest
    edit, never the caller's `ref.latest`), `delete_message.ts` (`author_tombstone`),
    `remove_message.ts` (`moderator_tombstone`), `archive_thread.ts`, `local_commands.ts`
    (petname, draft, markRead; nothing signed; a failed write is `storage_failed`) and
    `link_commands.ts` (goOnline, goOffline, syncNow over `syncEnabled`; refused with
    `history_invalid`). `pipeline.ts` lets `PipelineStep.command` be a function of held frames;
    `post_message.ts` shares `checkText` with edit; `outcomes.ts` gains the Text, ThreadCommand,
    Edit, Delete, Remove, Archive, Local, Link and AnyCommand refusal unions.
  - `TreehouseSession` exposes `editMessage`, `deleteMessage`, `removeMessage`, `archiveThread`,
    `setPetname`, `saveDraft`, `markRead`, `goOnline`, `goOffline` and `syncNow`, closing the
    gap "goOnline/goOffline/syncNow not on TreehouseSession". Signed commands share
    `postMessage`'s guards; local and link commands refuse `not_open` before open.
  - New `src/ui/strings.ts`: all copy as typed Records keyed by session unions (`refusalCopy`
    over `AnyCommandRefusal | AbilityRefusal`, so a missing reason fails `tsc`), plus delivery,
    pill, removed placeholder, phase copy and 04's confirmations; `trust_card.ts` re-exports it.
  - Decisions recorded in 03: signatures are `editMessage(thread, ref, text)`,
    `deleteMessage(thread, ref)`, `removeMessage(thread, ref)` with the timeline's
    `MessageLineage` (03 said `editMessage(ref, text)`; `MessageRef` has no replica and
    `local_store.test`'s import scan forbids signed commands reaching `src/local`); only
    `ref.root` is trusted; no app-side archive or target pre-check; new reasons `not_open` and
    `link_failed`. Copy change: 04's archived banner "Archived. Read only." used 01's never-used
    "Read"; it is now "Archived. No new messages." in `strings.ts` and 04.
  - Six application denials: Sim reference (`treehouse_thread_archive`; the session's audit
    quarantine set equals Sim's) for `archived thread`, `wrong author`, `quarantined target`;
    judge only, authored through the commands, for `missing or not-causal target`, `wrong target
    kind or thread`, `already tombstoned` (no Sim vector pins them at full frontier). The
    moderator test uses a real `change_moderator` transfer: the former holder is refused
    `not_holder` by the pre-judge, the new holder's remove counts, a member without the role gets
    `no_capability` before signing.
  - RED: 16 new tests in 8 files, 0 pass (missing session methods, missing `src/ui/strings`).
    Mutation checks: a lineage target forced to the root failed the edit and delete tests; "Read
    only." and "Nothing hosted." in strings failed the never-used and Plan 178 scans; restored.
  - Hermes: the new commands reach WebCrypto only through `canonicalHash` SHA-256, which the shim
    covers.
  - Simulator launch smoke (optional, launch only, not a slice gate): iPhone 17 Pro, iOS 26.5,
    dev build, fresh Metro bundle (827 modules). The app launches; Threads shows "Live · gen#5"
    with the welcome post "On relay" (`m1a5_threads_live.png`); Relay & Safety shows the approved
    hosting sentence and the demo-keys notice, read from the accessibility tree
    (`m1a5_trust_card.png`), the first on-screen sighting of both. Only lattice-client require
    cycle warnings. No command ran on the simulator (the M0 screen has no such controls).
  - NOT DONE: `App.tsx` inline copy not moved into `strings.ts` (M1a.7 replaces the screen);
    commands not wired to any control. NOT RUN: post, force-quit, relaunch; no loopback pointer
    was added because nothing local serves `/demo-endpoints.json` or `/demo-seed/<role>`. Left
    for M1a.7.
- **Integrator gate.** `tsc --noEmit` exit 0; Core suite 104/104 pass, 0 fail; `expo export
  --platform ios --clear` bundled `index-249eb2ae6828df541d832f9bb7ecd329.hbc` (2.6 MB) with 0
  `lattice-demo-wss` and 0 replica-store devcheck strings; progress script ok (staged). No
  cross-slice fixes were needed. Tier: Core for both slices; the M1a.5 launch smoke is Simulator
  launch evidence for M0.2 copy only. Nothing was written to the public demo relay (the launch
  smoke synced read-only).

- **Independent review and fix round.** Reviewers: Codex (`gpt-6.1-sol`, high; the user's standing
  model, run in place of the requested 6.2) and Antigravity Neon (medium). 17 findings (7 Codex, 10
  agy; 13 distinct after duplicates): 16 accepted (3 of them in part), 1 rejected, and 2 parts
  deferred. One fix round, no second review.
  - Accepted and fixed:
    - abilities (Codex blocker, agy major, STOP 1): `ARCHIVE_BLOCKED` is removed. The archive refusal
      now comes from lattice-client's `treehouseCommandOpStatus` over a probe op (mutation check:
      dropping the probe fails "abilities match the judge" on the archived state). The delegation
      match is kept as composition, as the Tauri shell's `treehouse_workflow.ts:623-635` does it, and
      a new test pins it to `memberCapability` at every prefix of the four vectors, with both
      granted and denied verdicts exercised.
      `postMessage`'s app-side archive pre-check is gone, so the pre-judge names "archived thread"
      after the capability check.
    - delivery (both): a message now shows the least delivered of my lineage ops. A new test
      covers an offline edit of an acked post (`saved`), a refused edit (`relay_refused`) and an
      unsent delete (`saved`). RED: `on_relay` where `saved` was expected. `edited` is false on
      removed placeholders, and the O(E²) spread is gone.
    - identity_mismatch (Codex): signing, `goOnline` and `syncNow` now stop. RED (observed with the gate
      disabled once): under Bob's key over Alice's outbox, `postMessage` returned `ok: true` with an
      id, so the post was signed and saved. A locked key with
      nothing held is `identity_mismatch` (`key_unavailable`), not `no_key` (agy, in part). The new
      reason `identity_mismatch` has copy.
    - `local` (Codex) is now a required port, and the no-op backend is deleted. The 4,000-op test
      (both) asserts the whole change under a measured ceiling, and the projection-only 150 ms under
      an honest name.
    - Roster: a Thread with zero frames is no longer a moderator mismatch (both). GroupSummary slots
      are the contract's 12, with `inviteScopeCap` 3 (both).
    - Refusal copy no longer says "grant" (agy).
    - `lastSyncMs` (agy, in part): every completed `syncNow` stamps, and only all-live routes
      stamp. RED: 2,000 where 62,000 was expected.
  - Rejected, with evidence:
    - agy claimed `thread_timeline` duplicates `causalListEntries` (STOP 1). The placeholder list
      is `causalListEntries` itself. The edit grouping only prepares input for upstream's `lww`,
      because `causalListEntries` (`reducers.ts:77`) returns the winning value, not its op id. This
      is recorded as a Known gap.
    - Also rejected, in part:
      - agy's "a true-to-false `matchesRelay` flip is stamped as success". `matchesRelay` is
        shell-kit's comparison result after a completed sync (`feed.ts:39`). The delivery test
        stamps a pending sync by design.
      - agy's "a key not in the Space should be `identity_mismatch`". The outbox keeps every
        authored id, so a key change on a phone that ever authored is already `outbox_other_key`.
        A revoked invitee is `key_only`.
  - Deferred, both recorded in Known gaps:
    - the pipeline signs before the pre-judge refuses `not_holder` (agy minor), to M1a.7;
    - the end-to-end 150 ms budget, to lattice-client.
  - Decisions are recorded in 03 ("Decisions recorded in the M1a.4-M1a.5 review fix round").
  - The fixes do not change what the M0 screen shows. `App.tsx` passes an explicit in-memory
    LocalStore, which is the same default as before. The launch-smoke screenshots predate the fix
    round, and the app was not relaunched after it.
- **Final gate (after the fix round).** `tsc --noEmit` exit 0. Core suite 108/108 pass, 0 fail.
  `expo export --platform ios --clear` exit 0, `index-cb19e4060f9a0ba7b97774b366f107bf.hbc`, with
  0 `lattice-demo-wss` and 0 replica-store devcheck strings. Progress script ok (staged). Tier:
  Core.

### 2026-11-25 · feat(treehouse-mobile): M1a.2 SQLite replica store, M1a.3 local store, M1a.6 demo fence, M1a.8 CI

Screenshots are in the session scratchpad
`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/`.

- **M0.1 simulator gate (stage 1).** iPhone 17 Pro, iOS 26.5, Xcode 27.2 selected; input
  through agent-device now works. The existing Xcode-beta `ios/` build was reused (JS from Metro).
  - Found: on Hermes, sync never merged anything. Hermes has no WebCrypto, so
    `lattice-client/src/codec.ts:129` `canonicalHash` threw `crypto.subtle unavailable`; both
    routes flapped between live and reconnecting with `ops 0`. The earlier "Live gen#5" launch
    evidence covered the subscription only. Node tests cannot catch this, and the first
    self-check missed it because its crypto leg called noble directly.
  - Fix: new `src/polyfills_crypto.ts`, imported from `src/polyfills.ts`, installs
    `crypto.subtle.digest` (SHA-256 only, `@noble/hashes`; other algorithms throw) when
    `crypto.subtle` is missing. The self-check crypto leg also checks the subtle SHA-256 known
    answer. Two new tests in `test/core/selfcheck.test.mts`; RED 2 failing (`ERR_ASSERTION`,
    `ERR_MODULE_NOT_FOUND`), GREEN 7/7.
  - After the fix: self-check custody, storage `sqlite`, crypto all pass (`m01_selfcheck_subtle.png`,
    `m01_selfcheck.png`, and one more observed pass after stage 3, `m01_selfcheck_after_m1a2.png`).
    Routes steadily live (gen#5 Space, gen#4 Thread, `matchesRelay` true); Threads shows
    "1 posts · 4 ops" with the welcome post "On relay", the same after relaunch
    (`m01_threads_live.png`, `m01_threads_relaunch.png`). Matches the read-only Node smoke.
  - NOT RUN: the post, force-quit and relaunch scenario (M0.1 and M1a.1). The app knows only the
    public demo relay and goes online on every launch, so even an offline post would reach it.
- **M1a.2 SQLite replica store (stage 2 Core, stage 3 Simulator).**
  - New `src/native/sqlite_replica_store.ts` (`SqliteReplicaStore`): 07 schema (replica, frame,
    meta schema_version 1); inserts only, the only UPDATEs move `authored`/`acked` 0 to 1; one
    `withTransactionAsync` per write, held copy and `onChange` after commit; no fallback on open
    error or unknown schema; `first_seen_ms` written in the retaining transaction (owner stays
    `ReplicaStore.firstSeenMs`, already in 03, defect (d) needs no change); one database per
    identity (`replicaDbName(pubkey)`), never the M0 `treehouse_mobile_v1.db`.
  - New `src/session/verify_held.ts` (`verifyHeld`, pure; mobile form of Tauri's
    `verifyProfile` plus `validateProfiles`): ids and signatures, closed deps, outbox and acked
    held, `#root:` genesis, creation command, every Thread referenced by the one Space. An adopted
    replica with no frames passes; Tauri's 43-character replica regex is not ported.
    `strictOpVerifier` moved here and is re-exported from `session.ts`.
  - `session.ts`: `open()` verifies held replicas; a failed open or verify sets
    `ReadModels.history = {ok:false, replica, reason}`, posting is refused `history_invalid`,
    nothing is deleted. The host's `mergeSync` verifies the candidate set before writing.
    `outcomes.ts` and 07's PostRefusal sample gain `history_invalid` (07 also gains
    `malformed_text`).
  - Defect (a): new `src/session/carry_over.ts` (`carryOverLegacyProfiles`) carries one
    identity's M0 snapshot profiles including the unsynced outbox, verifies first, writes nothing
    on failure, is idempotent, skips non-Treehouse replicas and never modifies the legacy
    snapshot. NOT WIRED: the app still runs on the host bridge; M1a.4 must call it before
    `storage.ts` is deleted. `storage.ts` stays.
  - Core tests: `replica_store_contract.mts` (cases now in `replica_store_contract_cases.ts`
    because Metro does not resolve `.mts`; the `.mts` re-exports them), `replica_store.test.mts`
    (memory and node:sqlite adapters, static no-DELETE scan, mid-transaction rollback, no
    fallback, per-identity name, two carry-over tests), `verify_held.test.mts` (2 named plus
    acceptance, merge gate, fresh device converging through the local relay). M1a.1's
    `session_tracer.test.mts` now seeds the Space; only the lone-Thread Sim vector sessions skip
    verify (`SIM_VECTOR_THREAD_ONLY`). RED: 20 of 25 failed (module not found, ENOENT,
    `history` undefined).
  - Simulator: dev-only `src/native/replica_store_device_check.ts` and a "Replica store check"
    card in `App.tsx` (required under `__DEV__` only) run the same contract cases through
    `openExpoReplicaDb`, plus a device-only case injecting a failure inside mergeSync. GREEN 6/6
    (`m1a2_replica_store_green.png`). RED control (acked UPDATE dropped): 4/5 with the mergeSync
    case failing (`m1a2_red_control.png`). "Reopen" here is close and reopen in one process;
    force-quit relaunch not run.
- **M1a.3 local store (Core).** New `src/local/local_store.ts` (port, `Draft`, `MessageRef`,
  `Settings = { syncEnabled }`, petname normalisation trimmed and capped at 40 code points,
  cached store, memory adapter) and `src/local/sqlite_local_store.ts` (own file
  `treehouse_local_v1.db`; petname, draft, read_marker, setting, meta; no silent fallback; writes
  queued in order and durable before the cache changes). `test/core/local_store.test.mts` 10/10
  (memory and node:sqlite); RED module not found. A transitive import scan proves nothing in the
  local store is reachable from the replica store or a signed op, so `LocalStore` must not be
  re-exported from `ports.ts`. NOT RUN: `openExpoLocalStore` on a device.
- **M1a.6 demo fence, trust card, no-access state (Core).** Demo code moved out of
  `treehouse_mobile_host.ts` into `src/demo/` (`manifest.ts`, `identities.ts` with founder and
  neighbor only, `DemoBar.tsx` with the public-keys notice); the host keeps `HostEndpoint` and no
  demo code, so M1a.4 can delete it (defect (e)). `App.tsx` reaches the demo only through
  `DEMO_ENABLED = __DEV__ || process.env.EXPO_PUBLIC_TREEHOUSE_DEMO === "1"` and a guarded
  `require`; Keychain mode removed. New pure `src/ui/trust_card.ts`: approved hosting sentence,
  `relayAccess()` and 04's no-access copy with the "Relay refused this phone" pill.
  `test/smoke/demo_relay.mts` imports from `src/demo`. `test/core/demo_fence.test.mts` 5/5
  (plus 3 solo reruns), refused and admitted cases against the local relay; RED 4 of 5.
  Release export has 0 `lattice-demo-wss` strings. M0.3 screen copy is still not reachable in the
  app (no in-app path dials with the device key).
- **M1a.8 CI (never run).** `flagship.yml`: new `mobile` path class (`clients/treehouse-mobile/**`,
  `docs/treehouse-mobile/**`, `clients/lattice-shell-kit/**`, the reused Tauri
  `treehouse_enrollment_fixture.exs`, core fan-out, workflow_dispatch); mobile paths no longer
  classify as core. New `treehouse_mobile` job builds the BEAM relay (`MIX_ENV=test mix compile
  --force --warnings-as-errors`) and lattice-client, runs typecheck, the Core suite and the
  progress check over the changes job's `BASE..HEAD` (falls back to `HEAD`, failing closed); added
  to `required`. No simulator job, no demo-relay smoke. Local: actionlint no new findings, the
  classifier simulated on sample paths, existing workflow contracts pass, steps dry-run on macOS.
  NOT RUN: the hosted job; `npm ci` and the Core suite have never run on Linux.
- **Integrator gate.** `tsc --noEmit` exit 0; Core suite 68/68 pass; `expo export --platform ios
  --clear` bundled `index-99429f3b76472e2304fd86c9b7bac3d5.hbc` (2.5 MB) with 0 demo-relay or
  devcheck strings; actionlint unchanged (5 pre-existing SC2209); progress script ok (staged).
  No cross-slice fixes were needed. Tier: Simulator for the self-check, read-only sync and
  relaunch, and the replica store contract on expo-sqlite; Core for the rest; none for M1a.8.
- **Review.** Codex (gpt-6.1-sol, high) and Antigravity Neon (medium) ran; both raised the same
  three findings (Neon read repo files only, its diff input was empty). 3 accepted, 0 rejected,
  0 deferred, fixed in one round:
  - (major) `App.tsx` ran verify-on-open through `session.open()` over the M0 snapshot but ignored
    `read().history` and went online anyway, with a blank Threads tab and no notice. Now a failure
    shows 04's "Saved group data failed its check." with the reason code (`HISTORY_INVALID` in
    `src/ui/trust_card.ts`), returns before `host.goOnline()`, and the manual toggle stays offline.
    Static test in `demo_fence.test.mts` (fails on the pre-fix App.tsx). Not seen on a simulator.
  - (major) `carryOverLegacyProfiles` could write before failing when the store already held some
    frames: a legacy outbox id held only by the store threw a TypeError mid-carry, and a misfiled
    legacy frame with an id the store held threw `wrong_replica` after the Space was written. Each
    legacy profile is now checked on its own first (frames filed under their replica, outbox and
    acked ids in that snapshot). New test in `replica_store.test.mts`, RED with
    `Cannot read properties of undefined (reading 'replica')`, writes nothing on either case.
  - (minor) without the demo, the status pill called `host.goOnline()` and showed the raw
    `host_not_configured`; the pill is now `disabled={!demo}`.
  - Final gate: `tsc --noEmit` exit 0; Core suite 70/70 pass; `expo export --platform ios --clear`
    with 0 demo-relay or devcheck strings; actionlint unchanged (5 pre-existing SC2209).

### 2026-11-25 · feat(treehouse-mobile): M1a.0 test harness and M1a.1 session tracer

- M1a.0. New `test/support/vectors.ts` (`loadTreehouseVector`, `judgeTreehouseFrames`,
  `verifyFrames`, `productOf`): expected state is `expectAtFullFrontier.state`, order is the
  `treehouseObservation.posts` ids, quarantined is `authorityQuarantine` (checked equal to
  `quarantine` in all four vectors). New `test/support/group_fixture.ts` (`buildGroup`,
  `testIdentity`, `heads`): a legacy root-only Space and legacy-rooted Thread built with
  lattice-client helpers, then invitation, acceptance and admit-and-grant per member. A
  TestIdentity exposes realm, public key and signer only; seeds come from a random per-process
  namespace and are never exposed. New `test/support/local_relay.ts` (`startLocalRelay`,
  `connectAs`): `pilot_node.exs` on loopback from a hand-written manifest, empty logs from the
  Tauri shell's `treehouse_enrollment_fixture.exs` (called by path, no Elixir changed), seeded by
  the admin relaying every frame over the real socket. `package.json`: `test`/`test:core` run the
  Core suite; `test:smoke` runs `test/smoke/demo_relay.mts`, moved from `test/m0_wss_gate.mts`,
  which reads only unless `DEMO_WSS_WRITE=1`.
- M1a.0 named tests in `test/core/harness.test.mts`; the refusal test also checks an unlisted key
  claiming a listed realm, and the convergence test posts concurrently from two members with the
  relay's advertised ids as reference. RED: all 4 failed with "Cannot find module
  test/support/...".
- M1a.1. New `src/session/`: `ports.ts` (KeyCustody, ReplicaStore with `firstSeenMs`, RelayLink,
  Clock as in 07), `outcomes.ts` (Outcome, PostRefusal, a closed QuarantineReason union of the six
  pinned denials in 03 wording, 12 judge reasons and a `quarantined` fallback; `MESSAGE_MAX_CHARS`
  4,000 code points, text trimmed, exactly 4,000 accepted), `session.ts`
  (`createTreehouseSession`, shell-kit's ShellHost inside; `createFeedRelayLink` wraps
  `createFeedController` unchanged), `projections/thread_timeline.ts` (id, author, text, mine,
  delivery saved/sending/on_relay for my own messages, null for others; canPost; order and
  quarantine from `observeTreehouse`), `commands/pipeline.ts` (ability via `memberCapability`,
  author, pre-judge via `materialize`, save, nudge), `commands/post_message.ts`, and memory
  adapters for every port.
- M1a.1 `src/App.tsx`: the thread tab reads `session.read().timelines[thread]` and Post calls
  `session.postMessage`. The M0 host still owns routes, sync and People. New, outside the slice
  file list: `src/lib/host_session_ports.ts`, a temporary bridge so the session reads and writes
  the host's identity-scoped snapshot (one frame source, no queued post stranded). A
  connect-generation guard drops a session superseded by an identity switch.
- M1a.1 decisions under delegation: `SessionPorts.link` is a factory over the ShellHost so the
  route book comes from RelayLink config; a stopped link's `syncNow` dials nothing and returns the
  idle state; `ReadModels = { timelines, link }`; a post of mine that is not in the outbox (pulled
  from the relay) shows `on_relay`; the boundary test also bans `node:` imports in
  `src/session` and scans `src/App.tsx` as the UI layer until M1a.7. First-seen owner stays
  `ReplicaStore.firstSeenMs`, already recorded in 03, so no doc change.
- M1a.1 RED: 8 of 9 new tests failed (7 ERR_MODULE_NOT_FOUND for `src/session/session`; the
  session boundary test failed its assertion with no files to scan). `ui and route layers do not
  import lattice-client` passed at RED because `src/app` and `src/ui` do not exist and `App.tsx`
  never imported lattice-client.
- Integrator gate: `tsc --noEmit` exit 0; Core suite 18/18 pass, exit 0 (also 3/3 implementer
  runs); `expo export --platform ios` bundled `index-d7e05ea4d8946f698ab4febd878cb833.hbc` (2.5 MB); progress
  script ok (staged). The relay tests need
  `MIX_ENV=test ~/.asdf/shims/mix compile` first. No cross-slice fixes were needed.
- NOT RUN: M1a.1 simulator relaunch and the M0.1 scenario through the new path (Xcode selection
  blocks simulator input); `test:smoke`, so nothing reached the public relay, and its new
  `DEMO_WSS_WRITE` branch is typechecked only. Tier: Core.
- Independent review: Codex (Sol 6.1 high) and Antigravity (Neon medium) both ran and reported
  the same 5 findings. Fact-checked against the code: 5 accepted, 0 rejected, 0 deferred, all
  fixed in one round.
  - (major) `App.tsx` connect: a superseded connect could overwrite the manifest, close the
    current session and reconfigure the host. It now checks `stale()` after every await before
    touching shared state, and its catch and finally do nothing when stale.
  - (major) the bridge's `appendAuthored` awaited the host's relay sync, so a failed sync turned
    a saved post into `storage_failed` (and a retry duplicated it). The host's write is split into
    `saveLocalFrame` (save only); the bridge uses it, and the bridge link's `syncNow` (the
    session's never-awaited nudge) syncs through the host when it is online.
  - (minor) `createFeedRelayLink.configure` checked routes one by one; it now calls
    `validateRoutes`, so an empty, duplicate, Spaceless or too-long set is refused and not saved.
    `SessionHost.validators` is the full `RouteValidators`.
  - (minor) a lone surrogate was reported as `identity_unavailable`; `postMessage` now refuses
    it before signing as `malformed_text`, a new app-level reason recorded in 03 (07's sample
    PostRefusal type does not list it yet).
  - (minor) a link-only state change replaced the timelines record; an unchanged set now keeps
    the identical record.
  - New assertions in `test/core/session_tracer.test.mts` (Spaceless route set refused,
    `malformed_text`, whole-record selector quiet on a link change). RED for `malformed_text`:
    `reason: 'identity_unavailable'` where `malformed_text` was expected.
- Final gate after fixes: `tsc --noEmit` exit 0; Core suite 18/18 pass, exit 0; `expo export
  --platform ios` bundled `index-ed1a8eaf135077c38848a9dfaba1832f.hbc` (2.5 MB); progress script
  ok (staged). Tier: Core.

### 2026-11-25 · feat(treehouse-mobile): M0.1 simulator boot and self-check

- Added `src/native/selfcheck.ts` (`runSelfCheck`, injectable deps): custody through
  expo-secure-store with no fallback, storage via `ExpoSqliteStorage.backend()` reporting
  sqlite vs memory, crypto via getRandomValues, SHA-256 "abc" and RFC 8032 test 1 known
  answers. Added a `__DEV__` Self-check card to the Relay & Safety tab in `src/App.tsx`, and
  `backend()`/`ready()` accessors on `ExpoSqliteStorage` (outside the slice file list, so the
  silent memory fallback is observable). Declared `@noble/hashes` 2.2.0 (already transitive).
- RED: `test/core/selfcheck.test.mts` failed with ERR_MODULE_NOT_FOUND before the module
  existed. GREEN: 3/3 pass; `tsc --noEmit` clean.
- Simulator: `expo run:ios` built with 0 errors, installed and launched on iPhone 17 Pro,
  iOS 26.5; Threads screen showed Live gen#5 as demo-founder (launch evidence only,
  `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m01_launch.png`).
- FAILED / NOT RUN: `agent-device press` and `dismiss-overlay` failed three times with "this
  Xcode cannot start its simulator service on this macOS" (DTServiceHub; `xcode-select -p` is
  Xcode-beta), so Self-check was not tapped and the three-pass `storage: sqlite` gate did not
  run. The post, force-quit, relaunch scenario was deliberately not run: the app only reaches
  the public demo relay and posting there is forbidden. The adapter itself has not failed.
- Doc changes: ground rule 1 of 07 now commits once per juncture (operator instruction); plan
  fixes: M1a.4 keeps `treehouse_mobile_host.ts` until M1a.6 moves the demo code, M1a.7 rewires
  `index.ts`, M1a.8 builds `lattice-client` and the BEAM relay and uses flagship.yml's
  `BASE..HEAD`, first-seen owner is `ReplicaStore.firstSeenMs` (07 M1a.2, 03).
- Review (Codex Sol, Antigravity Neon), one fix round: 10 findings (3 + 7), 9 accepted and fixed
  (default deps load inside error handling; run guard and disabled button; throwaway key deleted
  on exception paths; shared storage handle; keychainAccessible option mirrored; sqlite open error
  surfaced; tests for backend()/ready() and cleanup; stale PROGRESS wording; 07 firstSeenMs port).
  1 partly rejected: the screenshot path is session scratch and stays, labelled launch-only. 0
  deferred. The agy "spec edits outside file list" point is covered by the operator-requested
  plan-defect fixes.
- Final gate: `tsc --noEmit` 0; core tests 5/5; progress script ok. Tier: Core. Simulator not claimed.

### 2026-11-25 · Add Treehouse Mobile implementation plan

- Wrote `07-implementation-plan.md`: target layout, test references, build order, and for M0.1
  and M1a.0 to M1a.8 the files, signatures, named tests, gates and tiers; M1b as scenario
  table; M2 as outline.
- Aligned `06-milestones.md` with it: added M1a.0 (harness) and M1a.8 (CI), made M1a.1 a
  tracer, and narrowed the G-1 block to the public demo relay.
- Found while planning: shell-kit's test helpers boot a local BEAM relay from a manifest that
  can admit any key, so the invitation flow is testable without server changes. The M0 gate
  does not submit to the public relay. Xcode 27 and iOS simulators are installed. The relay's
  socket frame limit is 64,000 bytes.
- No app code changed. Checks run: progress script. Tier: none (docs).

### 2026-11-25 · Add Treehouse Mobile design set and progress log

- Wrote `docs/treehouse-mobile/` (README, 01 to 06, this file) and
  `scripts/check_treehouse_mobile_progress.sh`; linked them from Plan 296 and
  `clients/treehouse-mobile/AGENTS.md`.
- No app code changed.
- Measured enrollment artifact sizes with the real encoders and the live demo's route shapes:
  join request 173 chars, offer 1,494 (one thread), 2,705 (three), 8,155 (twelve), acceptance
  560. Thread ids beyond the first were synthetic.
- Read the live demo manifest: `relay_realms` is `demo-founder`, `demo-neighbor` for both
  Treehouse routes; `demo-observer` is a third participant.
- Ran M0.3 from Node with a fresh `MemoryKeyStore` key: Space and Thread routes both refused
  with `carrier peer error: unauthenticated`; nothing pulled.
- Added `clients/treehouse-mobile/CLAUDE.md` pointing at `AGENTS.md` and the update rule.
- Corrected the M0 record: the gate used memory adapters, and the simulator was never booted.
- Checks run: the progress script in all three modes (working tree: ok; a staged mobile-only
  change: fails as intended; `origin/main..HEAD`: ok with the M0 commit as baseline).
  Tier: Core for the M0.3 result; the rest is docs.

### 2026-11-25 · Scaffold Treehouse Mobile M0 (commit `bd9ddcc55`)

- Added `clients/treehouse-mobile`: Expo SDK 58, React Native 0.88, `TreehouseMobileHost`
  over shell-kit, SecureStore and SQLite adapters, a three-tab screen in `src/App.tsx`.
- Ran: `tsc --noEmit` (clean), `npm test` live relay gate (pass), `expo export --platform
  ios` (pass).
- Not run: any simulator or device launch. Tier: Core.
