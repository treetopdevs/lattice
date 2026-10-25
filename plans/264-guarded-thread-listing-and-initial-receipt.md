# Plan 264: guarded Thread listing and initial zero-write receipt

## Status and dependency

Prepared 2026-10-24 from main `187cc3d8a77242cbca0fa1d6916af10fc1d6ef0c`.
This is plan 224 PR 5. Implementation waits for catalog publication PR #168
(plan 263) to merge on its required gates; this packet itself changes no runtime.
After that merge, refresh this worktree from main and inspect the actual parent APIs.
Do not copy parent code, start from an unverified merge, or claim listing is built.
D-48 records the delegated decisions. The unified roadmap is the execution ledger.

Software acceptance uses the parent's disposable real-mode ceremony and guarded Linux
release fixtures. No absent production identity, physical machine or public relay is
needed to build this slice. Operational use retains plan 224's actual ceremony/backup
requirements. Native catalog trust and the two-app public-WSS session remain later work.

Read plans/README.md, plan 224 Design 5, plan 262 and the founder lifecycle contract §5.
After #168 merges, also read plan 263 and its runbooks. Review drift from this packet's
base in Holder, ReleaseGate, Durability, operator journal/owner and Treehouse catalogs;
reconcile unexplained changes before coding. Authority, Wire and catalog signing bytes
are unchanged by this slice.

## Outcome and authority boundary

A catalogued Thread has a signed inventory entry. Listing must additionally prove its
exact signed Space reference is currently honored and record the local `listed` receipt.
For a normal pending reference, deliver the already client-signed frame once. For initial
provisioning, the exact reference is already present: observe it and perform zero Space
writes. Neither path signs, grants membership, changes routes or creates client trust.

The carrier remains a courier of client-authored signed operations. No catalog or Space
seed is read on the relay host. The holder's service identity remains transport-only.
`listed` is a dated checked observation. A later revoke or roster change can make the
entry pending/refused on clients, which independently judge their own current histories.
No continuous freshness, automatic replacement or founder-loss claim follows.

Current-parent inspection adds three implementation constraints. Read-only holders skip
startup write rehearsal, so an append-capable courier must prove persistence through an
isolated sibling rehearsal; it must never rewrite the actual initial Space as a probe.
The existing persistence error path retains old memory even when rename has landed.
Fence subsequent holder mutations after any ambiguous persistence failure until verified
restart/reconciliation, so a different relay cannot overwrite that authentic disk history.
Test failure after rename followed by a different relay, not only redelivery of the same op.

## Supported operator API and command

Implement `ReleaseListing.publish(root, expected, ceremony_dir, probe_file)`. The explicit
probe file is needed to reuse the parent's authenticated release review; plan 224's older
three-argument sketch is amended in the same commit. It returns `{:ok, record}` or an
atom-only refusal and never prints inspected exceptions or secret terms.

Extend the parent's `CatalogCli` with `list`, using the existing guarded VM via local
release RPC or console. Required options: root, preserved expected catalogued-intent
file, ceremony and probe. No signer, seed, arbitrary frame, target replica/route, caller
"honored" flag or relay-toggle option. Strict command-file keys/argv rules remain.
The adapter starts no app/listener and never starts a second relay process. Lost-reply
retry reviews the actual `listed` record, after proving it is exactly the phase-only
transition from the preserved catalogued bytes. Extend the shared release review with
that explicit phase; do not pass invented journal bytes or regress ready/catalogued checks.
The runbook
shows preserving catalogued journal bytes, listing, exact retry and current-history refusal.

## Review before the holder

1. Read exact `expected` journal bytes at `catalogued`, guarded operator root/incarnation,
   the loaded manifest and health. Reuse the parent's release review at phase catalogued,
   including current roster/peers/relay realms, service binding, all authenticated route
   pulls and the post-probe re-read. Preserve `roster_drift_since_catalog`.
2. Verify the whole CatalogStore with the root-bound key. The committed head must equal
   the journal's catalog head and its exact catalog artifact; no different pending envelope.
   Re-read/digest/verify the immutable envelope through the store's verified reader.
   Validate all carried entries, actual instance routes and the bound bootstrap/service.
3. Read the one staged reference artifact through the existing bounded, race-aware reader;
   match artifact digest, canonical signed frame, op id, exact Space and the staged Thread.
   Require the matching entry in this committed catalog. A merely similar newly signed
   create_thread operation is not a substitute. Refuse `catalog_reference_mismatch`.
4. Find the exact served Space holder from the manifest and verified log replica. Pass no
   caller-selected holder or destination. Check ordinary pending versus initial-existing
   provenance using the parent's ReferenceMode; never infer initial mode from presence.

## Holder courier transaction

Add local `Holder.courier(holder, op, guard)` as one synchronous GenServer call.
The frame is decoded from the checked journal artifact by ReleaseListing. It is not a
new HTTP/WebSocket/Wire action and cannot be invoked by a carrier envelope or relay realm.
A local privileged BEAM caller is already inside the operator trust boundary; guard is
an internal function, never an untrusted callback decoded from a request.

Inside that one holder call:

- Require the release gate to be accepting, the intended path-backed holder and normal
  persistence availability. Quiesce/drain/failure fencing still applies. Only the
  instance's participant relay allowlist is bypassed by this local courier operation.
- Run guard over the holder's current in-memory Space log, before delivery, so a relay
  admission/revocation cannot interleave between judgment and delivery.
- Guard checks the staged roster equals the exact reviewed grant-recipient set; reload
  the same public binding against this supplied log and require the same bootstrap/key.
  Do not reread the Space holder or synchronously call itself inside guard.
- For a pending absent reference, build the authenticated hypothetical by accepting the
  exact staged op and require Authority to honor it with the catalog's root/creation/
  reference bindings. If already present, require exact op equality and still re-run
  guard; presence is never an authorization verdict. Refuse `reference_not_honored` on
  a lapsed reference, including a replay which was valid when first delivered.
- For initial-existing, require the exact reference already present and honored in the
  actual log, the parent's initial provenance and reviewed child title/creation. Never
  switch a missing initial reference into the append branch or rewrite Space to restore it.
- Deliver at most that one authenticated op and reuse the existing Holder/Sync/Durability
  persistence path. Refactor shared persistence, not a second file writer. No frame is
  acknowledged before durable persistence. Refuse in-memory or unsupported write paths.
- An exact already-present frame skips delivery and disk writes, while returning a
  checked presence receipt. This is essential for zero-write initial listing and retry.
- Return bounded public reference id, outcome and snapshot/frontier information. A
  rejected Sync delivery or an unchanged log without the checked frame is not success.

Run guard in a monitored, unlinked bounded worker while the holder waits; the holder's
mailbox remains serialized, so no relay can interleave. On deadline terminate the worker,
consume its monitor/result and refuse without persistence; a callback timeout must not
kill the holder or continue writing in a detached worker. Include this deadline in the
courier call budget in addition to the persistence budget. Catch guard raises/exits/invalid
returns as closed refusals; preserve the old log and
holder availability. Guard only evaluates its supplied Space snapshot and previously
verified bounded child context; it must not perform cross-holder calls or a recursive
Space pull. Reuse the parent's evidence budgets and a bounded courier call timeout that
covers guard plus existing persistence deadlines. Never relax the existing durability
or release-fence policy to avoid a timeout. A timeout is ambiguous, not proof of no write.

## Observation and owner receipt after the courier

Read authenticated served histories again for every committed catalog entry, with no
hypothetical frames. `CatalogEntries.observe/2` must pass, including the actual Space
reference, current authority and the unique bound bootstrap. Readiness/binding/roster
changes refuse a receipt even if the signed reference was already delivered; preserve
that authentic history and require an explicit retry/review, never remove the frame.

Construct exactly the catalogued record with `phase = listed`. Call existing
`Lock.listed/5` with the checked active manifest, expected raw bytes and current boot
incarnation. The Python owner remains the only journal writer and independently checks
CAS, attempt, unchanged manifest/envelope and derived transition. Add no signing or
semantic evaluation to Python.

Only when the actual initial consumer exists, update BOTH BEAM ReferenceMode/journal
validation and Python record validation to permit initial-existing at listed. Retain
closed review shape and all other artifact/provenance/chain checks. The owner's generic
listed plan cannot accept a changed head, changed catalog artifact or caller-authored
record fields. Keep BEAM/Python parity behavioral, without source/prose pins.

## Retry, concurrency and crash windows

- If a pending reference reached the holder but journal remains catalogued, retry checks
  exact presence and current honor, writes no duplicate and records listed once.
- If journal was replaced but reply was lost, re-read and recognize only the same exact
  attempt/catalog/reference/record transition from the original expected bytes. Re-run
  current-history review before idempotent success. A different receipt is stale intent.
- A concurrent relay arriving before the courier guard is judged inside guard. One
  arriving after courier may make the later full observation refuse; this is a dated
  observation boundary, never an excuse to mark a now-invalid reference listed.
- Two simultaneous list calls converge on one log op and one receipt, or a clear bounded
  busy/stale refusal whose exact retry succeeds. Never synthesize another reference.
- Owner death after delivery, before/after journal replace and before reply leaves the
  same authentic op and either catalogued or the matching listed receipt. Recover by
  exact retry. No cleanup deletes signed frames, catalog envelopes or journal history.
- A lapsed immutable reference keeps its catalog slot. Replacement/superseding attempts
  are row 244, not a fallback implemented here. Explain the refusal operationally.

## Implementation order

1. Verify #168 merge ancestry/tree/gates, refresh main and prepare Node dependencies.
   Reuse its ActivationFixture/publication helpers; do not replace real histories with
   fixtures carrying precomputed ready/honored flags.
2. Implement local holder courier with guard, fence/durability reuse, checked no-write
   presence and dedicated behavioral tests. Prove it is unreachable over the network.
3. Implement ReleaseListing with before/inside/after current-history checks and strict
   artifact/catalog linkage. Add both normal pending and initial-existing integration.
4. Wire list into CatalogCli, update both validators only with the guarded initial
   consumer, and document supported console/RPC commands and ambiguous retries.
5. Run the full crash/refusal/concurrency matrix, independent carrier-path review and
   requested adversarial review. Fix/reject each finding. Commit/open PR/autofix and
   run one final exact-tip hosted gate before software completion.

## Required behavioral evidence

- Real disposable ceremony, ordinary workflow export/import as available in #167/#168,
  stage/activate/restart/ready/catalogue → list → restart. Authenticate a carrier pull
  of the served reference and run the real CatalogEntries judgment over actual histories.
- Pending path appends exactly the staged client frame. Replay adds neither op nor
  journal receipt. Initial path has byte-identical Space file and unchanged inode/mtime,
  including retry and restart; missing or altered initial reference refuses.
- Wrong catalog key/binding/service, changed artifact/digest/op id, competing reference,
  stale expected/attempt/incarnation/manifest and forged/different receipt refuse.
- A correctly signed but currently unhonored reference refuses. Revoke/admit at a
  deterministic guard boundary to prove the roster/authority decision is in-holder;
  assert no operator phase advance and preserve already-authentic writes.
- Missing/unavailable carried history, carried authority drift, changed route and
  forked bootstrap refuse. Every carried entry is observed, not only the new Thread.
- Read-only network relay policy still refuses an authenticated participant push.
  Attempts to encode/invoke courier over the real WebSocket boundary refuse and create
  no write; local courier still persists through the required guarded path.
- Drain/closed gate, persistence timeout/error, guard error/exit and invalid callback
  returns yield bounded refusals without corrupting/replacing the readable log.
- Actual process kill around log durability and journal replacement/reply; exact retry
  yields one op and one receipt. Concurrent same-attempt listings and relay races pass.
- Both reference modes have closed command-file/CLI rehearsal, atom-only refusals,
  exact immutable catalog preservation and BEAM/Python record parity.

Run asdf Mix with OTP 28 PATH, prepare client/shell dependencies per AGENTS.md, format,
full `mix check`, both boundary Sobelow scans, and non-root Linux full operator tests
under the parent's pinned image/umask. macOS skips do not prove the owner. Run targeted
carrier boundary/refusal tests and the required hosted job; no physical/deployment claim.
Argon 4 High adversarial review is preferred; use Sonnet 5.5 High on authoritative
unavailability. Carrier write-path changes require the independent second review.

## Exit and next work

Software complete only when both guarded listing modes, full refusal/crash/concurrency
matrix, supported command flow, reviews and exact-tip required checks pass, with a
verified merge tree. Record evidence in PR/index. The operator's real ceremony/listed
run is separate. Next: plan 245 native catalog evaluation/trust enrollment and plan 261
ordinary-app relay integration; listed server evidence alone does not enable app chat.
