# Plan 169: Stop letting carrier control frames decide authority or delete the outbox

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Reconciled drift check (run first)**:
> ```sh
> git diff --stat 51ead43e..HEAD -- clients/lattice-client/src/materialize.ts clients/lattice-client/src/carrier.ts clients/township-tauri-shell/src/township_feed.ts clients/township-tauri-shell/src/township_preview.ts clients/township-tauri-shell/src/township_sync.ts
> ```
> If any listed production file changed since the reconciled head, compare the live behavior
> against the amended design below and STOP on an invariant conflict. The "Vulnerable snapshot"
> excerpts are historical evidence from the planned-at commit, not current line-number assertions.

## Status

- **Priority**: **P0** — the carrier server decides which operations the client's own authority
  analysis is allowed to see, and separately induces the client to delete un-relayed work from
  its outbox. Both contradict the repo's central non-claim.
- **Effort**: M — two contained changes plus the tests that pin them.
- **Risk**: MED — removing the carrier's verdict from the analysis input means a genuine
  BEAM↔TypeScript authority divergence now surfaces as a visible error instead of being
  silently absorbed. That is the point, but it may light up existing gates. Step 0 measures it
  before you change behavior.
- **Depends on**: Plan 163 is landed. A Plan-172-adjacent structural-quarantine slice is also
  landed; preserve both invariants. Plan 172's full canonical strictness remains TODO.
- **Category**: security
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Execution reconciliation — 2026-08-08

The mandatory original drift check stopped execution at `51ead43e`. Plan 163 and a later
structural-quarantine slice landed after this plan was written and changed the shared production
surface:

- Plan 163 added caller-controlled `expectedReplica` anchors and rejects foreign-replica
  carrier frames before semantic ingest. This wiring stays intact.
- Commit `0169adb5` added `structurallyQuarantined` to `materialize/5`. Those ids must remain
  excluded from authority analysis; replacing `authorityIncluded` wholesale with `inc`, as the
  original Step 3 says, would regress malformed-term isolation. This does not mark the broader
  Plan 172 canonical-encoder work done.
- `test/conformance.ts` still pins the unsafe external-quarantine behavior, while the actual
  Township feed regression belongs to `clients/township-tauri-shell/test/township_feed.ts`
  (`feed:app:contract`), not the WebSocket-only `clients/lattice-client/test/carrier_feed.ts`.
- Existing live-carrier and relay-sync tests expose peer-advertised ids under the misleading
  `acknowledgedFrameIds` name. Their behavior remains green; only the result name and assertion
  labels change. The path-2 RED evidence is the missing durable second-peer re-offer and the
  failure-atomic archive/queue write, both in the Township sync harness.

This section and the amended scope/steps below supersede the stale excerpts and instructions
where they conflict. Before implementation, re-run the focused drift check from the reconciled
head:

```sh
git diff --stat 51ead43e..HEAD -- clients/lattice-client/src/materialize.ts clients/lattice-client/src/carrier.ts clients/township-tauri-shell/src/township_feed.ts clients/township-tauri-shell/src/township_preview.ts clients/township-tauri-shell/src/township_sync.ts
```

The reconciled design is:

1. `materialize` keeps structural quarantine local and load-bearing. Its authority input is
   `inc - structurallyQuarantined`; a carrier report never subtracts from analysis and never
   contributes to applied quarantine, state, or winners.
2. Replace the ambiguous bare external set with an optional diagnostic object containing both
   the carrier report's op-id domain and its authority-quarantine ids. `null` means no report;
   an explicit object whose quarantine set is empty means an actual empty report.
3. After the complete local quarantine pass, compare the final local `quarantine` ids within
   the report's op-id domain with the reported quarantine ids, excluding structural ids from both
   sides. On mismatch, throw `CarrierAuthorityReportDivergenceError` carrying sorted `localIds`
   and `reportedIds`. Use final quarantine membership rather than `quarantineReasons.keys()`
   because an authority rejection may be fail-closed before a reason is attributed.
4. The comparison is deliberately domain-bounded: locally authored, not-yet-relayed work stays
   locally judged but cannot make an honest carrier report diverge merely because that work is
   absent from the carrier's log.
5. A carrier response is not a cryptographic acknowledgement. Rename the generic result from
   `acknowledgedFrameIds` to `peerReportedFrameIds`; it is advisory queue telemetry only.
6. Make the signed `delegationFrames` archive the durable re-offer source. Before queue
   compaction, atomically merge every current outbox frame into that archive. On every later
   sync, offer the merged archive plus outbox entries whose `replica` equals `expectedReplica` to
   peers that do not report those ids. Thus a malicious carrier can withhold or lie to itself,
   but cannot erase the signed frame needed to heal a later honest peer or induce cross-replica
   egress from a contaminated archive.
7. Keep the pre-submission advertisement/filter as a bandwidth hint. `pushReport.accepted` and
   post-relay duplicate confirmation may compact the working outbox only after archival; none
   of these unsigned values removes the durable re-offer copy.
8. No persisted `carrierFrames` retention cap exists, and the durable archive is intentionally
   append-only. Do not invent a dropping policy here. Record the relay rate-limit/tail-starvation
   interaction for follow-on design work.
9. The known focused pre-change baselines at `51ead43e` are green. Step 0 establishes and records
   the expanded baseline set before RED tests modify any gate.

One known parity boundary remains outside this plan: BEAM can report
`unauthorized_tombstone`, while the TypeScript judge has no corresponding implementation. No
current baseline vector exercises that gap. If the amended diagnostic exposes it in a required
gate, preserve the divergence evidence and STOP rather than teaching the carrier report to the
judge or editing `authority.ts` in this plan.

## Execution evidence — 2026-08-08

- The pre-fix regressions failed for the intended reasons: the forged carrier diagnostic changed
  local authority, while the sync aggregate named both `second_peer_recovery` and
  `archive_save_before_queue_compaction`. The reviewed RED evidence is commit `5b39b047`.
- Carrier authority reports now compare against the complete local quarantine result only within
  the verified report domain. Matching empty/non-empty reports pass; forged reports throw the
  named divergence error before projection or persistence; structural quarantine remains local.
- Peer-reported frame ids are advisory queue telemetry. Every compacted outbox frame is saved to
  the append-only signed-frame archive first, and that archive is filtered to the expected replica
  and re-offered to later peers. The failure-injection and second-peer recovery cases pass.
- Replica-mismatched and legacy unbound outbox frames remain queued and are surfaced separately as
  `strandedReplicaFrameIds` / `unboundReplicaFrameIds` in the sync result and Township UI. Candidate
  frames that the peer does not already report are hash/signature verified locally before they
  become an egress path; failed candidates are omitted without blocking ingress and surfaced as
  `unverifiableFrameIds`.
- Carrier grant/revoke attribution is limited to frames both authored by the current device key and
  actually present in `pushedFrames`; forged peer ids and other participants' archived frames cannot
  produce local accepted/quarantined UI classifications.
- The local revoked-capability summary consumes only a locally verified, expected-replica allowlist
  independent of peer advertisement. Archive verification failures are excluded from that summary
  and surfaced separately as `unverifiableArchiveFrameIds`.
- Candidate verification runs concurrently while retaining candidate order. Queue/archive warning
  ids are deduplicated in the UI and change the sync tone from success to warning.
- Archive verification for the local revoked-capability summary is O(archive) on every sync with
  unbounded `Promise.all` fan-out and re-verifies frames pulled earlier in the same call. A durable
  verified-id cache and concurrency bound belong with the deferred cursoring/retention design.
- No retention cap exists for either `carrierFrames` or `delegationFrames` at the persistence block
  in `clients/township-tauri-shell/src/township_sync.ts`. This execution intentionally adds none:
  cursoring, batching, retention, and backoff must be designed together so the 120-burst/12-per-
  second relay limit cannot repeatedly starve a large archive's causal tail.
- A forged authority report intentionally fails closed before persistence. The controller resets
  its retry attempt after connecting, so the current 100 ms first-delay behavior can create a
  roughly 10 Hz reconnect/resubscribe storm. Circuit breaking and operator-visible backoff remain
  follow-on work.
- `delegationFrames` now has two roles that can conflict after a pending, rejected, foreign, or
  unbound local frame: it is the durable re-offer archive, while feed refresh currently requires
  its complete id set to equal the carrier report's log. Feed refresh therefore fails closed. The
  parallel exact-set check in `township_sync.ts` instead returns the local revocation summary and
  silently skips its carrier divergence assertion, failing open. A permanently rejected frame is
  also re-offered on every sync because it can never enter the peer advertisement. These couplings
  predate this implementation, but durable archival makes them persistent. A follow-on must compare
  reports only with verified carrier-held frames and define rejected-frame progress without
  weakening local re-offer durability or authority diagnostics.
- All library and shell gates listed below passed, including the live 2-pushed/2-accepted
  invariant and all onboarding/release probes. `mix verify`, `mix check`, and both boundary-app
  Sobelow scans also exited 0 under the required OTP 28 toolchain.

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

## Vulnerable snapshot at the planned-at commit

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
| TS carrier materialization | `cd clients/lattice-client && npm run carrier:township` | exit 0 |
| TS live carrier | `cd clients/lattice-client && npm run carrier:township:live` | exit 0 |
| TS build (regenerates `dist/`) | `cd clients/lattice-client && npm run build` | exit 0 |
| Shell typecheck | `cd clients/township-tauri-shell && npm run typecheck` | exit 0 |
| Shell feed application | `cd clients/township-tauri-shell && npm run feed:app:contract` | exit 0 |
| Shell sync | `cd clients/township-tauri-shell && npm run sync:contract` | exit 0 |
| Shell live peer | `cd clients/township-tauri-shell && npm run live:contract` | exit 0 |
| Shell onboarding | `cd clients/township-tauri-shell && npm run onboarding:contract` | exit 0 |
| Shell release sync consumers | `cd clients/township-tauri-shell && npm run release:sync:contract && npm run release:author:contract && npm run release:root-origination:contract && npm run release:pairing:contract` | all exit 0 |
| Shell static wiring | `cd clients/township-tauri-shell && npm run frontend:contract` | exit 0 |
| Elixir suite | `$MIXCMD test` | exit 0 |

Baseline at the planned-at commit: `$MIXCMD test` exits 0.

## Scope

**In scope**:

- `clients/lattice-client/src/materialize.ts` — carrier-report diagnostic input, local comparison,
  and the named divergence error; preserve structural quarantine and replica anchoring
- `clients/lattice-client/src/carrier.ts` — rename the advisory peer-reported-id result so callers
  cannot mistake it for authenticated acknowledgement; retain the existing submission filter
- `clients/township-tauri-shell/src/township_feed.ts` — `validateCarrierStateReport` and its
  preview call site
- `clients/township-tauri-shell/src/township_preview.ts` — thread the explicit diagnostic object
- `clients/township-tauri-shell/src/township_sync.ts` — pass the no-report sentinel at the local
  materialization call, re-offer the durable frame archive, and archive the current outbox before
  advisory compaction; filter all egress candidates to `expectedReplica`; do not change its
  independent `revoked_capability` cross-check
- `clients/township-tauri-shell/src/App.vue` — surface foreign-replica and legacy-unbound outbox
  warnings after every higher-priority authority, revocation, and per-sync status message
- `clients/township-tauri-shell/src/style.css` — render successful syncs with retained queue/archive
  warnings as warnings rather than success
- `clients/lattice-client/test/conformance.ts` — replace the unsafe externally-determined
  quarantine regression with local-judge/diagnostic cases
- `clients/lattice-client/test/carrier_relay_sync.ts` — rename result assertions and keep
  pre-advertisement versus post-relay-report semantics explicit
- `clients/lattice-client/test/carrier.ts` — explicit no-report call sites and structural
  quarantine preservation
- `clients/lattice-client/test/live_carrier.ts` — rename the advisory result assertion; preserve
  the live evidence that already-present ids are not reported accepted
- `clients/township-tauri-shell/test/township_feed.ts` — end-to-end valid-revoke false-report
  divergence and persistence refusal
- `clients/township-tauri-shell/test/township_sync.ts` — prove a lying first peer cannot prevent a
  later honest peer from receiving the archived frame, plus archive-before-compaction assertions
- `clients/township-tauri-shell/test/township_live_peer.ts` — preserve the live push/acceptance and
  outbox expectations while the candidate source changes
- `clients/township-tauri-shell/test/township_onboarding.ts` — preserve the second-sync candidate,
  compaction-count, and pushed-frame contract
- `clients/township-tauri-shell/test/township_release_author_probe.ts`,
  `township_release_pairing_probe.ts`, `township_release_root_origination_probe.ts`, and
  `township_release_sync_probe.ts` — indirect sync consumers whose compaction assertions must stay
  green or be updated only for the archive-source semantics
- `clients/township-tauri-shell/test/frontend_shell.mjs` — update the static preview wiring pin
- `clients/lattice-client/dist/**` — regenerated by `npm run build`, **never hand-edited**
- `plans/169-carrier-control-frames-carry-no-authority.md` — this reconciliation and execution evidence
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- `apps/lattice_carrier_server/**` and `apps/lattice_core/lib/township/carrier_state_report.ex`.
  The server computing a report is not the bug — it is opt-in per manifest and its own moduledoc
  discloses what it derives. **The bug is the client trusting it.** Fixing this server-side would
  hide the divergence signal this plan exists to create.
- `clients/lattice-client/src/authority.ts` — plans 162 and 163 own it.
- The **replica pinning** work on the receive path. Plan 163 has landed; preserve its
  `expectedReplica` filter and caller wiring unchanged. If this work weakens or duplicates that
  filter, STOP: the plans collided.
- `clients/lattice-client/src/codec.ts` — plan 172 owns it.
- The `generation` / `ops_available` subscription path. It has the same "unsigned control value
  with teeth" shape, but it is a liveness hint whose worst case is a spurious or missed pull.
  Deliberately deferred — see Maintenance notes.

## Git workflow

- Branch: `codex/169-carrier-control-frames-carry-no-authority`
- Conventional commits matching `git log`, e.g.
  `test(carrier): add RED carrier-verdict and false-ack regressions`, then
  `fix(carrier): stop trusting carrier control frames for authority`.
- Commit the RED tests separately from the fix. The RED commit uses the current API: it changes
  expectations but does not introduce the diagnostic-object type before production owns it.
- Before **each** commit, obtain an adversarial Claude Opus 5 review, address every actionable
  finding, and re-review the exact final diff.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 0: Record the complete green baseline before changing tests

Run every focused gate that later participates in a STOP decision:

```bash
cd clients/lattice-client
npm run build && npm run conformance && npm run carrier:relay && npm run carrier:relay-sync && npm run carrier:feed \
  && npm run carrier:township && npm run carrier:township:live
cd ../township-tauri-shell
npm run typecheck && npm run frontend:contract && npm run feed:app:contract \
  && npm run sync:contract && npm run live:contract && npm run onboarding:contract \
  && npm run release:sync:contract && npm run release:author:contract \
  && npm run release:root-origination:contract && npm run release:pairing:contract
```

Record every exit code before editing a test. A gate that is not green here is a pre-existing
blocker; do not use RED-test failures as its baseline.

### Step 1: Write the two-path failing (RED) regressions first

Add the path-1 RED coverage in the harnesses that actually own it:

- In `clients/lattice-client/test/conformance.ts`, replace the current "externally determined
  quarantine" expectations with assertions that an omitted report leaves the local result
  unchanged and a carrier set that names a locally-honored op throws the named divergence error.
  Under the pre-fix API, keep using its existing explicit Set so the test compiles and fails at
  runtime rather than changing production types in the RED commit.
- In `clients/township-tauri-shell/test/township_feed.ts`, reuse its existing
  `authorityRevocation` fixture. Make the carrier report falsely name the valid revoke op (and
  suppress the locally quarantined revoked command), then assert refresh rejects with
  `carrier_authority_report_divergence`, carries the local/reported ids, and persists neither the
  log nor delegation frames. Today refresh silently adopts that set, so this case fails.
This matches Step 3's planned divergence behavior — do not assert identical authority results for
this case.

Add path-2 RED coverage to `clients/township-tauri-shell/test/township_sync.ts`: sync an authored
frame to a first client that falsely advertises it. Confirm the working outbox compacts only after
the signed frame enters `delegationFrames`. Then sync the same workflow to a second, honest client
whose advertisement is empty and assert that it receives the archived frame. Today the first sync
archives the frame, but the second passes only the now-empty `carrierFrames` queue to
`syncCarrierOnce`, so the recovery assertion fails.

Add a second path-2 RED case with a failure-injecting frame store whose `delegationFrames.save`
rejects and whose `carrierFrames.save` records any invocation. Assert sync fails and queue save is
never called. Do not infer this from generic command ordering: the current `Promise.all` starts the
queue save before the archive failure settles, so only the failure-injection assertion proves the
required write dependency.

The sync harness aborts on its first uncaught assertion. Wrap only these two new path-2 cases in a
small labelled failure accumulator, execute both cases, and assert the accumulator is empty once
at the end. The pre-fix RED output must therefore name both `second_peer_recovery` and
`archive_save_before_queue_compaction`; after the fix the same accumulator is empty. Do not
convert the rest of the script into a custom runner.

Read all three test files first and follow their existing harnesses. Reuse
`RecordingCarrierClient`/`MixedAckCarrierClient` in `township_sync.ts`; no call-indexed
advertisement script is needed.

**Verify RED**:

```bash
cd clients/lattice-client
npm run conformance
cd ../township-tauri-shell
npm run feed:app:contract
npm run sync:contract
```

The forged-diagnostic assertion fails in its owning script, while the single labelled path-2
aggregate reports both intended failures. The first-sync assertion that the frame enters the
archive is expected to pass already. Unrelated assertions remain green. If the forged diagnostic
does not fail, or either path-2 label is absent from the aggregate, STOP — that path is already
fixed and this plan is stale for it.

### Step 2: Adversarially review and commit only the RED evidence

Run Claude Opus 5 against the exact test diff. Address every finding and re-review until clean.
Commit only the tests after confirming each new assertion fails for its named pre-fix reason and
every unrelated assertion still reaches its prior result. The RED commit uses the current Set and
current `acknowledgedFrameIds` API; production types change only in Step 3/4.

### Step 3: Make the carrier's verdict advisory, not authoritative

In `clients/lattice-client/src/materialize.ts`, replace the bare external Set with an exported
diagnostic shape containing `opIds` and `quarantinedIds`; `null` is the default/no-report sentinel.
Export `CarrierAuthorityReportDivergenceError`, whose message contains
`carrier_authority_report_divergence` and whose sorted `localIds` / `reportedIds` fields are
machine-readable.

Preserve the landed structural-quarantine slice: `authorityIncluded` is
`inc - structurallyQuarantined` and `authorityOrder` is filtered to that set. Remove only
`externallyQuarantined` from authority input and from the applied `quarantined` set. Complete the
local `isQuarantined` pass first. Then:

- restrict local comparison ids to the diagnostic's `opIds` domain;
- derive them from the final local `quarantine` array;
- exclude `structurallyQuarantined` from both the local and reported sides before comparing,
  because BEAM authority quarantine and TypeScript structural quarantine are separate categories;
- compare the remaining ids exactly;
- treat any reported quarantine id in the report domain that has no non-structural local member
  in `inc` as a divergence, not as an id to ignore;
- throw the named error on mismatch before reduction/persistence can expose a projection.

In `township_feed.ts`, validation still requires the report op ids to match verified frames and
reported quarantine ids to be a subset. Return the diagnostic object rather than an authoritative
Set. In `township_preview.ts`, thread the object to `materialize`. Update the explicit local-only
callers in `township_sync.ts` and `test/carrier.ts` to pass `null` when they need the later
`expectedReplica` argument. Update the static wiring assertion literally.

**Verify**:

```bash
cd clients/lattice-client
npm run typecheck && npm run conformance && npm run carrier:township && npm run build
cd ../township-tauri-shell
npm run typecheck && npm run feed:app:contract && npm run frontend:contract
npm run sync:contract
```

The first line and the shell typecheck/feed/frontend chain exit 0, including matching non-empty and
matching empty diagnostics, a forged non-empty diagnostic, an honest carrier report with
local-only work outside its op-id domain, and structural quarantine preservation.
`sync:contract` reaches the single aggregate failure naming only the two still-RED path-2 cases
from Step 1; every earlier assertion passes, proving the changed local `materialize` call runs
correctly before the Step-4 queue fix. Compare honest authority results with Step 0; a newly-red
honest carrier case is the authority-parity STOP condition. `feed:app:contract` is the end-to-end gate that passes a BEAM
`authority_quarantine` through the new materialization diagnostic; `carrier:township:live` remains
useful parity evidence but does not exercise that wiring.

### Step 4: Make queue compaction recoverable without trusting carrier responses

In `clients/lattice-client/src/carrier.ts`, rename `acknowledgedFrameIds` to
`peerReportedFrameIds` throughout the public result and tests. Preserve the existing
pre-submission advertisement/filter, accepted ids, and post-relay duplicate check, but describe
their union as unsigned advisory telemetry. Do not call any of it an acknowledgement.

In `clients/township-tauri-shell/src/township_sync.ts`:

1. Build the sync candidate set with `mergeCarrierFrames([...localDelegationFrames,
   ...localCarrierFrames])`, then filter it to frames whose `replica === expectedReplica` before
   calling `syncCarrierOnce`. The durable signed archive—not the compactable queue—is the source
   of future re-offers, but a contaminated or legacy cross-replica archive must never become an
   egress path.
2. In the existing persistence write lock, merge `currentCarrierFrames` into
   `currentDelegationFrames` before filtering the queue by `peerReportedFrameIds`. First await the
   archive save (it may share a `Promise.all` with the local-log save); only after that resolves may
   `carrierFrames.save(compactedCarrierFrames)` begin. Do not put archive and queue saves in the
   same `Promise.all`: a rejected archive save must leave the queue untouched. A concurrent
   authoring write must also be archived before any matching id is removed.
3. Derive the public `compactedFrameIds` from the intersection of the reloaded current outbox and
   `peerReportedFrameIds`, and set `compactedFrameCount` from that actual removed-id list. Archive
   candidates that were not in the working queue must not inflate UI compaction telemetry. The
   removal's safety comes from prior local archival, not from trusting the peer.

Update evidence:

- `carrier_relay_sync.ts` and `live_carrier.ts`: rename result assertions only. Preserve current
  advertisement scripts, the live pushed count of 2, accepted count of 2, and the evidence that
  already-present push frames are not reported accepted.
- `township_sync.ts`: assert archive-before-compaction, then prove a later empty honest peer is
  offered the archived frame that the first peer falsely claimed. Explicitly update every fixture
  that seeds a non-empty `delegationFrames` archive: archive candidates widen the push set, so
  cumulative `RecordingCarrierClient` acceptance and positional `MixedAckCarrierClient` outcomes
  must become id-keyed or their assertions must include the archive frames. Preserve the intended
  grant/revoke classifications. Keep the empty-archive partial/mixed/retry relay expectations
  unless the field rename directly requires an edit.
- Add a foreign-replica archive frame beside an expected-replica frame and assert the recording
  client receives only the expected-replica frame. This is a green fix assertion, not a pre-fix RED
  case, because the old code did not submit the archive at all.
- `township_live_peer.ts`: run unchanged behaviorally; its 2 pushed/2 accepted/empty working
  outbox expectations must remain green.
- `township_onboarding.ts` and the four scoped release probes: preserve their intended second-sync
  and compaction semantics. Update only assertions whose candidate set honestly widens to the
  archive; keep actual removed-id counts exact.

The carrier may still deny availability to its own session, lie in `accepted`, or lie in the
post-relay advertisement. Those values can trim a working queue but cannot remove the durable
signed re-offer copy. A later honest peer can therefore heal the log.

**Verify**:

```bash
cd clients/lattice-client
npm run typecheck && npm run carrier:relay-sync && npm run carrier:township:live && npm run build
cd ../township-tauri-shell
npm run sync:contract && npm run live:contract && npm run onboarding:contract \
  && npm run release:sync:contract && npm run release:author:contract \
  && npm run release:root-origination:contract && npm run release:pairing:contract
```

All exit 0, including the two-peer recovery regression. Any behavior change in the pushed or
accepted counts of `carrier:township:live` or `live:contract` is a STOP condition; archive-seeded
unit/probe fixtures may widen only where explicitly asserted above.

### Step 5: Measure and record the durable-retention boundary

Step 4 makes `delegationFrames` the durable re-offer archive. Read
`clients/township-tauri-shell/src/township_sync.ts` and establish whether anything caps either the
working `carrierFrames` queue or the durable archive.

- If a cap already exists, record where, and do nothing.
- If none exists, **do not add one in this plan.** Record it as a finding in your final report
  with the file and line where a policy would belong. Also record that a new relay peer receiving
  a large archive can repeatedly hit the server's 120-burst/12-per-second limit while the current
  causal loop restarts from the front, starving the tail. Retention, batching, cursoring, and
  backoff are one design decision; a drop-oldest cap would silently lose the exact recovery
  evidence this plan protects.
- Record the intentional fail-closed liveness effect of a forged authority report: feed refresh
  throws before persistence after a successful connection, so `createTownshipFeedController`
  resets its attempt counter and reconnects after `reconnectDelay(0)`—100 ms—on every cycle. The
  resulting roughly 10 Hz reconnect/resubscribe storm is preferable to a forged projection but
  needs an operator-visible circuit breaker and backoff that also respects carrier rate limits.

**Verify**: you have recorded the answer. No files changed in this step.

### Step 6: Full green

```bash
cd clients/lattice-client && npm run typecheck && npm run build && npm run conformance \
  && npm run carrier:relay && npm run carrier:relay-sync && npm run carrier:feed \
  && npm run carrier:township && npm run carrier:township:live
cd ../township-tauri-shell && npm run typecheck && npm run frontend:contract \
  && npm run feed:app:contract && npm run sync:contract && npm run live:contract \
  && npm run onboarding:contract && npm run release:sync:contract \
  && npm run release:author:contract && npm run release:root-origination:contract \
  && npm run release:pairing:contract
cd ../.. && $MIXCMD test
```

**Verify**: every command exits 0. Compare `npm run conformance` and
`npm run carrier:township:live` against the Step-0 baseline — any newly-red case is a STOP
condition.

## Test plan

New/amended cases, following the existing harness style in each file:

1. `clients/lattice-client/test/conformance.ts` — no-report materialization stays locally
   determined; matching empty/non-empty reports pass; forged empty/non-empty reports throw the
   named error with both sorted id sets; local-only ids outside the report domain do not diverge;
   structural quarantine remains excluded from authority analysis and report comparison.
2. `clients/township-tauri-shell/test/township_feed.ts` — a report naming the valid revoke op
   instead of the locally revoked-capability command throws before persistence, while the honest
   revocation report still projects the locally decided state.
3. `clients/lattice-client/test/carrier_relay_sync.ts` — pre-submit advertisement, accepted
   response, and post-relay confirmed/unconfirmed duplicate paths remain distinct but are exposed
   only as `peerReportedFrameIds`.
4. `clients/township-tauri-shell/test/township_sync.ts` — every compacted queue frame first exists
   in the durable archive; a second honest peer receives a frame the first peer falsely claimed;
   an archive-save failure never starts queue compaction; foreign-replica archive frames never
   egress; partial/mixed/retry paths preserve their existing behavior.
5. `clients/lattice-client/test/live_carrier.ts` and shell `township_live_peer.ts` — the live
   pushed/accepted counts remain 2, the working outbox compacts, and the durable archive retains
   the complete signed frame set for later peer healing.
6. `township_onboarding.ts` and the four scoped release probes — second-sync, pushed-frame, and
   compaction assertions remain exact when the durable archive joins the candidate set.

## Done criteria

Machine-checkable. ALL must hold:

- [x] `cd clients/lattice-client && npm run typecheck` exits 0
- [x] `cd clients/lattice-client && npm run conformance` exits 0
- [x] `cd clients/lattice-client && npm run carrier:relay && npm run carrier:relay-sync && npm run carrier:feed && npm run carrier:township && npm run carrier:township:live` — all exit 0
- [x] `cd clients/township-tauri-shell && npm run typecheck && npm run frontend:contract && npm run feed:app:contract && npm run sync:contract && npm run live:contract && npm run onboarding:contract && npm run release:sync:contract && npm run release:author:contract && npm run release:root-origination:contract && npm run release:pairing:contract` — all exit 0
- [x] `$MIXCMD test` exits 0
- [x] `rg -n "acknowledgedFrameIds" clients/lattice-client clients/township-tauri-shell` returns no
      match in source, tests, or regenerated `dist/`
- [x] `grep -n "authorityIncluded" clients/lattice-client/src/materialize.ts` shows it is no
      longer derived by subtracting a carrier report and still excludes structural quarantine
- [x] The diagnostic object carries both report op ids and quarantine ids; carrier ids never
      enter the local applied-quarantine set
- [x] Every id removed from `carrierFrames` has first been merged into `delegationFrames`, and
      the next sync candidate set includes that durable archive
- [x] All six test groups from the amended test plan exist and pass
- [x] `git status --porcelain` lists no file outside the in-scope list
- [x] `plans/README.md` status row for 169 updated

## STOP conditions

Stop and report back (do not improvise) if:

- The forged diagnostic does not fail before source changes, or either
  `second_peer_recovery`/`archive_save_before_queue_compaction` label is absent from the pre-fix
  aggregate — that specific path is already fixed. The first-sync archive-presence assertion is
  expected green and is not a STOP trigger.
- `npm run conformance` or `npm run feed:app:contract` goes red after Step 3 for an honest report
  when it was green in Step 0. That is a real BEAM↔TypeScript authority divergence that the carrier's
  verdict was masking. **Report it with the diverging op ids and reasons; do not restore the
  parameter to make it green.** This is the most important STOP condition in the plan — the
  whole point is to stop hiding exactly this.
- `township_live_peer.ts` no longer pushes and accepts exactly the two genuinely missing frames,
  or the first live sync no longer archives the complete signed set before emptying its working
  outbox.
- The two-peer recovery regression requires trusting a carrier response, deleting an archive
  frame, or editing a server boundary. Preserve the failing evidence; do not call an unsigned
  response an acknowledgement to make it green.
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
- **Outbox invariant**: carrier reports may optimize the working queue only after its signed frame
  exists in the durable archive, and that archive participates in every later peer sync. This
  reduces a lying carrier to availability failure against its own session.
- **Interacting landed work**: plan 163 pins TypeScript ingest to the paired replica, while commit
  `0169adb5` structurally quarantines malformed decoded terms. Both are explicit invariants of the
  reconciled implementation; Plan 172's remaining canonical strictness stays TODO in the ledger.
- **Explicitly deferred, and why**:
  - *Queue/archive retention, relay cursoring, and backoff* (step 5). The archive cannot use a
    silent dropping cap, while a large archive re-offered through the 120-burst/12-per-second
    relay limit can starve its causal tail if every retry starts at the front. This needs a
    combined retention and progress design, not a patch.
  - *Authority-report divergence circuit breaking.* A forged or genuinely divergent report now
    fails closed before persistence. Because a successful connection resets the retry counter
    before refresh, the feed controller then reconnects every 100 ms rather than climbing its
    backoff ladder. A later plan should make that alarm operator-visible and avoid this indefinite
    roughly 10 Hz retry storm without weakening the fail-closed result.
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
