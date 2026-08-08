# Plan 169: Stop letting carrier control frames decide authority or delete the outbox

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- clients/lattice-client/src/materialize.ts clients/lattice-client/src/carrier.ts clients/township-tauri-shell/src/township_feed.ts clients/township-tauri-shell/src/township_sync.ts
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: **P0** — the carrier server decides which operations the client's own authority
  analysis is allowed to see, and separately induces the client to delete un-relayed work from
  its outbox. Both contradict the repo's central non-claim.
- **Effort**: M — two contained changes plus the tests that pin them.
- **Risk**: MED — removing the carrier's verdict from the analysis input means a genuine
  BEAM↔TypeScript authority divergence now surfaces as a visible error instead of being
  silently absorbed. That is the point, but it may light up existing gates. Step 2 measures it
  before you change behavior.
- **Depends on**: none. (Adjacent to plan 163, which owns *replica pinning* in the same files —
  see Scope for the boundary.)
- **Category**: security
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Why this matters

`apps/lattice_carrier_server` states its contract in `lattice_carrier_server.ex:12-14` and in
`CLAUDE.md`: it performs **structural delivery only**, holds no participant custody, and
**never decides semantic authority**. The client is supposed to be the judge.

Two paths break that in the opposite direction — not by the server *taking* authority, but by
the client *handing* it over:

1. **The client subtracts the carrier's authority verdict from its own analysis input.** The
   server computes `Authority.analyze(Matter, log)` and serves the result as
   `authority_quarantine`. The desktop feed passes those ids into `materialize()`, which
   removes them from the set given to `analyzeAuthority`. So the server picks which operations
   the client's judge may consider. Naming a valid `{:revoke, id}` op's id suppresses it, and a
   revoked capability materializes as live. Naming a `{:beacon, epoch}` op suppresses lease
   lapse. The only guard is that the reported ids must be a subset of the ids the client
   already holds — no defence at all, since those ids are public and the server holds them.

2. **The client deletes outbox frames the peer merely *claims* to have.** `syncCarrierOnce`
   treats membership in the peer's advertised id list as an acknowledgement: the frame is
   removed from the push candidates **without ever being transmitted**, then folded into
   `acknowledgedFrameIds`, which the shell uses to compact the persisted outbox. A carrier that
   simply lies about what it holds makes the client permanently discard its own un-relayed
   operations. The op survives in the local log but is never re-offered, so it is invisible to
   every other participant. Censorship becomes free and deniable, and the victim performs the
   deletion.

`docs/threat_model_v2.md:43-45` treats a misbehaving carrier as an availability problem. Both
paths above turn it into an integrity problem, because control values that were never signed
have been given semantic weight.

## Current state

### Path 1 — the carrier's verdict gates the client's analysis

`clients/township-tauri-shell/src/township_feed.ts:100-101`:

```typescript
    const externallyQuarantined = validateCarrierStateReport(stateReport, delegationFrames);
    const matter = townshipPreviewFromOps(ops, externallyQuarantined);
```

`clients/township-tauri-shell/src/township_feed.ts:334-357` — the whole of the "validation":

```typescript
function validateCarrierStateReport(
  report: CarrierStateReport,
  frames: CarrierOpFrame[],
): ReadonlySet<string> {
  const reportIds = new Set(report.op_ids);
  const frameIds = new Set(frames.map((frame) => frame.id));
  const reportMatchesFrames =
    report.log_size === report.op_ids.length &&
    reportIds.size === report.op_ids.length &&
    reportIds.size === frameIds.size &&
    [...reportIds].every((id) => frameIds.has(id));

  if (!reportMatchesFrames) {
    throw new Error("carrier state report does not match verified frames");
  }

  const quarantined = new Set(report.authority_quarantine.map(([id]) => id));
  if ([...quarantined].some((id) => !reportIds.has(id))) {
    throw new Error("carrier state report does not match verified frames");
  }

  return quarantined;
}
```

It compares **id sets**. It never recomputes a single reason.

`clients/lattice-client/src/materialize.ts:66-73` — where the verdict takes effect:

```typescript
  const authorityIncluded = new Set(
    [...inc].filter((id) => !externallyQuarantined.has(id)),
  );
  const authorityOrder = order.filter((id) => authorityIncluded.has(id));
  ...
    authority = analyzeAuthority(schema, ops, authorityIncluded, authorityOrder, byId);
```

The server side that computes it: `apps/lattice_core/lib/township/carrier_state_report.ex:39-45`
(`Authority.analyze(Matter, log)`), served from
`apps/lattice_carrier_server/lib/lattice_carrier_server/web_socket.ex:178-183`.

### Path 2 — untransmitted frames counted as acknowledged

`clients/lattice-client/src/carrier.ts:737` and `:747-765`:

```typescript
  const peerIds = new Set(await client.advertise());
  ...
  const candidateFrames = localCarrierFrames.filter((frame) => {
    const op = carrierOpToSemanticOp(frame, realmByPubkey);
    if (!peerIds.has(op.id)) return true;
    peerKnownFrameIds.push(carrierFrameId(frame));
    return false;
  });

  const submission = options.submission ?? "push";
  const submitted = await submitCarrierFrames(client, candidateFrames, submission);
  const acknowledgedFrameIds = [
    ...new Set([
      ...peerKnownFrameIds,
      ...submitted.pushReport.accepted,
      ...submitted.confirmedDuplicateIds,
    ]),
  ];
```

`clients/township-tauri-shell/src/township_sync.ts:211-218` consumes it:

```typescript
  const compactedCarrierFrames = currentCarrierFrames.filter(
    (frame) => !acknowledgedFrameIds.has(frameId(frame)),
  );
  ...
  await workflow.carrierFrames.save(compactedCarrierFrames);
```

`peerKnownFrameIds` are frames the client **never sent**. Their only evidence is the peer's own
unsigned `frontier_result`.

### Repo conventions to match

- TypeScript is strict ESM, `moduleResolution: bundler`, with `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. No `any`, no `as` casts to silence errors, no `@ts-ignore`.
- The library's fail-closed discipline: every `catch` in `clients/lattice-client/src/` converts
  to a rejection or rethrows — see `authority.ts:283` (`authority_analysis_failed`) and
  `consent.ts:77` (`invalid_consent`) as the shape to match.
- Test scripts are `tsx` entry points under `clients/lattice-client/test/` and
  `clients/township-tauri-shell/test/`, registered as npm scripts. They are plain scripts, not
  a framework — match the surrounding assertion/reporting style of the file you edit.

## Commands you will need

```bash
export MIXCMD="$HOME/.asdf/shims/mix"
export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
```

| Purpose | Command | Expected on success |
|---|---|---|
| TS typecheck (library) | `cd clients/lattice-client && npm run typecheck` | exit 0 |
| TS conformance | `cd clients/lattice-client && npm run conformance` | exit 0 |
| TS carrier relay | `cd clients/lattice-client && npm run carrier:relay` | exit 0 |
| TS carrier relay sync | `cd clients/lattice-client && npm run carrier:relay-sync` | exit 0 |
| TS carrier feed | `cd clients/lattice-client && npm run carrier:feed` | exit 0 |
| TS live carrier | `cd clients/lattice-client && npm run carrier:township:live` | exit 0 |
| TS build (regenerates `dist/`) | `cd clients/lattice-client && npm run build` | exit 0 |
| Shell typecheck | `cd clients/township-tauri-shell && npm run typecheck` | exit 0 |
| Elixir suite | `$MIXCMD test` | exit 0 |

Baseline at the planned-at commit: `$MIXCMD test` exits 0.

## Scope

**In scope**:

- `clients/lattice-client/src/materialize.ts` — the `externallyQuarantined` parameter only
- `clients/lattice-client/src/carrier.ts` — the `peerKnownFrameIds` / `acknowledgedFrameIds`
  construction in `syncCarrierOnce` only
- `clients/township-tauri-shell/src/township_feed.ts` — `validateCarrierStateReport` and its
  one call site
- `clients/township-tauri-shell/src/township_sync.ts` — only if threading the changed
  acknowledgement set requires it
- `clients/lattice-client/test/carrier_feed.ts`, `clients/lattice-client/test/carrier_relay_sync.ts` — new assertions
- `clients/lattice-client/dist/**` — regenerated by `npm run build`, **never hand-edited**
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- `apps/lattice_carrier_server/**` and `apps/lattice_core/lib/township/carrier_state_report.ex`.
  The server computing a report is not the bug — it is opt-in per manifest and its own moduledoc
  discloses what it derives. **The bug is the client trusting it.** Fixing this server-side would
  hide the divergence signal this plan exists to create.
- `clients/lattice-client/src/authority.ts` — plans 162 and 163 own it.
- The **replica pinning** work on the receive path (filtering pulled frames by paired replica).
  That is **plan 163**. If you find yourself adding a replica filter, STOP: the plans collided.
- `clients/lattice-client/src/codec.ts` — plan 172 owns it.
- The `generation` / `ops_available` subscription path. It has the same "unsigned control value
  with teeth" shape, but it is a liveness hint whose worst case is a spurious or missed pull.
  Deliberately deferred — see Maintenance notes.

## Git workflow

- Branch: `codex/169-carrier-control-frames-carry-no-authority`
- Conventional commits matching `git log`, e.g.
  `test(carrier): add RED carrier-verdict and false-ack regressions`, then
  `fix(carrier): stop trusting carrier control frames for authority`.
- Commit the RED tests separately from the fix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the two failing (RED) regressions first

Add to `clients/lattice-client/test/carrier_feed.ts` a case proving path 1: build an op set
containing a valid `{:revoke, ...}` authority op, materialize it twice — once with an empty
`externallyQuarantined` set and once with a set naming the revoke op's id — and assert the
**materialized authority result is identical**. Today it differs, because the second call hides
the revoke from `analyzeAuthority`.

Add to `clients/lattice-client/test/carrier_relay_sync.ts` a case proving path 2: drive
`syncCarrierOnce` against a stub client whose `advertise()` returns an id the client holds in
its outbox but has **never pushed**, and assert that id does **not** appear in the returned
`acknowledgedFrameIds`. Today it does.

Read both test files first and follow their existing harness — `carrier_relay_sync.ts` already
constructs stub carrier clients, so reuse that construction rather than inventing one.

**Verify**: `cd clients/lattice-client && npm run carrier:feed` and `npm run carrier:relay-sync`
→ **both new cases FAIL**, every pre-existing case still passes. If either new case passes
before you change source, STOP — that path is already fixed and this plan is stale for it.

### Step 2: Measure the divergence the fix will expose

Path 1's fix makes the client compute authority itself. If BEAM and TypeScript currently
disagree anywhere, that disagreement has been silently absorbed and will now surface. Find out
first:

```bash
cd clients/lattice-client
npm run conformance && npm run carrier:township:live
```

Record whether both are green **before** any change. Then, after step 3, re-run them and
compare. Any newly-red case is a genuine BEAM↔TS authority divergence — a `CLAUDE.md` STOP
condition, not something to suppress by restoring the parameter.

**Verify**: both commands run and you have recorded their result. No files changed yet.

### Step 3: Make the carrier's verdict advisory, not authoritative

In `clients/lattice-client/src/materialize.ts`, stop subtracting `externallyQuarantined` from
the analysis input. `authorityIncluded` becomes `inc` and `authorityOrder` becomes `order`.

Do not simply delete the parameter — its diagnostic value is real. Keep accepting it, compute
authority unconditionally, then **compare**: if the local analysis and the reported set
disagree, throw a distinct, named error (`carrier_authority_report_divergence`) carrying both
sets. That converts a silent override into a loud alarm, which is the posture
`clients/township-tauri-shell/src/township_sync.ts:313-321` already takes for the
`revoked_capability` reason.

Read `materialize.ts` fully before editing: `externallyQuarantined` is threaded from several
call sites and the parameter may be optional at some of them. Preserve the existing signature
shape and defaults.

**Verify**: `cd clients/lattice-client && npm run typecheck` → exit 0, and
`npm run carrier:feed` → the step-1 case now passes.

### Step 4: Count only real acknowledgements

In `clients/lattice-client/src/carrier.ts`, `syncCarrierOnce` must no longer treat
peer-advertised possession as acknowledgement.

Keep the `candidateFrames` filter — not re-pushing a frame the peer says it already has is a
sensible bandwidth optimisation and is safe on its own. What must change is that
`peerKnownFrameIds` **must not flow into `acknowledgedFrameIds`**. Only
`submitted.pushReport.accepted` and `submitted.confirmedDuplicateIds` — both of which are
responses to frames this session actually submitted — may acknowledge.

The consequence is intended: a frame the peer claims to hold but never acknowledged stays in
the outbox and is re-offered on a later sync. That is the correct trade — retention over silent
loss.

**Verify**: `cd clients/lattice-client && npm run typecheck` → exit 0, and
`npm run carrier:relay-sync` → the step-1 case now passes.

### Step 5: Bound outbox retention so the fix cannot become a leak

Step 4 means frames persist until genuinely acknowledged. Confirm this cannot grow without
limit: read `clients/township-tauri-shell/src/township_sync.ts` and establish whether anything
caps the persisted `carrierFrames` array.

- If a cap already exists, record where, and do nothing.
- If none exists, **do not add one in this plan.** Record it as a finding in your final report
  with the file and line where a cap would belong. Adding a retention policy is a design
  decision (drop-oldest silently loses data — the exact failure this plan is fixing) and it
  deserves its own plan rather than being smuggled into this one.

**Verify**: you have recorded the answer. No files changed in this step.

### Step 6: Full green

```bash
cd clients/lattice-client && npm run typecheck && npm run build && npm run conformance \
  && npm run carrier:relay && npm run carrier:relay-sync && npm run carrier:feed \
  && npm run carrier:township:live
cd ../township-tauri-shell && npm run typecheck
cd ../.. && $MIXCMD test
```

**Verify**: every command exits 0. Compare `npm run conformance` and
`npm run carrier:township:live` against the step-2 baseline — any newly-red case is a STOP
condition.

## Test plan

New cases, following the existing harness style in each file:

1. `clients/lattice-client/test/carrier_feed.ts` — materializing with a non-empty
   `externallyQuarantined` naming a valid `{:revoke, ...}` op produces the **same** authority
   result as materializing with an empty set. (Path 1: the carrier cannot hide a revoke.)
2. `clients/lattice-client/test/carrier_feed.ts` — when the reported quarantine set disagrees
   with the locally computed one, `materialize` throws `carrier_authority_report_divergence`
   rather than adopting the report.
3. `clients/lattice-client/test/carrier_relay_sync.ts` — a frame the peer advertises but which
   was never submitted does **not** appear in `acknowledgedFrameIds`.
4. `clients/lattice-client/test/carrier_relay_sync.ts` — a frame that *was* submitted and
   appears in `pushReport.accepted` **does** appear in `acknowledgedFrameIds` (the honest path
   still compacts).

Verification: `npm run carrier:feed` and `npm run carrier:relay-sync` → exit 0 with the four
new checks reported.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd clients/lattice-client && npm run typecheck` exits 0
- [ ] `cd clients/lattice-client && npm run conformance` exits 0
- [ ] `cd clients/lattice-client && npm run carrier:relay && npm run carrier:relay-sync && npm run carrier:feed && npm run carrier:township:live` — all exit 0
- [ ] `cd clients/township-tauri-shell && npm run typecheck` exits 0
- [ ] `$MIXCMD test` exits 0
- [ ] `grep -n "peerKnownFrameIds" clients/lattice-client/src/carrier.ts` shows it is no longer
      part of the `acknowledgedFrameIds` set
- [ ] `grep -n "authorityIncluded" clients/lattice-client/src/materialize.ts` shows it is no
      longer derived by subtracting `externallyQuarantined`
- [ ] The four new test cases from the test plan exist and pass
- [ ] `git status --porcelain` lists no file outside the in-scope list
- [ ] `plans/README.md` status row for 169 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Either step-1 case passes before you change source — that path is already fixed.
- `npm run conformance` or `npm run carrier:township:live` goes red after step 3 when it was
  green in step 2. That is a real BEAM↔TypeScript authority divergence that the carrier's
  verdict was masking. **Report it with the diverging op ids and reasons; do not restore the
  parameter to make it green.** This is the most important STOP condition in the plan — the
  whole point is to stop hiding exactly this.
- Removing `peerKnownFrameIds` from the acknowledgement set causes an existing gate to fail
  because it depended on frames being compacted without transmission. Report which gate.
- The fix appears to require editing `apps/lattice_carrier_server/**`,
  `clients/lattice-client/src/authority.ts`, or `clients/lattice-client/src/codec.ts`.
- You find a third path where an unsigned carrier control value changes local authority state
  (search: `grep -rn "stateReport\|state_result\|advertise()\|frontier_result" clients/*/src | grep -v dist`).
  Report it rather than expanding scope.

## Maintenance notes

For the human or agent who owns this next:

- **What a reviewer should scrutinize**: that no code path reintroduces "a value the peer sent
  us" into the authority analysis input. The rule to hold is simple — the carrier may tell the
  client *what exists*, never *what counts*.
- **Interacting future work**: plan 163 pins the TypeScript ingest to the paired replica in the
  same files. Land one, regenerate, then the other; simultaneous edits to `carrier.ts` will be
  painful to review.
- **Explicitly deferred, and why**:
  - *Outbox retention cap* (step 5). Needs a design decision, not a patch.
  - *The `generation` / `ops_available` hint.* Same unsigned-control-value shape, but its worst
    case is a spurious or missed pull, not a wrong authority verdict. Worth a follow-on that
    treats a generation regression as an alarm rather than a hard client failure.
  - *Channel authentication generally.* The deeper issue is that the carrier session
    authenticates the handshake and nothing after it — `apps/lattice_carrier_server` listens
    with `:ranch_tcp` + `:cowboy_clear` (`listener.ex:43`), so every post-handshake control
    frame is unauthenticated on the wire. This plan removes the *authority weight* from those
    frames rather than authenticating them. If control frames ever need to be trusted again,
    they need a MAC derived from the handshake first.
- **Documentation drift to fix once this lands**: `docs/threat_model_v2.md:78-80` says the
  carrier "cannot forge or tamper — any modification is caught by signature/hash verification."
  That is true of op bodies and false of control frames. After this plan the statement is much
  closer to true; the sentence should be narrowed to say so explicitly.
