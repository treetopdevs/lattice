# Plan 163: Pin TypeScript ingest to the paired replica and make command decode fail closed

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 764a1945..HEAD -- clients/lattice-client/src/carrier.ts clients/lattice-client/src/authority.ts clients/township-tauri-shell/src/township_sync.ts clients/township-tauri-shell/src/township_feed.ts apps/lattice_core/lib/township/matter.ex
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 — both defects are in the TypeScript trust chain that plan 162 hardens. Until
  this lands, a hostile carrier peer can move the trust anchor out from under plan 162's new
  predicate.
- **Effort**: S–M (two independent changes, each small; the fail-closed conversion needs care)
- **Risk**: LOW — both changes make the client stricter in ways the BEAM already is. The risk is
  breaking legacy vectors whose ops carry no `replica` field.
- **Depends on**: `plans/162-authority-root-binding.md` (recommended — 162 touches
  `clients/lattice-client/src/authority.ts` too; landing them in sequence keeps each diff reviewable)
- **Category**: security / bug
- **Planned at**: commit `764a1945`, 2026-07-29

## Execution evidence

Recorded on `codex/round4-security-reliability` during the reviewed execution:

- The foreign-replica RED admitted the signed foreign frame, emptied Township state, and produced
  four quarantines. Removing the ingest comparison reproduced that named failure; reverting the
  explicit anchor separately failed the direct anchor assertions.
- The `link_election` RED quarantined operation
  `PpPRV1FW9vo4TBX1OWe16B8-hq7DSdRgTyYqIqQ6AE0` as
  `operation_not_granted`. The green path retains the real command name, produces zero state
  mutations, and remains absent from the quarantine set.
- Adding temporary BEAM command `:plan163_drift_probe` made
  `Township command decoder table matches the BEAM DSL` fail. A second temporary mutation added a
  two-argument `link_election` overload; conformance exited 1 at
  `Township command decoder arities match the BEAM DSL`, with runtime
  `[["link_election", 1]]` versus BEAM
  `[["link_election", 1], ["link_election", 2]]`. Both mutations and their temporary export
  support were removed, the test environment was recompiled, and the complete vector corpus was
  regenerated.
- Security review changed the initial unknown-command throw to per-operation BEAM-compatible
  quarantine. Regression coverage now pins `unknown_command`, `bad_command_arity`, and
  `malformed_command`; prototype-name lookup; malformed raw terms; scalar arguments accepted by
  BEAM; custody-consent reason precedence; and explicit coverage sentinels for both Township and
  Toolshed command tables.

## Why this matters

Two independent holes in the TypeScript client's ingest path:

**A. The replica root trust anchor is inferred from log contents.** `validateDelegations` picks the
root commitment from *whichever op happens to sort first*:

```ts
const outerReplica = ops.find((op) => op.replica !== undefined)?.replica;
```

Canonical order seeds the ready set with all depth-0 ops sorted by ascending hash, and op ids are
content hashes, so an attacker can cheaply grind an op that sorts first. Serve one self-signed op
with `deps: []`, a low-sorting id, and `replica: "…#root:<attacker commitment>"` and the client's
entire root determination flips: the *genuine* genesis fails `replicaRootMatches` and is marked
`impostor_genesis`, every delegation descending from it cascades to `invalid_parent`, and every
command quarantines. Pair it with an attacker genesis on the same forged replica string and
`resolveRoot` returns the **attacker** as replica root — which confers revocation authority over
every delegation and beacon authority over every lease.

The BEAM has exactly this check and the client does not: `Log.accept/2` rejects
`op.replica != log.replica` as `:wrong_replica`. And neither shell caller filters — the paired
replica is right there in the peer config and in the session challenge, and it is never compared to
what came back.

**B. Unknown commands fail open with a wrong reason.** `payloadFromBody`'s switch handles ten
Township commands; `Township.Matter` defines eleven. The missing one, `link_election`, falls through
to `neutralPayload(kind)`, which sets `command` to the literal string `"command"`. Capability
checking then compares `"command"` against the delegation's granted ops and always returns
`operation_not_granted`. So a correctly-capped `link_election` op is honored by `Lattice.Sim` and
quarantined by the TS client — a divergent quarantine set, and no TS shell can ever project a
linked election. Worse, the *shape* guarantees this recurs: every future Elixir command added
without a matching TS case reproduces the same silent wrong answer instead of failing loudly.

After this plan: pulled operations that do not belong to the paired replica are rejected at ingest,
the root commitment is an explicit parameter rather than an inference, `link_election` decodes
correctly, and an unmapped command is a loud failure instead of a wrong reason atom.

## Current state

### Defect A — the inferred trust anchor

`clients/lattice-client/src/authority.ts:896-910`:

```ts
function validateDelegations(
  ops: readonly Op[],
  collected: ReadonlyMap<string, CollectedDelegation>,
): Map<string, AuthorityDelegationRecord> {
  const genesisIds = new Set(
    ops.flatMap((op) =>
      op.authority?.type === "genesis" ? [op.authority.delegation.id] : [],
    ),
  );
  const outerReplica = ops.find((op) => op.replica !== undefined)?.replica;
```

`outerReplica` is the sole input to every `impostor_genesis` decision at `authority.ts:948-959`.

The ordering that makes it grindable — `clients/lattice-client/src/dag.ts:71-92` seeds the ready set
with depth-0 ops sorted by ascending hash.

The only ingest gate is `verifyCarrierOp` (`clients/lattice-client/src/carrier.ts:741-744`), which
checks the content hash and the author's signature over `canonicalBytesForCarrierOp`. `frame.replica`
is inside those signed bytes and is signed by the **attacker's own key**, so it verifies fine.
`assertCarrierOpFrame` (`carrier.ts:1178`) only type-checks `typeof op.replica !== "string"`.
`integrate` (`clients/lattice-client/src/sync.ts:34-38`) merges purely by id.

The two shell callers, neither of which compares a replica:

- `clients/township-tauri-shell/src/township_sync.ts:177` — `await syncCarrierOnce(...)`, then
  `:206` — `const mergedOps = integrate(currentOps, synced.ops);`
- `clients/township-tauri-shell/src/township_feed.ts:74` — `export async function refreshTownshipFromCarrier(`,
  then `:91` — `carrierOpsToSemanticOps(pulledFrames, options.realmByPubkey)` and `:98` —
  `const ops = integrate(currentOps, pulledOps);`

Confirmed: `grep -n 'replica' clients/township-tauri-shell/src/township_sync.ts` returns **nothing**.

The paired replica is already available to both callers —
`clients/township-tauri-shell/src/township_carrier_peer.ts:27` and `:280` carry
`TownshipCarrierPeerConfig.replica`, and it is already sent in the session challenge
(`carrier.ts:268`, `:304`, `:371`).

The BEAM counterpart, `apps/lattice_core/lib/lattice/log.ex:136-140`:

```elixir
  def accept(%__MODULE__{} = log, %Op{} = op) do
    cond do
      op.replica != log.replica ->
        {:rejected, log, :wrong_replica}
```

### Defect B — the fail-open command decode

`clients/lattice-client/src/carrier.ts:1020-1060` — the command switch:

```ts
  if (kind === "command" && isTuple(body)) {
    const command = atomName(body.values[0]);
    const args = listValues(body.values[1]);

    switch (command) {
      case "set_title":
        return { field: "title", mutation: "write", value: binText(args[0]), command };
      case "set_summary":
        return { field: "summary", mutation: "write", value: binText(args[0]), command };
      case "post":
        return { field: "posts", mutation: "append", value: binText(args[0]), command };
      case "admit":
        return { field: "members", mutation: "add", value: binText(args[0]), command };
      case "remove_member":
        return { field: "members", mutation: "remove", value: binText(args[0]), command };
      case "close_matter":
        return { field: "clerk_locked", mutation: "write", value: true, command };
      case "reopen_matter":
        return { field: "clerk_locked", mutation: "write", value: false, command };
      case "describe":
        return { field: "description", mutation: "write", value: binText(args[0]), command };
      case "note_condition":
        return { field: "condition_notes", mutation: "append", value: binText(args[0]), command };
      case "custody_transfer": { ... }
```

and the fallthrough at `carrier.ts:1164-1170`:

```ts
  return neutralPayload(kind);
}

function neutralPayload(command: string): Payload {
  return { field: "__authority", mutation: "write", value: null, command };
}
```

`neutralPayload` is also used deliberately for authority kinds (`carrier.ts:1091`, `:1096`, `:1135`,
`:1145`, `:1157`) with a descriptive `command` string — do **not** change those call sites.

The Elixir command set, `apps/lattice_core/lib/township/matter.ex:46-61`:

```elixir
  command(:set_title, [:text], do: [{:title, {:write, text}}])
  command(:set_summary, [:text], do: [{:summary, {:write, text}}])
  command(:post, [:text], do: [{:posts, {:append, text}}])
  command(:admit, [:member], do: [{:members, {:add, member}}])
  command(:remove_member, [:member], do: [{:members, {:remove, member}}])

  command(:link_election, [:spec_digest],
    do:
      case spec_digest do
        _ -> []
      end
  )

  # Clerk-only, authority-guarded.
  command(:close_matter, [], do: [{:clerk_locked?, {:write, true}}])
  command(:reopen_matter, [], do: [{:clerk_locked?, {:write, false}}])
```

`link_election` reduces to **zero mutations** — but it must still carry `command: "link_election"`
so `capabilityQuarantine` can check it against the delegation's granted ops.

Where the wrong reason is produced, `clients/lattice-client/src/capability.ts:41`:

```ts
  if (op.command === undefined || !delegation.ops.includes(op.command))
    return { quarantined: true, reason: "operation_not_granted" };
```

The delegation in the existing carrier vector already grants `link_election` — see
`clients/lattice-client/test/vectors/township_carrier_w1.json` (search for `link_election`).

`Township.Election.verify_link/2` (`apps/lattice_core/lib/township/election.ex:117`) requires the
link op to be **absent** from `Authority.quarantine(Matter, log)`, so the entire election-linking
feature depends on this op being honored.

### Repo conventions to follow

- Adversarial scenarios are exported by `mix lattice.export_vectors` and consumed by
  `clients/lattice-client/test/conformance.ts`. New scenarios register in the `fixed` list at
  `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex:66-103`.
- The client's per-area test entry points are individual `tsx test/*.ts` scripts registered in
  `clients/lattice-client/package.json:16-30` and each wired as its own CI step.
- TypeScript is `strict: true` with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
  (`clients/lattice-client/tsconfig.json:10-12`). Do not add `any` or `as` escapes.

## Commands you will need

**Toolchain**: invoke mix as `~/.asdf/shims/mix`.

| Purpose | Command | Expected on success |
|---|---|---|
| TS typecheck | `npm --prefix clients/lattice-client run typecheck` | exit 0 |
| TS conformance | `npm --prefix clients/lattice-client run conformance` | exit 0, all PASS |
| TS carrier | `npm --prefix clients/lattice-client run carrier:township` | exit 0 |
| TS live carrier | `npm --prefix clients/lattice-client run carrier:township:live` | exit 0 |
| TS relay / relay-sync | `npm --prefix clients/lattice-client run carrier:relay` / `carrier:relay-sync` | exit 0 |
| TS authoring | `npm --prefix clients/lattice-client run township:authoring` | exit 0 |
| TS build | `npm --prefix clients/lattice-client run build` | exit 0 |
| Shell typecheck | `npm --prefix clients/township-tauri-shell run typecheck` | exit 0 |
| Shell sync contract | `npm --prefix clients/township-tauri-shell run sync:contract` | exit 0 |
| Shell feed contract | `npm --prefix clients/township-tauri-shell run feed:contract` | exit 0 |
| Regenerate vectors | `MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors` | writes files |
| Elixir gate | `~/.asdf/shims/mix check` | exit 0 |

Regenerate vectors with `MIX_ENV=test` after a `~/.asdf/shims/mix test` in the same session — see
the staleness note at `.github/workflows/flagship.yml:118-125`.

## Scope

**In scope**:

- `clients/lattice-client/src/authority.ts` (the `outerReplica` parameter only)
- `clients/lattice-client/src/carrier.ts` (the command switch and its fallthrough only)
- `clients/lattice-client/src/materialize.ts` (only if threading the expected replica requires it)
- `clients/lattice-client/src/sync.ts` (only if the replica filter belongs in `integrate`)
- `clients/township-tauri-shell/src/township_sync.ts`
- `clients/township-tauri-shell/src/township_feed.ts`
- `clients/lattice-client/test/*.ts` (new assertions)
- `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` (new scenarios)
- `clients/lattice-client/test/vectors/*.json` (regenerated — never hand-edited)
- `clients/lattice-client/dist/**` (regenerated by `npm run build` — never hand-edited)
- `plans/README.md` (status row)

**Out of scope**:

- `apps/lattice_core/lib/lattice/authority.ex` — plan 162 owns it. If you find yourself needing to
  change Elixir authority logic, STOP: the two plans have collided.
- `apps/lattice_core/lib/township/matter.ex` — the Elixir command set is correct; TypeScript is the
  side that is behind. Do not add or remove Elixir commands.
- `apps/lattice_carrier_server/**` — the server is transport-only. The replica filter belongs on the
  client, which is the side that must not trust the peer.
- `clients/lattice-client/src/codec.ts` — canonical bytes are already correct; the op hash verifies.
  This is a semantic-decode fix, not an encoding fix.
- The `neutralPayload` call sites for authority kinds (`carrier.ts:1091`, `:1096`, `:1135`, `:1145`,
  `:1157`) — those are deliberate.
- `Township.Election` internals — this plan makes `link_election` decode; it does not add election
  projection to the client.

## Git workflow

- Branch: `advisor/163-ts-ingest-pinning`
- Two logical commits, one per defect, so each is independently reviewable:
  `fix(client): reject pulled ops from a foreign replica` and
  `fix(client): decode link_election and fail closed on unknown commands`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (RED): Add an adversarial foreign-replica vector and watch the client accept it

Add a scenario to `apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex` named
`township_foreign_replica_injection`, registered in the `fixed` list.

Because the Sim oracle operates on a single log and `Log.accept/2` already rejects foreign-replica
ops, the oracle cannot naturally *contain* a foreign op. So export the two pieces separately: the
legitimate log as usual, plus an extra field in the scenario's evidence map carrying a
**standalone, validly-signed carrier op frame on a different replica string** for the TS test to
splice in. Construct it with `Op.new(attacker, other_replica, [], :authority, {:genesis, attacker_deleg, %{}})`
where `other_replica` embeds a different `#root:` commitment, and encode it with the same carrier
wire encoder the scenario already uses for `oracleCarrierOps`.

Then add assertions to `clients/lattice-client/test/carrier.ts` (or a new
`test/foreign_replica.ts` registered as an npm script — state which you chose):

1. Splice the foreign frame into the pulled frame set alongside the genuine ones.
2. Assert that after ingest, the resulting op set contains **only** ops whose `replica` equals the
   expected replica.
3. Assert the materialized state and quarantine set are **identical** to the run without the foreign
   frame.

**Verify (this step must FAIL)**:

```sh
MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors
npm --prefix clients/lattice-client run carrier:township
```

→ must fail. Expected shape: the foreign op is present in the merged set, and — if its id sorts
first — the genuine genesis is reported `impostor_genesis` and the state is empty.

Record the exact failure. If the foreign frame is already rejected, the defect does not exist as
described — STOP and report.

### Step 2 (GREEN): Reject foreign-replica ops at ingest and make the anchor explicit

Two coordinated changes:

**(a) Filter at ingest.** Thread the expected replica into the ingest path and drop (or hard-fail on)
any frame whose `replica` differs, **before** `carrierOpsToSemanticOps`. Prefer hard-fail over
silent-drop if the surrounding code already surfaces errors — a peer serving foreign ops is
misbehaving and should be visible — but silent-drop is acceptable if the existing sync contract
cannot carry a new error. State which you chose and why.

Apply it at both shell call sites, using the replica already present in the peer config
(`township_carrier_peer.ts:27`):

- `clients/township-tauri-shell/src/township_sync.ts` — around `syncCarrierOnce` at `:177` and
  before `integrate` at `:206`
- `clients/township-tauri-shell/src/township_feed.ts` — before `carrierOpsToSemanticOps` at `:91`

**(b) Make the anchor a parameter, not an inference.** Change `authority.ts:905` so `outerReplica`
comes in as an explicit argument rather than `ops.find(...)`. Thread it from the caller that knows
the paired replica. Keep a defined fallback for callers that genuinely have no expected replica
(legacy Tier-A vectors have ops with `replica === undefined`) — the safest fallback is to keep the
current inference **only** when no expected replica was supplied, and to document that in a comment
as a legacy path.

If threading a new required parameter through `materialize()` would break its public signature in a
way the shell cannot absorb, use an optional field on the existing options object instead. Do not
change the signature in a way that silently makes the strict path opt-in for the shell — the shell
must pass it.

**Verify**:

```sh
npm --prefix clients/lattice-client run typecheck \
  && npm --prefix clients/lattice-client run carrier:township \
  && npm --prefix clients/lattice-client run conformance \
  && npm --prefix clients/lattice-client run v01:guard
```

→ all exit 0. Then:

```sh
npm --prefix clients/lattice-client run build
npm --prefix clients/township-tauri-shell run typecheck \
  && npm --prefix clients/township-tauri-shell run sync:contract \
  && npm --prefix clients/township-tauri-shell run feed:contract
```

→ all exit 0.

### Step 3: Prove the filter is load-bearing (mutation)

Remove the replica comparison, re-run `npm --prefix clients/lattice-client run carrier:township`,
and confirm it fails with the step-1 failure. Restore. Record the output.

Separately: revert `outerReplica` to the `ops.find(...)` inference while keeping the ingest filter,
and confirm at least one assertion still fails (the two defenses must be independently tested — if
reverting (b) produces no failure, add a direct unit assertion that calls the authority analysis with
an explicit anchor and a log containing a mismatched op).

### Step 4 (RED): Add a `link_election` scenario and watch it quarantine

Add `township_link_election` to `lattice.export_vectors.ex`:

- Create the matter, grant the clerk (or a resident) a delegation whose `ops` include `:link_election`.
- Author `Sim.command(sim, "<realm>", :link_election, [spec_digest], cap: <delegation id>)` with a
  fixed 43-char digest string.
- Assert `assert_authority_honored!(log, link.id)` — the Elixir oracle honors it.
- Return via `capability_scenario/4` with `"linkOperationId"` and `"specDigest"` in the evidence map.

**Verify (this step must FAIL)**:

```sh
~/.asdf/shims/mix test && MIX_ENV=test ~/.asdf/shims/mix lattice.export_vectors --out clients/lattice-client/test/vectors
npm --prefix clients/lattice-client run conformance
```

→ the Elixir side passes (the op is honored); `conformance` **fails** because the TS client
quarantines the link op as `operation_not_granted`. Record it.

### Step 5 (GREEN): Decode `link_election` and make the fallthrough fail closed

**(a)** Add the missing case to the switch at `carrier.ts:1035`, emitting a payload that carries the
real command name and produces no state mutation. Match how the codebase represents a
zero-mutation command; if there is no existing precedent, the minimal shape is a payload whose
`command` is `"link_election"` and whose field/mutation are chosen so the reducer applies nothing.
Confirm against the Elixir reducer: `Township.Matter`'s `link_election` yields `[]` mutations, so
the materialized state must be byte-identical with and without the op.

**(b)** Change the `kind === "command"` fallthrough so an unmapped command is loud. Inside the
`if (kind === "command" && isTuple(body))` block, replace the implicit fall-through to
`neutralPayload(kind)` with an explicit throw (or a distinguishable `unknown_command` marker that
the caller turns into a hard failure). Do **not** change `neutralPayload` itself or its authority
call sites — only the command path.

Choose throw vs. marker by asking: does any current caller need to survive an unknown command from a
peer? If yes (a client on an older version pulling from a newer replica), a marker plus an explicit
`unknown_command` quarantine reason is correct and strictly better than the current wrong reason.
If no, throw. State your choice and reasoning in the report.

**(c)** Add a guard test asserting the fail-closed behavior: feed a synthetic command frame with a
command name that exists in neither runtime and assert the client fails loudly (or quarantines with
`unknown_command`) rather than reporting `operation_not_granted`.

**Verify**:

```sh
npm --prefix clients/lattice-client run typecheck \
  && npm --prefix clients/lattice-client run conformance \
  && npm --prefix clients/lattice-client run carrier:township \
  && npm --prefix clients/lattice-client run carrier:relay \
  && npm --prefix clients/lattice-client run carrier:relay-sync \
  && npm --prefix clients/lattice-client run township:authoring
```

→ all exit 0, all PASS.

### Step 6: Add a drift guard between the two command tables

The whole point of (b) is that the next Elixir command must not silently diverge. Add a check that
compares the two command sets and fails when they drift. The cheapest robust version: have the
exporter emit the Elixir command list into a scenario's evidence map (from
`Township.Matter.__commands__/0` or whatever the `Lattice.Replica` DSL exposes — inspect
`apps/lattice_core/lib/lattice/replica.ex` for the introspection function), and add a TS assertion
that every exported command name is handled by `payloadFromBody`.

If no such introspection function exists, do not add one to the DSL — instead assert in the TS test
against a literal list, and add a comment in `apps/lattice_core/lib/township/matter.ex` pointing at
the TS switch as the place that must be updated in lockstep. State which route you took.

**Verify**: deliberately add a dummy command to the Elixir side, confirm the guard fails, then
remove it. Record the output.

### Step 7: Full gate

```sh
~/.asdf/shims/mix check
npm --prefix clients/lattice-client run build
npm --prefix clients/lattice-client run typecheck
npm --prefix clients/lattice-client run conformance
npm --prefix clients/lattice-client run v01:guard
npm --prefix clients/lattice-client run canonical
npm --prefix clients/lattice-client run township:authoring
npm --prefix clients/lattice-client run carrier:township
npm --prefix clients/lattice-client run carrier:relay
npm --prefix clients/lattice-client run carrier:relay-sync
npm --prefix clients/lattice-client run carrier:township:live
npm --prefix clients/lattice-client run carrier:feed
npm --prefix clients/township-tauri-shell run typecheck
npm --prefix clients/township-tauri-shell run sync:contract
npm --prefix clients/township-tauri-shell run feed:contract
npm --prefix clients/township-tauri-shell run action:contract
```

→ all exit 0. Commit the regenerated `clients/lattice-client/dist/**` with the source change.

## Test plan

- **New exported scenarios**: `township_foreign_replica_injection` (carries a standalone foreign-replica
  frame in its evidence map), `township_link_election`. Model after `township_capability_invalid`
  (`lattice.export_vectors.ex:1155`).
- **New TS assertions** in `clients/lattice-client/test/carrier.ts` (or a new registered script):
  foreign frame is rejected; state and quarantine are identical with and without it; the genuine
  genesis is never `impostor_genesis` because of a foreign op.
- **New TS assertion**: an unknown command name fails loudly / quarantines `unknown_command`, and
  specifically **not** `operation_not_granted`.
- **Conformance**: `township_link_election` must move from FAIL (step 4) to PASS (step 5).
- **Mutation**: step 3's two reverts and step 6's dummy-command check, each with a named failure.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npm --prefix clients/lattice-client run typecheck` exits 0
- [ ] `npm --prefix clients/lattice-client run conformance` exits 0, all PASS, including `township_link_election` and `township_foreign_replica_injection`
- [ ] `npm --prefix clients/lattice-client run carrier:township`, `carrier:relay`, `carrier:relay-sync`, `carrier:township:live`, `carrier:feed` all exit 0
- [ ] `npm --prefix clients/lattice-client run v01:guard` and `canonical` exit 0
- [ ] `npm --prefix clients/township-tauri-shell run typecheck`, `sync:contract`, `feed:contract`, `action:contract` all exit 0
- [ ] `grep -n 'link_election' clients/lattice-client/src/carrier.ts` returns a `case` in the command switch
- [ ] `grep -n 'replica' clients/township-tauri-shell/src/township_sync.ts` returns at least one comparison (it returns nothing today)
- [ ] `clients/lattice-client/src/authority.ts` no longer contains `ops.find((op) => op.replica !== undefined)` as the sole anchor source (a documented legacy fallback is acceptable)
- [ ] `~/.asdf/shims/mix check` exits 0
- [ ] `npm --prefix clients/lattice-client run build` exits 0 and regenerated `dist/**` is committed
- [ ] Step 3's two mutations and step 6's dummy command each produce a named failure, recorded in your report
- [ ] `git status` shows no modified file outside the In-scope list
- [ ] `plans/README.md` status row for 163 updated

## STOP conditions

Stop and report back (do not improvise) if:

- **The step-1 foreign frame is already rejected** or **the step-4 `link_election` op already
  conforms** — the defect does not exist as described.
- **Making `outerReplica` an explicit parameter breaks legacy vectors** whose ops carry
  `replica === undefined` in a way the documented fallback cannot absorb. Report which vectors and
  what you tried.
- **The fail-closed conversion breaks an existing green suite** because some current flow relies on
  an unmapped command decoding neutrally. That would mean a command is being exercised that neither
  runtime maps — a finding worth reporting rather than working around.
- **You need to change `apps/lattice_core/lib/lattice/authority.ex`.** Plan 162 owns that file; a
  collision means the plans need resequencing.
- **You need to add or change an Elixir command in `Township.Matter`** to make the TS side line up.
  The Elixir set is the source of truth here.
- `Lattice.Replica` exposes no command-introspection function and you are tempted to add one to the
  DSL — that is a substrate change; report it and use the literal-list route instead.

## Maintenance notes

- **Reviewer focus**: whether the replica filter is applied *before* `carrierOpsToSemanticOps` at
  both call sites. Filtering after semantic conversion still lets a foreign op influence the anchor.
- **The two defenses are deliberately redundant.** The ingest filter stops foreign ops from entering;
  the explicit anchor stops the analysis from trusting log contents even if one slips through
  (e.g. via a code path that does not use the shell's sync helpers). Do not collapse them into one.
- **The drift guard from step 6 is the durable part of defect B.** `link_election` is one instance;
  the fail-closed fallthrough plus the guard is what stops instance N+2. If a future plan adds an
  Elixir command, the guard should fail before the divergence ships.
- **Deferred out of this plan**: extracting the ~750-line canonical CBOR codec that lives inside
  `carrier.ts:923-1500` into its own module (`consent.ts:2` already reaches into `carrier.ts` for
  `canonicalTerm`, and `codec.ts` type-imports back — a type-only cycle today). Real, but a pure
  move that would make this security diff unreviewable.
- **Also deferred**: the carrier client has no notion of "which replica am I subscribed to" at the
  protocol level — the session challenge carries a replica but the `pull` response is not bound to
  it. Server-side binding would be defense-in-depth on the transport-only boundary; it needs a
  design decision about whether the carrier may reject on semantic grounds.
