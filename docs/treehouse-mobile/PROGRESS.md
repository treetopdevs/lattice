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
| Milestone | M1b.1 to M1b.7 done at Simulator against a loopback relay with a Node second participant: Threads tab, thread screen, edit and delete, arrived-later and unread (M1b.1 to M1b.4); refusal states with Copy text back (M1b.5), archived thread and Thread info (M1b.6), and the Group tab with Relay, Safety, My key, Export to a file and Verify & audit (M1b.7). M1a complete (M1a.8 CI job written, never run). M1 is NOT done: the M1 exit check against the public demo relay has not run (needs the operator's go-ahead), the CI job has never run, and the named-tests audit across 03 was not redone |
| Highest evidence tier reached | Simulator |
| Works today | On the iPhone 17 Pro simulator (iOS 26.5) with the dev build pointed at a loopback relay (`EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN=http://127.0.0.1:4100`, never the public relay): the app launches into the tabs; Threads lists the thread and pushes `thread/[replica]` (a colon-bearing replica id survives as a route param); a post goes "On relay" and the relay's own ids grow; backgrounding closes the app's relay sockets and foregrounding reopens them and posts again; after force-quit and relaunch both posts are present and still on the relay; self-check passes (custody, sqlite row round-trip, crypto); the `SqliteReplicaStore` check passes 6/6 on expo-sqlite. Since M1b.5 to M1b.7 (durable screenshots in `docs/treehouse-mobile/evidence/`): after the admin revokes this key's post grant (second participant `--revoke founder`), a post signed while paused shows Not counted with the judge's reason and Copy text, and the composer is replaced by the reason naming the admin (`m1b5_cannot_post_bar.png`); the long-press sheet's Copy puts the text on the clipboard (`m1b5_sheet_copy.png`); a moderator archive from Thread info or from the other side replaces the composer with "Archived. No new messages." for both roles, with no manual sync (`m1b6_founder_archived_banner.png`, `m1b6_neighbor_live_banner.png`), and the Threads tab moves it under Archived threads; the Group tab shows summary, Relay (hosting sentence, address, per-route connection, Sync now, Pause sync switch), Safety, My key and Export; Verify & audit lists the revoked grant and the not-counted op with `revoked_capability` (`m1b7_audit_revoked_not_counted.png`); Export writes `Documents/treehouse-space-<id>.frames.json` and opens the share sheet; ops authored by the other side while the app was backgrounded arrived on foreground with no relaunch (scratchpad screenshot only); a tampered Thread frame gives history_invalid with Export and Re-sync, and re-sync comes back Live in `_r1` with the old store untouched (`m1b7_history_invalid_recovery.png`); the demo bar's role switcher works (the role resets to Founder on relaunch). Since M1b.1 to M1b.4 (durable screenshots in `docs/treehouse-mobile/evidence/`): a second participant's post raises a row's unread count with no manual sync and opening the thread clears it; three posts made with sync paused show "Saved on this phone", survive a force-relaunch with the draft, and go "On relay" on resume; edit shows "edited" with the draft kept, delete shows the placeholder, a moderator Remove shows its placeholder; a post from the other participant while this phone was paused sorts above this phone's later posts with "Arrived later", is counted on the Threads row and sits under an "N unread" divider; screens show names as You, petname or key check, never the realm; dark mode and large or accessibility text sizes were checked on the Threads tab and the thread screen, with the exceptions listed under Known gaps ("Not seen on a device"). After the review round, a 14-message backlog plus three new posts opened under a "3 unread" divider with no false "Arrived later" caption and the row cleared on return (`docs/treehouse-mobile/evidence/m1b_review_divider_no_false_caption.png`). Seen in stage 1 but with no surviving screenshot: the history_invalid notice after a tampered frame, the D-31 export share sheet and re-sync into a fresh `_r1` store. Core: carry-over of the M0 snapshot outbox (a failed carry-over is history_invalid), the M1a.7 review fixes (not yet on a device), gated merges only through the session, lifecycle binding, `useReadModel` over `useSyncExternalStore`, the read models against Sim vectors and the judge, the command pipeline, the demo fence (release bundle holds no demo strings) |
| Does not work today | The People tab is still a placeholder (M2); people management and invitations have no UI (M2); Continue in a new thread, rollover and the successor link are absent (G-2); Message details is not in the sheet; Copy gives no visible acknowledgement (screen reader only); the lapsed-grant and removed-from-group refusal lines and the `lapsed`/`not_usable` audit states have no fixture and ran in Core only; the demo role is not persisted across launches; plain `npm ci` fails ERESOLVE on the mobile lock (not verified at HEAD); VoiceOver itself never ran (only the accessibility tree was read); carry-over never ran on a device; building the judged view costs about 5 s at 4,000 ops in Node (quadratic, Hermes not measured); a phone's own key on the relay (G-1); the CI job has never executed; lint is not configured |

## Status board

| Slice | Status | Tier | Evidence |
|---|---|---|---|
| M0 scaffold, typecheck, Hermes bundle | done | Core | `tsc --noEmit` clean; `expo export --platform ios` bundled 708 modules (2026-11-25). Release export rechecked at M1a.7 close (exit 0) |
| M0 live relay gate | done | Core | `npm test` against `lattice-demo-wss.fly.dev` passed with `MemoryKeyStore` and `MemoryMobileStorage` (2026-11-25), as `test/m0_wss_gate.mts`. Since M1a.0 that script is `test:smoke` (`test/smoke/demo_relay.mts`); M1a.7 rewrote it onto the app session. It is typechecked only and has not been rerun |
| M0.1 simulator boot with real SecureStore and SQLite | done | Simulator | iPhone 17 Pro, iOS 26.5: self-check custody, storage `sqlite` (row round-trip), crypto pass (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a7s3_10_selfcheck.png`); post, force-quit and relaunch on a loopback relay (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a7s3_05_posted_on_relay.png`, `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a7s3_09_relaunch_thread_posts_on_relay.png`). The earlier `m01_*` screenshots no longer exist |
| M0.2 trust-card copy | done | Simulator | approved hosting sentence from 01 in `src/ui/strings.ts`; `demo_fence.test.mts` and `strings.test.mts` assert it. Seen on the Group tab with the loopback origin and the demo-keys notice (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a7s3_03_group_tab.png`) |
| M0.3 device-key identity against the relay | doing | Core | refused Space route gives `no_relay_access` and 04's copy against the local relay (`demo_fence.test.mts`). No in-app path dials with the device key, so the screen copy cannot appear for this case yet |
| M1a.0 test harness and fixtures | done | Core | 4 named tests pass in the Core suite (127/127 at M1a.7 close). Needs `MIX_ENV=test mix compile` for the local relay tests. Smoke script not run |
| M1a.1 ports, session and post tracer | done | Simulator | 9 named tests in the Core suite. Post and relaunch now ran through the app on a loopback relay (`m1a7s3_05_posted_on_relay.png`, `m1a7s3_09_relaunch_thread_posts_on_relay.png`) |
| M1a.2 SQLite replica store | done (carry-over Core only) | Simulator | wired into the app at M1a.7; contract 6/6 on expo-sqlite (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1a7s3_11_replica_store_check.png`); posts survive force-quit and relaunch (`m1a7s3_09_relaunch_thread_posts_on_relay.png`). Verify-on-open, gated merge and carry-over: Core (`app_session.test.mts`). Since M1b.7, history_invalid after a tampered Thread frame, Export from the problem card and re-sync into `_r1` (old store's frame sha256 unchanged) ran on the simulator (`docs/treehouse-mobile/evidence/m1b7_history_invalid_recovery.png`). The M1a.2 RED-control screenshot no longer exists |
| M1a.3 local store | done | Core | `local_store.test.mts` (memory and node:sqlite), including the `replicaStoreEpochs` setting across a reopen. `openExpoLocalStore` runs in the app since M1a.7 and a sync-off setting survived a relaunch in stage 1, but that screenshot no longer exists |
| M1a.4 read models | done (Threads and thread screen on screen since M1b.1 to M1b.4, Group tab and audit since M1b.7; People still a placeholder; 150 ms budget met by the projection only) | Core | 11 named tests plus more in the Core suite; Sim vectors and real-signed judge authoring as references; 4,000-op projection about 9 ms, a whole replica change about 4.7 s (150 ms budget unmet there). The tab screens print status, group, link, threads, roster and the timeline (seen in `m1a7s3_01` to `_04`), launch evidence only, not checked against a reference on device |
| M1a.5 command pipeline | done | Core | 9 named tests plus extra checks in the Core suite. On the simulator post ran at M1a.7 (`m1a7s3_05`, `_07`); since M1b.3 edit, delete and moderator remove ran through the session's command path (`docs/treehouse-mobile/evidence/m1b3_edited_draft_kept.png`, `docs/treehouse-mobile/evidence/m1b3_deleted_placeholder.png`); tier stays Core because the pipeline's refusal paths ran only in Core |
| M1a.6 demo bootstrap fenced | done | Core | `demo_fence.test.mts` (refused and admitted against the local relay); release `expo export --platform ios` at M1a.7 close holds 0 `lattice-demo-wss`, 0 `EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN`, 0 `DEMO_KEYS_PUBLIC`, 0 dev-check strings, 0 `demo-endpoints.json`; rechecked at M1b.7 close (exit 0; 0 `lattice-demo-wss`, 0 `EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN`, 0 "Their keys are public", 0 "Run Self-check", 0 `demo-endpoints.json`). The demo bar's role switcher was used on the simulator in M1b.5 to M1b.7; the role is not persisted across launches |
| M1a.7 navigation and lifecycle | done | Simulator | Core 127/127, `tsc` 0. iPhone 17 Pro, iOS 26.5, loopback relay: tabs (`m1a7s3_01_threads_tab.png`, `_02_people_tab.png`, `_03_group_tab.png`), pushed thread (`_04_thread_pushed.png`), post on relay (`_05`), background closes the app's relay sockets and foreground reopens them and a new post reaches the relay (`_06`, `_07`, socket counts in `m1a7s3_evidence.txt`), force-quit relaunch (`_08`, `_09`), dev checks (`_10`, `_11`), all under `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/`. Deviations: disconnect shown by `lsof` on the app process, not a relay log (the fixture logs no connections); foreground pull of ops authored elsewhere not run; lint not run (no ESLint config) |
| M1a.8 CI job | doing (never run) | - | `treehouse_mobile` job in `flagship.yml`; actionlint adds no findings; steps dry-run on macOS only. Needs the first hosted run. Plain `npm ci` on the mobile lock fails ERESOLVE locally (react-dom 19.3.1 wants react ^19.3.1; the app pins 19.3.0), likely pre-existing but not verified at HEAD, so the job's `npm ci` step will probably fail |
| M1b.1 Threads tab | done | Simulator | `threads_tab.test.mts` (9 plus 1 review test; RED 9/9). iPhone 17 Pro, iOS 26.5, loopback relay, second participant `test/support/second_participant.mts` as neighbor: row went to unread with no manual sync (`docs/treehouse-mobile/evidence/m1b1_unread_raised.png`), opening the thread cleared it (`docs/treehouse-mobile/evidence/m1b1_unread_cleared.png`); pause sync then resume delivered as "1 unread". The collapsed "▸ Archived threads (1)" toggle was seen on the simulator in M1b.6 (expanded rows not seen); the link pill before a Space is pulled, waiting-to-send and "Not connected" marks: Core only. Unread badge not seen at accessibility sizes |
| M1b.2 Thread screen | done (some parts Core only) | Simulator | `thread_screen.test.mts` (8; RED 8/8). Three posts saved while paused, force-relaunch kept them and the draft (`docs/treehouse-mobile/evidence/m1b2_relaunch_saved_draft.png`), resume took relay ids 4 to 7 and all marks "On relay" (`docs/treehouse-mobile/evidence/m1b2_resumed_on_relay.png`); keyboard offset fixed on device; a posted draft did not come back after relaunch. identity_mismatch branch, failed-save retry (including the review fix: a pause-save that fails is retried by the next flush), input lock while posting, the hidden mark text and the per-replica Composer key: Core only |
| M1b.3 Edit and delete | done (Copy restored in M1b.5) | Simulator | `message_sheet.test.mts` (6; RED 6/6). Edit kept the draft (`docs/treehouse-mobile/evidence/m1b3_edited_draft_kept.png`), delete showed the placeholder (`docs/treehouse-mobile/evidence/m1b3_deleted_placeholder.png`); during the device run `second_participant.mts --show` printed edited, then deleted, then removed (relay ops 4, 5, 6, 8), but that `--show` ran the app's own `projectThreadTimeline`, so it is not an independent cross-device check and no such check is claimed; the relay op counts show only that the frames were accepted. After review `--show` prints lattice-client's `observeTreehouse` posts instead (rerun once on a plain backlog, not on an edit). Edit and tombstone outcomes are Core-tested in `edit_message`, `delete_message` and `remove_message`. Copy and Details left out; moderator sheet close is now blocked while a delete or remove runs (Core only) |
| M1b.4 Arrived later, unread | done | Simulator | `arrived_later.test.mts` (6; RED 5/6, the sixth is a guard), partition and heal judged by `judgeTreehouseFrames`. Late post counted on the row (`docs/treehouse-mobile/evidence/m1b4_counted.png`) and shown under "1 unread" with "Arrived later" between this phone's posts (`docs/treehouse-mobile/evidence/m1b4_divider_caption.png`). Late post while the thread is open: Core only. Caption not seen at accessibility-extra-large |
| M1b.5 Refusal states | done (some parts Core only) | Simulator | `refusal_states.test.mts` (6; RED 11/12 with the updated `message_sheet`, plus a second RED from the simulator's doubled full stop), judge reasons checked against lattice-client `observeTreehouse`. Revoke while paused: the paused post is Not counted with the reason and Copy text, the composer is replaced by the admin line (`docs/treehouse-mobile/evidence/m1b5_cannot_post_bar.png`); sheet Copy (`docs/treehouse-mobile/evidence/m1b5_sheet_copy.png`); clipboard read back through agent-device. One dev-build rebuild for `expo-clipboard`. Core only: lapsed-grant, removed-from-group, never-granted and key-unavailable lines; VoiceOver's Copy action |
| M1b.6 Archived thread | done (some parts Core only; accessibility partly outstanding) | Simulator | `archived_thread.test.mts` (5; RED 5/5) against the Sim `treehouse_thread_archive` vector and `observeTreehouse`. Founder archived from Thread info; the banner replaced the composer (`docs/treehouse-mobile/evidence/m1b6_founder_archived_banner.png`); a later neighbor post was held as `application_archived_thread`; as neighbor, a remote archive turned the composer into the banner with no manual sync (`docs/treehouse-mobile/evidence/m1b6_neighbor_live_banner.png`). Core only: the confirmation closing on a remote archive, moderator Remove after archive; the 1.5x Info cap was not re-seen on a device |
| M1b.7 Group tab | done (some parts Core only; accessibility partly outstanding) | Simulator | `group_tab.test.mts` (5 plus 1 review test; RED 5/5, review RED 1/1); since the review round a grant's usability is checked by a signed post the judge honors, and lapsed and never-honored grants have a Core fixture. Audit listed the revoked grant and the not-counted op with `revoked_capability`, and `--show founder` printed the same independently (`docs/treehouse-mobile/evidence/m1b7_audit_revoked_not_counted.png`); Export wrote a 5-frame file; foreground pull of ops authored while backgrounded (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1b7_02_foreground_pull.png`, scratchpad only); recovery rerun (`docs/treehouse-mobile/evidence/m1b7_history_invalid_recovery.png`). Not seen on a device: audit screen in dark mode or at large text, the final Safety wording, `lapsed`/`not_usable` states |
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
| Simulator evidence lives in a clearable scratchpad | the session scratchpad was emptied once between M1a.7 stages, losing every `m01_*`, `m1a2_*`, `m1a5_*` and `m1a7s1_*` screenshot; the M0 and M1a rows cite only `m1a7s3_*` files, which can be lost the same way; M1b rows cite durable copies in `docs/treehouse-mobile/evidence/` | M3 |
| Carry-over never ran on a device | the loopback keys have no M0 snapshot; `carryOverLegacyProfiles` is Core only | M3 |
| Review fixes not run on a device | the M1a.7 fix round (lifecycle reconcile, blocking carry-over, re-sync order, adoption notice, export guard, removed placeholder) is Core only; the stage 3 screenshots predate it | M1b |
| A failed carry-over left behind by re-sync | after a confirmed re-sync the fresh store skips the M0 snapshot, so unsent M0 posts that failed their check stay only in the untouched M0 file | 04 |
| ReplicaDb handles never closed | `openAppSession` opens one expo-sqlite handle per store and `close()`/`resync()` do not close it; repeated role switches or re-syncs leak handles | M1b |
| Dev detail line after re-sync | the demo bar's "store N" keeps the old epoch until relaunch (dev only) | M1b |
| Carry-over re-verifies on every launch | idempotent, but re-verifies the whole store on top of the session's own verify-on-open; cost not measured | M1b |
| Unsent posts in a failed store | re-sync opens a fresh store; unsent posts in the failed one are neither re-sent nor exported (D-31 covers the Space only). The confirmation copy says so | 04 |
| Entry stays `index.ts` | 07 says point the entry at `expo-router/entry`; `main` stays `index.ts`, which installs the polyfills and then imports `expo-router/entry` (the SDK 58 custom-entry variant) | 07 |
| Disconnect evidence is `lsof`, not a relay log | the loopback fixture has no connection log | M1a.8 |
| Require-cycle warning toast at launch | lattice-client require cycles (treehouse.js and treehouse_member_continuity.js; carrier.js and authority.js) show "Open debugger to view warnings" in dev | lattice-client |
| Lint not configured | AGENTS.md asks for lint; there is no ESLint config or script, and `expo lint` would install one. Not run | M3 |
| `loopback_demo` connect-timeout flake | "carrier connect timeout" once just after a machine restart, then passed repeatedly | M1a.8 |
| Judged view cost grows quadratically; 150 ms budget unmet end to end | `replica_view.ts` builds one decode and judge per replica change from lattice-client's decode plus two materializes: 48+49 ms at 500 ops, 153+143 ms at 1,000, 522+525 ms at 2,000, about 2.5+2.5 s at 4,000 in Node, run synchronously by the session on every frame that arrives. The 4,000-op test asserts 150 ms on the projection only (about 9 ms) and a measured 15 s ceiling on a whole replica change (about 4.7 s). Needs a lattice-client change (incremental judged view); not measured on Hermes | M1a.4 budget test, lattice-client |
| Gated merge re-verifies every held replica | signatures are cached, but each merge re-hashes and re-materializes all held frames; not measured | M1b |
| Hermes has no WebCrypto | `src/polyfills_crypto.ts` installs SHA-256 only for `crypto.subtle.digest`; `lattice-client/src/treehouse_offline_enrollment.ts:28` calls `crypto.subtle` unguarded, so any other algorithm throws on a phone | M2 |
| Ability probes the judge with a synthetic op | `abilities.ts` asks `treehouseCommandOpStatus` about a probe op targeting a probe post of this key's own; an exported per-command policy query in lattice-client would be cleaner | lattice-client |
| 4,000-op ceiling headroom | the whole-change ceiling (15 s) is about 3x the 4.7 s measured on this Mac; the Linux CI job has never run | M1a.8 |
| Pipeline signs before the pre-judge | a former role holder (`not_holder`) or a command on an archived Thread is signed, then refused by the pre-judge and discarded; with a biometric Keychain this would prompt for a signature that is thrown away | M1b |
| Winning edit id grouped in the app | `thread_timeline.ts` groups honored edit effects by root to ask lattice-client's `lww` for the winning edit id, because `causalListEntries` returns the winning value but not its op id | lattice-client |
| Read model limits | `relay_refused` lasts for the last sync only (O-6); removal-pending and relay access are known only for this phone's own key; audit grant states `lapsed` and `not_usable` and the lapsed-grant refusal line are Core only (fixture since the review round); the removed-from-group refusal line is read from SessionStatus in a pure ui helper, not the timeline; "joining" is inferred from an honored, unrevoked invitation; `lastSyncMs` is a session stamp; a key the held Space neither admits nor invites, with no other key's outbox, is `key_only` | M1b, M2 |
| `CI=1 expo start` does not watch files | a stale bundle is served after edits (it bit M1a.7 stage 3); restart Metro without `CI` or with `--clear` | - |
| M1a.8 job never ran | `npm ci` for Expo/RN deps and the Core suite have never run on Linux; the Core tests need Node 22.13+ for `node:sqlite` | M1a.8 |
| Doc 06's M1a.3 row says "first-seen times" | stale; 03 names `ReplicaStore.firstSeenMs` as owner and LocalStore holds none | 06 |
| Local relay fixture borrows a Tauri shell script | `test/support/local_relay.ts` runs `clients/treehouse-tauri-shell/test/support/treehouse_enrollment_fixture.exs` by path to create empty logs | M1a.8 |
| `test:smoke` never rerun | rewritten onto the app session in M1a.7; typechecked only, both with and without `DEMO_WSS_WRITE=1` | M1a.0 |
| Plan 180 orders iOS after E1 | plan index does not yet say 296 is a parallel track | O-7 |
| Navigator header clips at accessibility sizes | Threads draws its own header; People, Group and the pushed thread screen still use the navigator header, which clipped "Threads" before M1b.1. At accessibility-extra-large the "Group" title clips (M1b.7) and the thread screen's Info label crowded the title (M1b.6; capped at 1.5x, not re-seen); People not checked | M3 |
| "Today" can go stale across midnight | day separators are computed when the timeline changes | M1b |
| Unread divider not scrolled to, taken once per open | the list does not scroll to the divider, so with more unread than one screen it can sit out of view; it is not retaken after background and foreground while the screen stays open | M1b |
| Second participant is a Node script | `test/support/second_participant.mts` posts, revokes the neighbor's post grant (`--revoke`, M1b.5) and archives a thread (`--archive`, M1b.6) (and with `--show` prints lattice-client's `observeTreehouse` posts since the review round; during the M1b.3 device run it printed the app's own `projectThreadTimeline`, so that run is not an independent check) over the loopback relay; the plan's browser starter needs the public demo relay and was not used. M1's exit check still repeats M1b.2 against the public relay with the browser starter | M1 exit |
| Read marker marks the whole timeline on open | the thread screen marks every counted id, including rows the virtualized list never put on screen, so a backlog longer than one screen loses its unread cue (01 says "ids this phone has shown"; Codex review). Marking only viewable rows was tried in the review round and withdrawn: the positional "Arrived later" rule then captioned older backlog rows that were simply not yet scrolled to (`docs/treehouse-mobile/evidence/m1b_review_viewport_marking_withdrawn.png`). Needs, together: an arrival-based "Arrived later" rule in `thread_timeline.ts`, viewport marking, and scrolling to the divider; not attempted in M1b.5 | M1b |
| Removed member's petname on the thread screen | the thread screen resolves petnames from the Roster, which omits removed members, so their retained messages show a key check while the Threads row (LocalStore petname) shows the petname. Needs a petname read model or a per-message petname in the projection | M2 |
| VoiceOver never run | M1b.1 to M1b.4 read the accessibility tree only; Android not run | M3 |
| Cleanup stopped the relay fixture by pattern | M1b.2 ran `pkill -f pilot_node.exs`, which would also stop another session's fixture; later runs should stop the loopback server's own child | M1a.8 |
| Not seen on a device | M1b.5 to M1b.7: the lapsed, removed-from-group, never-granted and key-unavailable refusal lines; the archive confirmation closing on a remote archive, moderator Remove after archive, the 1.5x Info label cap, the confirmation and Archive button in dark mode or large type; the audit screen in dark mode or at large text, the final Safety wording (edited after the device run), the saved-line reset on role switch; file-URL share on Android. Earlier review-round fixes: the archived section's expanded rows, the pill before a Space is pulled, failed pause-save retry, per-replica Composer key, sheet close blocked while busy, "You" without "(you)" on People (seen once in the accessibility tree); waiting-to-send and "Not connected" row marks, and the unread badge at accessibility sizes (M1b.1); identity_mismatch branch, failed-save retry, input lock while posting (M1b.2); a late post arriving while the thread is open and the caption at accessibility-extra-large (M1b.4) | M1b |
| Details not in the message sheet | there is no Message details screen | M2 |
| Copy has no visible acknowledgement | only the screen reader hears "Copied" | M3 |
| Demo role not persisted across launches | the app comes back as Founder after a relaunch (dev only) | M1b |
| npm ci ERESOLVE on the mobile lock | plain `npm ci` and `expo install` fail: react-dom 19.3.1 (peer) wants react ^19.3.1, the app pins 19.3.0; pre-existing (verified in the review round: `npm ci --dry-run` on the HEAD lock fails the same way). M1b.5 and M1b.7 hand-edited the lock (`expo-clipboard` added, `expo-file-system` hoisted, same tarball and integrity) and reinstalled with `npm ci --legacy-peer-deps`; the CI job's plain `npm ci` will probably fail | M1a.8 |
| Audit relay facts never compared with a real sync | `generation` and `matchesRelay` are tested with a literal feed route; the projection passes shell-kit's values through and no test checks them against the local BEAM relay (review round) | M1a.8 |
| Review-round strings not seen on a device | the Archive hint, the copy-failed line and the export write-failed line changed after the simulator runs; the Android export (text as `message`) never ran | M3 |
| Judge allows `archive_thread` after an archive | a Core test pins it; Thread info hides Archive on `timeline.archived` instead | lattice-client |
| No successor link or rollover | the Thread replica records no successor; Continue in a new thread and the near-threshold prompt need G-2 | 05 |
| Audit "generation" is a hint counter | the relay generation shown is shell-kit's latest hint seen, not an op count (seen as 4 beside 5 ops with Matches relay Yes) | M1b |

## Next up

Follow the build order in [07-implementation-plan.md](07-implementation-plan.md):

1. M1a.8: fix the plain `npm ci` ERESOLVE on the mobile lock (react / react-dom pins), push the
   junctures and get the `treehouse_mobile` job green on Linux.
2. M1 exit check, with the operator's go-ahead only (it writes to a shared public thread): repeat
   M1b.2 on the simulator against the public demo relay with the browser starter, and record it at
   Simulator tier. Not run so far.
3. Re-audit M1's done criteria: every read model and command 03 covers for M1 has its named tests,
   compared with a Sim vector where one exists (not redone at M1b.7).
4. The deferred trio, together: viewport read-marking, an arrival-based "Arrived later" rule using
   `ReplicaStore.firstSeenMs`, and scrolling to the divider (not attempted in M1b.5).
5. Ask for a lattice-client change that makes the judged view incremental, and measure `replica_view`
   on Hermes; ask for a per-command policy query (`treehouseDelegationStates` was exported in the
   M1b.5 to M1b.7 review round).
6. M2: People tab, invitations and member management, testable against the local relay.

## Log

Newest first.

### 2026-11-25 · feat(treehouse-mobile): M1b.5 to M1b.7 refusal states, archived thread and Group tab

Three slices run one after another in this checkout, each on the previous one's uncommitted work.
All simulator runs: iPhone 17 Pro, iOS 26.5, loopback relay `http://127.0.0.1:4100` through
`test/support/loopback_demo_server.mts` (a fresh one per run), Metro with
`EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN` pointing at it, never the public relay. The second participant
is the Node script `test/support/second_participant.mts`, now with `--revoke founder` and
`--archive founder` (both signed through lattice-client authoring helpers and relayed), and `--show`
also printing the judge's `archived` flag and every not-counted op with its reason. The app gained
no people-management UI; admin actions came from that script or from the demo role switcher (used on
screen for the first time in M1b.5). The plan has no `## M1b.5` to `## M1b.7` sections, so each slice
took its spec from the M1b table row and doc 04. Durable screenshots are in
`docs/treehouse-mobile/evidence/`; the rest are in the clearable session scratchpad
`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/`.
Metro, the loopback server and its BEAM child were stopped by PID after each slice; at integration
nothing listened on 4100 or 8081 and no `pilot_node`, `expo start` or loopback process remained.

- **M1b.5 Refusal states (Simulator; some lines Core only).**
  - Projection: new `ThreadTimeline.postRefusal` (null when this key can post). It starts from the
    Abilities reason for `post`; a `no_capability` is refined by the new `grantRefusal` in
    `abilities.ts`, which takes the judge's validated delegation records (`authoritySecurity`)
    addressed to this key and carrying `post`, and asks lattice-client's `delegationFrontierRefusal`
    about each: `revoked_capability`, `lease_expired`, or `no_capability` when never given.
    `Ability` itself is unchanged (`abilities.test` pins its `no_capability` to `memberCapability`).
  - New pure `src/ui/refusal_view.ts`: `cannotPostLine` combines `postRefusal` with SessionStatus
    `removed` and the archived flag; `notCountedLine` gives the judge's reason. `CannotPostBar`
    replaces the composer with one line from `cannotPostCopy`, naming who can fix it.
  - `NotCountedBubble`: dashed and muted instead of 0.6 opacity (keeps text contrast), shows "Not
    counted", the judge's reason and a "Copy text" button; Copy text is also a custom accessibility
    action (RN 0.88 docs checked) and the label includes the reason.
  - Copy is back in the long-press sheet, first for every message with text; a not-counted message
    gets Copy only. `src/ui/clipboard.ts` uses expo-clipboard `setStringAsync` (SDK 58 docs fetched)
    then announces "Copied". Core modules do not import expo-clipboard (a test checks).
  - Install: `expo install expo-clipboard` wrote `~58.0.4` but npm failed ERESOLVE (react-dom 19.3.1
    vs react 19.3.0). A `--legacy-peer-deps` retry pruned 15 peer packages from the lock, so the lock
    was restored and only the `expo-clipboard` entry spliced in by hand; node_modules reinstalled with
    `npm ci --legacy-peer-deps`. One dev-build rebuild: `expo run:ios --device 0CD290A4-...
    --no-bundler`, exit 0.
  - Tests: new `test/core/refusal_states.test.mts` (6): revoked grant gives the bar and the admin
    line; a post signed before the revoke arrived is not counted with a reason equal to lattice-client
    `observeTreehouse`'s quarantine reason, the sheet offers Copy only, the bar agrees, the label has
    no doubled full stop; a key with no grant gets `no_capability`; precedence and words for every
    reason; source scans. 12 `message_sheet` assertions now expect Copy; `postRefusal: null` added to
    literal timelines in three tests. No test removed.
  - RED: 11 of 12 failed (`ERR_MODULE_NOT_FOUND` for `src/ui/refusal_view`, sheet assertions missing
    `copy`, no `<CannotPostBar`). A second RED came from the simulator, which showed a doubled full
    stop in the label ("...away from you.. On relay"); the new assertion failed, then passed.
  - Simulator: switched to Neighbor; posted "Before the revoke" (On relay); paused sync;
    `--revoke founder` accepted by the relay; posted "Said while paused" (Offline · 1 waiting); sync
    on: the post went On relay but Not counted with "The admin took this away from you." and Copy
    text, and the composer became "The admin took back posting in this thread from you. Only the admin
    can give it back." (`docs/treehouse-mobile/evidence/m1b5_cannot_post_bar.png`). Copy text put
    "Said while paused" on the clipboard (`agent-device clipboard read`). Long-press on the counted
    post offered only Copy (the revoke removed Edit and Delete), which copied "Before the revoke"
    (`docs/treehouse-mobile/evidence/m1b5_sheet_copy.png`). Dark mode at accessibility-extra-large
    wraps without clipping (`m1b5_03_dark_axl.png`, scratchpad); the SessionBanner key check
    truncates with an ellipsis (pre-existing). The role reset to Founder after relaunch.
  - Core only or not exercised: the lapsed-grant line (no lease or beacon fixture), removed-from-group
    (pure helper only), never-granted and key-unavailable lines; VoiceOver's Copy action; `--show`
    after the revoke (no second-party view of that not-counted post in this slice); Android.
  - The deferred trio (viewport read-marking, arrival-based "Arrived later" using
    `ReplicaStore.firstSeenMs`, scroll to the divider) was not attempted: three coupled changes,
    withdrawn once before after a simulator false positive, with M1b.6 and M1b.7 building on this tree.
- **M1b.6 Archived thread (Simulator; some parts Core only).**
  - New `ArchivedBanner` ("Archived. No new messages.") replaces the composer in an archived thread
    for every key, the moderator included, ahead of removal or any grant reason, decided by the new
    pure `threadFooter` in `refusal_view.ts` (composer, archived or cannot_post). No successor link:
    the Thread replica records none, and rollover needs G-2.
  - New route `src/app/thread-info/[replica].tsx` (registered in `_layout.tsx`; chosen over a path
    nested under `thread/[replica]` to avoid route ambiguity), opened from an "Info" header button
    (screen-reader name "Thread info"). It shows title, archived line, Messages, Signed entries "N of
    4,000", Size "N KB of 8 MB" (pure `src/ui/thread_info.ts`) and a note that this app can't continue
    a thread in a new one yet. Archive thread shows only when Abilities allow `archive_thread` and the
    thread is not archived, and confirms with 04's sentence; the confirmation closes if an archive
    arrives from elsewhere while open (Core/code only).
  - Projection: `ThreadHealth` gains `messages`, `opsLimit`, `bytesLimit`; new exports `ROLLOVER_OPS`
    = 4000 and `ROLLOVER_BYTES` = 8 MiB, recorded in 03. Finding: the judge still allows
    `archive_thread` after an archive; a Core test pins this and the screen hides the item.
  - Tests: `test/core/archived_thread.test.mts` (5), references the Sim `treehouse_thread_archive`
    vector (archived, live-post count, op count), real fixture sessions and lattice-client
    `observeTreehouse`. RED 5/5 (`Cannot find module .../src/ui/thread_info` twice, `threadFooter is
    not a function`, `Cannot read properties of undefined (reading 'confirmArchive')`,
    `AssertionError: thread-info/[replica] route`). ThreadTimeline literals in `arrived_later`,
    `message_sheet` and `thread_screen` gained the health fields; no test removed.
  - Simulator run A (founder, existing dev build, Metro `--clear`): neighbor posted; Thread info showed
    Messages 1, Signed entries 4 of 4,000, Size 3 KB of 8 MB and Archive thread; confirmation with 04's
    sentence (`m1b6_01_confirm.png`, scratchpad); on Archive relay ids went 4 to 5 and the thread
    screen showed the banner (`docs/treehouse-mobile/evidence/m1b6_founder_archived_banner.png`). The
    other side then posted; relay accepted it; `--show` printed `archived (judge's state): true` and
    `not counted 0DHVUTL49lIW: application_archived_thread`; the app did not show it. The Threads tab
    moved the thread under "▸ Archived threads (1)" (first time seen on a device). Dark mode at
    accessibility-extra-large: banner and info screen do not clip (`m1b6_03_info_dark_axl.png`,
    scratchpad); the Info header label crowded the title, so it was capped with
    `maxFontSizeMultiplier={1.5}`, not re-seen on the device.
  - Simulator run B (neighbor, after a server restart, thread open with the composer showing):
    `--archive founder` accepted by the relay; the composer turned into the banner with no manual sync
    (`docs/treehouse-mobile/evidence/m1b6_neighbor_live_banner.png`); Thread info as neighbor showed
    no Archive button.
  - Not seen on a device: the 1.5x cap; confirmation and Archive button in dark mode or large type;
    confirmation closing on a remote archive; moderator Remove after archive (Core only); VoiceOver.
- **M1b.7 Group tab (Simulator; some parts Core only).**
  - `group.tsx`: summary card in words, `RelayCard`, `SafetyCard`, `KeyCard` (My key) and Export; the
    demo bar and dev checks stay below. `RelayCard`: the approved hosting sentence, relay address, a
    connection line per route ("Group: Connected", "General: Reconnecting · 2 waiting"), waiting
    total, Sync now, a Pause sync switch (label and hint) and the Verify & audit link.
  - Safety lines: readable by the relay operator, who can also take the relay offline; no recovery if
    this phone is lost; the lost-admin line in Plan 178's terms; text only; Delete and Remove leave
    synced copies in the signed history; the demo-keys line in dev builds only, from `src/demo`
    through `Bootstrap.demo.safetyNote`. No encryption, deletion-from-other-phones or availability
    claim. My key: key check, Keychain or test key, can't be moved to another phone.
  - Verify & audit (`src/app/audit.tsx`, pushed): per replica, Group first: op count, frontier, relay
    generation, matches-relay ("Not compared yet" before a sync), every grant with its state and every
    not-counted op with the judge's raw reason; ids and reasons selectable.
  - Projections: `AuditGrant.state` is now `usable | revoked | lapsed | not_usable` (was `live |
    not_live`), from `liveTreehouseDelegations` then `delegationFrontierRefusal` over
    `authoritySecurity`; `LinkStatus.syncEnabled` added (the switch reads it, not the Offline pill);
    the relay address is owned by `AppSession.relayAddresses` (`relayOrigins`), recorded in 03.
  - Export writes a file: new adapter `src/native/export_file.ts` (expo-file-system SDK 58
    `File`/`Paths.document`, docs fetched); `exportHeld` writes the D-31 text, shares the file URL and
    returns the name ("Saved as {name}"); a failed write falls back to sharing the text.
    `expo-file-system ~58.0.14` is now a declared dependency (already in the build's pods, no
    rebuild). The lock entry was hand-hoisted from `node_modules/expo/node_modules/expo-file-system`
    (same tarball and integrity), because `expo install` and plain `npm ci` fail ERESOLVE.
  - Tests: new `test/core/group_tab.test.mts` (5). RED 5/5 (`Cannot find module src/ui/group_view`
    four times; `AssertionError` on the missing `src/ui/RelayCard.tsx`). `audit_view.test.mts` (state
    names; the revoked grant now asserts `revoked`) and `threads_tab.test.mts` (LinkStatus literal
    gains `syncEnabled`) adjusted; no test removed. Reference: the judge's `revoked_capability`
    quarantine from lattice-client `observeTreehouse`. The vectors carry no grant state, and the
    usable-iff-live assertion uses the same lattice-client call as the projection, so it is not
    independent.
  - Simulator: as Neighbor with Pause sync on, posted "Said while the revoke was on its way" (Saved on
    this phone); `--revoke founder` accepted; Pause sync off, pill Live; Verify & audit for General
    showed "You · author_edit, author_tombstone, post · revoked" and "nzremf7x-MGY… ·
    revoked_capability" (`docs/treehouse-mobile/evidence/m1b7_audit_revoked_not_counted.png`);
    `--show founder` independently printed `not counted nzremf7x-MGY: revoked_capability`. Observed:
    General showed relay generation 4 beside 5 ops with Matches relay Yes (generation is shell-kit's
    latest hint seen, not an op count).
  - Export: Save group data wrote `Documents/treehouse-space-WqzIoz1Xb1BH.frames.json` (3,914 bytes,
    5 frames, frame ids equal the relay's Space ids); the share sheet offered it ("JSON · 4 KB", Save to
    Files). Only shape and counts were inspected, never contents.
  - Foreground pull (first time): app on Threads, sent home (0 relay sockets); the founder posted
    "Posted while your phone was in the background"; foregrounded (same pid 38609, no relaunch): the
    General row changed to the new post with "1 unread" and the app held 4 relay sockets again
    (`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m1b7_02_foreground_pull.png`,
    scratchpad only).
  - Recovery rerun: one Thread frame's `sig` was tampered in the neighbor's replica store with python
    sqlite3 on the simulator data (nothing printed; frame-table sha256 9a58… to 5b6e…). Switching to
    Neighbor showed `history_invalid` (`invalid_retained_history`), Offline, 0 relay sockets, with
    Export and Re-sync (`docs/treehouse-mobile/evidence/m1b7_history_invalid_recovery.png`). Export from
    the problem card wrote the file (the Space was intact). The earlier export JSON this run had made
    was deleted from the app's Documents first (an export file, not held frames). Re-sync came back
    Live in `_r1` with 11 frames; the old store's frame sha256 stayed 5b6e….
  - Accessibility: Group cards in dark mode at accessibility-extra-large wrap without clipping
    (`m1b7_04_dark_axl_group.png`, `m1b7_05_dark_axl_switch.png`, scratchpad); the navigator header
    "Group" clips (known M3 gap). Not seen on a device: the audit screen in dark mode or at large
    text, the final Safety wording (edited after the device run), the saved-line reset on role switch.
  - Not exercised: `lapsed` and `not_usable` grant states (no fixture); file-URL share on Android.
  - Release check: `expo export --platform ios` exit 0; the `.hbc` holds 0 `lattice-demo-wss`, 0
    `EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN`, 0 "Their keys are public", 0 "Run Self-check", 0
    `demo-endpoints.json`. `src/App.tsx`, `src/lib/treehouse_mobile_host.ts` and
    `src/native/storage.ts` are absent.
- **Integrated gate** (from `clients/treehouse-mobile`, Node 22.15.1): `tsc --noEmit` exit 0; Core
  179/179 pass, 0 fail; slice gates `refusal_states`, `message_sheet`, `archived_thread`,
  `group_tab` 22/22; `scripts/check_treehouse_mobile_progress.sh` on the staged change. No
  cross-slice fixes were needed. Integration review found the two grant classifiers
  (`grantRefusal`, `audit_view`) both delegate revoke/lapse to lattice-client but build separate
  `authoritySecurity` caches with different candidate filters; recorded under Known gaps. During
  M1b.5 one full Core run had 8 failures (7 local-relay tests run while `expo run:ios` was building,
  plus the implementer's own source-scan test); the rerun was 169/169.
- **Not run:** VoiceOver itself (accessibility tree only), Android, lint (not configured), the CI
  job, plain `npm ci` on the HEAD lock, the public demo relay; the release `expo export` check was
  run by the M1b.7 implementer and not rerun at integration.
- **M1 status, stated plainly.** Done: `src/App.tsx`, `src/lib/treehouse_mobile_host.ts` and
  `src/native/storage.ts` are gone; the import-boundary tests pass; no slice claimed Physical.
  Outstanding: the M1 exit check (M1b.2 repeated on the simulator against the public demo relay
  with the browser starter) was NOT run, because it writes to a shared public thread and needs the
  operator's go-ahead, so "Simulator against both relays" is open; the M1a.8 CI job has never run
  (and its plain `npm ci` will probably fail ERESOLVE); "every read model and command M1 covers has
  its named tests and Sim-vector comparison" was not re-audited.
- **Independent review** (one fix round, no second review): Codex (Sol 6.1 high, the user's standing
  model) and Antigravity Neon (medium) ran and returned the same 8 findings. Accepted 5, partly
  accepted 2, rejected 0 outright, deferred the remaining parts:
  - Accepted, fixed: (1) the audit called a forged grant under a revoked parent `revoked`; (2)
    `grantRefusal` filtered delegation records in the app without the honored-introduction condition.
    Both now read one lattice-client query: a new additive export `treehouseDelegationStates`
    (`clients/lattice-client/src/treehouse_enrollment.ts`, dist rebuilt, the diff touches only the
    enrollment files; `test/treehouse_enrollment.ts` asserts it for a revoke and a lapsed lease and
    passes, as does lattice-client's `tsc`). `ReplicaView.delegationStates` holds it and `live` is
    derived from it, so both projections' own `authoritySecurity` passes are gone. RED: a new
    `group_tab` test failed with `forged sub-grant (invalid_capability)`: expected `not_usable`,
    actual `revoked`; it passes now. For (2), no fixture builds a valid grant introduced only by a
    refused frame (an authority grant frame is not refused for who relays it, and not after its
    parent's revoke), so that sub-case is fixed by using lattice-client's filter, not shown by RED.
    (3) `exportHeld` swallowed a failed file write: it now shows "Could not save the file on this
    phone, so the share sheet has the text instead." and still shares the text; Share's `url` is iOS
    only (reactnative.dev/docs/share fetched), so Android now shares the text as `message`. (7) Copy
    no longer swallows a clipboard failure: it shows "Could not copy the text. Try again." (8) The
    Archive hint said "Closes"; it is now "Archives this thread: no new messages, edits or deletes
    for anyone. Asks first." The three new strings were not seen on a device; Android not run.
  - Partly accepted: (4) the "usable exactly when live" loop compared the projection with itself; it
    is replaced by a signed post citing the grant that the judge honors, and the lapsed path now has a
    Core fixture (a leased grant to a key with no other grant plus a root beacon past its epoch; the
    judge gives `lease_expired`, the audit `lapsed`, `grantRefusal` `lease_expired`). The audit's
    `generation` and `matchesRelay` are still tested with a literal route: the projection only passes
    shell-kit's feed values through, and no test compares them with a real relay sync (deferred,
    Known gaps). (5) Accessibility: the M1b.6 and M1b.7 rows now say accessibility is partly
    outstanding (the items were already listed under "Not seen on a device"); no simulator rerun in
    this round. The foreground-pull screenshot stays in the scratchpad, because the juncture keeps two
    durable screenshots per slice; its loss would leave that claim with this log text only.
  - Fact-checked and deferred: (6) the hand-edited lock. Plain `npm ci --dry-run` on the HEAD lock
    fails the same way (`ERESOLVE ... While resolving: react-dom@19.3.1 Found: react@19.3.0`), so
    the conflict predates this juncture; `npm ci --dry-run --legacy-peer-deps` on the new lock
    resolves. The fix belongs to M1a.8.
- **Gate after the review fixes** (Node 22.15.1, from `clients/treehouse-mobile`): `tsc --noEmit`
  exit 0; Core 180/180 pass, 0 fail; slice gates `refusal_states`, `message_sheet`,
  `archived_thread`, `group_tab` all pass; `demo_fence` and `strings` rerun after these doc edits;
  `scripts/check_treehouse_mobile_progress.sh` on the staged change. lattice-client: `tsc` exit 0,
  `tsx test/treehouse_enrollment.ts` all PASS.
- **Tier:** Simulator for the M1b.5 revoke scenario and both Copy paths, the M1b.6 archive scenario
  on both roles, and the M1b.7 audit, export, foreground pull and recovery scenarios; Core for the
  parts named above.

### 2026-11-25 · feat(treehouse-mobile): M1b.1 to M1b.4 threads tab, thread screen, edit and delete, arrived-later and unread

Four slices run one after another in this checkout. All simulator runs: iPhone 17 Pro, iOS 26.5,
the existing dev build (no native module added, no rebuild), loopback relay
`http://127.0.0.1:4100` through `test/support/loopback_demo_server.mts`, Metro with
`EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN` pointing at it, never the public relay. The app ran as the
demo founder. The second participant in every scenario is the new Node script
`test/support/second_participant.mts` (posts as a demo role; `--show` prints the role's view;
loopback origins only; fetches the seed the way the app does and never prints it). The plan's
browser starter was not used because it needs the public demo relay. Durable screenshots are in
`docs/treehouse-mobile/evidence/`; the rest are in the clearable session scratchpad
`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/`.
Metro and the loopback server were stopped after each slice.

- **M1b.1 Threads tab (Simulator).**
  - `src/app/(tabs)/threads.tsx` is one virtualized FlatList of the new `ThreadRow` and
    `LinkPill`. The tab draws its own header (Group name plus pill, safe-area top inset) because
    the navigator header clipped at accessibility sizes. The pill opens the Group tab (no Relay
    screen yet). Rows say every state in words ("N unread", "N waiting to send", "Not
    connected") with one screen-reader label per row. Archived threads sit behind a collapsed
    "Archived threads (N)" toggle (a footer at first; a list row heading the archived rows after review). New thread and the slots-full line are hidden for all of M1
    (G-2; `create_thread` is never allowed).
  - Projection (`thread_list.ts`, Core tested): `last.authorPetname` from the session's
    `local.petname`; `routeNotConnected` only when some route is live and this thread's is not.
    Pure helpers in `src/ui/thread_rows.ts`.
  - Realm no longer shown (01): `displayName` gives You, petname, then "Key check
    <fingerprint>"; `SessionBanner` and `group.tsx` show the key check; `Connected.names` removed
    from SessionProvider and composition (`demoRealmByPubkey` stays in `src/demo/manifest.ts`).
  - Dark mode: the root layout wraps the Stack in expo-router's `ThemeProvider` with the app
    palette; the tab bar and headers stayed light before.
  - Docs 03 and 04 record the M1a.7 decisions and the M1b.1 decisions.
  - Tests: `test/core/threads_tab.test.mts` (9). RED 9/9 (missing `src/ui/thread_rows`,
    `routeNotConnected` undefined, `authorPetname` undefined, realm rendered in `group.tsx`).
  - Simulator: the neighbor posted and the row went to "2 unread" with no manual sync or
    relaunch; opening the thread and going back cleared it; repeated on the final layout as "1
    unread" then cleared (`docs/treehouse-mobile/evidence/m1b1_unread_raised.png`,
    `docs/treehouse-mobile/evidence/m1b1_unread_cleared.png`). With sync paused the pill said
    Offline and a neighbor post did not arrive; after "Turn sync on" it arrived as "1 unread"
    (pull after pause, not after backgrounding). Dark mode at accessibility-extra-large
    (`m1b1_05_dark_large_text_offline.png`, `m1b1_06_dark_resumed_unread.png`, scratchpad).
  - Not seen on a device: archived section, waiting-to-send and "Not connected" marks; the
    unread badge at accessibility sizes.
- **M1b.2 Thread screen (Simulator for the scenario; some parts Core only).**
  - `thread/[replica].tsx` renders `MessageList`, an inverted virtualized FlatList of `Bubble`,
    with author runs and day separators by first-seen time ("Today", "Yesterday", or a local
    date). `DeliveryMark` is a glyph and words: ◷ Saved on this phone / Sending, ✓ On relay,
    ⚠ Relay did not accept, ⚠ Relay is not accepting messages; no second check. Each bubble has
    one label that says every state. Author names use Roster petnames, never the realm.
  - `Composer` saves the draft through `session.saveDraft` after a 400 ms pause, on blur and on
    unmount; fills from the stored draft once, never over typed text; clears it after an
    accepted post; retries a failed save; locks input while a post runs; send needs text and
    `canPost`. `keyboardVerticalOffset` is `useHeaderHeight()` minus the bottom inset (replaces
    the fixed 90).
  - New `ReadModels.drafts`, separate from timelines so a draft save never rebuilds one (a test
    asserts this). identity_mismatch problem card branches on `reason` (`key_unavailable`,
    `key_missing`, `outbox_other_key`) through `src/ui/problem_copy.ts` and never offers reset.
  - Tests: `test/core/thread_screen.test.mts` (8). RED 8/8 (`ERR_MODULE_NOT_FOUND` for
    `src/ui/thread_view` and `problem_copy`; `undefined !== {}` for `drafts`; no `<MessageList`).
  - Simulator: neighbor posted (relay ids 4); sync paused; three posts each "◷ Saved on this
    phone", pill "Offline · 3 waiting", relay still 4; composer flush on the keyboard
    (`m1b2_03_three_saved_keyboard.png`, scratchpad); typed a draft, force-relaunched: posts still
    saved, sync still paused, draft in the composer
    (`docs/treehouse-mobile/evidence/m1b2_relaunch_saved_draft.png`); sync on: relay 4 to 7, pill
    Live, all three "✓ On relay", draft kept
    (`docs/treehouse-mobile/evidence/m1b2_resumed_on_relay.png`); posting the draft took relay to
    8 and after another relaunch the composer was empty. Dark mode and accessibility-large type
    did not clip (`m1b2_06_dark.png`, `m1b2_07_dark_large_type.png`, scratchpad).
  - Core only: the identity_mismatch branch; failed-save retry, the input lock and the hidden
    mark text (made after the device run).
  - Cleanup used `pkill -f pilot_node.exs` by pattern (would also stop another session's
    fixture; nothing matched afterwards).
- **M1b.3 Edit and delete (Simulator; Copy regressed).**
  - New `MessageSheet` and `ConfirmDialog` share one RN `Modal` whose content switches, so iOS
    never presents two at once. Item rules live in pure `src/ui/message_sheet.ts`, combining the
    Abilities read model (`author_edit`, `author_tombstone`, `moderator_tombstone`) with the
    timeline's mine, standing and removed facts; a removed or not-counted message offers
    nothing; a moderator's own message offers Delete, not Remove. The sheet holds only an id and
    closes when its message is removed elsewhere or the thread archives.
  - Composer edit mode ("Editing message", Cancel, Save): the saved draft is flushed first and
    comes back unchanged; edit keystrokes are never saved as the draft. The bubble declares
    "Message actions" as an accessibility action with a hint; the backdrop is hidden from screen
    readers.
  - Tests: `test/core/message_sheet.test.mts` (6), checked against real fixture sessions with the
    judge as reference. RED 6/6 (`ERR_MODULE_NOT_FOUND`).
  - Simulator: posted "Meet at the shed at six" with "half a draft" in the composer; Edit to
    "...seven" showed "edited" with the draft restored
    (`docs/treehouse-mobile/evidence/m1b3_edited_draft_kept.png`); Delete showed 04's
    confirmation and then "Message deleted · On relay"
    (`docs/treehouse-mobile/evidence/m1b3_deleted_placeholder.png`). `second_participant.mts
    --show neighbor` printed posted (4 ops), edited (5), `[Message deleted]` (6). A moderator
    Remove in dark mode left `[Removed by moderator]` on both sides (8). Edit then Cancel left the
    message unchanged. At the largest text size the sheet fits and the confirmation scrolls in its
    card. Fixed during the run: confirmation text colour in dark mode, confirmation ScrollView
    clipping.
  - Limits: the other side is a Node script printing the app's own projection; the relay op
    counts are the independent fact. Modal close fade not checked frame by frame.
  - Regression: Copy is not in the sheet (needs `expo-clipboard` and a rebuild) and bubbles that
    open a sheet are no longer selectable, so a moderator cannot copy any counted message.
    Details left out (no details screen). Both go to M1b.5.
- **M1b.4 Arrived later and unread by id (Simulator).**
  - New `UnreadDivider` ("N unread", read as "N unread from here") and `ArrivedLateCaption`
    ("↑ Arrived later", hidden from the screen reader because the bubble label says it).
  - Projection (`thread_timeline.ts`, Core tested): new `ThreadTimeline.unmarked`, the counted
    messages, own included, not in the read marker. The screen marks `unmarked`, so a post that
    arrives while this phone is paused can be arrived later relative to its own posts. Own
    history held with an empty read marker (reinstall, re-sync, role switch) still marks nothing
    arrived later (guard test). `unreadIdsOf` removed from `thread_rows.ts`.
  - `createOpenMarks` in `src/ui/thread_view.ts` holds the divider (taken once per open, above
    the first unread id, count at open) and the arrived-later ids (only grow while open) from
    the timeline seen before the read-marker write; both reset when another replica opens.
    Decisions recorded in 03 and 04.
  - Tests: `test/core/arrived_later.test.mts` (6), including a partition and heal over
    `createFakeFeed` with `judgeTreehouseFrames` as the order reference. RED 5/6 (`unmarked`
    missing, `createOpenMarks is not a function`, `thread.unreadDivider is not a function`, two
    assertions); the empty-marker guard passed before and after. Earlier slices' tests were
    adjusted for `unmarked` (`thread_screen`, `message_sheet`, `threads_tab`); no test was removed.
  - Simulator: neighbor posted "Before the pause"; the app opened the thread; Pause sync; the app
    posted "Mine one", "Mine two", "Mine three" (Offline · 3 waiting); the neighbor posted "While
    you were paused" at the relay heads; Turn sync on. The row said "1 unread"
    (`docs/treehouse-mobile/evidence/m1b4_counted.png`); the thread showed the "1 unread" divider
    above the late post, between "Mine one" and "Mine two" with "↑ Arrived later", still there
    after the read-marker write (`docs/treehouse-mobile/evidence/m1b4_divider_caption.png`). Dark
    mode and accessibility-extra-large divider (`m1b4_03_dark.png`,
    `m1b4_05_dark_axl_divider.png`, scratchpad).
  - Not run: the caption at accessibility-extra-large; a late post arriving while the thread is
    open (Core only). The list does not scroll to the divider.
- **Integrated gate before review** (from `clients/treehouse-mobile`, Node 22): `tsc --noEmit` exit 0; Core
  162/162 pass, 0 fail (includes the four slice gates); `scripts/check_treehouse_mobile_progress.sh`
  on the staged change. No cross-slice fixes were needed.
- **Not run:** VoiceOver itself (accessibility tree only), Android, lint (not configured), the
  CI job, the public demo relay.
- **Tier:** Simulator for M1b.1 to M1b.4 scenarios, with the Core-only parts named above.
- **Independent review (one round).** Codex (run on `gpt-6.1-sol` high, the user's standing
  model, not the 6.2 the workflow named) reported 5 findings and Antigravity Neon (medium) 9.
  Three were reported by both (self-comparing second participant, missing Copy, removed-member
  petname), counted once each: 11 distinct findings. Accepted 11, rejected 0. Fixed 8:
  - a pause-save that fails is kept and retried by the next flush, including one still in flight
    at unmount (`createDraftSaver`; new assertions in `thread_screen.test.mts`, RED against the
    old saver: test 6 failed);
  - `second_participant.mts --show` prints lattice-client's `observeTreehouse` posts, not the
    app's projection, and PROGRESS no longer claims an independent cross-device check for M1b.3;
  - the archived toggle is a list row heading the archived rows (`threadsTabRows`, Core test);
  - the link pill shows before a Space is pulled; `Composer` is keyed by replica; the message
    sheet ignores Android Back and VoiceOver escape while a delete or remove runs; People no
    longer says "You (you)"; the `message_sheet.ts` comment no longer claims selectable text;
    PROGRESS overclaims on accessibility sizes reworded.
  Deferred 3 (Known gaps): whole-timeline read marking (M1b; viewport marking was implemented,
  seen on the simulator to caption backlog rows "Arrived later" falsely, and withdrawn:
  `docs/treehouse-mobile/evidence/m1b_review_viewport_marking_withdrawn.png`), Copy text
  (M1b.5), removed-member petname (M2).
  - Simulator after the fixes (iPhone 17 Pro, iOS 26.5, loopback relay, same dev build, servers
    stopped by PID afterwards with no `pilot_node` left): 14 then 3 neighbor posts; the row said
    "3 unread", the thread showed the "3 unread" divider with no false caption
    (`docs/treehouse-mobile/evidence/m1b_review_divider_no_false_caption.png`), the row cleared
    on return; People showed "You" alone; `--show` printed 17 live posts. The other fixes are
    Core only.
  - Gate after the fixes: `tsc --noEmit` exit 0; Core 163/163 pass, 0 fail (slice gates
    threads_tab 10, thread_screen 8, message_sheet 6, arrived_later 6); progress check on the
    staged change.

### 2026-11-25 · feat(treehouse-mobile): M1a.7 navigation, lifecycle and SQLite-backed session

Built in three stages. Screenshots are in the session scratchpad
`/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/`.
That folder was emptied between stages 1 and 2, so every `m1a7s1_*` screenshot named below no
longer exists; only the `m1a7s3_*` files do.

- **Stage 1: session wiring (Simulator at the time; screenshots since lost, so claimed as Core
  here except where stage 3 re-ran it).**
  - The app runs on `TreehouseSession` over `SqliteReplicaStore` (expo-sqlite, one file per key)
    and `openExpoLocalStore`; no in-memory LocalStore remains. New composition root
    `src/native/app_session.ts` (`openAppSession`): opens the store sharing one db handle with
    `session.open()`; calls `carryOverLegacyProfiles` with the M0 snapshot, read by the new
    read-only `src/native/legacy_snapshot.ts` (plan defect (a): no unsynced post is stranded);
    adopts the route replicas, opens the session and configures the link; goes online only when
    history is ok, the key matches and the saved `syncEnabled` is on.
  - Gated merges: the session's verified `mergeSync` is the only merge path; a static test
    allows only `session.ts` and the carry-over to call it.
  - Deleted `src/lib/treehouse_mobile_host.ts`, `src/lib/host_session_ports.ts`
    (`identityCustody` moved into `app_session.ts`) and `src/native/storage.ts`, after the demo
    code had moved to `src/demo/` (plan defect (e)).
  - Self-check storage leg now round-trips a row on its own `treehouse_selfcheck_v1.db`;
    `backend` is `sqlite | none`, no memory fallback. `test/smoke/demo_relay.mts` rewritten onto
    the app session; it stops the link before it posts.
  - Recovery (04): `session.exportSpaceFrames()` (new `src/session/commands/export_space.ts`)
    builds the D-31 `lattice-space-frames-export-v1` file through lattice-client's
    `buildSpaceFramesExport`, reading the root through `committedRootAuthor`, now shared with
    `verify_held.ts`. New refusals `no_space` and `export_failed` (`ExportRefusal`, copy in
    `strings.ts`). The UI hands the text to RN `Share.share` (RN 0.88 docs fetched). Re-sync,
    after an `Alert` confirmation, opens a fresh `..._r<N>.db`; the pointer is the new LocalStore
    setting `replicaStoreEpochs` (per public key). The failed store is never touched; `resync()`
    is refused (`history_ok`) unless history failed.
  - Dev-build loopback pointer: `EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN`, read only in
    `src/demo/manifest.ts`; `demoOrigin()` accepts loopback only and never falls back to the
    public relay. New `test/support/loopback_demo.ts` and `loopback_demo_server.mts` sit in front
    of the local relay fixture and serve `/demo-endpoints.json`, `/demo-seed/founder|neighbor`
    (random per process, never printed) and `/relay-ids/<space|thread>`. `group_fixture.ts`
    gained `identityFromSeed` and `buildGroup({identities})`. `sqlite_local_store.ts` accepts
    object-valued settings and rejects null or arrays.
  - Tests: `app_session.test.mts` (5: carry-over then relay; relaunch over the same file then
    relay; history_invalid export plus re-sync with the old file byte-identical; re-sync refused
    while ok; no merge path or M0 files), `loopback_demo.test.mts` (2), self-check (2 rewritten,
    1 new), `local_store` epoch setting across a reopen (added after GREEN on review, so no RED),
    `demo_fence` history-before-online check now on `app_session.ts`.
  - RED: 14 of 20 failed (`ERR_MODULE_NOT_FOUND`, `ERR_ASSERTION`, `ERR_TEST_FAILURE`), e.g.
    `not ok 1 - the app session carries an unsynced M0 post over before open, and it reaches the
    relay  code: 'ERR_MODULE_NOT_FOUND'`; `not ok 5 - the app source has no merge path around the
    session and no M0 host or snapshot storage  code: 'ERR_ASSERTION'`; `not ok 13 - the demo
    origin pointer is loopback only, and is read only inside src/demo`.
  - Gate then: `tsc` 0; Core 116/116; release export with the pointer unset held 0
    `lattice-demo-wss`, 0 pointer name, 0 dev-check strings.
  - Simulator then (existing dev build, loopback server on 4100, never the public relay): origin
    and "Mode: loopback" shown; self-check pass; post "On relay", relay ids 3 to 4; pause sync and
    post: "Saved on this phone", "Offline · 1 waiting"; relaunch kept both posts and sync off
    (first device run of `openExpoLocalStore`); sync on: both "On relay", relay 5 ids; export
    opened the share sheet; one Thread frame's sig tampered in the app container (python sqlite3
    on simulator data) showed history_invalid with `invalid_retained_history`, sync stayed off,
    Export and Re-sync offered; re-sync came back live in `_r1` with 5 ops and the old file's
    frame-table sha256 unchanged; "store 1" persisted after relaunch. Screenshots
    (`m1a7s1_relay_origin_loopback.png`, `m1a7s1_posted_on_relay.png`,
    `m1a7s1_offline_saved.png`, `m1a7s1_relaunch_saved.png`, `m1a7s1_relaunch_on_relay.png`,
    `m1a7s1_export_share.png`, `m1a7s1_history_invalid.png`, `m1a7s1_resync_confirm.png`,
    `m1a7s1_resync_fresh_store.png`, `m1a7s1_relaunch_after_resync.png`,
    `m1a7s1_selfcheck.png`) no longer exist.
  - Not run: carry-over on a device (Core only); the rewritten smoke script (typechecked only).
- **Stage 2: Expo Router skeleton and lifecycle (Core; the simulator was blocked).**
  - Installed with `node_modules/.bin/expo install` for SDK 58: `expo-router` ~58.0.32,
    `react-native-safe-area-context` ~5.11.1, `react-native-screens` ~4.30.1, `expo-linking`
    ~58.0.17, `expo-constants` ~58.0.16; the install added the `expo-router` plugin to `app.json`.
    Docs read first from docs.expo.dev (context7 failed to connect): SDK 58 Expo Router
    manual-install, core concepts, tabs, navigation, notation, stack and src directory.
  - Routes in `src/app`: `_layout.tsx` (Stack inside SessionProvider), `index.tsx` (redirects `/`
    to `/threads`, an extra file because the tabs are named routes), `(tabs)/_layout.tsx`
    (Threads, People, Group), the three tab screens and `thread/[replica].tsx`, all placeholders
    printing their read model. The thread screen has a minimal Post; the Group tab keeps the trust
    card, export, the demo bar and the dev-only Self-check and Replica store check cards.
  - `index.ts` installs the polyfills then imports `expo-router/entry`; `main` stays `index.ts`
    (custom-entry variant); `src/App.tsx` is deleted (plan defect (b)).
  - New `src/composition.tsx` is the composition root and the only file that reaches `src/demo`
    (the demo fence bans `src/ui` and `src/app` from importing it, so 07's SessionProvider
    placement was split). `SessionProvider` takes a structural `Bootstrap`, keeps the
    connect-generation guard, carry-over notice, history_invalid notice, export and confirmed
    re-sync, and binds lifecycle to the current session through a ref. Extra files
    `src/ui/read_model_source.ts`, `theme.ts`, `SessionBanner.tsx`.
  - `useReadModel(select, deps)` calls `useSyncExternalStore` over `read_model_source.ts`; the
    snapshot is cached per ReadModels object, so selectors only pick.
  - `native/lifecycle.ts` `bindLifecycle(AppState, target)`: active foregrounds, background
    backgrounds, inactive is ignored, transitions are serialized, repeats collapse, a failing
    transition does not stop the next. New `session.foreground()` and `background()` via
    `link_commands`: foreground starts the link and syncs only when sync is on and history and key
    are ok; background stops the link; neither writes `syncEnabled`. `strings.ts` gains `tabs.*`,
    `thread.*` and `relay.resumeSync`.
  - Tests: new `navigation.test.mts` (4) and `lifecycle.test.mts` (6, adopted from an interrupted
    attempt, its `MemoryKeyCustody.empty()` test bug fixed before implementation). `demo_fence`,
    `import_boundaries` and `strings` retargeted from `App.tsx` to `composition.tsx`,
    `group.tsx`, `SessionProvider.tsx` and `src/app`, every assertion kept.
  - RED: all 10 new tests failed: `session.background is not a function`,
    `session.foreground is not a function`, `ERR_MODULE_NOT_FOUND` for `src/native/lifecycle` and
    `src/ui/read_model_source`, `AssertionError` "app/_layout.tsx exists" (plus the test bug
    `MemoryKeyCustody.empty is not a function`). Baseline before edits: 115/126 with one
    `loopback_demo` "carrier connect timeout" flake that has passed since.
  - Gate then: `tsc` 0; Core 126/126. Release export (3.6 MB `.hbc`): 0 `lattice-demo-wss`, 0
    demo-bar and dev-check strings, routes present. Dev bundle with the pointer: every route, the
    demo, both dev cards and `127.0.0.1:4100`.
  - Simulator BLOCKED: `expo run:ios` reached Build Succeeded then hung; agent-device install and
    open timed out; device tools returned "Could not communicate with device support";
    `xcrun simctl list` did not answer (CoreSimulatorService hung). Not restarted by the agent.
- **Stage 3: simulator gate (Simulator).** The orchestrator restarted CoreSimulatorService.
  Stages 1 and 2 were not rewritten.
  - Native rebuild for expo-router: `node_modules/.bin/expo run:ios --no-bundler --device
    0CD290A4-...` (iPhone 17 Pro, iOS 26.5), Build Succeeded and installed; Expo's own `simctl
    openurl` then timed out (Metro not yet up), so the app was launched through agent-device.
    `test/support/loopback_demo_server.mts 4100` and Metro with
    `EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN=http://127.0.0.1:4100`; never the public relay. All UI
    actions through agent-device.
  - Seen: launches into the tabs, Threads lists `# General` (`m1a7s3_01_threads_tab.png`);
    People and Group (relay origin `http://127.0.0.1:4100`, both replicas live, trust card,
    demo-keys notice) (`m1a7s3_02_people_tab.png`, `m1a7s3_03_group_tab.png`); tapping the thread
    pushes `thread/[replica]` with its timeline, so a colon-bearing replica id survives as a route
    param (`m1a7s3_04_thread_pushed.png`); post while live: "On relay", relay ids 3 to 4
    (`m1a7s3_05_posted_on_relay.png`); background via agent-device `home`: pid 74050 held 2
    established sockets to relay ports 54420 and 54421 before and 0 after
    (`m1a7s3_06_backgrounded_home.png`); foreground via `open` without relaunch: same pid, 2 new
    sockets, "Live", a second post took the relay from 4 to 5
    (`m1a7s3_07_foreground_reconnected_post_on_relay.png`); force-quit and relaunch (pid 74050 to
    84009): both posts "On relay", relay still 5, sockets back (`m1a7s3_08_relaunch_threads.png`,
    `m1a7s3_09_relaunch_thread_posts_on_relay.png`); Self-check custody, storage sqlite row
    round-trip, crypto pass (`m1a7s3_10_selfcheck.png`); Replica store check "SqliteReplicaStore
    on expo-sqlite: 6/6 pass" (`m1a7s3_11_replica_store_check.png`). Socket and relay counts in
    `m1a7s3_evidence.txt`.
  - Defect exposed and fixed: on iOS 26 the SDK 58 native stack with no header background uses
    the translucent Liquid Glass bar and lays the screen under it; the thread banner sat under the
    status bar and header and the back button read "(tabs)"
    (`m1a7s3_04a_thread_header_overlap_before_fix.png`). `src/app/_layout.tsx` now sets
    `<Stack screenOptions={{ headerTransparent: false }}>` and `headerBackTitle: tabs.threads` on
    `thread/[replica]` (sources: docs.expo.dev stack page, installed expo-router
    `useHeaderConfigProps` and react-native-screens `ScreenStackItem` `getSafeAreaEdges`).
    Confirmed on screen after a Metro restart without `CI=1` (the first Metro run with `CI=1`
    did not watch files). New test in `navigation.test.mts`: "the thread screen sits below an
    opaque stack header and its back button names the Threads tab"; RED `not ok 5 ...
    AssertionError` (4 pass, 1 fail), green after.
  - Not run or limits: the plan's "local relay log shows the disconnect" is evidenced by `lsof`
    on the app process (the fixture logs no connections); foreground pull of ops authored
    elsewhere was not exercised; `keyboardVerticalOffset={90}` no longer fits the opaque header
    (M1b.2); a launch toast from lattice-client require cycles; no Hermes timing; the demo role
    switcher not exercised; lint not run.
- **Close (integrator).** `tsc --noEmit` exit 0; Core 127/127; release
  `expo export --platform ios --clear` with the demo env unset (exit 0,
  `index-938a3d7336369501b7b83ee1e574f00f.hbc`): 0 `lattice-demo-wss`, 0
  `EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN`, 0 `DEMO_KEYS_PUBLIC`, 0 `replica_store_device_check`, 0
  "Run replica store check", 0 "Run Self-check", 0 `demo-endpoints.json`. Lint not run: no ESLint
  config or script exists and `expo lint` would install one. Smoke script not run. Docs 03 and 04
  not updated for the stage 1 and 2 decisions (Known gap). Status board rows that cited deleted
  screenshots now cite `m1a7s3_*` files or say the file is gone.
- **Independent review and fix round (closer).** Reviewers: Codex (`gpt-6.1-sol`, high; the
  user's standing instruction) and Antigravity Neon (medium), both ran. 14 findings (Codex 3,
  Neon 11; Codex 1 and Neon 3 are the same race): 12 accepted (two only in part), 2 deferred plus
  the deferred half of one partial, 1 half rejected.
  - Accepted and fixed:
    - Background during startup (Codex 1, Neon 3): `bindLifecycle` now returns a binding with
      `reconcile()`; `SessionProvider.install` calls it, so a session that opened while the app was
      already in the background is stopped, queued behind any running transition.
    - Failed carry-over was only a notice (Codex 2): 03 says a verify failure on launch is
      history_invalid. New `SessionPorts.blockedHistory`; `openAppSession` passes a failed carry-over
      as `carry_over: <reason>`, so the session never goes online or signs, and re-sync is offered.
    - Carry-over on every store epoch (Neon 1): only epoch 0 carries the M0 snapshot, so a
      confirmed re-sync can leave a failed carry-over behind (the M0 file stays untouched).
    - Re-sync closed the session first (Neon 2): `resync()` persists the pointer, opens the fresh
      session, and only then closes the old one; on failure it restores the pointer and the old
      session stays open.
    - Export threw on a genesis frame without `deps` (Codex 3): root discovery moved into the
      `try`, so it is `export_failed`; the provider's export now guards the whole call.
    - Adoption failures swallowed (Neon 4): `AppSession.adoptFailed` lists them and the provider
      shows them as a notice (not blocking).
    - Smoke race (Neon 5): `demo_relay.mts` waits for both the Space and the Thread
      (typechecked only, not run).
    - Same-origin Reconnect was a no-op (Neon 6, in part): an attempt counter re-runs connect.
    - Moderator removal shown as author deletion (Neon 8): `ThreadListItem.last.removed` is now
      `Removed | null` and the Threads tab uses `removedPlaceholder[removed]`.
    - Self-check probe test used a fresh database (Neon 10): it now reruns over the same database
      and asserts the `probe` table is empty.
    - Stale notice (Neon 11, in part): `install(null)` clears the notice.
  - Rejected: Neon 6's other half. The `initialError` early return is the loopback fence: a
    pointer that is not loopback is an error to fix in the env, not something the demo bar may
    route around.
  - Deferred (Known gaps): ReplicaDb handles never closed (Neon 7); realm strings on screen
    (Neon 9, M1b petnames and fingerprints); the dev detail line keeps the old store epoch after a
    re-sync (Neon 11's other half, dev only).
  - RED (fix round, against the staged pre-fix source): 6 of the new tests failed:
    `expected: 'history_invalid' actual: 'key_only'` (failed carry-over); `the failed session stays
    open: {"ok":false,"reason":"not_open"}`; adoption failure not reported;
    `Cannot read properties of undefined (reading 'length')` (export);
    `binding.reconcile is not a function`; `expected: 'by_moderator' actual: true`. The
    strengthened self-check test passed before and after (it guards behaviour that was already
    correct).
  - Final gate: `tsc --noEmit` exit 0; Core 133/133 pass, 0 fail; release `expo export --platform
    ios --clear` with the demo env unset (exit 0, `index-fcfd532da7303128ab2000e79af3018f.hbc`): 0
    `lattice-demo-wss`, 0 `EXPO_PUBLIC_TREEHOUSE_DEMO_ORIGIN`, 0 `DEMO_KEYS_PUBLIC`, 0
    `replica_store_device_check`, 0 "Run replica store check", 0 "Run Self-check", 0
    `demo-endpoints.json`. Lint not run (not configured). The fix round did not run on the
    simulator: the stage 3 screenshots predate it.
- Tier: Simulator for navigation, lifecycle, post, force-quit and relaunch, and the dev checks
  (before the review fixes); Core for carry-over, recovery, the review fixes and the rest.

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
