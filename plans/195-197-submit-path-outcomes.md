# Plan 195 and 197: Name every relay submit outcome once (own quarantined frames stop acking; a submit error keeps the pass's progress)

> **Executor instructions**: Follow this plan step by step and run every verification command. If a
> STOP condition occurs, stop and report. Rows 195 and 197 share `treehouse_sync.ts` and `fake_relay.ts`, so
> 195 lands first. Line numbers were read at `50e6aec34`; the pre-change line map is in this file's history
> at `afe764eb4` and in PR #131.

## Status

- **Priority**: P3
- **Effort**: M (195 is S; 197 is the M, because `carrier.ts` is the shared client)
- **Risk**: LOW–MED (shell sync loop and feed state; one additive, default-off option and one
  error subclass in `clients/lattice-client/src/carrier.ts`; no server, custody, signing, wire-codec
  or persisted-state change)
- **Depends on**: 181 (DONE), 196 (DONE, PR #129: the 10 s dial and 30 s request bounds this plan
  leaves alone). Row 197 is sequenced after 195 because both edit the one submit path.
- **Category**: correctness (ends two finding classes from the Plan 181 closeout review: an
  acknowledgement the relay never made durable, and progress thrown away by a submit error)
- **Planned at**: commit `50e6aec34`, 2026-10-16
- **Policy fit**: rule 1 claim tier is **core** (shell unit tests over the in-process relay stand-in,
  `lattice-client` tests over scripted clients), with the two real-socket gates run once as
  non-regression, not as new evidence. Rule 3: `carrier.ts` edit, so this PR gets the adversarial
  review and a second independent review (Codex Sol). Rule 6: no test asserts on prose. Rule 7: row
  200's missing messages stay row 200; this plan adds a reason string and two data fields, not copy.

## Why this matters

Plan 181's Treehouse shell submits each locally authored frame to the relay one at a time and
records an acknowledgement (`acked`) only for ids the relay made durable. Two paths break that.

**Row 195.** The shell acks an own frame the relay answers with the `quarantined` bucket
(`treehouse_sync.ts:229-235`). The real relay stores a structurally quarantined op only as evidence:
it is not in the log's op set, so it is never advertised and never served (`log.ex:214-219`, pinned by
`treehouse_route_boot_test.exs:104-113`). The sync panel therefore says "acknowledged" for an
operation that no member, including this device on its next pull, can ever read back, and
`matchesRelay` stays false for good. The in-process stand-in (`fake_relay.ts:66,108-121`) stores and
advertises exactly those ops and invents a report reason (`"authority"`) that the real client refuses
to decode, so every shell test passed over the bug.

**Row 197.** `submitCarrierFrames` rethrows every relay error reply except `rate_limited`
(`carrier.ts:1320-1326`). Everything the pass had already gathered is lost with the throw: the frames
it pulled (verified, ready to commit), and the acks for frames the relay accepted earlier in the same
pass. One bad frame therefore wedges the whole route: frame 3 gets an error, frames 1 and 2 were durable
but are never acked because the closing advertise is never reached, and no foreign frame is ever merged.
The feed then treats the throw as a connection failure and redials, walking the backoff table to a 5 s
cadence (`treehouse_feed.ts` `reconnectDelay`), forever, for replies a redial cannot change.

Both come from the same thing: the shell has never written down the closed set of replies a relay can
give to a submit, and what each one means for durability. This plan writes it down once (below), makes the
shell and the stand-in agree with it, and changes only what the table says is wrong.

## The relay's closed reply set

Read from source, not from the row text. "Served" means a later `pull` can return the op; "advertised"
means a later `frontier` lists its id.

### Report outcomes (a `relay_result`, the socket stays healthy)

A submit runs `Sync.deliver(log, [op])` (`holder.ex:221`), which calls `Log.accept` once and files the
result into one report bucket (`sync.ex:88-107`, finalized `sync.ex:117-125`). Reasons on the wire are the
closed list `already_quarantined | bad_signature | wrong_replica` (`wire_vocabulary.ex:233`,
`wire_vocabulary.ts:216-220`); the client refuses any other (`carrier.ts:2449-2456`).

| Outcome | Source of the verdict | Persisted | Advertised / served | Notes |
|---|---|---|---|---|
| `accepted: [id]` | `log.ex:223` insert, `sync.ex:95` | yes, before the reply (`holder.ex:378-384`) | yes (`holder.ex:241`; `sync.ex:34-38`) | generation bumps (`holder.ex:458`) |
| empty report (duplicate) | id already in the op set, `log.ex:207-208`; `sync.ex:95` `was_present` | no write (`holder.ex:374-376`) | already yes | the shell must confirm by a fresh advertise (`carrier.ts:1329-1334`) |
| `quarantined: [id, bad_signature]` | `Op.valid?` false, first time, `log.ex:214,218` | yes, in `log.quarantine` only (dump includes it, `log.ex:267-272`) | **no**: not in `op_ids`/`topo_ops` (`log.ex:75,79`), so not paged (`holder.ex:241,246`); `treehouse_route_boot_test.exs:104-113` asserts the advertise excludes it | the generation still bumps (`holder.ex:458` counts quarantine), so a hint fires for nothing pullable |
| `quarantined: [id, already_quarantined]` | same id quarantined before and still invalid, `log.ex:215-216` | no write: log unchanged, `persist_relay/3` first clause (`holder.ex:374-376`) | no | the resubmit of a stuck frame costs the relay one token and zero writes |
| `rejected: [id, wrong_replica]` | `op.replica != log.replica`, `log.ex:204-205` | no | no | cannot happen to a retained own frame (`verifyProfile` pins `frame.replica`, `treehouse_workflow.ts:175-178`) |
| `pending: [id]` | a dep is absent, `log.ex:222-224`; `sync.ex:101-102,123` | no | no | any frame whose dependency was quarantined, rejected or never sent |

**Authority failure is not a bucket.** A capability or role failure is decided at reduction time, not at
delivery (`log.ex:20-26`), so the relay stores the op and reports it `accepted`
(`treehouse_route_boot_test.exs:76-93`, the `no_cap` and `weak_post` cases). `Lattice.Sim` does the same:
it inserts and lets `Authority.analyze` rule (`sim.ex:323-330`). The stand-in's `"quarantined"` with reason
`"authority"` therefore models nothing real.

### Error replies (`{type: "error", reason}`, the socket stays open, `carrier.ts:1062` throws)

| Reason | Source | Meaning for a `relay` submit | Durable? |
|---|---|---|---|
| `rate_limited` | `web_socket.ex:196` (token bucket, burst 120, 12/s, `:22-29`) | nothing was judged; retry after a refill | no |
| `read_only` | `web_socket.ex:250-251` ← `holder.ex:224` (peer realm not in `relay_realms`); also `:241`, `:272` (unknown request type, including a generic `push`) | this realm may read, not submit; permanent until the operator changes the route's relay realms | no |
| `malformed` | `web_socket.ex:253-254` (`Wire.decode_op` failed), `:267-268` (no `op`), `:67` (bad JSON or shape) | the relay could not decode this frame's bytes; deterministic for the same bytes | no |
| `unavailable` | `web_socket.ex:256-263` (`persistence_failed`; the holder keeps its old log, `holder.ex:386-387`) | the relay judged the op but could not make it durable; transient | no |
| `unauthenticated` | `web_socket.ex:149,162` | no session; cannot occur after a completed hello | no |
| `unsupported_frame` | `web_socket.ex:74` (binary frame) | this client never sends one | no |
| `malformed_cursor`, `stale_cursor` | `holder.ex:260-273`, `web_socket.ex:226-228` | read path only (`advertise`/`pull` pagination); never a reply to `relay` | n/a |

### Not a reply: the connection drops

`holder.ex:209-214` returns `{:error, :release_closed}` while the operator quiesces a release, and
`GenServer.call` on `Holder.relay` can exit on its own timeout (`holder.ex:62-66,501-504`). The relay
handler's `with ... else` has no arm for either (`web_socket.ex:245-264`), so the handler raises and the
socket closes. A frame larger than 64,000 bytes is closed by cowboy (`web_socket.ex:15,40`). The client sees
`carrier websocket closed` or, if nothing arrives, `carrier request timeout` (`carrier.ts:1050-1062`; the
bound is row 196's). This is the right fail-closed behavior for the client to treat as "reconnect with
backoff", and it is already what the feed does. It is an **observed server gap** (a quiesce could answer
`unavailable` instead of killing the socket), recorded here and left to the operator; it is not a STOP, the
reply contract above is intact.

## What a structurally quarantined own frame is

1. **It cannot normally exist.** An own frame reaches `client.relay()` only after it passed strict Ed25519
   in the shell (`verifyProfile`, `treehouse_workflow.ts:164-191`, run on every persist) and again in
   `syncCarrierOnce` (candidates failing `verifyCarrierOp` are dropped from egress,
   `carrier.ts:1246-1257`). A relay that answers `bad_signature` for it is therefore either a TS/BEAM
   verifier or canonical-encoding divergence, or a relay that lies (the report is unsigned). Both are
   conditions an operator must see; neither is "wait and it will arrive".
2. **The relay never serves it back.** Persisted as evidence only (table above), so a later pull cannot
   restore it to `matchesRelay`, and nobody else will ever hold it.
3. **`Lattice.Sim` cannot author it**: `Sim.append` uses `Log.append!`, which raises on anything but `:ok`
   (`log.ex:234-241`, `sim.ex:262-266`). Delivered from elsewhere, Sim files it in `log.quarantine`, out of
   `ops`, out of state, out of `Sim.quarantined/3` (which reads only the authority set, `sim.ex:323-330`),
   and out of `Sim.sync`'s transfer (`topo_ops`). The relay and Sim agree: it is absent from the log.
4. **Its dependents are blocked, not lost.** Every later own frame depends on the frontier, so it names the
   quarantined id as a dep; the relay answers each `pending` (`log.ex:222-224`). They stay in the outbox,
   never acked, resubmitted each sync exactly as `pending` frames are today (no new cost class).

## The rule (195)

A structurally quarantined **own** frame is a **standing refusal: visible, never acked, and resubmitted once per sync**. It is not "terminal" in the persisted sense (nothing records it) and not "retried forever" in the loop sense (at most one attempt per sync, none inside a sync after the first reply):

- It is never acked. `acked` means "durable and readable back on the relay"; a quarantined op is neither.
  The ack set becomes accepted plus relay-confirmed presence only (the `accepted` bucket, a confirmed
  duplicate, or a fresh advertise listing the id).
- It stays in the outbox and stays unacked, so `pending = outbox − acked` still counts it. Retained history
  never shrinks and nothing is deleted.
- It is **not retried inside a sync**: the sync records every id the relay replied to and never resubmits it
  in a later round of the same call.
- It **is** resubmitted once per later sync. The relay answers `already_quarantined` with no write
  (`holder.ex:374-376`), and a fixed or replaced relay that now accepts the frame heals the route with no
  special case. This costs one relay token per stuck frame per sync; a refused chain of N frames costs N,
  which is what the `pending` dependents already cost today.
- It is **visible**: the result already carries it in `quarantined` as `[id, reason]`; the feed and panel
  state gain `refused` (below) so a reason string is shown instead of "acknowledged".

**No persisted field.** `LocalProfile` keeps `{product, replica, frames, outbox, acked}`
(`treehouse_state.ts:14-21`); `mergeSync` is unchanged (`treehouse_workflow.ts:735-791`, it already only
acks held, authored ids). The refusal is a live relay verdict recomputed by the resubmit, so no migration,
no parse change, and a relay that changes its mind is believed. The cost of that choice is the one
resubmit per sync stated above; the alternative (a persisted `refused` marker) would need a `parseState`
migration and would freeze a verdict from a relay the shell does not trust to be right. Not chosen.

**Profiles saved by the previous build.** Before this change a `quarantined` reply acked the frame, and
`acked` never shrinks (`assertRetainedMonotonic`, `mergeSync` only adds), so such a profile keeps the false
ack. It is not repaired in storage; it is not trusted in reporting. `syncTreehouseRoute` adds any id the relay
quarantined or rejected in this sync and does not list to `pendingIds`, and the feed's `pending`/`acked` counts
treat the last sync's `refused` ids as pending, so the panel stops calling them acknowledged as soon as one
sync has run. Until that first sync (and after a restart) the saved set is what the counts show. A relay that
later accepts the frame settles it with no special case.

**`matchesRelay` stays the literal equality it is today** (local ids equal the closing advertise). The
expected direction was to drop refused ids from the comparison; the source argues against it:
(a) their dependents are `pending` and would have to be dropped too (the transitive closure), or the flag
stays false in the normal case anyway; dropping the closure turns the flag true while undelivered frames
exist, which is the optimism this plan removes; (b) a pending own frame already makes the flag false, so a
refused one is the same signal, not a new inconsistency; (c) nothing gates on the flag (it only feeds the
panel label, `treehouse_feed.ts:246-262`, `treehouse_panel_sync.ts:55-62`). The inconsistency the row names
was "acknowledged" next to a permanent false; with the ack removed, "waiting" next to a false is true. The
terminal state is carried by the new `refused` list instead. The label's "yet" is wrong for a refused
frame; that is copy, row 200.

## Classification of every submit error reply (197)

Applied at the `client.relay()` call only. Transport failures (`carrier websocket closed`, `carrier request
timeout`, `malformed carrier relay response`, an undecodable report) still throw out of the sync exactly as
today; the reconnect-with-backoff the feed does for them is correct.

| Reason | Class | What the pass does | What the feed does |
|---|---|---|---|
| `rate_limited` | retry-later | unchanged: the stall loop sleeps and resubmits (`STALL_SLEEP_MS`, `MAX_STALLS`), sets `rateLimited` when the bound runs out | unchanged: not an error |
| `unavailable` | stop this pass, keep progress | commit the pulled dependency-closed set and earlier acks, stop submitting, report `submitStopped` with the reason; do not throw | no redial: the relay is up and the failure is its disk; the next hint, the 60 s poll, or a manual Sync retries |
| `read_only` | stop this pass, keep progress | same as `unavailable`; the pull half still works on a read-only realm, so it is merged | no redial, connection stays `live`, `submitStopped: "read_only"` stays until a sync that does not stop |
| `malformed` | terminal for that frame | the frame joins `rejected` as `[id, "malformed"]` (relay will not hold it), is excluded from the rest of the pass, and the rest of the outbox continues (dependents answer `pending`) | no effect; it is a per-frame verdict, shown in `refused` |
| `unauthenticated`, `unsupported_frame`, any reason not in this table | unexpected | commit the pass's progress first, then throw `carrier peer error: <reason>` unchanged | unchanged: `unauthenticated` is already a `refusal()` (`treehouse_feed.ts:107`); the rest back off as today |

Why `read_only` is not added to the feed's `refusal()` list: that state is labelled "Refused: this server is
not the one saved for the route" and kills the subscription; a read-only realm is the right server, still
serves pulls, and should keep receiving hints. Why `unavailable` is not left on the backoff: redialing a
healthy socket cannot fix the relay's disk, and the 5 s cadence is the bug the row names.

## Commands you will need

Use nvm's Node 22; a fresh worktree needs `MIX_ENV=test` compiled before the real-socket gate.

```bash
export PATH="$HOME/.nvm/versions/node/v22.15.1/bin:$PATH"
# lattice-client (after any src edit)
cd clients/lattice-client && npm run typecheck && rm -rf dist && npm run build
npm run carrier:relay && npm run carrier:relay-sync
cd ../..
git diff --exit-code --stat -- clients/lattice-client/dist   # only after you have committed the rebuilt dist
# shell
cd clients/treehouse-tauri-shell && npm run typecheck && npm test
# real-socket non-regression, run once at the end (a fixture relay from pilot_node.exs)
npm run gate:enrollment
cd ../lattice-client && npm run carrier:township:live
cd ../township-tauri-shell && npm run frontend:contract
```

## Scope

Only these files change. Nothing under `apps/` or `.github/`. No new dependency.

1. `clients/lattice-client/src/carrier.ts` (row 197; second review required)
   - Add `export class CarrierPeerError extends Error { readonly reason: string }`. `request()` throws it
     at the current `error` reply site with `message` byte-identical to today's
     `carrier peer error: ${reason}`.
   - Add `export function carrierPeerErrorReason(error: unknown): string | null`: the reason for a
     `CarrierPeerError`, or for any `Error` whose message starts with `carrier peer error: ` (so fakes and
     scripted clients that throw a plain `Error` keep working); `null` otherwise. `carrierRateLimited` is
     rewritten on top of it.
   - `SyncCarrierOptions` gains optional `onRelayError?: "throw" | "stop"` (default `"throw"`).
   - `SyncCarrierResult` gains optional `submitStop?: { frameId: string; reason: string }`.
   - `submitCarrierFrames`: in the relay loop, catch only errors from `client.relay(frame)`. If
     `carrierPeerErrorReason` is `null`, rethrow (transport failure). Otherwise record
     `{ frameId: frame.id, reason }`; if the reason is `rate_limited` or `onRelayError === "stop"`, `break`
     and return what was gathered; else rethrow as today. An error from the duplicate-confirming
     `client.advertise()` (1329-1334) is not caught: it still throws. The generic `push` path is unchanged.
   - `syncCarrierOnce` threads the option through and returns `submitStop` (also for `rate_limited` in
     default mode: an additive field; its `pushedFrames`/`pushReport` behavior is unchanged).
   - Then `rm -rf dist && npm run build` and commit the regenerated `dist/src` and `dist/test`.
2. `clients/lattice-client/test/carrier_relay_sync.ts` and `test/carrier_relay.ts` — see Test plan (d).
3. `clients/treehouse-tauri-shell/src/treehouse_sync.ts` (rows 195 and 197)
   - Call `syncCarrierOnce` with `onRelayError: "stop"`.
   - Add `attemptedNow: Set<string>`: every id in `synced.pushedFrames` (any frame the relay replied to,
     whatever the bucket) after each round. Candidates exclude `attemptedNow` as well as `relayHeld` and
     `deliveredNow`. `remaining` is `candidates` not acked and not attempted. Behavior change to name in the PR:
     today a `rejected` or `pending` candidate is resubmitted in the next round of a rate-limited sync (only
     acked ids enter `deliveredNow`); with `attemptedNow` it is not. That is the intended improvement, and it
     is also what keeps a quarantined frame to one attempt per sync once it no longer acks.
   - **195**: the ack set is `report.accepted` (submitted candidates) plus `synced.peerReportedFrameIds`
     (candidates). Remove the `report.quarantined` mapping at 229-235. Quarantined ids stay in
     `result.quarantined` and out of `acked`.
   - **197**: keep `synced.submitStop` in a pass variable. Once set to a non-`rate_limited` reason, later
     rounds submit no candidates (pulls still run). After the commit block and the open-dependency branch,
     apply the table: `rate_limited` runs the stall loop keyed on the explicit reason (replacing the
     `submitted.size < candidates.length` inference, which also stalled 10 s on candidates the client
     dropped as unverifiable; with no stop recorded, unsent candidates now just end the loop);
     `unavailable` and `read_only` set `result.submitStopped = { id, reason }` and `break` to the closing
     advertise; `malformed` pushes `[id, "malformed"]` to `result.rejected`, clears the stop and continues
     with the rest; any other reason throws `new CarrierPeerError(reason)` (same message) after the commit.
   - `[id, "malformed"]` in `RouteSyncResult.rejected` is a shell-domain reason: add a comment on the field
     that its reasons are a superset of the wire's `WIRE_REPORT_REASONS` (the wire list plus `malformed`,
     which is a relay error reply, not a report reason).
   - `RouteSyncResult` gains `submitStopped: { id: string; reason: string } | null` (initial `null`).
     `matchesRelay` and `pendingIds` keep their definitions. Update the comments at 48-49 and 141-145: the
     relay persisted (accepted) or a fresh advertise lists it; quarantined, rejected and pending never ack.
4. `clients/treehouse-tauri-shell/src/treehouse_feed.ts`
   - `TreehouseRouteFeedState` gains `refused: [string, string][]` (ids the relay will not hold, from
     `result.quarantined` then `result.rejected`, last sync) and `submitStopped: string | null` (reason).
     Both initialise to `[]`/`null` in `setLink` and the snapshot.
   - `record()` takes the whole result: it stores `matchesRelay`, `refused`, `submitStopped`, and sets
     `message` to `"Relay subscription is live."` or, when stopped, that text plus `" Submit stopped: "` and
     the reason. `refreshAll` stops overwriting the message when `submitStopped` is set.
   - No change to `refusal()`, `reconnectDelay`, or `runWorker`: a stop reply no longer throws, so no
     redial is requested. The unexpected class still reaches the existing catch.
5. `treehouse_panel_sync.ts` passes `refused` and `submitStopped` through; `EnrollmentPanel.vue` lists each
   refused id with its reason (one label, pinned by `enrollment_ui_contract.mjs`; row 200 owns the rest).
6. `clients/treehouse-tauri-shell/test/support/fake_relay.ts` — mirror the real relay (Test plan (a)).
7. `clients/treehouse-tauri-shell/test/sync.ts`, `test/feed.ts`, `test/sync_panel.ts` — Test plan (b), (c).
8. `plans/README.md` — rows 195 and 197 status cells (one line each, at most 200 characters), by the
   builder who finishes each row.

## Test plan

RED first for every item; each builder writes the red test, sees it fail for the stated reason, then
changes the source.

**(a1) Make the stand-in honest (195; needs no `lattice-client` change).** In `fake_relay.ts`: drop the
`stored` set and the `stored` term from `advertisedIds()`; keep a `quarantine: Set<string>` that is never
advertised or served. `forced: "quarantined"` and an invalid signature both reply
`quarantined: [[id, "bad_signature"]]` the first time and `[[id, "already_quarantined"]]` after, store
nothing in `log`, and never use the reason `"authority"`. Add a per-reply check that every reason in a
returned report is in the closed list `already_quarantined | bad_signature | wrong_replica`, so the stand-in
can never again report what the real decoder refuses.

**(a2) Error replies in the stand-in (197).** Add `errors: Map<string, string>` (a per-id reason, `"*"` for
every frame) so `deliver` can throw `new CarrierPeerError(reason)` (from the rebuilt `dist`) for
`unavailable`, `read_only`, `malformed`, `unauthenticated` and `rate_limited`.

Expected red for (a1): `test/sync.ts` case 1 at `assert(acked.has(posts[1]!))` (the quarantined id is no longer
served or advertised, and after step 3 not acked).

**(b) 195 (`test/sync.ts`).**
- Case 1, changed: `forced.set(posts[1], "quarantined")` now means `bad_signature`. Expected assertion
  changes: `result.pendingIds` goes from `[posts[2], posts[3]]` to `[posts[1], posts[2], posts[3]]`, and the
  `acked.has(posts[1])` line flips. Assert posts[1] is **not**
  in `profile.acked`, **is** in `result.pendingIds`, is in `result.quarantined` as `[id, "bad_signature"]`,
  is absent from `relay.log` and from `relay.advertisedIds()`, and that `matchesRelay` is `false`.
- Repeat sync of the same state: posts[1] answers `already_quarantined`; the record is byte-identical and
  `native.writes` is unchanged (still true); the relay saw `relay:<posts[1]>` exactly once more per sync.
- New: a rate-limited sync (`tokens` low, `FakeClock`) with a quarantined frame mid-outbox: it is
  submitted once in that call (assert the event count), and the sync completes. Red before step 3: the
  quarantined frame was acked and so excluded; after removing the ack without `attemptedNow` it would be
  resubmitted each round.
- New: the quarantined frame later accepted by the relay (clear `forced`): acked by the next sync, no
  duplicate ack, no duplicate frame.

**(c) 197 (`test/sync.ts`, `test/feed.ts`).**
- `test/sync.ts`, progress survives an error: reuse the case 5 joiner fixture so the relay holds a foreign
  frame P that the founder has not pulled, and the founder has own frames A and B. `errors.set(B,
  "unavailable")`. Red before the fix (the sync rejects). Green: the call resolves; A is acked; P is
  retained (`pulledFrames === 1`); B is in `pendingIds`; `result.submitStopped` is
  `{ id: B, reason: "unavailable" }`. A second sync with the error cleared acks B, with no duplicate frame
  or ack. Repeat with `read_only`.
- `malformed`: `errors.set(B, "malformed")`: resolves; B is in `result.rejected` as `[B, "malformed"]`;
  B's dependents answer `pending`; the relay saw `relay:B` exactly once (no loop).
- Unexpected reasons: `unauthenticated` (and an invented `"weird"`) still reject with
  `carrier peer error: <reason>`, but A's ack and P's merge are already committed in the record.
- `rate_limited` behavior is unchanged: the existing case 4 (outbox larger than the burst) stays green.
- `test/feed.ts`, no redial storm (the harness's injected feed `sleep` is the only redial timer, recorded in
  `Harness.delays`; session count is `h.sessionsOf(replica).length`): a founder with a pending post and a
  stand-in whose **Thread** relay answers every `relay` with `read_only` (scope the error map to that relay;
  the Space relay stays healthy so the Space-first ordering is undisturbed), `pollMs: 0`. Green: the route reaches `live`,
  `submitStopped === "read_only"`, `pending > 0`, **`h.delays` is empty and one session exists after
  `await quiet(40)`**, and a foreign frame placed on the relay is pulled. Red before the fix: `h.delays`
  walks `[100, 250, 500, 1000, 2000, 5000]`, the case 4b shape. Same assertions for `unavailable`. Then fire
  the captured poll callback (`h.timerFns[0]`, with `pollMs: 60000`): exactly one more sync and one more
  `relay:` attempt, still no new session.
- `unauthenticated` still ends in `refused` with no redial (existing case 5 pattern); a non-refusal
  unexpected reason still backs off (case 4b), proving the throw path is intact.
- `test/sync_panel.ts`: update the two feed-state literals for the new required fields and assert the
  panel passes `refused`/`submitStopped` through unchanged.

**(d) `lattice-client`.**
- `test/carrier_relay_sync.ts`, beside the existing `unavailableClient` case: (i) default mode still rejects
  with `/carrier peer error: unavailable/` and the error is a `CarrierPeerError` with
  `reason === "unavailable"`; (ii) `onRelayError: "stop"`, genesis accepted then grant errors `read_only`:
  resolves, `pushedFrames` is `[genesis]`, `pushReport.accepted` is `[genesis]`, `peerReportedFrameIds` is
  `[genesis]`, `pulledFrames` is returned, `submitStop` is `{ frameId: grant.id, reason: "read_only" }`;
  (iii) stop mode with a plain transport error (`new Error("carrier websocket closed")`) still rejects;
  (iv) stop mode with an error from the duplicate-confirming `advertise()` still rejects; (v) default-mode
  `rate_limited` result is unchanged and now also carries `submitStop` with reason `rate_limited`;
  (vi) `carrierPeerErrorReason` returns the reason for a `CarrierPeerError` and for a plain `Error` with the
  same message, and `null` for anything else.
- `test/carrier_relay.ts:84-86`: keep the regex, add `instanceof CarrierPeerError` and `.reason ===
  "read_only"`.
- Run `npm run carrier:relay-sync` and `npm run carrier:relay`. `npm run typecheck` in both packages.

**Real-socket gates (non-regression, run once, claim nothing new).** `npm run gate:enrollment` in the shell
(a real Elixir relay; the sync loop changed), `npm run carrier:township:live` in `lattice-client` (the
`request()` error class changed), and `npm run frontend:contract` in `township-tauri-shell` (imports the
rebuilt `dist`; the Township path must stay byte-identical). None exercises an own frame being quarantined;
the real-relay pin for that verdict stays the Elixir `treehouse_route_boot_test.exs:104-113`, which the
stand-in now mirrors line for line.

## Done criteria

- The closed reply table above is the one place the outcomes are stated; the stand-in matches it and its
  reasons are checked against the real closed list.
- An own frame the relay reports `quarantined` is never in `acked`, is in `pendingIds`, `quarantined` and
  the feed's `refused`, is submitted at most once per sync, and a relay that later accepts it acks it.
- A `read_only`, `unavailable` or `malformed` reply never discards the pass's pulled frames or earlier acks,
  and none of them causes a redial; `unauthenticated` and unknown reasons still throw, after committing.
- `matchesRelay` keeps its definition and `pendingIds` is still outbox minus acked, plus the ids the relay
  refused in that sync and does not list (the legacy-ack case); no persisted field, no `parseState` change.
- `refused` and `submitStopped` are the last completed sync's verdict: a later failed sync clears them
  rather than leaving them stale.
- Default-mode `syncCarrierOnce` callers (Township push and relay) see identical behavior and messages;
  `dist` is rebuilt and committed and `git diff --exit-code -- clients/lattice-client/dist` is clean after a
  fresh `rm -rf dist && npm run build`.
- PR body states claim tier core, names the two behavior changes (quarantine no longer acks; stop replies no
  longer redial), the `matchesRelay` decision, and lists the adversarial review and the Codex Sol review.

## Non-claims

No claim that a structurally quarantined own frame is recoverable, or that the relay's verdict is correct
(it may be a verifier divergence or a lying relay; this plan only stops the shell from hiding it). No server
change, so the quiesce socket-drop gap is recorded, not fixed. No change to what the real-socket gates
exercise, no production deployment, no Phase G completion, no receipt-free W4, no catalog, mobile or device
result. No UI copy beyond one refused-id label and the reason string (row 200). Rows 199, 201 and 202 are untouched. The `refused` list is
the last sync's verdict, not durable history: after an app restart it is empty until the first sync, and a
later failed sync clears it. A false ack saved by the previous build is not removed from the profile.

## STOP conditions

- A hosted gate or the Elixir relay test shows a structurally quarantined **own** frame on a healthy build
  (that is a verifier-divergence bug to file, not a state to paper over).
- The typed error cannot keep `message` byte-identical, or `carrier_relay.ts`/`carrier_relay_sync.ts`
  existing regexes, `treehouse_feed.ts:107`'s string compare, or the Township path change behavior.
- A fix needs a persisted `LocalProfile` field, a `mergeSync` change, or any edit under `apps/` or
  `.github/` (the server contract is intact per the table; do not "fix" the quiesce drop here).
- `dist` cannot be rebuilt cleanly or `git diff --exit-code` stays dirty after a fresh build.
- `gate:enrollment` or `frontend:contract` regresses after one rerun on an idle machine.

## Maintenance notes

- A new relay error reason or report bucket is a table edit here first, then the stand-in, then the
  classification in `treehouse_sync.ts`; an unknown reason must keep throwing so it cannot be silently
  swallowed as a "stop".
- If resubmitting a long refused chain each sync ever matters, the follow-up is a persisted, relay-bound
  refused marker with a `parseState` migration; it is deliberately not built here.
- A `malformed` reply ends that submit round and starts a new round (advertise, pull with the full `have`
  list, one relay token per frame), so a relay that answers `malformed` to every frame costs one round per
  frame, bounded by the outbox cap. Continuing the submit loop past the frame inside `submitCarrierFrames`
  would remove the per-round cost; it needs a second `lattice-client` option and is not built here.
- Row 200 (copy for `refused`/`submitStopped` and the "yet" in the neutral label) follows this plan.
