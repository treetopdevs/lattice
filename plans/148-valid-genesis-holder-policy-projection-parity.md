# Plan 148: Valid-genesis holder/policy projection parity (F2 prerequisite)

## Status

TODO - bounded predecessor to Plan 146. Do not add v7, participant authoring, Tauri custody, or
artifact behavior here.

Run after Plan 147 reaches exact-tip hosted closure so the two TypeScript authority corrections do
not overlap.

## Priority

**P0 for Plan 146** - Plan 147 closes capability/revocation decision-dependence but deliberately
defers the valid-genesis holder divergence at `authority.ts:188-197` versus
`authority.ex:497-503`. Plan 146 cannot ask a witness to sign an app-derived holder epoch or policy
until that projection is independently pinned to BEAM.

## Objective

Make one narrow TypeScript authority projection decision-exact against `Lattice.Authority`:

- which valid genesis operations contribute clerk acquisitions, in canonical order;
- which acquisition is the current clerk holder epoch;
- which effective valid-genesis witnessed policy applies after canonical policy merge;
- which valid genesis operation supplied that winning policy; and
- that a root-mismatched or otherwise invalid genesis contributes neither acquisition nor policy.

Expose the effective recovery-policy projection through the existing authority analysis boundary so
Plan 146 can build one public review helper without duplicating `collectPolicies` in the shell. The
server authority report remains an optional cross-check, never an input.

## Oracle Probe

Before changing TypeScript, author a deterministic Sim/exporter probe with:

1. a bound replica and legitimate root;
2. two canonically ordered, valid same-root genesis introductions for `:clerk`, with distinct
   witnessed-policy evidence;
3. one signed root-mismatched genesis that attempts to inject a holder and policy; and
4. exact exported BEAM acquisition timeline, current holder/acquisition op id, effective policy,
   winning policy genesis operation id, policy id, and quarantine reasons.

The expected live-code hypothesis is that BEAM records each valid genesis acquisition while the
current TypeScript `state.holder === null` guard records only the first. The probe, not this prose,
is authoritative.

## TDD Slices

Work one public seam at a time. Never run Mix commands concurrently; use the explicit asdf OTP 28
PATH from `AGENTS.md`.

1. **BEAM probe RED/GREEN.** RED exporter guard for the missing scenario and exact authority
   projection. GREEN only the deterministic Sim scenario/export fields. Regenerate vectors and
   require every pre-existing vector byte to remain unchanged.
2. **TypeScript conformance RED.** Assert acquisition timeline, current epoch, effective witnessed
   policy, winning policy genesis operation id, policy id, and rejected impostor contribution. The
   current reducer must fail for the characterized F2 difference.
3. **TypeScript projection GREEN.** Make the smallest `authority.ts` correction that matches the
   exported oracle. Return a read-only `recoveryPoliciesByRole` projection containing the policy and
   its winning genesis operation id from `AuthorityAnalysis`; do not export or duplicate the private
   collector itself.
4. **Load-bearing mutation.** Restore the old first-genesis-only guard or otherwise drop the later
   valid acquisition. The focused conformance assertion must fail, then restore GREEN.
5. **Authority-input independence guard.** Prove the projection accepts only independently verified
   operations/schema/order inputs and has no relay-report parameter or shell-side policy collector.
6. **Closure.** Build generated dist, run focused/full client gates, explicit OTP 28 `mix check`,
   both Sobelow scans, exact-worktree council review, commit/push, and exact-tip hosted flagship.

## Expected File Boundary

- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`
- focused exporter guard tests
- one new generated `clients/lattice-client/test/vectors/township_genesis_projection_parity.json`
- `clients/lattice-client/src/authority.ts`
- focused TypeScript conformance/carrier tests
- generated `clients/lattice-client/dist/**`
- this plan, `plans/README.md`, and the narrow authority claim wording in
  `TOWNSHIP_BUILD_MAP.md`

Any v7, LiveView, Tauri, native key, artifact, export, mobile, carrier protocol/server,
election/attestation, Phase F/M4, or deployment change is scope drift.

## Required Gates

- Exporter guard and generated vector prove the exact BEAM projection and invalid-genesis refusal.
- Pre-existing generated vector bytes remain unchanged.
- TypeScript conformance is RED before GREEN and the deliberate mutation is detected.
- `npm run conformance`, `npm run v01:guard`, `npm run carrier:township`, and
  `npm run carrier:township:live` are green.
- Typecheck/build and generated-dist equality are green.
- Full explicit-OTP-28 `mix check`, both boundary Sobelow scans, and `git diff --check` are green.
- Claude Opus reviews every RED/GREEN and correction. Codex and Antigravity review the oracle,
  projection GREEN, staged diff, and hosted result.
- Exact-tip hosted Unit + property, flagship artifact, and packaged macOS jobs are green.

## STOP Conditions

- Plan 147 is not `DONE`.
- The actual Sim probe differs from the hypothesis above; stop and rewrite this plan from the
  observed oracle before changing TypeScript.
- Going GREEN changes a pre-existing vector byte or any non-genesis authority result.
- The shell receives a second policy collector or trusts a relay report for holder/policy selection.
- A policy update, rotation, v7, artifact, native custody, or user-facing claim enters scope.

## Completion Claim

When `DONE`, Plan 148 may claim only:

> TypeScript independently reproduces BEAM's valid-genesis clerk acquisition timeline, current
> holder epoch, effective witnessed recovery policy, and winning policy genesis operation id,
> including rejection of root-mismatched policy injection, under a Sim-exported load-bearing parity
> vector.

It does not make the full TypeScript reducer decision-exact, add policy-update semantics, or open a
participant authoring surface. Plan 146 remains blocked until this plan and Plan 147 both close.
