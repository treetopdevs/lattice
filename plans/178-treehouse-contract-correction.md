# Plan 178: Treehouse Contract Correction

## Status

DRAFT ticket execution. Documentation plus one copy-contract test. Not a product, security,
availability, E2EE, founder-loss or centerless-operation claim.

- **Priority**: P0 (Plan 158 ticket "Treehouse Contract Correction"; Plan 177 wave-reorder item 5).
- **Effort**: S.
- **Depends on**: `plans/158-real-device-beta-poc-program-map.md` and
  `plans/177-group-first-antifragile-reaim.md`.
- **Planned at**: `origin/main` `5de862a7`, branch `claude/178-treehouse-contract`.
- **Lands with**: `apps/lattice_core/test/treehouse/contract_test.exs`, the corrected
  `plans/treehouse_one_pager.html`, one added row in `plans/README.md` and one added status
  paragraph in Plan 158. No production source file changes.

## Objective

Freeze the text-only Treehouse beta contract (command vocabulary, conflict rules, roles, hosting,
founder loss, invitations, history and beta exclusions) as the single spec later agents build from,
correct every one-pager claim that the contract contradicts, and pin both by test so the copy cannot
drift back ahead of the evidence.

## Why

- Plan 158 ticket text: the M2 substrate exists but the product runtime and deployment are missing;
  invites carry no use limit and are not bearer links; the pilot relay keeps a plaintext log that
  its operator, or for a member-operated relay the host device and its OS including any
  administrator, that device's backups and every transport peer the relay manifest admits, can
  read; that host can withhold availability; and the relay can neither decide semantic authority
  nor erase device-held history.
- Plan 177 D1: every hosting sentence names who can read and who can withhold availability. Plan 177
  AF-2 fails today, so no copy may promise founder-loss safety.
- The one-pager still carries the July 2026 claims. Copy must follow evidence, not precede it.

## Frozen contract

Later Treehouse plans (Domain and Cross-Runtime Parity, TS Realm and Isolated Shell, Android
Candidate and Two-Week Pilot) implement this text and may not widen it without amending this file.

### Command vocabulary

Post bodies are text: no media, reactions, polls or attachments. The command set is frozen to
exactly the following commands, in exactly this order, and Elixir and TypeScript identifiers must
map one-to-one onto it.

Space commands:

- `create space` pins the name, the admin holder and the witnessed succession policy in genesis.
- `create thread` takes a title, runs the catalog provisioning saga, and publishes the
  capability-authorized Thread reference on the Space only after its route is ready; the new
  reference, route and grants then propagate to existing members.
- `issue invitation` mints one recipient-bound invitation with one signed ID and one recipient,
  scoped to the Space and the current Thread catalog.
- `revoke invitation` closes one outstanding invitation.
- `admit member` signs the exact-audience Space and current-Thread membership grants for the
  recipient of an accepted invitation, at the member or moderator level.
- `remove member` revokes Space and Thread grants and transport admission, exposing
  `removal_pending` until reconciliation completes.
- `transfer admin` moves the admin holder.
- `change moderator` grants or transfers a moderator role; its authority-field effect makes the
  whole command holder-gated.
- `revoke grant` revokes one grant, including a moderator grant.
- `witnessed succession` follows the witness set, threshold and evidence rules pinned in genesis;
  dormant-tick succession is not enabled, and the mobile ceremony is hidden in the first beta.

Thread commands:

- `post` appends one text post.
- `author edit` replaces the body of the author's own honored post.
- `author tombstone` tombstones the author's own honored post.
- `moderator tombstone` tombstones a post through a distinct moderator-holder-gated command.

### Conflict rules

Concurrent edits resolve by the existing canonical op ordering. A causally visible tombstone is
irreversible and wins over every edit. One signed command yields one op ID, one DAG node, one
authorization decision, one quarantine decision and one ordered `effects[]`; an existing singular
effect normalizes to a one-element array, and the signed command bytes determine the complete
ordered array in both runtimes. Validation and reduction are all-or-none, so a malformed,
unauthorized or application-invalid effect applies none of them. Status inspection reads only the
causal `context.visible_ops` and `context.verdicts`. Every referenced post or edit in the target
lineage must be honored, belong to the same Thread and carry the right kind, so an authorized edit
cannot launder a quarantined lineage into visibility. The application-denied IDs union with
authority quarantine before either reducer runs.

Application denial reasons are pinned in exactly this order:

- `missing or not-causal target`
- `quarantined target`
- `wrong target kind or thread`
- `wrong author`
- `already tombstoned`

### Roles

The role set is frozen to exactly, in this order:

- `admin`
- `moderator`
- `member`

Authority is a revocable, transferable per-field capability, never a role row in a database. An
author edit or tombstone must be signed by the honored root post's author; a moderator tombstone is
holder-gated by its authority effect. Stale-holder ops are quarantined and stay visible in the
audit; concurrent transfers by one holder resolve by canonical order.

### Hosting and plaintext

The relay is a plaintext host: its operator, or for a member-operated relay the host device and its OS including any administrator, that device's backups and every transport peer the relay manifest admits, can read the log; the host can withhold availability; and the relay cannot decide semantic authority or erase device-held history.
Transport allowlisting is not semantic membership, so the member-operated reader list holds only
while the manifest admits current members and nothing else. Relay loss is the AF-1 gate and holds
today; a relay reseeded from a stale member copy serves a strictly smaller op set and nothing
detects that gap on its own.

### Founder loss

Founder loss is not survived today: AF-2 fails because beacons are honored only from the replica root, witnessed recovery covers a role and not the root, and key rotation and recovery are M3; manual admin transfer is the only handoff the first beta claims.
The AF-2 design decision is routed into the Plan 175 spike; no build here. Member key loss is the
separate AF-3 design item: social re-admission by group attestation is the intended answer and no
path is built today.

### Invitations

An invitation is recipient-bound and has one signed ID and one recipient; replay is idempotent, rebinding is quarantined, and revocation closes it; it is not a bearer link and carries no expiry or use-limit claim.
The joiner creates its own keys; the admin admits the transport key and signs exact-audience grants.
No bearer authority or secret crosses the QR image or deep link.

### History and volume

History is device-held and replayable; thread rollover, archiving a thread and starting a new one under the same Space, is the pilot volume policy against the 4,000-op / 8 MiB / 5-second thresholds, and no safe-unbounded-history claim is made.
The first beta allows at most 12 Thread replicas per Space (Plan 158 Decision 8), so each rollover
consumes one of those slots; the cap is a catalog limit, not a history-forgetting rule.
Rollover is described as archiving a thread, never as deleting, compacting or forgetting history.
Production compaction stays excluded.

### Beta exclusions

The first beta excludes exactly, in this order:

- `notifications`
- `background delivery`
- `media`
- `reactions, votes and polls`
- `bots and integrations`
- `federation and cross-space identity` (M6)
- `E2EE` (M3)
- `automated recovery and key rotation` (M3)
- `the 60-day multi-community exit gate`
- `invite use limits and bearer invites`
- `founder-loss survival` (AF-2)
- `any availability guarantee`
- `production compaction`
- `receipt-free anything` (`Lattice.Attestation.Stub` stays frozen and false)

## One-pager corrections

Old claims are quoted in code spans. The contract test exempts exactly those quoted old claims and
the authoritative prohibited-phrase paragraph near the end of this file; every other code span here
is scanned as ordinary prose.

| Line | Old claim | Corrected claim | Rule |
| --- | --- | --- | --- |
| 131 | `durable, uncapturable community spaces`, `shipped on M1+M2 alone` | durable, member-held community spaces; a planned cut resting on already-green M1 behaviors plus the M2 carrier, with the product runtime and deployment named as not built | D1, 158 ticket |
| 143 | `because there is no server to do any of those things to`, `Everything user-facing runs on` | a relay keeps a plaintext copy; its readers and the withholding host are named; the planned cut rests on green M1 behaviors plus the M2 carrier while its runtime and deployment are named as not built | D1, 158 ticket |
| 165 | `no one can take this from you` | records their members hold themselves; no guarantee restated | D1 |
| 171 | `the record survives every device dying but one` | only the record that phone had already synced | AF-1 |
| 180 | (none) | honesty note: corrected 2026-09-03 under Plan 178 | 177 item 5 |
| 185 | `there is no landlord` | history is device-held; the relay host can read and withhold, not erase; rollover thresholds stated | D1 |
| 186 | `no coordinator` as a whole-system claim | only conflict reduction is coordinator-independent; transport runs through the hosted relay | D1 |
| 190 | `does not orphan the space` | the founder-loss sentence above; manual admin transfer only | AF-2 |
| 200 | `TTL'd, use-limited capabilities` | the invitation sentence above | 158 shell ticket |
| 201 | relay holds the plaintext log | the same sentence naming its readers and the withholding host | D1 |
| 206 | `nothing hosted` | relay named; the same full reader enumeration and the withholding host named | D1 |
| 210 | `survive intact on the last phone` | device-held history to the extent synced; relay readers and withholding host named | AF-1 |
| 235 | `nothing hosted, nothing to seize` | the hosting sentence above; AF-1 holds today | D1 |
| 236 | `Coordinator-free` | deterministic conflict reduction needs no coordinator; the host is named | D1 |
| 252 | `BLOCKING` M2 status | substrate present; product runtime and deployment missing | 158 ticket |
| 253 | `key loss resolves socially` as the M3 answer | member key loss is AF-3 with no path built today; founder/root key loss is AF-2 and fails today | AF-2, AF-3 |
| 261 | reactions, votes and polls as Treehouse ops | reactions, votes and polls are absent from the first beta | 178 vocabulary |
| 262 | `social re-admission is the documented answer` | social re-admission is the intended answer (AF-3, not built) | AF-3 |
| 265 | readable by every member | readable by every member and by the named relay readers, whose host can withhold availability | D1 |
| 272 | `zero server dependency` | relay is a plaintext host with the same full reader enumeration and the withholding host named, and that the core loop tolerates losing (AF-1) | AF-1, D1 |

## Scope

- This file; the one-pager edits above; the contract test; one added README row; one added Plan
  158 status paragraph.
- No change to `TOWNSHIP_BUILD_MAP.md`, `plans/toolshed_one_pager.html`, any vector, fixture or
  production source.

## Non-goals

Everything in the `CLAUDE.md` boundary: no federation, cross-town identity or universal tally (M6);
no key rotation, recovery or E2EE (M3); no production compaction; no coercion-resistant election,
and `Lattice.Attestation.Stub` stays frozen and false; no ballots or credentials on
`Township.Matter`. No Elixir or TypeScript domain code, no shell, no device evidence, no AF-2 or
AF-3 build.

## STOP conditions

- Any sentence in this file or the one-pager that hosts nothing, has no relay to lose, promises
  founder-loss safety, an availability guarantee, E2EE, a bearer or use-limit invite, or safe
  unbounded history. The test's prohibited list is authoritative.
- Any hosting sentence that omits who can read or who can withhold availability.
- Any edit to an existing line of `plans/README.md`, Plan 158 or `TOWNSHIP_BUILD_MAP.md`.
- Any private key, seed or capability secret in a doc, fixture or test output.
- Any em-dash in this file.

## TDD plan

1. RED: add `apps/lattice_core/test/treehouse/contract_test.exs` (`Lattice.Treehouse.ContractTest`,
   `async: true`, `@repo_root Path.expand("../../../..", __DIR__)`). For the one-pager it scans the
   visible text in both a tag-joined and a whitespace-normalized form, plus every HTML comment and
   every attribute value, after decoding named, decimal and hex entities, and refutes every
   prohibited phrase; it then asserts the required corrected sentences. For this plan it removes
   exactly the quoted old claims and the authoritative prohibited-phrase paragraph, normalizes
   whitespace, and refutes the same phrases; it asserts the required contract sentences and
   headings and the exact ordered command set, denial precedence, role set and beta-exclusion set.
   It also asserts the README row 178 string and a whitespace-tolerant match for the Plan 158
   status paragraph.
   Run it against the unedited files and keep the failure output as RED evidence.
2. GREEN: apply the one-pager edits, add the README row and the Plan 158 paragraph.
3. Prose-pin suites stay green.

## Verification

| Command | Expected |
| --- | --- |
| `~/.asdf/shims/mix test apps/lattice_core/test/treehouse/contract_test.exs` (repo root, OTP 28 `PATH`) | green |
| `~/.asdf/shims/mix test apps/lattice_core/test/township/audit_bundle_test.exs apps/lattice_core/test/township/read_model_test.exs` | green; existing pins intact |
| `git diff --name-only origin/main; git ls-files --others --exclude-standard` | exactly the five files in Scope |
| `grep -c $'\xe2\x80\x94' plans/178-treehouse-contract-correction.md` | `0` |

Prohibited phrases (case-insensitive, listed in code spans so this file passes its own scan):
`nothing hosted`, `serverless`, `no server to`, `nothing to seize`, `use-limited`,
`does not orphan`, `zero server dependency`, `guaranteed availability`, `there is no landlord`,
`uncapturable`, `ttl'd`, `no registry to scrape`, `cannot be deleted, paywalled`.

## Done criteria

- README row 178 present; Plan 158 status paragraph present; no other README or Plan 158 line
  changed; `TOWNSHIP_BUILD_MAP.md` untouched.
- Contract test green with RED evidence recorded in the PR.
- Every hosting sentence in the one-pager and this file names readers and the withholding host.
