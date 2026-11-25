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
| Milestone | M0 committed, simulator proof not run; design set and implementation plan written |
| Highest evidence tier reached | Core |
| Works today | Node gate: connect to the demo relay as a demo identity, read the Group and Thread, post offline, queue survives a simulated restart |
| Does not work today | anything on a simulator or phone (never launched); a phone's own key on the relay; invitations; edit, delete, archive; people management |

## Status board

| Slice | Status | Tier | Evidence |
|---|---|---|---|
| M0 scaffold, typecheck, Hermes bundle | done | Core | `tsc --noEmit` clean; `expo export --platform ios` bundled 708 modules (2026-11-25) |
| M0 live relay gate | done | Core | `npm test` against `lattice-demo-wss.fly.dev` passed with `MemoryKeyStore` and `MemoryMobileStorage` (2026-11-25) |
| M0.1 simulator boot with real SecureStore and SQLite | todo | - | never run |
| M0.2 trust-card copy | todo | - | current copy omits who can read |
| M0.3 device-key identity against the relay | doing | Core | tried from Node 2026-11-25: both routes refused `unauthenticated`, zero frames held. Screen copy for this state still to do |
| M1a.0 test harness and fixtures | todo | - | |
| M1a.1 ports, session and post tracer | todo | - | |
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
| M0 simulator proof missing | Keychain, SQLite and Hermes runtime paths are unexecuted | M0.1 |
| M0 host re-reduces per render and rewrites the whole snapshot per save | will not scale past small threads | M1a.2, M1a.4 |
| M0 capability picker ignores required roles | may offer an action the judge then refuses | M1a.4 |
| No verify-on-open | saved frames are trusted at launch | M1a.2 |
| Trust-card copy does not name the reader | conflicts with the D1 hosting rule | M0.2 |
| Plan 180 orders iOS after E1 | plan index does not yet say 296 is a parallel track | O-7 |

## Next up

Follow the build order in [07-implementation-plan.md](07-implementation-plan.md):

1. M0.1: launch on the iOS Simulator and run the self-check.
2. M1a.0: Core test harness with the local relay.
3. M1a.1: the post tracer through the new session.
4. Then M1a.2, M1a.3, M1a.6 and M1a.8 in parallel.

## Log

Newest first.

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
