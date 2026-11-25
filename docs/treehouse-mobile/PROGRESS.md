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
| Milestone | M0 committed; M0.1 self-check built, simulator gate not run (blocked: Xcode selection); M1a.0 harness and M1a.1 session tracer done at Core |
| Highest evidence tier reached | Core |
| Works today | Core suite with no public relay: Sim vector loader, in-test Group builder and a local BEAM relay (`pilot_node.exs`) that admits listed keys and refuses others; `TreehouseSession` reads a thread timeline equal to Sim order and quarantine, posts offline as saved, shows on relay after sync against the local relay, and keeps the queued post across a restart. The M0 thread tab now reads and posts through the session (bundled, not run on a device) |
| Does not work today | anything verified on a simulator beyond launch (self-check never tapped) or on a phone; a phone's own key on the relay; invitations; edit, delete, archive; people management |

## Status board

| Slice | Status | Tier | Evidence |
|---|---|---|---|
| M0 scaffold, typecheck, Hermes bundle | done | Core | `tsc --noEmit` clean; `expo export --platform ios` bundled 708 modules (2026-11-25) |
| M0 live relay gate | done | Core | `npm test` against `lattice-demo-wss.fly.dev` passed with `MemoryKeyStore` and `MemoryMobileStorage` (2026-11-25), as `test/m0_wss_gate.mts`. Since M1a.0 that script is `test:smoke` (`test/smoke/demo_relay.mts`, imports rewired) and has not been rerun after the move; `npm test` now runs the Core suite |
| M0.1 simulator boot with real SecureStore and SQLite | blocked (Xcode-beta cannot run simulator input on this macOS) | Core | self-check code and 3 Core tests pass; app built, installed and launched on iPhone 17 Pro (iOS 26.5, screenshot `/private/tmp/claude-501/-Users-nicholas-develop-lattice/7ca0f07f-6bd2-42cc-82d3-4b6ed54121d7/scratchpad/m01_launch.png`, launch only); self-check not tapped, three-pass sqlite gate not run |
| M0.2 trust-card copy | todo | - | current copy omits who can read |
| M0.3 device-key identity against the relay | doing | Core | tried from Node 2026-11-25: both routes refused `unauthenticated`, zero frames held. Screen copy for this state still to do |
| M1a.0 test harness and fixtures | done | Core | 4 named tests pass in the 18/18 Core suite; `tsc --noEmit` clean (2026-11-25). Needs `MIX_ENV=test mix compile` for the local relay tests. Smoke script not run |
| M1a.1 ports, session and post tracer | done | Core | 9 named tests pass in the 18/18 Core suite (three implementer runs and one integrator run); `expo export --platform ios` bundled. Simulator relaunch: not run (Xcode selection) |
| M1a.2 SQLite replica store | todo | - | |
| M1a.3 local store | todo | - | |
| M1a.4 read models | todo | - | |
| M1a.5 command pipeline | todo | - | |
| M1a.6 demo bootstrap fenced | todo | - | |
| M1a.7 navigation and lifecycle | todo | - | |
| M1a.8 CI job | todo | - | |
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
| M0 simulator proof missing | the app launches, but Keychain and SQLite self-check results and persistence across relaunch are unverified; adapter has not failed, it was not exercised | M0.1 |
| Simulator input blocked | `agent-device press` fails (DTServiceHub) while `xcode-select` points at Xcode-beta; `/Applications/Xcode.app` also exists | M0.1 |
| M0 host re-reduces per render and rewrites the whole snapshot per save | will not scale past small threads | M1a.2, M1a.4 |
| M0 capability picker ignores required roles | may offer an action the judge then refuses | M1a.4 |
| No verify-on-open | saved frames are trusted at launch | M1a.2 |
| Trust-card copy does not name the reader | conflicts with the D1 hosting rule | M0.2 |
| M1a.1 simulator relaunch not run | the session-backed thread tab is bundled but has never executed on a device | M1a.1, M0.1 |
| `src/lib/host_session_ports.ts` is a temporary bridge | the session reads and writes the M0 host's identity-scoped snapshot so no queued post is stranded; its `firstSeenMs` returns undefined, its link `start`/`stop` do nothing (the host still owns online/offline) and its `syncNow` only forwards the post nudge to the host while online | M1a.2, M1a.4, M1a.6 |
| Session `goOnline`/`goOffline`/`syncNow` not on `TreehouseSession` yet | tests drive the RelayLink directly | M1a.5 |
| Local relay fixture borrows a Tauri shell script | `test/support/local_relay.ts` runs `clients/treehouse-tauri-shell/test/support/treehouse_enrollment_fixture.exs` by path to create empty logs | M1a.8 |
| `test:smoke` `DEMO_WSS_WRITE=1` branch never run | the moved smoke script is typechecked only; without the flag it does not relay | M1a.0 |
| Plan 180 orders iOS after E1 | plan index does not yet say 296 is a parallel track | O-7 |

## Next up

Follow the build order in [07-implementation-plan.md](07-implementation-plan.md):

1. M0.1: fix the Xcode selection for the agent-device daemon, then tap Relay & Safety > Run Self-check and screenshot; custody, storage (must say sqlite) and crypto must all pass, on three runs. Do the post/relaunch step against a local relay only, never the public demo relay.
2. M1a.1 Simulator: once input works, relaunch and repeat the M0.1 scenario through the session path against a local relay.
3. M1a.2, M1a.3, M1a.6 and M1a.8 in parallel. M1a.2 must carry over unsynced posts from the M0 identity-scoped snapshot that `host_session_ports.ts` writes to.

## Log

Newest first.

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
