# Plan 264: guarded Thread listing and initial zero-write receipt

## Status and dependency

IN PROGRESS: independent holder APIs and focused persistence tests are implemented.
Catalog integration is unblocked by the verified green parent merge. Complete listing
crash/refusal evidence, implementation reviews and required final gates remain.

Prepared 2026-10-24 from then-current main. This is plan 224 PR 5, now rebased onto
merged catalog publication PR #168 (plan 263). Its exact tested tree and merge ancestry
were verified before rebase; implementation files were preserved byte-for-byte.

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

Current-parent inspection adds two persistence constraints. Read-only holders skip
startup write rehearsal, so an append-capable courier must prove persistence through an
isolated sibling rehearsal; it must never rewrite the actual initial Space as a probe.
The existing persistence error path retains old memory even when rename has landed.
Fence subsequent holder mutations after any ambiguous persistence failure until a
controlled release restart restores and verifies the served file, so a different relay cannot overwrite that authentic disk history.
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

Use a reviewed snapshot compare-and-swap (CAS), preserving OD-3(a)'s requirement that
current authority judgment and delivery cannot be separated by a concurrent relay.
No arbitrary callback runs inside the holder. Add local snapshot/review and courier
APIs; neither is an HTTP/WebSocket/Wire action or decodable from a carrier envelope.
The privileged BEAM operator is already inside the local trust boundary.

1. Obtain the actual holder's immutable log snapshot and a closed token binding release
   owner/incarnation, source path, replica and a deterministic digest of the entire log,
   including quarantine. Authenticate the snapshot. A disk-only snapshot is insufficient.
2. Outside the holder, a dedicated pure listing reviewer computes the exact candidate via
   `Sync.deliver(snapshot, [op])`, requires exact accepted/present op equality, verifies
   authenticity and runs current roster, root/bootstrap/binding and catalog authority
   checks on that SAME candidate. Use previously verified closed public ceremony data;
   do not use a different path-based Space observation or invent carried references.
   Pure review uses a monitored unlinked bounded worker; its crash/hang never blocks the
   holder or kills the operator RPC process.
3. For pending absent, require the exact staged signed op to be accepted and honored.
   For pending present, require exact equality and current honor. For initial-existing,
   require already-present exact honor and the parent's one-Thread provenance/title/
   creation rules. Never turn missing initial into append. Keep ReferenceMode.observe
   strict for staging; add a narrow listing predicate rather than weaken absence checks.
4. Send `Holder.courier(holder, op, reviewed_token)` with closed data only. In one call,
   require an accepting nonnil release owner, the intended path-backed source and proven
   persistence support. Match the exact current snapshot token and reviewed op/candidate
   digest, recompute deterministic Sync delivery, and persist only that same candidate.
   Any intervening relay/roster/quarantine change refuses `stale_served_history`; caller
   must obtain a new snapshot and review, never silently refresh the token.
5. Only the local courier bypasses the participant realm allowlist. Preserve all release
   fence/drain rules and shared Holder/Sync/Durability persistence; add no second writer.
   An exact present op returns a checked presence receipt with no log rewrite, subscriber
   notification or duplicate delivery. An unchanged/rejected Sync report is not success.
6. Return bounded public id/outcome/frontier information. Keep outcome/frontier out of
   journal bytes so delivered and present retries derive the same phase-only receipt.

The critical holder call has no semantic review callback or new cross-holder wait.
Its timeout stays within the existing relay persistence/cleanup/slack budget, and its
normal bounded duration must fit ReleaseQuiesce's default five-second drain window.
Close the gate during blocked persistence in tests: drain captures the completed exact
log or fails closed, never commits an incomplete capture. A caller timeout is ambiguous,
not proof of no effect. Request cancellation within a bound, retain the monitor and
release-owned write lease until actual worker completion/death, and keep replacement
writers fenced if termination is unknown. Register the worker before effects, tied to
its live holder; reauthorize the exact lease after acquiring the target lock immediately
before filesystem work. An old owner cannot authorize a delayed worker after replacement.
Target-lock startup checks cannot cross a still-active old filesystem effect. Retain
single-OS-process log ownership and stop the old VM before another process uses its paths.

Read-only path holders explicitly call a separate bounded `prove_durability` before
requesting a snapshot token. Reuse `Durability.rehearse_target_isolated` in the actual
target directory with cleaned siblings, cache success per holder incarnation/source,
and exclude rehearsal from the courier's critical-call budget. Failure leaves proof
false, the target untouched and the holder alive. In-memory/unowned/unsupported paths
refuse atoms. Presence-only initial listing never runs target-replacing rehearsal.

The release owner retains sticky per-holder fences and monitors write workers in its
existing lease set. Holder child replacement in the same release cannot clear a fence.
Owner or unacknowledged worker death fences its route before replacement admission.
The shared writer records stage disposition internally while preserving public error
shapes. A known completed pre-rename failure stays retryable. Every timeout, post-rename
failure or unknown disposition transitions the live holder from OPEN to FENCED before
reply. FENCED refuses relay, courier, new review snapshots and drain capture with atoms;
readiness cannot claim a writable healthy holder. No local reset/unfence API exists.
Exit only through controlled release restart, verified file restore and normal durability
proof in a new incarnation. A pre-rename failure must never be classified from an errno
alone. Test before/after rename and a hung directory sync, then a different relay and
drain; neither may overwrite/capture stale memory. Do not promote an unsynced candidate
into a successful receipt. The final observation must authenticate the served carrier
history and establish equality with disk, including quarantine where relevant, not merely
observe a file ahead of the live holder. Unknown/late effects remain fenced.

Retain strict initial single-reference and all-carried-entry checks. Name initial
competition and lapsed carried-entry refusals distinctly and document row 244 as recovery;
neither is a reason to relax authority. Use the core's existing honored predicate
semantics: Authority constructs quarantine from exactly the keys of reasons.

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
- A concurrent relay arriving between snapshot review and courier refuses the stale
  token. One arriving after courier may make the later full observation refuse; this is a dated
  observation boundary, never an excuse to mark a now-invalid reference listed.
- Two simultaneous list calls converge on one log op and one receipt, or a clear bounded
  busy/stale refusal whose exact retry succeeds. Never synthesize another reference.
- Owner death after delivery, before/after journal replace and before reply leaves the
  same authentic op and either catalogued or the matching listed receipt. Recover by
  exact retry. No cleanup deletes signed frames, catalog envelopes or journal history.
- A lapsed immutable reference keeps its catalog slot. Replacement/superseding attempts
  are row 244, not a fallback implemented here. Explain the refusal operationally.

## Implementation order

1. Prepare Node/Mix dependencies and inspect current main. Holder snapshot/CAS,
   persistence fencing and proof APIs were built independently while #168 verified.
   Prove no new network action, with no precomputed honor flags.
2. Parent #168 merge ancestry/tree/gates and rebase are verified. Reuse its actual
   ActivationFixture/publication APIs; preserve both plans and decisions. Complete
   current Linux evidence and focused confirmations of the owner-lifetime fixes.
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
  including retry and a read-only Space holder restart; missing or altered initial
  reference refuses. Relay-enabled startup rehearsal may replace its target: for that
  existing behavior assert restart bytes only and unchanged inode/mtime during listing.
- Wrong catalog key/binding/service, changed artifact/digest/op id, competing reference,
  stale expected/attempt/incarnation/manifest and forged/different receipt refuse.
- A correctly signed but currently unhonored reference refuses. Revoke/admit at a
  deterministic snapshot-to-CAS boundary to prove a stale authority decision cannot write;
  assert no operator phase advance and preserve already-authentic writes.
- Missing/unavailable carried history, carried authority drift, changed route and
  forked bootstrap refuse. Every carried entry is observed, not only the new Thread.
- Read-only network relay policy still refuses an authenticated participant push.
  Attempts to encode/invoke courier over the real WebSocket boundary refuse and create
  no write; local courier still persists through the required guarded path.
- Drain/closed gate, persistence timeout/error and reviewer crash/hang or invalid token
  yield bounded refusals without corrupting/replacing the readable log.
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
