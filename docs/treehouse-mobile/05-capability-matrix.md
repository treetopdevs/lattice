# 5. Capability matrix

For each thing the app wants to do: is the signed command in the frozen vocabulary, does a
client function exist, can the relay support it for a self-made phone key, and where has it
been proven. This is the list of substrate work the UX depends on.

Checked 2026-11-25 against `bd9ddcc55`. "Client" means `lattice-client` or `lattice-shell-kit`.
"Tauri" means the flow already runs in `clients/treehouse-tauri-shell`.

Legend: ✅ exists · ◐ partial · ❌ missing · n/a not needed

## Features

| Feature | Command | Client function | Relay support | Proven in | Mobile status |
|---|---|---|---|---|---|
| Read a Group and Thread | n/a | ✅ `observeTreehouse` | ✅ pull | Tauri, browser starter, M0 Node gate | ◐ M0, demo identities only |
| Post | ✅ `post` | ✅ `authorTreehouseCommand` | ✅ submit, for admitted realms | same | ◐ M0, demo identities only |
| Offline queue and heal | n/a | ✅ shell-kit outbox and acks | ✅ | same | ◐ M0 Node gate with memory storage |
| Push-triggered sync | n/a | ✅ `createFeedController` | ✅ `ops_available` | Tauri, M0 Node gate | ◐ not run on a device |
| Edit own message | ✅ `author_edit` | ✅ | ✅ | Sim, Tauri | ❌ |
| Delete own message | ✅ `author_tombstone` | ✅ | ✅ | Sim, Tauri | ❌ |
| Moderator remove | ✅ `moderator_tombstone` | ✅ | ✅ | Sim | ❌ |
| Archive thread | ✅ `archive_thread` | ✅ | ✅ | Sim | ❌ |
| Abilities per command | n/a | ✅ `memberCapability`, `liveTreehouseDelegations` | n/a | Tauri `snapshot()` | ❌ M0 uses its own picker |
| Invite and join (3 artifacts) | ✅ `issue_invitation`, `admit_member` | ✅ `treehouse_enrollment.ts` | ❌ **relay access for the new key is a manifest edit** | Plan 181 dev-trace variant, hand-written routes | ❌ |
| Invite with more than 3 threads | ✅ | ❌ capped by `TREEHOUSE_LITE_THREAD_CAP = 3` | n/a | | ❌ |
| Per-Thread root keys (bounded Threads) | n/a | ✅ `threadSigners` in admit; `prepareTreehouseBoundedThreadCreation` | n/a | Tauri native custody | ❌ mobile custody is single-key |
| Admit as moderator | ✅ `admit_member` level | ❌ helper hardcodes `member` | n/a | | ❌ |
| Offline invitation bundle | ✅ | ✅ `treehouse_offline_enrollment.ts` | n/a | Tauri | ❌ file hand-off, later |
| Revoke invitation | ✅ `revoke_invitation` | ✅ generic authoring | ✅ | Sim | ❌ |
| Remove member | ✅ `remove_member` | ◐ command and grant revocation exist; no single helper and no `removal_pending` derivation found | ❌ **dropping relay access is a manifest edit** | Sim | ❌ |
| Change moderator | ✅ | ✅ `authorTreehouseRoleTransfer` | ✅ | Sim | ❌ |
| Transfer admin | ✅ | ✅ `authorTreehouseRoleTransfer` | ✅ | Sim | ❌ |
| Start a group | ✅ `create_space` | ✅ `prepareTreehouseBoundedSpaceCreation` | ❌ **a new replica needs a new relay instance in the manifest** | Tauri local preview | ❌ |
| New thread | ✅ `create_thread` | ✅ `prepareTreehouseBoundedThreadCreation` | ❌ **same: route provisioning** (Plan 224 catalog path is operator-run) | Tauri local preview | ❌ |
| Rollover | ✅ archive + create | ◐ no helper; thresholds are policy | ❌ needs New thread | | ❌ |
| Durable "relay refused" | n/a | ❌ last sync only | ✅ relay reports it | | ❌ |
| Message send time | ❌ no time in an op | n/a | n/a | | design uses local first-seen |
| Shared display names | ❌ not in vocabulary | n/a | n/a | | design uses local petnames |
| Member key loss | ◐ `attest member key v1` adopted | ◐ `treehouse_member_continuity.ts` | | AF-3 not complete | out of scope |
| Admin phone loss | ❌ AF-2 fails today | | | | out of scope; stated in Safety |
| Notifications, background sync | excluded | | | | out of scope |
| Media, reactions | excluded | | | | out of scope |

## Mobile-specific adapters

| Adapter | State |
|---|---|
| Keychain custody (`expo-secure-store`) | written in M0, never executed; the Node gate used `MemoryKeyStore` |
| SQLite store (`expo-sqlite`) | written in M0, never executed; the Node gate used `MemoryMobileStorage`; rewrites the whole snapshot per save |
| Hermes crypto polyfills | bundle built; not run on a simulator |
| Camera and QR | not started; `lattice-mobile-core` has pairing QR and deep-link helpers for Township pairing, not Treehouse artifacts |
| Share sheet, `treehouse://` links | not started |
| App lifecycle (foreground, background) | not started |

## The substrate gaps, in priority order

### G-1 Relay access for a self-made key (blocks M2 and any real use)

The relay authenticates `trusted_peers` and lets `relay_realms` submit, both read from a
static manifest at start. The demo manifest lets `demo-founder` and `demo-neighbor` submit
and lists `demo-observer` as a third participant. Tested 2026-11-25 from Node: a fresh device
key (realm `mobile-device`) was refused on the Space and Thread routes with `carrier peer
error: unauthenticated`, and held zero frames afterwards. So the M0 "Keychain" identity
cannot even read.

Options:

| | Approach | Cost | Trade-off |
|---|---|---|---|
| a | Operator edits the manifest and restarts for each joiner | none | not a product; fine for a 2-phone demo |
| b | Demo-only HTTP endpoint on the Fly testbed that admits a posted public key | small, server | anyone can join the demo relay; acceptable for a labelled public demo only |
| c | Relay derives admission from the Space log: a key is admitted if it is the recipient of an honored, unrevoked invitation or a current member | medium, server; touches the "relay holds no semantic authority" boundary | the real answer; needs its own plan and review |

Recommendation: (b) to unblock M2 on the demo relay, labelled as demo scaffolding, and open a
substrate plan for (c). Removal of relay access on `remove member` rides on (c).

### G-2 Provisioning a new replica (blocks Start a group, New thread, rollover)

Each replica is its own relay instance with its own key and URL in the manifest. Plan 224's
catalogued and listed path exists but is operator-run. Until a self-service path exists, the
app ships with one pre-provisioned Group and a fixed thread set, and hides or explains the
create actions.

### G-3 Shared application layer (blocks nothing, saves duplication)

The Tauri workflow holds the verified-open, abilities and ceremony logic mobile needs. Lift it
into `lattice-shell-kit` behind custody and store ports (open decision O-1).

### G-4 Enrollment limits

Lift the 3-thread invitation cap toward the contract's 12, allow the moderator level in
`authorTreehouseAdmitAndGrant`, and decide the offer transport above one thread (O-4).

### G-5 Durable refusal

Persist the relay's refusal of an authored op so "relay did not accept" survives a restart
(O-6).

## Program-level conflict to resolve

[Plan 180](../../plans/180-group-first-roadmap.md) schedules iOS (Wave E) after E1, the
Android physical gate and pilot. Plan 296 starts with iOS. The operator started 296 on
2026-11-25, so this doc set treats 296 as a parallel demo track that makes no E1 claim; the
plan index should record that explicitly (open decision O-7).
