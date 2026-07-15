# Plan 145: Genesis-pinned witnessed succession recovery

## Status

IN PROGRESS - the BEAM certificate, authority/Sim path, adversarial suite, TypeScript cross-oracle,
signature mutation, and exact-tip implementation CI are green. Claim-boundary documents still need
their own exact-tip hosted closure before this plan becomes `DONE`.

Planned against commit `1a086e203b2a8d25fdc6284a219b751625dc6163` on
`codex/township-build-map`, after Plan 144 and its exact-tip hosted closure are green.

## Objective

Replace unilateral successor assertion with an opt-in, genesis-pinned recovery authorization
floor while preserving deterministic replay and every existing legacy succession vector:

- a valid genesis pins a recovery witness set and threshold for one role;
- a witnessed succession is honored only when a threshold of distinct pinned witnesses signs one
  domain-separated claim bound to the replica, role, exact current-holder acquisition epoch,
  current holder, designated successor, and exact recovery policy;
- malformed, unknown, duplicate, invalid-signature, subthreshold, and replayed certificates remain
  in the log but are authority-quarantined with deterministic reasons; and
- BEAM and TypeScript independently verify the same certificate and reduce the same checked vector.

This plan authorizes a governance recovery event. It does not prove elapsed time, physical holder
absence, network failure, witness independence, witness honesty, or coercion resistance. Automatic
tick-based dormancy remains a legacy characterized POC mode and is not made trustworthy here.

## Trust-Model Decision

Plan 144 proved that absence cannot be derived from the current successor-authored tick. A fresh
adversarial review compared carrier liveness, process-local logical time, causal activity, one
recovery signer, m-of-n witnesses, and removing production succession.

The review rejected three tempting shortcuts:

- carrier connection state would make a transport server semantic authority and cannot distinguish
  partition from failure;
- `Lattice.Clock` or a successor counter is unilateral process state, not shared evidence; and
- counting distinct log authors is Sybil-defeated because Lattice identities are free and log
  admission is structural. Counting only honored commands would also make the authority timeline
  depend on command validation, which already depends on the authority timeline.

The selected first floor is explicit governance: a root-signed genesis policy pins the only keys
whose recovery attestations count. A quorum raises the attack from one conflicted successor to the
configured threshold. It still does not prove absence; witnesses assert that recovery is authorized.

## Wire And Policy Contract

### Opt-in genesis policy

Legacy policies remain byte-for-byte unchanged:

```elixir
%{successor: successor_pubkey, dormant_ticks: n}
```

The new opt-in policy is:

```elixir
%{
  successor: successor_pubkey,
  recovery: %{
    mode: :witnessed,
    version: 1,
    witnesses: [witness_pubkey, ...],
    threshold: m
  }
}
```

The witness list is sorted by raw public-key bytes for policy identity and verification. A policy
is invalid when the version/mode is unsupported, a witness is malformed or duplicated, or
`threshold` is outside `1..length(witnesses)`.

The effective policy for a role remains the existing `collect_policies/3` result: valid genesis
policies are visited in canonical DAG order and merged, with the last valid entry for that role
winning globally. Plan 145 does not introduce policy-update semantics or make policy selection
causal to the succession op. The certificate must match that effective policy exactly. A future
policy-migration design must revisit this existing global-genesis behavior before exposing recovery
authoring.

### Versioned succession proof

The existing body stays unchanged for legacy tick mode:

```elixir
{:succeed, role, delegation, at_tick}
```

Witnessed mode uses the same authority event with an explicitly tagged proof:

```elixir
{:succeed, role, delegation, {:witnessed, certificate}}
```

The certificate is a canonical plain map so the existing canonical and carrier term codecs carry
it without a new struct tag:

```elixir
%{
  claim: %{
    version: 1,
    replica: replica_id,
    role: role,
    holder: current_holder_pubkey,
    holder_epoch: current_holder_acquire_op_id,
    successor: successor_pubkey,
    policy_id: recovery_policy_id
  },
  signatures: [%{witness: witness_pubkey, signature: signature}, ...]
}
```

Each witness signs exactly:

```elixir
Lattice.Canonical.term(["lattice-succession-witness-v1", claim])
```

The claim uses these exact canonical types:

- map keys are atoms;
- `version` is a non-negative integer;
- `replica`, `holder_epoch`, and `policy_id` are binaries containing their string values;
- `role` is an atom;
- `holder` and `successor` are raw Ed25519 public-key binaries; and
- each signature entry has atom keys with raw witness/signature binaries.

TypeScript must reconstruct signing bytes from the retained raw carrier terms so it cannot erase
the atom/binary/integer distinctions while mapping public keys to diagnostic realm names.

`policy_id` is exactly:

```elixir
recovery = %{
  mode: :witnessed,
  version: 1,
  witnesses: Enum.sort(witness_pubkeys),
  threshold: m
}

recovery
|> then(&Lattice.Canonical.term(["lattice-recovery-policy-v1", &1]))
|> then(&:crypto.hash(:sha256, &1))
|> Base.url_encode64(padding: false)
```

The preimage contains the normalized `recovery` sub-map, not `successor`; the claim separately
binds the exact successor. This prevents a certificate for one witness set or threshold from being
replayed after a different effective policy is observed. BEAM and TypeScript must use the same
raw-byte witness sort and preimage.

The certificate builder sorts signature entries by raw witness public-key bytes. Verification
rejects an otherwise valid but non-canonical signature order, preventing set-order malleability.

Certificate validation is strict: an extra malformed, unknown, duplicate, out-of-order, or
bad-signature entry rejects the entire certificate even when enough other entries are valid. The
deterministic reason precedence is:

1. `:invalid_recovery_policy`;
2. `:recovery_certificate_required` or `:witnessed_recovery_not_configured`;
3. `:malformed_recovery_certificate`;
4. `:unsupported_recovery_version`;
5. `:recovery_claim_mismatch` for replica/role/holder/holder-epoch/successor mismatch;
6. `:recovery_policy_mismatch`;
7. `:unknown_recovery_witness`;
8. `:duplicate_recovery_witness`;
9. `:noncanonical_recovery_signatures`;
10. `:invalid_recovery_signature`; and
11. `:insufficient_recovery_witnesses`.

## Partition And Conflict Semantics

Witnesses authorize recovery from the causal view named by the claim. They cannot prove that a
partitioned holder is dead. A partition may therefore leave disconnected replicas temporarily
materializing different holders, as the existing offline-first model already permits. On merge,
the canonical authority timeline chooses one deterministic acquisition and stale-holder quarantine
excludes losing writes. This plan does not claim linearizability, consensus, a lease, or CP behavior.

The certificate must bind the acquisition visible at the succession operation's dependencies. A
certificate for an earlier acquisition is rejected after transfer, prior succession, or any other
holder epoch change visible to the operation. Concurrent unseen activity remains the explicit
availability tradeoff documented by ADR 0004.

## TDD Sequence

### RED 1 - integrated BEAM authorization floor

Add a focused succession test before production code. With a witnessed 2-of-3 genesis policy:

1. one pinned signature is `:insufficient_recovery_witnesses` and the holder does not move;
2. two pinned signatures are honored and the successor becomes holder; and
3. signatures from arbitrarily many unpinned Sybil identities are
   `:unknown_recovery_witness` and do not move the holder.

The first run must fail because `Sim` and `Authority` do not understand the policy/proof shape.

### GREEN 1 - certificate, policy, Sim, and reducer consumer

Add one pure certificate module consumed by both `Sim` and `Authority`; it is not a standalone
unused primitive. Extend `Sim.create_replica/3` to resolve witness realm ids to public keys and
extend `Sim.succeed/4` with a test-harness-only witnessed option. Extend the authority role timeline
to validate witnessed proof against the acquisition visible at the op's dependencies. Preserve the
legacy integer branch exactly.

### RED/GREEN 2 - adversarial binding matrix

Add failing tests, then the smallest fixes, for:

- duplicate pinned witness;
- non-canonical signature ordering;
- malformed certificate or policy;
- bad witness signature;
- stale holder-epoch replay after a holder transfer/re-acquisition;
- cross-replica, cross-role, and wrong-successor claim replay;
- wrong recovery-policy id; and
- a witnessed proof presented to a legacy policy, or a tick presented to a witnessed policy.

Add a mixed-defect case with a valid threshold plus one unknown or invalid extra entry; strict
fail-closed validation must reject it according to the precedence above.

Run a mutation that lowers a valid 2-of-3 certificate to one signature. The focused honored-holder
assertion must fail, then restore the second signature.

### RED/GREEN 3 - cross-oracle vector

Export one named Sim scenario, `township_succession_witnessed_recovery`, containing a denied
subthreshold operation followed by a valid threshold operation, real carrier frames, realm keys,
the BEAM authority reasons, holder winner, certificate claim, and policy id.

Before changing TypeScript production types/reduction, make conformance fail on the new policy and
proof shape. Then independently:

- decode and hash/signature-verify every carrier frame;
- recompute the domain-separated witness payload and policy id;
- verify distinct pinned witness signatures and the holder epoch;
- reproduce the BEAM quarantine set and final holder; and
- fail closed on unsupported or malformed witnessed evidence.

Do not add a TypeScript authoring API or reuse exporter-provided validity booleans.

The BEAM checkpoint may land as a reviewed internal milestone before the TypeScript checkpoint, but
Plan 145 remains `IN PROGRESS`. Do not mark the plan complete or claim cross-oracle support until
the generated vector, independent TypeScript verification, and conformance reduction are green.

### GREEN 4 - claim-boundary documents

Only after executable evidence is green:

- update ADR 0004 with the selected governance authorization model and remaining non-claims;
- correct `Lattice.Clock` and `docs/lattice2_design.md` wording that currently implies operation
  authoring reads the process clock;
- replace `docs/path_to_real.md`'s stale recommendation to derive authority from carrier liveness;
- update `docs/lattice_poc_status.md`, `TOWNSHIP_BUILD_MAP.md`, and `plans/README.md`; and
- keep user-facing succession blocked until a separate ceremony plan exists.

## Expected Files

- `apps/lattice_core/lib/lattice/authority/succession_certificate.ex` (new)
- `apps/lattice_core/lib/lattice/authority.ex`
- `apps/lattice_core/lib/lattice/sim.ex`
- `apps/lattice_core/lib/lattice/clock.ex` (documentation only)
- `apps/lattice_core/test/lattice2/witnessed_succession_test.exs` (new)
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`
- `apps/lattice_core/test/township/export_vectors_test.exs`
- `clients/lattice-client/src/op.ts`
- `clients/lattice-client/src/carrier.ts`
- `clients/lattice-client/src/authority.ts`
- `clients/lattice-client/src/codec.ts` only if a focused exported claim encoder is required
- `clients/lattice-client/test/conformance.ts`
- `clients/lattice-client/test/vectors/township_succession_witnessed_recovery.json` (generated)
- generated `clients/lattice-client/dist/**` mirrors required by the normal build
- `docs/adr/0004-succession-validation.md`
- `docs/lattice2_design.md`
- `docs/path_to_real.md`
- `docs/lattice_poc_status.md`
- `TOWNSHIP_BUILD_MAP.md`
- `plans/README.md`
- this plan

Any shell, LiveView, carrier-server, mobile, election, attestation, or participant-authoring file is
scope drift.

## Non-Claims And Migration

- Legacy `dormant_ticks` operations and named vectors remain accepted exactly as characterized by
  Plan 144; they remain untrusted and are not a production recommendation.
- Witnessed recovery is opt-in and does not silently reinterpret an existing genesis policy.
- Witness signatures authorize recovery; they do not prove absence, elapsed time, independence,
  honesty, non-coercion, or receipt-freeness.
- The carrier remains transport-only and does not select witnesses, inspect liveness, or sign
  recovery claims.
- No v7 intent, LiveView control, Tauri ceremony, TypeScript authoring helper, mobile custody
  change, deployment claim, Phase F/M4 expansion, or W4 claim lands here.
- User-facing succession remains blocked after this plan. A later plan must design review, witness
  collection, expiry/reconfirmation policy if desired, native custody, and explicit publication.

## STOP Conditions

- Stop if a successor-controlled tick, causal count, wall clock, process uptime, carrier generation,
  or `Lattice.Clock` value is called proof of dormancy.
- Stop if unregistered distinct authors are counted as independent witnesses.
- Stop if witness membership or threshold can be changed outside a valid genesis policy.
- Stop if the certificate is not bound to the exact holder acquisition epoch and exact policy id.
- Stop if malformed/unknown/duplicate/invalid signatures are ignored instead of failing closed.
- Stop if signature entries are not deterministically sorted or mixed valid/invalid entries are
  partially accepted.
- Stop if the implementation changes legacy tick bytes or the Plan 144 vectors.
- Stop if temporary partition divergence is described as consensus, linearizability, or CP.
- Stop if any user-facing authoring, carrier semantic authority, Plan 077/mobile work, Phase F/M4
  implementation, or W4 claim appears.

## Verification

Use the explicit asdf OTP 28 toolchain from `AGENTS.md`; never let Homebrew or mise provide BEAM.
Never run Mix commands concurrently.

```sh
PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" \
  MIX_ENV=test "$HOME/.asdf/shims/mix" test \
  apps/lattice_core/test/lattice2/witnessed_succession_test.exs

PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" \
  MIX_ENV=test "$HOME/.asdf/shims/mix" test \
  apps/lattice_core/test/township/export_vectors_test.exs

PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" \
  MIX_ENV=test "$HOME/.asdf/shims/mix" lattice.export_vectors \
  --out clients/lattice-client/test/vectors

cd clients/lattice-client && npm run conformance
cd clients/lattice-client && npm run typecheck

PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH" \
  MIX_ENV=test "$HOME/.asdf/shims/mix" check

git diff --check
```

Run a fresh read-only Claude Code Opus review at the plan, every RED/GREEN evaluation, the mutation,
the exact claim wording, and the final publication diff.

## Completion Gate

Plan 145 is `DONE` only when:

- the selected witness trust model and rejected shortcuts are recorded without an absence claim;
- the BEAM security matrix and mutation prove the threshold, pinning, epoch, and replay boundaries;
- the certificate primitive is consumed by both `Sim` and `Authority` in the same slice;
- the generated carrier vector is independently verified and reduced by TypeScript;
- every legacy vector remains byte-identical and green;
- focused, full OTP 28, static, and boundary-security gates pass;
- Claude reports no P0-P2 issue on implementation or claims; and
- a new exact-tip hosted flagship run passes the exporter, conformance, and packaged chains.

Even then, user-facing succession remains incomplete and no physical-absence or coercion-resistance
claim is earned.
