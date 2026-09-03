# Plan 177: Group-first antifragile re-aim

## Status

DRAFT program amendment. Operator decisions recorded 2026-09-01. Not a product, security,
availability or centerless-operation claim.

- **Priority**: P0 (program direction).
- **Effort**: M for the amendment and the AF-1 test. The AF-2 and AF-3 builds are not sized here.
- **Depends on**: `plans/158-real-device-beta-poc-program-map.md` (the map this amends) and
  `plans/175-succession-tick-provenance-spike.md` (receives the AF-2 decision).
- **Planned at**: `origin/main` `058310f7`, branch `claude/177-group-first-reaim`.
- **Lands with**: `apps/lattice_carrier_server/test/relay_reseed_test.exs` (AF-1), one added row
  in `plans/README.md`, and the `## Amendment 2026-09-01 (Plan 177)` section of Plan 158. No
  production source file changes.

## Intention

Build the most robust, antifragile system for groups under 150 people, tuned for roughly 9 to 15
members, whose one use case is a durable group chat over a member-operated relay. The relay is a
host, not a server-free design: it can read and can withhold (D1). Toolshed layers on that group with
the existing custody contract (Plan 158, Toolshed Custody v2 Semantic Repair) plus a trust layer
governed by D2 below. Extra features come later, and only after the AF gates hold.

## Objective

Record three changes to the program map and three operator decisions, and replace the CD1 gate with
loss gates that can be tested.

(a) **First product.** The Treehouse-shaped durable group is the first product. Township moves
behind it in both semantic and device delivery order (see the wave reorder below). Nothing in
`Township.Matter`, `Township.Election*` or the `/township` instrument is removed or reworked by
this plan.

(b) **Toolshed becomes a module of the group app**, not a third isolated app. This is an amendment
to the Plan 158 Product isolation contract, and it is not in force until an operator countersign
line is added to that contract, before Wave C. Until then the isolation table (app ID, deep-link
scheme, key service, database, signing alias) stands as merged. Isolation is retained at the
replica, catalog and manifest level in every case: a Tool replica keeps its own root, grant issuer,
route and service fingerprint (Plan 158, Toolshed Isolated Shell). Do not silently flip the merged
contract.

(c) **CD1 is no longer the target gate.** AF-1..AF-3 below replace it. Plan 150 host mode is
retained as a privacy option only: the served log is plaintext to the hosting device, and the D1
copy rule applies. Plan 152's LAN discovery item is dropped; QR image and deep link remain the only
offer carriers. The `TOWNSHIP_BUILD_MAP.md` §4a parked list is unchanged, and Plan 152's proposed
§4a un-parking edit is withdrawn.

## Why

- Plan 158 orders Township first because Township had the most real code. The operator's stated
  goal is a small durable group. Every Township beat (W0-W3) already runs on the same substrate,
  and the group product exercises it at lower stakes and higher op cadence.
- CD1 (Plans 150-152) targeted "no operator server in the loop" for a demo and remains unbuilt
  (TODO/BLOCKED in `plans/README.md`). It did not test what happens when the relay, the founder or
  a member device is destroyed. Antifragility is a loss claim, so the gates must be loss scenarios
  with a Sim oracle.
- The one-pagers already promise founder-loss survival and "nothing hosted". Today neither is
  true (AF-2, D1). Copy must follow evidence, not precede it.

## Operator decisions (2026-09-01)

### D1: plaintext

An operator-hosted relay keeps the Plan 158 Decision 3 copy: the relay can read matter content and
can deny liveness; E2EE is deferred (M3). A member-operated relay (Plan 150 host mode) may say that
its readers are members' devices only when it enumerates them: the relay host device and its OS
(including any administrator of that device), that device's backups, and every transport peer the
relay manifest admits (`trusted_peers`). Transport allowlisting is not semantic membership, so that
sentence holds only while the manifest admits current members and nothing else. The host can deny
service. No copy says "nothing hosted" while any relay persists plaintext, whatever the AF gates
say. Copy rule: every hosting sentence names who can read and who can withhold availability.

### D2: reputation

Facts, never scores. The trust layer renders and exports co-signed custody facts only: no numeric,
ranked or aggregated value of any kind. There is no push or broadcast of negative reputation. A
member's record is pull only and only with the subject present: the subject presents co-signed
receipts and signs a challenge with the same key that signed those receipts, and the verifier checks
both against the log. The subject can append a dispute op so the trail shows both sides. Scope is
within-shed only. Cross-shed portability is identity continuity across communities and stays behind
the M6 boundary. Copy rule: "the audit trail is the reputation"; never "score", "karma" or "rating".

### D3: volume

Thread rollover (archive a Thread replica, start a new one under the same Space) is the pilot
compaction policy. Production compaction stays excluded (`CLAUDE.md`). The instrument measures
per-thread op count and bytes against the existing 4,000-op / 8 MiB / 5-second thresholds from
Plan 158 (Treehouse Android Candidate and Two-Week Pilot; Program stop conditions) and shows the
rollover control when a thread nears them. Copy rule: rollover is described as archiving a thread,
never as deleting, compacting or forgetting history.

## Antifragility gates

Each gate is a loss scenario with `Lattice.Sim` as the oracle. Each carries an honest "today" line
that must be updated in this file when it changes.

### AF-1: relay loss

The relay process and its disk are destroyed. A member reseeds a new relay on a different path with
a different service identity (`LatticeCarrierServer.Runtime` `identity_file` / `log_file`) from
its retained state only: the log it obtained by pulling, plus the transport peer admission list
(realm ids and public keys) it already holds as pairing state. Nothing comes from the old server's
disk, and the peer list is not derivable from the log alone, since an admitted member that never
authored an op has no key in it. Every member keeps
its own local log between phases and pulls only what that copy lacks; all members reconverge with
zero loss of acknowledged ops and Sim-equal state and frontier. The negative control is narrow: a
relay reseeded from a stale member copy serves a strictly smaller op-id set than the oracle, the
missing ops are enumerable against the oracle and against a member copy that retained the
acknowledged op, and the reseeded relay's frontier is behind. Neither the relay nor the stale member
detects that gap on its own; a divergence-reporting path is not built or claimed here.

Today: landed with this plan as `apps/lattice_carrier_server/test/relay_reseed_test.exs`. It builds
on the Plan 142 durability contract (`LatticeCarrierServer.Holder`) and the restart precedent in
`apps/lattice_carrier_server/test/township_projection_test.exs`.

### AF-2: founder loss

The founder's device is destroyed. The group can still admit a member, revoke a delegation and
advance the beacon.

Today: FAILS by design. Beacons are honored only from the replica root (Plan 149,
`plans/149-delegation-lease-epoch-beacons.html`; `apps/lattice_core/lib/lattice/authority.ex`
moduledoc, "Delegation leases" bullet). Witnessed recovery in
`docs/adr/0004-succession-validation.md` covers a role's succession policy and not the root, and
adds no post-genesis witness rotation. Key rotation and recovery are excluded as M3. The design
choice (witness-set beacons and top-level grants pinned at genesis, versus delegated root powers) is
routed into the Plan 175 spike under its decision 4 ("Who must emit beacons"). No build here.

Decision 2026-09-03: the Plan 175 spike settled decision 4. Root-only beacons stay the default and
delegated single-key beacon power is rejected. The one in-bounds candidate is a witness set with a
threshold pinned at genesis, carried as a new body of the existing `:authority` op kind, and it is
opened as `plans/179-witnessed-beacons-af2-founder-loss.md` (effort L, risk HIGH) to be built and
tested, not because it is known to work: Plan 179 is proposed to test post-founder-loss beacon
advancement, and nothing about it may be claimed until its founder-removed Sim test is green and
merged. The spike also left the legacy self-asserted succession tick frozen and characterized
rather than repaired. Founder loss is still not survived, AF-2 fails until that test lands, and no
copy may claim otherwise before then.

One power this decision hands over, recorded here under D1 rather than discovered later. Epoch
advancement is the sole driver of Plan 149 lease lapse, so a beacon emitter can expire every
expiring delegation on the replica, and a single beacon at the canonical integer ceiling does it
permanently while stopping the clock for the life of the replica (reproduced in
`docs/research/succession_tick_provenance.md` section 6.6). Today only the founder's root key can
do this, and it already holds issuer-side revocation, so nothing is widened. Plan 179 widens it to
any threshold subset of the pinned witnesses, which is why it carries two bounds on the witnessed
epoch: a per-step ceiling pinned in the genesis beacon policy, and an absolute horizon fixed in both
runtimes as a protocol constant, below the canonical integer ceiling and not settable at genesis.
Neither bound removes the power inside the step. Any copy describing the witness set names
that power in the same sentence as the grant. Decision record:
`docs/research/succession_tick_provenance.md`.

AF-2's own wording needs one qualifier, recorded here so no later copy inherits the wider reading.
"Revoke a delegation" is provable after founder loss only for delegations whose issuer survives: a
revoke is honored from the delegation issuer or the replica root and from nobody else, so every
delegation the founder issued becomes permanently irrevocable once the founder realm is gone. The
only exit for such a grant is a witnessed epoch advance past its expiry, which exists only if the
grant was leased at issue time. A group that wants to be able to remove a founder-granted member
after founder loss must lease every founder-issued grant at genesis, and that is a creation-time
decision with no later repair. Plan 179 proves the narrowed clause and pins it with a negative
control; the unleased founder grant to a member who later turns hostile stays an open gate.

### AF-3: member device loss

A member with a new key rejoins and their history is linked to the new key by a group attestation
(a vouch signed by current members), not by rotation. The old identity is tombstoned; the vouch is a
fact in the log, not a score.

Today: no path. This is a design item; no build here. It must not become an M3 rotation ceremony or
a cross-community identity registry (M6).

## Plan 158 wave reorder

This text is mirrored in Plan 158, `## Amendment 2026-09-01 (Plan 177)`.

1. Wave A (A1, A2, A3) is unchanged.
2. After Wave A, run Treehouse Contract Correction and Treehouse Domain and Cross-Runtime Parity
   (formerly Wave D1), then the Treehouse shell, Android candidate and two-week pilot (formerly
   Wave D2), before the Township B waves (B1, B2). Treehouse reaches a device before Township does.
3. Toolshed Custody v2 Semantic Repair keeps its P0 and its position ahead of any Toolshed UI.
4. The Toolshed custody ledger read model is scheduled after custody v2 with zero new op kinds. Per
   member it derives transfers, on-time returns, open return requests with epoch age, and disputes
   from op presence, extending `apps/lattice_core/lib/toolshed/read_model.ex` across Tool logs. D2
   governs its output.
5. Treehouse Contract Correction must also correct the one-pager claims in
   `plans/treehouse_one_pager.html`: "founder loss does not orphan the space" (§3, Roles as Caps)
   to match AF-2 status, and "nothing hosted" (§3 storyline, §4 A3-lite) to match D1: that phrase is
   prohibited while any relay persists plaintext, independent of AF-3 status.
   `plans/toolshed_one_pager.html` carries the same "nothing hosted" phrase and falls under D1 when
   Toolshed copy is next touched.
6. Wave E (iOS) keeps its one-product-at-a-time rule after Android evidence stabilizes, but runs in
   Treehouse, Toolshed, Township order instead of the merged Township/Toolshed/Treehouse order.

## Scope

- This file; one added row in `plans/README.md`; one added section in Plan 158.
- The AF-1 test file named above.
- No change to `TOWNSHIP_BUILD_MAP.md`, the isolation table, any vector or any production source.

## Non-goals

Everything in the `CLAUDE.md` boundary list: no federation, cross-town identity or universal tally
(M6); no key rotation, recovery or E2EE (M3); no production compaction; no coercion-resistant
election, and `Lattice.Attestation.Stub` stays frozen and false; no ballots or credentials on
`Township.Matter`. In addition:

- no host migration (a reseed under AF-1 is a new relay, not a moved one);
- no availability claim of any kind;
- no cross-community identity registry;
- no score, rank, karma or aggregate of any kind;
- no new op kinds.

## STOP conditions

- Any numeric or ranked reputation value rendered or exported.
- Any broadcast or push of negative reputation.
- Any registry keyed on identity across communities.
- Any doc or copy claiming founder-loss safety before AF-2 and AF-3 pass, or saying "nothing
  hosted" or "serverless" while any relay persists plaintext.
- Any edit to an existing prose-pinned row or sentence in `plans/README.md` or
  `TOWNSHIP_BUILD_MAP.md` (`apps/lattice_core/test/township/audit_bundle_test.exs` and
  `apps/lattice_core/test/township/read_model_test.exs` pin them).
- Any change to product isolation without the operator countersign line in Plan 158.
- Any private key, seed or capability secret in a doc, fixture or test output.

## TDD plan

1. AF-1 RED/GREEN: `apps/lattice_carrier_server/test/relay_reseed_test.exs`, run from the
   repository root.

   ```sh
   cd apps/lattice_carrier_server && PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" ~/.asdf/shims/mix test test/relay_reseed_test.exs
   ```

2. DOCS: this plan, the README row and the Plan 158 amendment; the prose-pin suites stay green.
3. Remaining work items, in order (each is its own plan or a Plan 158 ticket):
   1. Treehouse Contract Correction (Plan 158 ticket, with the item 5 one-pager corrections);
   2. AF-2 decision via the Plan 175 spike, then its follow-on build plan;
   3. Toolshed custody ledger read model after Custody v2 (zero new op kinds, D2 output);
   4. Thread rollover policy in the instrument (D3), measured against the existing thresholds;
   5. Isolation countersign line in the Plan 158 Product isolation contract, before Wave C.

   AF-3 remains a design item and is scheduled only after AF-2 has a decision.

## Verification

| Command | Expected |
| --- | --- |
| AF-1 command above | green |
| `~/.asdf/shims/mix test apps/lattice_core/test/township/audit_bundle_test.exs apps/lattice_core/test/township/read_model_test.exs` (repo root, same `PATH`) | green; README and build-map pins intact |
| `git diff --name-only origin/main; git ls-files --others --exclude-standard` (repo root) | exactly `plans/177-group-first-antifragile-reaim.md`, `plans/README.md`, `plans/158-real-device-beta-poc-program-map.md` and `apps/lattice_carrier_server/test/relay_reseed_test.exs` |
| `grep -c $'\xe2\x80\x94' plans/177-group-first-antifragile-reaim.md` | `0` |

## Done criteria

- README row 177 present; Plan 158 amendment section present; no other README or Plan 158 line
  changed.
- AF-1 test green; AF-2 and AF-3 "today" lines truthful at merge time.
- The operator countersign line is still absent from the isolation contract; adding it is a later,
  explicit act.
