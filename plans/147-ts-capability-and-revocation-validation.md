# Plan 147: Port capability and revocation validation into TS reduction (close the F1 decision gap)

## Status

IN PROGRESS - implementation, local gates, and council review are complete; exact-tip hosted CI
is the remaining closure gate.

The first Claude Opus RED review found that the draft's "concurrent use is honored" wording
contradicted `Authority.revoked_as_of?/5`. An explicit OTP 28 Sim probe confirmed that a command
concurrent with a valid revoke is quarantined `:revoked_capability` at the merged full frontier.
The corrected oracle contract below is authoritative for Slice 1.

Slice 1 GREEN evidence: the focused RED failed on the first absent vector; the corrected nine-vector
exporter and its full focused file pass 16 tests with zero failures; all 21 pre-existing checked
vector files remain byte-for-byte identical; exactly nine new vectors were generated. Claude Opus
returned `PROCEED` on the exact GREEN, then its only P2 (null cap versus the planned present unknown
id) was corrected test-first and independently re-reviewed `PROCEED`.

Slices 2-4 GREEN evidence: conformance first failed 45 checks (12 dropped-cap evidence checks plus
33 state/quarantine/reason checks). Retaining decoded command caps made all 12 evidence checks pass
without changing the 33 semantic failures; the shared authority projection, revoke fact, one-path
capability validator, and reason map then made the full corpus green. Typecheck, V-01 guard,
canonical bytes, in-memory carrier, and live OTP 28 carrier gates pass. Mutations that accepted an
invalid delegation, skipped visibility, or made an unauthorized revoke effective each produced
three focused conformance failures and were restored. Claude Opus returned `PROCEED` on the exact
GREEN with no P0-P1 finding.

Slice 5 GREEN evidence: the shell now materializes the just-durably-persisted retained frame set
locally and returns only that capability/revocation summary. A carrier state report is compared
only when its op-id set equals the local frame-id set; order and duplicate IDs are normalized,
non-`revoked_capability` reasons are outside the comparison, unequal evidence is ignored, and an
equal-evidence revoked-set mismatch fails with labeled `authority_report_divergence` without
adopting carrier IDs or attributions. RED pinned absent/throwing reports, unequal evidence,
same-evidence suppression/substitution/injection, duplicate/reordered report IDs, non-revoked
reason scope, durable persistence, and non-adoption. Focused sync, 42 frontend source checks
(31 pass, 11 intentional skips), Vue typecheck, and reactive feed pass. The complete local
`npm run app:convergence` chain passes through stable-relay onboarding, v1-v6 packaged handoffs,
reactive feed, and installed deep-link delivery. OTP 28 `mix verify` and both Sobelow scans pass.
Claude Opus returned `PROCEED` on the corrected RED and exact GREEN with no P0-P1 finding.

## Priority

**P0** — this is the same class as Plan 140's V-01 prime directive. The TS client is
byte-exact but not decision-exact: its semantic reduction materializes command ops that
the Sim oracle quarantines for capability reasons. Do this before any new action-ladder
version (v7) or any surface that lets a TS realm render "accepted" state to a user.

## Findings this plan fixes (evidence, Round 4 review 2026-07-15)

**F1 — capability and revocation enforcement is entirely absent from TS reduction.**

The oracle quarantines a command op unless its capability passes six checks
(`apps/lattice_core/lib/lattice/authority.ex` — `validate_command/7` at ~`:706` calling
`cap_ok/7` at ~`:759`):

- `:no_capability` — `op.cap` names no collected delegation
- `:invalid_capability` — the named delegation failed id/signature validation
- `:capability_wrong_audience` — `op.author != delegation.audience`
- `:operation_not_granted` — the command is not in `delegation.ops`
- `:capability_not_visible` — no intro of the delegation is in the op's ancestors
- `:role_not_granted` — a role required by the command's mutations is not in `delegation.roles`
- `:revoked_capability` — `revoked_as_of?/5`: a valid revoke of the delegation (or any
  ancestor in its parent chain, `delegation_chain_ids/2`) exists that the op is not
  causally before

plus the revoke side (`collect_revokes/3` at ~`:457`): a revoke is *effective* only if
`revoke_authorized?/4` (author is the delegation's issuer or the bound root); an
unauthorized revoke is itself quarantined `:unauthorized_revoke` (~`:450`) **and**
excluded from effective revokes — the symmetry that keeps quarantine sets identical
across replicas.

The TS side has no counterpart to any of this:

- the semantic `Op` drops the capability: `clients/lattice-client/src/op.ts` has no `cap`
  field; `assertCarrierOpFrame` (`clients/lattice-client/src/carrier.ts:1111`) checks only
  `Array.isArray(op.cap)` and the decode path never carries it into reduction
- `revoke` decodes to an inert `neutralPayload` (`clients/lattice-client/src/carrier.ts:1099-1100`)
- `isQuarantined` (`clients/lattice-client/src/quarantine.ts`) implements only the holder
  rules (`:not_holder` / `:stale_holder`) for authority-gated fields

**Executed counterexample class:** any keypair authors a validly signed
`{post, [...]}` command whose `cap` names a nonexistent or unattenuated delegation. Sim
quarantines it (`:no_capability` / `:operation_not_granted`); the TS reducer materializes
the post. Every non-role-gated Township command (`post`, `set_title`, `set_summary`,
`admit`, …) is reachable this way.

**Decision-dependence residual:** the shell papers over the gap by reading
`revoked_capability` attribution from the *server's* authority state report
(`clients/township-tauri-shell/src/township_sync.ts:290-302`,
`authorityRevokedCapabilitySummaryFromState`). That is decision-dependence on the relay,
not decision-exactness against the oracle — it quietly weakens the untrusted-relay trust
model that every plan since 127 has been careful to preserve.

## Objective

After this plan, TS semantic reduction quarantines **exactly the same command ops for
exactly the same capability/revocation reasons** as `Lattice.Authority`, decided locally
from independently verified evidence (the Plan-140 validated delegation set), and the
parity is defended by Sim-exported adversarial vectors that fail CI on drift — not by
review. The server state report becomes a cross-check, never the source of a local
acceptance decision.

## Oracle semantics to port (normative checklist)

Port these behaviors exactly; where TS behavior is ambiguous, author a Sim probe first
(see STOP conditions):

1. Capability resolution keys off the delegation **id** carried in `op.cap`, resolved
   against the same collected-delegation map that Plan 140's `analyzeAuthority` already
   builds with verified ids and signatures. Do not build a second delegation store.
2. Check order matters for reason parity: lookup → validity → audience → ops → visibility
   → roles → revocation (`cap_ok/7`). Emit the oracle's reason names.
3. Visibility means: at least one op that *introduced* the delegation is in the command
   op's ancestor set (`deleg_ops` ∩ `ancestors(op)` ≠ ∅).
4. `roles_needed` derives from the command's mutations via the replica schema
   (`mutation_roles/2` — fields declared `authority:` contribute their role); commands
   touching no authority field need no roles but still need every other check.
5. Revocation is causal, not temporal: a delegation is revoked *as of* op O iff an
   effective revoke of any id in its parent chain exists with O ∉ ancestors(revoke).
   A use causally before the revoke is honored; concurrent and causally-later uses are
   quarantined.
6. Revoke authorization: issuer-or-root. Unauthorized revokes are quarantined
   `:unauthorized_revoke` AND ineffective. Both halves, always together.
7. Tombstone symmetry sanity: `:unauthorized_tombstone` (root-only) is already handled —
   do not disturb it; add a regression assertion.

## Scope

### Included (five fenced slices, each RED → GREEN → gates)

**Slice 1 — Sim-exported adversarial capability corpus.**
Extend `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (`scenarios/0`) with
new fixed vectors, one per reason, each with exporter guard tests pinning the oracle's
quarantine reason, final state, and (where relevant) holder result:

- `township_capability_missing` — garbage `cap` id → `:no_capability`
- `township_capability_invalid` — `cap` names a collected delegation whose canonical id/signature
  validation fails → `:invalid_capability`
- `township_capability_wrong_audience` — Bob authors with Alice's delegation → `:capability_wrong_audience`
- `township_capability_operation_not_granted` — delegation grants `{post}` only, op is `set_title` → `:operation_not_granted`
- `township_capability_not_visible` — op's deps exclude every intro of its delegation → `:capability_not_visible`
- `township_capability_role_not_granted` — role-gated command (`set_status`-class) with role-less delegation → `:role_not_granted`
- `township_capability_revoked_causal` — one causally-before use is honored, one concurrent use is
  quarantined `:revoked_capability`, and one causally-later use is quarantined
  `:revoked_capability` in the same vector — pins the causal, not temporal, semantics
- `township_capability_revoked_chain` — revoke of a *parent* delegation quarantines use of the child (`delegation_chain_ids` coverage)
- `township_revoke_unauthorized` — Mallory revokes Alice's delegation → revoke op quarantined
  `:unauthorized_revoke`; Alice's command explicitly depends on that bad revoke and is still
  honored, proving the revoke is excluded from effective revokes

Regenerating the corpus (`MIX_ENV=test mix lattice.export_vectors --out
clients/lattice-client/test/vectors`, as `.github/workflows/flagship.yml:115` does) must
change **no pre-existing vector bytes** — only add fixtures. That invariant held for every
Plan-140 checkpoint; keep it.

**Slice 2 — carry the capability into TS semantic reduction.**
Retain `cap` (delegation id, decoded from the carrier frame's `cap` term) and the decoded
command name on the semantic `Op` (`clients/lattice-client/src/op.ts`,
decode in `clients/lattice-client/src/carrier.ts`). Follow the Plan-140 outer-replica
pattern: the field is additive; a command op reaching capability validation *without*
retained cap evidence fails closed (quarantine, loud reason), it does not default to
accepted. Persisted semantic JSON authored before this slice must be re-decoded from
retained carrier evidence — same rule as the outer-replica checkpoint.

**Slice 3 — `capability.ts`: the ported validator.**
First deepen `AuthorityAnalysis` with one read-only security projection from its existing pass:
collected delegation id → canonical delegation/invalid status/introduction op ids, resolved root,
and effective authorized revoke facts. This is the single shared store consumed by authority and
capability decisions; do not recollect those facts in `capability.ts`.

New module `clients/lattice-client/src/capability.ts` implements §Oracle semantics 1–6
over that projection, plus revoke decoding: replace the
`neutralPayload` at `carrier.ts:1099-1100` with a real revoke fact
(`{ type: "revoke", delegationId }`) consumed by the validator. Wire it into the same
reduction pass that calls `isQuarantined` (`clients/lattice-client/src/materialize.ts`) so
there is still exactly ONE quarantine decision path. Capability validation runs for every command
operation, including commands that touch no authority-gated field; holder-field validation remains
one later part of that same path rather than the condition for entering it. Synchronous,
browser-compatible, no new runtime import cycles — same constraints Plan 140 held.

**Slice 4 — conformance and carrier gates assert reason parity.**
`clients/lattice-client/test/conformance.ts` gains state + quarantine-set + reason
assertions for all nine new vectors; `npm run carrier:township` and
`npm run carrier:township:live` re-assert quarantine parity for capability scenarios the
same way they assert authority parity today. Randomized vectors
(`township_random_*`): extend the exporter's generator so random scenarios can emit
capability-violating ops, then regenerate ONLY if the corpus-stability STOP below is
honored (new seeds as new files beats mutating existing ones).

**Slice 5 — the shell stops trusting the relay's answer.**
`authorityRevokedCapabilitySummaryFromState` (`township_sync.ts:290-302`) becomes a
cross-check: compute the summary locally from Slice-3 reduction, compare against the
server report when one is available, and on mismatch fail closed (surface a labeled
divergence, never adopt the server's accept). The server report is no longer consulted at
all for whether an op materializes.

### Explicitly deferred (do not let this plan absorb them)

- **F2** genesis-honoring divergence (`authority.ts:188-197` vs `authority.ex:497-503`) —
  owned by bounded Plan 148 after this plan closes; touching it here risks re-opening Plan 140
  ground and overlapping the capability correction.
- **F3** `or_set` materialized ordering and **F4** `causal_list` delete — separate small
  parity plans; different blast radius (state bytes, not quarantine decisions).
- **N1** review-UI consent fidelity, **N2** relay hardening — separate plans.
- Any wire change: operation wire v1 already carries `cap`; this plan only stops
  *dropping* it client-side.
- Any new action-ladder version or user-facing surface.

## Execution sequence (bite-sized; RED before GREEN, commit per green slice)

Toolchain: run mix as `~/.asdf/shims/mix` with the OTP 28/Elixir 1.19 `PATH` prefix per
`AGENTS.md`; run TS via the package scripts (never the recursing `npm` wrapper for ad-hoc
binaries — use `node_modules/.bin/` directly if needed).

1. **Slice 1 RED:** write exporter guard tests for the nine vectors in
   `apps/lattice_core/test/` beside the existing forged-authority exporter tests. Run
   `~/.asdf/shims/mix test apps/lattice_core/test --only export_vectors` (or the file
   path) — expect failures naming missing scenarios.
2. **Slice 1 GREEN:** implement the scenarios in `lattice.export_vectors.ex`; rerun; then
   `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors`
   and `git diff --stat clients/lattice-client/test/vectors` — expect ONLY new files.
   Commit.
3. **Slice 4-RED (deliberately early):** add the conformance assertions for the new
   vectors now. `npm run conformance` in `clients/lattice-client` must fail with the TS
   client *honoring* ops the oracle quarantines — this is the executable statement of F1.
   Commit the RED assertions only if your loop tolerates a red gate on the branch;
   otherwise keep them staged and fold into the Slice-3 commit.
4. **Slice 2:** retain `cap`/command on the semantic op; `npm run typecheck`,
   `npm run canonical` (bytes must be untouched — decode-side change only). Commit.
5. **Slice 3 GREEN:** implement the shared `AuthorityAnalysis` security projection,
   `capability.ts`, and revoke fact; `npm run conformance`,
   `npm run v01:guard`, `npm run carrier:township`, `npm run carrier:township:live` all
   green. Three deliberate mutations (treat an invalid delegation as valid; skip the visibility
   check; treat unauthorized revoke as effective) must each turn at least one vector red — record
   all three. Commit.
6. **Slice 5:** shell cross-check; shell vitest + `npm run feed:app:contract` +
   full local `npm run app:convergence`. Commit.
7. Full `~/.asdf/shims/mix verify` (OTP 28), both Sobelow scans, then the hosted flagship
   run — all three jobs — before marking DONE.

## Required gates

- Exporter guard tests green; corpus regeneration byte-stable for pre-existing vectors.
- `npm run conformance` asserts state + quarantine + reason for all nine new vectors.
- `npm run v01:guard`, `npm run canonical`, `npm run carrier:township`,
  `npm run carrier:township:live` green.
- All three deliberate mutations are detected by the corpus (not by a hand test).
- Shell gates: vitest, reactive feed contract, complete local `npm run app:convergence`.
- Full `mix verify` green; hosted flagship run green across all three jobs at the exact
  closure tip.
- Claude (or equivalent) exact-diff RED and GREEN reviews return `PROCEED`, per the
  Plan-140 loop discipline.

## STOP conditions

- **Oracle surprise:** if Sim's actual behavior on any vector differs from this plan's
  §Oracle semantics (Plan 140 hit exactly this — Sim structurally accepts a self-issued
  non-genesis delegation), STOP, pin the oracle with an exporter probe test, correct the
  plan text, and only then write TS code. Never "fix" the oracle from the client side.
- **Corpus mutation:** if going green requires changing bytes of any pre-existing
  checked-in vector, STOP and escalate — that means the port changed behavior outside the
  capability seam.
- **Plan-140 regression:** if any change weakens the validated authority pass
  (`analyzeAuthority`) or re-introduces a `REFUSED_PENDING_*`-style blanket refusal as a
  shipping state, STOP.
- **Persistence break:** if retaining `cap` on the semantic op forces a persisted-JSON
  migration the Plan-141 exclusive-writer layer cannot express as reload-and-union, STOP
  and record the migration design before proceeding.

## Non-claims

- No receipt-freeness, coercion-resistance, or M4 claim; the election path is untouched.
- No fix for F2 (genesis parity, owned by Plan 148), F3 (`or_set` ordering), F4
  (`causal_list` delete) — the
  TS client is NOT claimed fully decision-exact until those close; this plan closes the
  capability/revocation class only.
- No server/relay behavior change; no new push semantics; no participant custody change.
- No claim that the randomized corpus exhaustively covers capability interleavings —
  coverage is the nine named adversarial shapes plus whatever the generator gains.

## Implementation files

- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` — nine scenarios + guards
- `apps/lattice_core/test/` — exporter guard tests (beside existing authority-vector tests)
- `clients/lattice-client/src/op.ts` — additive `cap` / command retention
- `clients/lattice-client/src/carrier.ts` — decode retention; real revoke fact (~`:1099`)
- `clients/lattice-client/src/authority.ts` — expose the existing pass's verified delegation/root/
  effective-revoke projection without a second collector
- `clients/lattice-client/src/capability.ts` — NEW: the ported validator
- `clients/lattice-client/src/materialize.ts` — wire validator into the single quarantine path
- `clients/lattice-client/test/conformance.ts`, `test/carrier.ts`, `test/live_carrier.ts`
- `clients/lattice-client/test/vectors/township_capability_*.json`,
  `township_revoke_unauthorized.json` — NEW fixtures (Sim-exported, never hand-authored)
- `clients/township-tauri-shell/src/township_sync.ts` — cross-check, fail-closed divergence

## Completion claim

When done, this plan may claim exactly: "TS semantic reduction locally enforces the
oracle's capability and revocation semantics (`no_capability`, `invalid_capability`,
`capability_wrong_audience`, `operation_not_granted`, `capability_not_visible`,
`role_not_granted`, `revoked_capability`, `unauthorized_revoke` — including causal
revoked-as-of and parent-chain revocation), decided from independently verified evidence
and defended by Sim-exported adversarial vectors in CI; the shell consumes the server
authority report only as a fail-closed cross-check." Update the Plan 147 row in
`plans/README.md` and note the remaining F2/F3/F4 parity gaps there.
