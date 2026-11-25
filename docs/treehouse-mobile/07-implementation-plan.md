# 7. Implementation plan

How to build what [03](03-application-layer.md) and [04](04-screens-and-flows.md) describe.
[06](06-milestones.md) owns slice ids, sequence and open decisions; this file owns everything
an agent needs to execute a slice. Status is in [PROGRESS.md](PROGRESS.md).

M0 and M1 are specified to the level of files, signatures, named tests and gate commands. M2
and later are outlined and get the same treatment when M1b is under way.

## Scope

- `clients/treehouse-mobile/` only, plus the CI job in slice M1a.8.
- One pre-provisioned Group, demo identities for M1, legacy-rooted Threads (no `#authority:`).

## Non-goals

- No change to `lattice-client`, `lattice-shell-kit`, the relay or any Elixir app. If a slice
  seems to need one, stop and write it up under Known gaps instead.
- No per-Thread keys, group creation, thread creation or rollover before M2 (they need G-2).
- No notifications, background sync, media, reactions or E2EE (contract exclusions).
- No lifting of the Tauri workflow into shell-kit (O-1 default).

## STOP conditions

Stop, record the reason in PROGRESS and ask, rather than work around any of these:

- A reducer, capability check, codec or signature check would have to be written in the app.
- A test can only pass by comparing the app with itself where a Sim vector or the BEAM relay
  could be the reference.
- A gate would push to the public demo relay by default.
- A private key, seed or signature input would appear in a log, test output, QR or link.
- Held frames would be deleted or rewritten, or a key regenerated, to recover from an error.
- Copy would use a word from the "never uses" list in [01](01-ubiquitous-language.md).
- An Expo or React Native API is being written from memory. Fetch the SDK 58 docs first, as
  `clients/treehouse-mobile/AGENTS.md` requires.

## Ground rules for every slice

1. Branch from the current tip. Commits are made once per juncture (M0.1; M1a.0+M1a.1;
   M1a.2+M1a.3+M1a.6+M1a.8; M1a.4+M1a.5; M1a.7; M1b), with each slice's RED evidence collected
   in the commit body, by operator instruction 2026-11-25.
2. TDD: write the named tests first and keep the failing output as RED evidence in the commit
   body. Then make them pass.
3. Touch only the files the slice lists. Slices listed as parallel have disjoint file sets.
4. Finish with the slice's gate plus the standard gate, then update PROGRESS in the same commit.
5. Claim only the tier that ran.

Standard gate, run from the repo root (Node 22 from nvm; call binaries directly because the
npm shell wrapper recurses on this machine):

```sh
export PATH="$HOME/.nvm/versions/node/v22.15.1/bin:$PATH"
cd clients/treehouse-mobile
node_modules/.bin/tsc --noEmit
node_modules/.bin/tsx --preserve-symlinks --test "test/core/**/*.test.mts"
cd ../.. && scripts/check_treehouse_mobile_progress.sh
```

## Target layout

```
clients/treehouse-mobile/
  src/
    app/                 Expo Router routes only (M1a.7)
    session/             application layer; no react, react-native or expo imports
      ports.ts           KeyCustody, ReplicaStore, LocalStore, RelayLink, Clock
      session.ts         TreehouseSession: wiring, subscribe, lifecycle
      projections/       one file per read model; pure functions
      commands/          one file per command; pipeline.ts shared
      outcomes.ts        Outcome<T, R> and the reason unions
      memory/            in-memory adapters for every port (used by Core tests)
    native/              adapters that import expo-* (custody, sqlite, lifecycle)
    local/               LocalStore schema and SQLite adapter
    ui/                  components, theme, strings.ts
    demo/                demo manifest, seeds, role switcher (dev builds only)
  test/
    core/                *.test.mts, Node, memory adapters
    support/             fixtures: local relay, group builder, vector loader
    smoke/               gates against the public demo relay (read-only by default)
```

An import-boundary test (M1a.1) fails if `src/session/**` imports `react`, `react-native`,
`expo*` or `src/native/**`, or if `src/app/**` or `src/ui/**` imports
`@treetopdevs/lattice-client` directly.

## Test references

| Reference | Where | Used for |
|---|---|---|
| Sim vectors | `clients/lattice-client/test/vectors/treehouse_thread_conflicts.json`, `treehouse_thread_archive.json`, `treehouse_space_membership.json`, `treehouse_space_roles.json` (each has `oracleCarrierOps` and `expectAtFullFrontier`) | read models must equal Sim's state, order and quarantine set |
| Local BEAM relay | `writePilotManifest` and `spawnPilotManifestServer` from `@treetopdevs/lattice-shell-kit/testing/relay`, running `apps/lattice_carrier_server/priv/pilot_node.exs` | real sockets, real admission, any test key can be admitted |
| In-process relay | `FakeRelay`, `FakeConnection`, `FakeClock` from `@treetopdevs/lattice-shell-kit/testing` | sync and submit outcomes, forced refusals. It has no availability feed. |
| Worked example | `clients/treehouse-tauri-shell/test/enrollment_sync_gate.ts` and `test/support/` | how to build a Space and Threads in-test, boot the relay and compare with the oracle |
| Public demo relay | `https://lattice-demo-wss.fly.dev` | smoke only. Gates that submit to it are opt-in (`DEMO_WSS_WRITE=1`), because every run would add a message to a shared thread. |

The local relay needs the BEAM built once: `MIX_ENV=test ~/.asdf/shims/mix compile` from the
repo root. `route_alphabet.json` already permits `ws://127.0.0.1`, and the iOS Simulator shares
the Mac's loopback, so simulator gates can use the same local relay.

## Build order

```
M0.1 ─► M1a.0 ─► M1a.1 (tracer) ─┬─► M1a.2 ─┐
                                 ├─► M1a.3 ─┼─► M1a.4 ─► M1a.5 ─► M1a.7 ─► M1b.*
                                 ├─► M1a.6 ─┘
                                 └─► M1a.8
```

M1a.2, M1a.3, M1a.6 and M1a.8 can run in parallel after M1a.1. M0.2 and the rest of M0.3 are
folded into M1a.6.

---

## M0.1 Simulator boot

**Goal.** Prove the three things M0 never executed: Keychain custody, SQLite storage and
Hermes crypto. No design work; the M0 screen stays.

**Depends on.** Nothing. Xcode 27 and iOS simulators are installed on this machine.

**Files.** `app.json` (bundle id, scheme `treehouse`), `src/App.tsx` (a dev-only "Self-check"
row in the Relay tab), `src/native/selfcheck.ts` (new).

**Steps.**

1. Read the SDK 58 docs for development builds, `expo-secure-store` and `expo-sqlite`.
2. `selfcheck.ts` exports `runSelfCheck(): Promise<SelfCheck>`:
   - `custody`: create a key under a throwaway name, read it back, sign and verify, delete it.
   - `storage`: write a snapshot, read it back, compare; report whether the SQLite adapter or
     its memory fallback answered. Today `ExpoSqliteStorage` falls back silently on any error;
     the check must expose which one ran.
   - `crypto`: `crypto.getRandomValues`, SHA-256 and Ed25519 against a fixed known answer.
3. Build and launch with `npx expo run:ios`. Drive the simulator through the Device panel
   tools, as the repo's device rules require.
4. Scenario: launch, Founder identity connects, post a message, force-quit, relaunch, the
   message is still there and shows on relay. Then run Self-check and screenshot it.

**Gate.** Self-check shows three passes with `storage: sqlite` (not `memory`); the scenario
completes. If any part fails, record exactly what failed and stop; fixing the adapter is then
the first task of M1a.2 (storage) or M1a.1 (custody).

**Tier.** Simulator. **PROGRESS row.** M0.1.

---

## M1a.0 Test harness and fixtures

**Goal.** A Core test suite that runs without the public relay, and fixtures every later slice
uses.

**Files (all new).** `test/support/vectors.ts`, `test/support/group_fixture.ts`,
`test/support/local_relay.ts`, `test/core/harness.test.mts`; `package.json` scripts; move
`test/m0_wss_gate.mts` to `test/smoke/demo_relay.mts`.

**Contents.**

```ts
// test/support/vectors.ts
export function loadTreehouseVector(name: string): {
  replica: string; frames: CarrierOpFrame[]; realmByPubkey: Record<string, string>;
  expected: { state: unknown; order: string[]; quarantined: Record<string, string> };
};

// test/support/group_fixture.ts
// Builds one Space and one legacy-rooted Thread with lattice-client authoring helpers,
// following clients/treehouse-tauri-shell/test/enrollment_sync_gate.ts.
export async function buildGroup(opts: { members?: number }): Promise<{
  admin: TestIdentity; members: TestIdentity[];
  space: { replica: string; frames: CarrierOpFrame[] };
  thread: { replica: string; frames: CarrierOpFrame[] };
}>;

// test/support/local_relay.ts
export async function startLocalRelay(group: Group, admit: TestIdentity[]): Promise<{
  routes: CarrierRoute[]; stop(): Promise<void>; kill(): Promise<void>;
}>;
```

**Scripts.**

| Script | Runs |
|---|---|
| `test` and `test:core` | `tsx --preserve-symlinks --test "test/core/**/*.test.mts"` |
| `test:smoke` | `tsx --preserve-symlinks test/smoke/demo_relay.mts` (reads only unless `DEMO_WSS_WRITE=1`) |

**Named tests** (`harness.test.mts`).

- `vector loader returns frames whose reduced state equals the vector's expected state`
- `group fixture produces a Space and Thread the judge honors with zero quarantined ops`
- `local relay admits a listed key and refuses an unlisted one as unauthenticated`
- `two test identities converge through the local relay`

**Gate.** Standard gate. **Tier.** Core. **PROGRESS row.** M1a.0.

---

## M1a.1 Ports, session and the post tracer

**Goal.** The thinnest vertical path through the new layers: read a thread and post to it via
`TreehouseSession`, shown in the existing M0 screen. Proves the architecture before widening.

**Depends on.** M1a.0.

**Files.** New: `src/session/ports.ts`, `outcomes.ts`, `session.ts`,
`projections/thread_timeline.ts`, `commands/pipeline.ts`, `commands/post_message.ts`,
`memory/*.ts`, `test/core/session_tracer.test.mts`, `test/core/import_boundaries.test.mts`.
Edited: `src/App.tsx` (thread tab reads `session.threadTimeline`, send calls
`session.postMessage`). `TreehouseMobileHost` stays for everything else until M1a.4.

**Signatures.**

```ts
// ports.ts
export interface KeyCustody {
  status(): Promise<"none" | "available" | "unavailable">;
  publicKey(): Promise<string | null>;            // base64, 32 bytes
  create(): Promise<string>;                      // refuses if a key exists
  sign(bytes: Uint8Array): Promise<Uint8Array>;
}
export interface ReplicaStore {
  open(): Promise<void>;
  replicas(): HeldReplica[];                      // { replica, product }
  profile(replica: string): HeldProfile | undefined;   // shell-kit's type
  adopt(replica: string, product: TreehouseProduct): Promise<void>;
  appendAuthored(replica: string, frame: CarrierOpFrame): Promise<void>;
  mergeSync(replica: string, pulled: CarrierOpFrame[], ackedIds: string[]): Promise<boolean>;
  firstSeenMs(replica: string, id: string): number | undefined;   // sole owner of first-seen times
  onChange(listener: (replica: string) => void): () => void;
}
export interface RelayLink {
  configure(config: RouteConfig | null): Promise<void>;
  start(): Promise<void>; stop(): Promise<void>;
  syncNow(): Promise<FeedState>;
  state(): FeedState;
  onState(listener: (state: FeedState) => void): () => void;
}
export interface Clock { now(): number }

// outcomes.ts
export type Outcome<T, R extends string> = { ok: true; value: T } | { ok: false; reason: R };

// session.ts
export interface TreehouseSession {
  open(): Promise<void>;
  close(): Promise<void>;
  subscribe<T>(select: (m: ReadModels) => T, listener: (value: T) => void): () => void;
  read(): ReadModels;
  postMessage(thread: string, text: string): Promise<Outcome<{ id: string }, PostRefusal>>;
}
export type PostRefusal =
  | "identity_unavailable" | "no_capability" | "empty_text" | "text_too_long"
  | "malformed_text" | "archived thread" | "storage_failed" | "history_invalid"
  | QuarantineReason;
```

The session implements shell-kit's `ShellHost` internally (route book from `RelayLink`
config, `profile` and `mergeSync` from `ReplicaStore`, `signer` from `KeyCustody`), so the
existing `createFeedController` and `syncRoutes` are used unchanged. Capability selection
uses `memberCapability`; `pickTreehouseCapability` is not carried over.

`ThreadTimeline` in this slice has: ordered messages with `id`, `author`, `text`, `mine`,
`delivery` (`saved`, `sending`, `on_relay`), and `canPost`. The rest arrives in M1a.4.

**Named tests.**

- `timeline equals Sim order and text for treehouse_thread_conflicts`
- `timeline omits quarantined posts for treehouse_thread_archive`
- `post appears as saved while the link is stopped, then on_relay after sync` (local relay)
- `post by a key without a grant is refused no_capability and writes nothing`
- `empty and over-long text are refused before signing`
- `a second session on the same store sees the queued post after restart`
- `subscribe fires once per change and not when an unrelated slice changes`
- `session layer imports no react, react-native, expo or native modules`
- `ui and route layers do not import lattice-client`

**Gate.** Standard gate, then relaunch on the simulator and repeat the M0.1 scenario through
the new path. **Tier.** Core, plus Simulator if the relaunch is done. **PROGRESS row.** M1a.1.

---

## M1a.2 SQLite replica store

**Depends on.** M1a.1, and M0.1's storage result. **Parallel with** M1a.3, M1a.6, M1a.8.

**Files.** New: `src/native/sqlite_replica_store.ts`, `src/session/verify_held.ts`,
`test/core/replica_store_contract.mts`, `test/core/replica_store.test.mts`,
`test/core/verify_held.test.mts`. Deleted at the end: `src/native/storage.ts` once nothing
imports it.

The `ReplicaStore` port also exposes `firstSeenMs(replica, id): number | undefined`, the single
owner of first-seen times (see [03](03-application-layer.md)).

**Schema.**

```sql
CREATE TABLE replica (replica TEXT PRIMARY KEY, product TEXT NOT NULL);
CREATE TABLE frame   (replica TEXT NOT NULL, id TEXT NOT NULL, seq INTEGER NOT NULL,
                      json TEXT NOT NULL, authored INTEGER NOT NULL DEFAULT 0,
                      acked INTEGER NOT NULL DEFAULT 0, first_seen_ms INTEGER NOT NULL,
                      PRIMARY KEY (replica, id));
CREATE TABLE meta    (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- schema_version
```

- Inserts only. `authored` and `acked` move 0 to 1 and never back. No `DELETE` on `frame`.
- `appendAuthored` and `mergeSync` are each one transaction.
- No silent fallback: if the database cannot open, `open()` rejects and the session reports
  `history_invalid` with the reason.
- `first_seen_ms` is written here because it must be set in the same transaction that retains
  the frame; `LocalStore` reads it through `ReplicaStore.firstSeenMs` (M1a.3).

**Verify on open** (`verify_held.ts`, pure): for each held replica, every frame's id and
signature check, deps are closed, outbox and acked ids are held, the genesis matches the
replica's `#root:` commitment, and every held Thread is referenced by the held Space. This is
the mobile form of the Tauri shell's `verifyProfile` and `validateProfiles`, calling the same
`lattice-client` functions. Result: `{ ok: true } | { ok: false; replica; reason }`.

**Named tests.** The contract file runs against both the memory adapter and, on the
simulator, the SQLite adapter.

- `append then reopen returns the same frames in insertion order`
- `appending the same id twice stores one row`
- `mergeSync reports false and writes nothing when nothing is new`
- `acked ids must name held frames`
- `no statement deletes or updates frame json` (static scan of the adapter source)
- `verify rejects a tampered signature, a missing dependency, a wrong root and an unreferenced thread`
- `a failed verify leaves the store untouched and surfaces history_invalid`

**Gate.** Standard gate; contract suite inside a dev build on the simulator.
**Tier.** Simulator. **PROGRESS row.** M1a.2.

---

## M1a.3 Local store

**Depends on.** M1a.1. **Parallel with** M1a.2, M1a.6, M1a.8.

**Files.** New: `src/local/local_store.ts` (port and memory adapter),
`src/local/sqlite_local_store.ts`, `test/core/local_store.test.mts`. A separate database file
from the replica store, so device-local facts can never be mistaken for group facts.

```ts
export interface LocalStore {
  petname(pubkey: string): string | null;
  setPetname(pubkey: string, name: string | null): Promise<void>;
  draft(thread: string): Draft | null;            // { text, editOf?: MessageRef }
  saveDraft(thread: string, draft: Draft | null): Promise<void>;
  readIds(thread: string): ReadonlySet<string>;
  markRead(thread: string, ids: readonly string[]): Promise<void>;
  setting<K extends keyof Settings>(key: K): Settings[K];
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void>;
  onChange(listener: (kind: LocalKind) => void): () => void;
}
```

**Named tests.** `petname round-trips and clears`, `draft survives reopen`,
`markRead is additive and idempotent`, `petnames are trimmed and capped at 40 characters`,
`nothing in the local store is reachable from the replica store or a signed op` (import scan).

**Gate.** Standard gate. **Tier.** Core. **PROGRESS row.** M1a.3.

---

## M1a.4 Read models

**Depends on.** M1a.2, M1a.3.

**Files.** New under `src/session/projections/`: `group_summary.ts`, `link_status.ts`,
`thread_list.ts`, `abilities.ts`, `roster.ts`, `audit_view.ts`, `session_status.ts`; extend
`thread_timeline.ts`. Tests: one `*.test.mts` per file. Do not delete
`src/lib/treehouse_mobile_host.ts` here: its demo code (`fetchDemoEndpoints`, `fetchDemoSeed`,
role switcher) moves to `src/demo/` in M1a.6 first. Delete it once M1a.6 has landed and
`App.tsx` no longer imports it.

Each projection is a pure function `(inputs) => readModel` with the field set in
[03](03-application-layer.md). The session recomputes a projection only when one of its
inputs changed (replica change, feed state change, local change) and keeps the previous
object when the result is structurally equal, so subscribers do not re-render.

**Named tests.**

- `group summary, roster and roles equal Sim for treehouse_space_membership and treehouse_space_roles`
- `abilities match the judge: every allowed command is honored when authored, every refused one is not` (property-style over the vectors: author each command for each key and compare)
- `message delivery: saved, sending, on_relay, relay_refused, stopped` (FakeRelay forced outcomes)
- `message standing: a post quarantined after a concurrent revoke shows not_counted with its reason`
- `edited and removed messages render the winning text or placeholder per Sim`
- `a post that sorts above read messages is marked arrivedLate and counts as unread`
- `unread count is ids not in the read set, not a position`
- `link status reduces route states to one pill per the table in 03`
- `session status: no_key, key_only, member, removed, identity_mismatch, history_invalid`
- `projections return the identical object when inputs are unchanged`
- `timeline of 4,000 ops projects in under 150 ms in Node` (budget; adjust once measured)

**Gate.** Standard gate. **Tier.** Core. **PROGRESS row.** M1a.4.

---

## M1a.5 Commands and strings

**Depends on.** M1a.4.

**Files.** New under `src/session/commands/`: `edit_message.ts`, `delete_message.ts`,
`remove_message.ts`, `archive_thread.ts`, `local_commands.ts` (petname, draft, markRead),
`link_commands.ts`; `src/ui/strings.ts`; tests per command plus `strings.test.mts`.

- Every command goes through `pipeline.ts` (ability, author, pre-judge, save, publish, nudge).
- `strings.ts` holds all user-facing text as typed constants, and
  `refusalCopy: Record<AllRefusalReasons, string>`, so a new reason without copy fails
  `tsc`.
- The message limit is 4,000 characters. That is well under the relay's 64,000-byte socket
  frame; no domain limit is pinned upstream, so this is an app rule (O-10).

**Named tests.**

- `edit replaces text; a second edit targets the latest edit in the lineage`
- `edit by a non-author is refused wrong author and writes nothing`
- `delete is irreversible: a later edit is refused already tombstoned`
- `moderator remove needs the moderator holder`
- `archive denies post, edit and delete afterwards with archived thread`
- `each of the six pinned application denials maps to its reason` (vectors `treehouse_thread_conflicts`, `treehouse_thread_archive`)
- `a command refused at pre-judge leaves the outbox unchanged`
- `strings contain none of the prohibited or never-used words` (lists from Plan 178 and 01)
- `the hosting sentence names who can read and who can withhold`

**Gate.** Standard gate. **Tier.** Core. **PROGRESS row.** M1a.5.

---

## M1a.6 Demo fence, trust card, no-access state

**Depends on.** M1a.1. **Parallel with** M1a.2, M1a.3, M1a.8. Covers M0.2 and the rest of M0.3.

**Files.** New: `src/demo/manifest.ts`, `src/demo/identities.ts`, `src/demo/DemoBar.tsx`,
`test/core/demo_fence.test.mts`. Edited: `src/App.tsx`.

- Move `fetchDemoEndpoints`, `fetchDemoSeed` and the role switcher into `src/demo/`.
- Demo code is reachable only when `__DEV__` or `EXPO_PUBLIC_TREEHOUSE_DEMO=1`.
- The demo bar states that demo keys are public, so anyone can post as these identities.
- Replace the trust card text with the approved hosting sentence.
- Remove the "Keychain" mode from the switcher. A device key that the relay refuses shows
  "The relay doesn't know this phone yet" (link state `refused`), not a generic error.

**Named tests.** `session and ui import nothing from src/demo`,
`a refused space route yields the no relay access status`,
`trust card text equals the approved hosting sentence`.

**Gate.** Standard gate. **Tier.** Core. **PROGRESS rows.** M0.2, M0.3, M1a.6.

---

## M1a.7 Navigation and lifecycle

**Depends on.** M1a.5.

**Files.** New: `src/app/_layout.tsx`, `src/app/(tabs)/_layout.tsx`, `threads.tsx`,
`people.tsx`, `group.tsx`, `src/app/thread/[replica].tsx`, `src/native/lifecycle.ts`,
`src/ui/SessionProvider.tsx`, `src/ui/useReadModel.ts`. Deleted: `src/App.tsx`. Edited:
  `index.ts` (it imports `src/App.tsx`; point the entry at Expo Router, `expo-router/entry`, and
  set `main` in `package.json` to match, in the same change that deletes `App.tsx`).

- Read the SDK 58 Expo Router docs first; install with `npx expo install`.
- `useReadModel(select)` wraps `session.subscribe` with `useSyncExternalStore`.
- `lifecycle.ts`: foreground starts the link and syncs; background stops it. No background
  work is scheduled.
- Screens are placeholders that render their read model as plain text. Real UI is M1b.

**Gate.** Standard gate. Simulator: tabs switch, a thread opens, backgrounding closes the
sockets (local relay log shows the disconnect) and foregrounding reconnects and syncs.
**Tier.** Simulator. **PROGRESS row.** M1a.7.

---

## M1a.8 CI

**Depends on.** M1a.0. **Parallel with** everything after it.

**Files.** `.github/workflows/flagship.yml` (new job and a `mobile` path class in the
existing classifier).

- Triggers on `clients/treehouse-mobile/**`, `clients/lattice-client/**`,
  `clients/lattice-shell-kit/**`, `docs/treehouse-mobile/**`.
- Steps: `npm ci` in the three packages, build `clients/lattice-client` (the mobile package
  consumes its build output), build the BEAM relay itself (do not assume another job's build),
  `tsc --noEmit`, `test:core`, and `scripts/check_treehouse_mobile_progress.sh` over the same
  `BASE..HEAD` range `flagship.yml` already computes for its other checks, not
  `origin/main..HEAD`.
- No simulator job yet; that comes with M3.

**Gate.** The job is green on the slice's own PR. **Tier.** Core. **PROGRESS row.** M1a.8.

---

## M1b Chat loop screens

Each slice replaces one placeholder screen with the design in
[04](04-screens-and-flows.md). Logic is already in the session, so these slices add
components, layout and interaction only. Each adds component tests where behaviour is
non-visual, and ends with a simulator run recorded in PROGRESS with a screenshot.

| Slice | Files (under `src/app` and `src/ui`) | Simulator scenario that must pass |
|---|---|---|
| M1b.1 Threads tab | `threads.tsx`, `ThreadRow`, `LinkPill` | two identities; a post from the browser starter raises the unread count; opening the thread clears it |
| M1b.2 Thread screen | `thread/[replica].tsx`, `MessageList`, `Bubble`, `Composer`, `DeliveryMark` | pause sync, post three messages, relaunch, resume sync; marks go saved to on relay; draft survives relaunch |
| M1b.3 Edit and delete | `MessageSheet`, `ConfirmDialog` | edit then delete own message; other device shows "edited" then the placeholder |
| M1b.4 Arrived later, unread | `UnreadDivider`, `ArrivedLateCaption` | both devices post while one is paused; after resume the late post is marked and counted |
| M1b.5 Refusal states | `CannotPostBar`, `NotCountedBubble` | revoke the member's grant from the admin; composer is replaced by the reason |
| M1b.6 Archived thread | `ArchivedBanner`, thread info screen | moderator archives; both devices show read-only |
| M1b.7 Group tab | `group.tsx`, `RelayCard`, `SafetyCard`, `AuditScreen`, export | audit lists the revoked grant and a not-counted op with its reason; export writes a file |

Scenarios run against the local relay so they are repeatable and do not write to the public
demo. M1's exit check repeats M1b.2 against the public demo relay once, with the browser
starter as the second participant.

Accessibility is part of each slice's done criteria: every state mark has a text label,
dynamic type does not clip, dark mode is checked.

---

## M2 and later (outline)

The local relay fixture can admit any test key, so the whole invitation ceremony is testable
at Core and Simulator tiers now. G-1 blocks only the public demo relay and real use.

| Slice | Outline |
|---|---|
| M2.2 Ceremony saga | `src/ceremony/` state machines for both sides, saved in `LocalStore`; Core test drives two sessions through the local relay and kills each at every step |
| M2.1 Onboarding | welcome, trust card, key creation, choose; `KeyCustody.create` on first run |
| M2.3 QR | show and scan for the three artifacts; single QR for a one-thread offer; share sheet otherwise |
| M2.4 People tab | roster, petnames, key check, invitations in progress, revoke |
| M2.5 Member management | remove, change moderator (one transfer per replica), transfer admin |
| M2.0 Public demo access | O-5: a server change, planned on the substrate track |
| M3, M4 | as in [06](06-milestones.md) |

Per-Thread keys (O-11) enter with thread creation, after G-2.

## Verification summary

| Command (from `clients/treehouse-mobile` unless noted) | Expected |
|---|---|
| `node_modules/.bin/tsc --noEmit` | no errors |
| `node_modules/.bin/tsx --preserve-symlinks --test "test/core/**/*.test.mts"` | all named tests for completed slices pass |
| `node_modules/.bin/tsx --preserve-symlinks test/smoke/demo_relay.mts` | pass; submits nothing unless `DEMO_WSS_WRITE=1` |
| `npx expo run:ios`, then the slice's simulator scenario | scenario passes; screenshot in the PR |
| repo root: `scripts/check_treehouse_mobile_progress.sh` | `ok` |

## Done criteria for M1

- `src/App.tsx`, `src/lib/treehouse_mobile_host.ts` and `src/native/storage.ts` are gone.
- Every read model and command in [03](03-application-layer.md) that M1 covers has its named
  tests, and those that have a Sim vector are compared with it.
- The import-boundary tests pass.
- The M1 exit scenario has run on the simulator against both the local relay and the public
  demo relay, and PROGRESS records it at Simulator tier.
- No slice claimed Physical.
