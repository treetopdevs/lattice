# Plan 261: two ordinary desktop Treehouse apps over the real relay

## Status and scope

Design prepared 2026-10-24 against `ffb7f3f22d1abf7adfd437bc0f14292dadffff56`.
User adopted D1–D6 and authorized starting slice A on 2026-10-24. Deployment remains
a later authorized operation. Slice A's library, native custody, crash recovery and
ordinary desktop creation have local and hosted software proof. Offline exchange,
Linux provisioning and guarded listing are also merged and verified. Native catalog
installation, actual physical-device custody and the real-relay field session remain.
No live host inspection or deployment accompanies this work.

Target: one assisted, text-only session between two ordinary macOS apps, independently
created Keychain identities, one new bounded Space and one bounded Thread, one real WSS
relay, foreground sync, offline posting/heal and restart persistence. Operator-assisted
file exchange and relay provisioning are allowed; editing app databases, fixture keys,
dev-trace networking, or manually entering unsigned routes are not acceptance paths.

This is a design plan under README rule 8. Fixture implementation can proceed without
real secrets or machines. Field acceptance waits on the named operator inputs below.
The unified roadmap remains the execution ledger; this document supplies its design.

## Findings: what exists and what does not

| Area | Existing evidence / source | Missing work |
| --- | --- | --- |
| Two-app loop | Plan 181: packaged test-variant invite/join/post/heal/restart | Ordinary identities, ordinary UI, public relay |
| Identity | `clients/treehouse-tauri-shell/src-tauri/src/key_store.rs`, `preview.rs`; `beginJoin()` in `src/treehouse_workflow.ts` | Packaged proof of distinct persistent ordinary identities |
| Enrollment | `issueInvitation`, `useOffer`, `confirmOffer`, `acceptInvitation`, `admitAndGrant` in that workflow | Independent evidence import before relay access; catalog-backed route source |
| Ordinary UI | `src/App.vue` requires both enrollment and dev-trace flags | Supported desktop enrollment UI and production WSS config |
| Transport admission | `apps/lattice_carrier_server/lib/lattice_carrier_server/operator/staging.ex`: `peers_exact`, `relays_reviewed` | Initial provisioning includes the admitted second identity before activation |
| Member permissions | `clients/lattice-client/src/treehouse_enrollment.ts` authors admission and exact-audience grants | Prove those helpers against bounded histories; grants are currently authored without an explicit lease |
| Thread creation | Ordinary workflow creates independently rooted bounded Spaces/Threads | Hosted packaged, initial staging and field proof (254); grammar closed by #164 (258) |
| Catalog trust | Elixir/TS evaluators; plan 245 native design | Native implementation; plan 245 first install is root-only |
| Capacity | `src/treehouse_state.ts`: all profiles in a 1 MiB record; sync pauses at `full` (plan 257) | Native owner pre-install check (plan 245 PR 5) |

All shell-relative paths above are under `clients/treehouse-tauri-shell/`.
Plan 224 PRs 1–3 are built; PRs 4–5 and plan 245 build PRs remain dependencies.
The local service-identity record describes an operations event, not a deployed carrier.

## Recommended decisions

D1–D6 below were adopted by the user's 2026-10-24 instruction to proceed. Native custody is implemented locally; hosted packaged, initial staging and actual Keychain evidence remain open.

### D1: close the initial admission circle offline

Current sequence cannot be promoted directly: the joiner needs a relay pull to verify
the invitation, while staging permits only the reviewed roster plus replica roots.
Do not open the relay to an unadmitted key or quietly weaken `peers_exact`.

Recommend enrollment by verified file exchange before the first publication:
founder exports invitation evidence; joiner verifies it and signs acceptance offline;
founder admits and grants locally; operator provisions the resulting reviewed roster.
Transport admission remains operator-controlled; membership remains signed log authority.
No new carrier message or remote administration API is required.

This deliberately supports the first two identities before initial activation. Adding
a third person to an already-running group needs a separately designed roster-update
transaction; do not claim this plan implements live membership reconciliation.

### D2: use one deterministic client realm per identity (row 256)

Recommend `treehouse-client:` followed by canonical unpadded base64url of the 32-byte
identity public key. Derive it from native identity, never from a catalog, arbitrary
offer field, service realm, or caller-supplied realm. It is a label, not authentication;
the authenticated handshake still proves possession of that public key.

Use the same mapping in app, operator manifest generation and readiness tests. Validate
against the existing shared alphabet. One key has exactly one realm. Keep legacy saved
realms on their existing path; refuse conflicting catalog enrollment with an explicit
migration explanation instead of silently rewriting them. No Wire-format change.

### D3: member trust needs explicit verification, not a root-only check removal

Recommend a native member-enrollment owner sharing plan 245's canonical/authority/catalog
evaluator and trust store. Keep its root bootstrap authoring command root-only.
Add a distinct first-member-install command with these additional preconditions:

- The local native identity matches the invitation recipient and signed acceptance.
- A user-reviewed group fingerprint matches the Space/root/bootstrap identity supplied
  by the founder through a separately verified channel (in person or a known call).
  Show a grouped SHA-256 fingerprint of a domain-separated canonical tuple containing
  Space replica, root public key and bootstrap op id; never trust a fingerprint carried
  only in the same unverified file as independent confirmation.
- The final signed histories verify the invitation, acceptance, honored admission,
  exact-audience usable Thread grants, unique bootstrap and catalog entries.
- Service identity, origin and routes are derived from those verified artifacts.

The invitation file is an untrusted candidate, not a route-installation receipt. Native
review tokens bind exact bytes, recipient, generation and identity; stale/reused tokens
refuse. Persist first trust atomically with enrollment state under plan 245's lock/CAS.
Existing identity plus deleted/corrupt trust stays `trust_recovery_required`; it must
never reopen a fresh enrollment slot. Extend plan 245's identity initialization marker
for join intent, including interrupted first launch and one-time legacy migration.

Retain D-44's honest-shell re-observation boundary: this plan does not silently adopt
row 260's native network client or claim compromised-webview freshness protection.

### D4: implement bounded Thread creation in the app (254, 258)

Use native signing and the existing authority rules to prepare child genesis, creation,
required continuation profile/pins, and the signed Space reference. Preserve independent
Thread root identity requirements; a transport service key never becomes an authority
root. Do not import a fixture Thread or relabel an existing legacy Thread.
Make family checks kind-aware in both TS and Rust, including `verifyProfile`.

Before building the UI, prove a bounded founder can issue the invitation, admit the
recipient and author usable bounded Thread grants through the existing authority
judgments in Elixir and TS. Decide required lease/profile inputs from those judgments.
If the existing helper's unleased grant is refused, implement the correct bounded grant
authoring; do not change Authority policy to make the demo pass. Missing witness/pin
inputs become explicit setup prerequisites, not synthesized eligibility.

### D5: choose a bounded first milestone rather than an unplanned storage rewrite (257)

Recommend retaining the existing storage architecture for this milestone and imposing
a common capacity budget on the one-Space/one-Thread path. Exporter and native owner
must calculate the serialized post-import profile size, including metadata and outbox;
refuse before changing trust or profile state if it exceeds the current 1 MiB record.
Give a visible capacity explanation and preserve readable history when posting stops.

This requires an explicit amendment to plan 245's maximum-size acceptance contract:
that plan currently expects much larger evaluator-valid evidence to import. Large
catalog/history fixtures must remain evaluator tests, but workflow acceptance tests
must exercise the adopted store limit. Do not mark row 257 done by adding an importer
check while retaining contradictory large-import done criteria. If the operator wants
the larger capacity now, shard storage first; that is the higher-cost alternative.

Applied by plan 257 (D-130): the existing sync path pauses a route at `full` with a visible
explanation, both stores accept exactly 1 MiB, and plan 245 PRs 5-6 now require the owner check
and store-limit acceptance tests instead of large-import workflow criteria. The exporter's
half of this budget is row 300.

### D6: scope the milestone explicitly

Recommend a scoped desktop experiment before R11c replacement, R14 lifecycle and the
Android community pilot. This is broader than plan 181's loopback waiver; it requires
an explicit roadmap amendment before enabling ordinary network builds. R13, G2 and
R21b are not automatically DONE. Continue using the pilot carrier boundary, never the
legacy `lattice_server` endpoint. Disclose that the relay/host/backup readers can read
plaintext and withhold availability; no E2EE or automatic replacement claim.

## Concrete user/operator sequence

1. Both ordinary apps create distinct identities through supported controls. Joiner
   exports its public join request; repeated export and restart retain the same key.
2. Founder creates bounded Space/Thread, completes required profile setup and catalog
   bootstrap ceremony, and receives the join request. No relay connection is needed.
3. Founder authors an invitation and exports a closed, versioned invitation-evidence
   file containing recipient, invitation id, Space/Thread scope and signed histories.
   Exclude route authority from this file; scope and roots are verified from histories.
4. Joiner imports it, checks the fingerprint with the founder, reviews scope and signs
   acceptance. Store candidate evidence separately from installed profiles/routes.
   The existing `acceptInvitation` requires held profiles and confirmed routes; add an
   offline evidence-review path instead of populating `PreviewState.relay` to bypass it.
5. Founder imports acceptance, verifies its recipient signature, commits honored
   admission and grants, and exports the final signed histories for provisioning.
6. Operator verifies/restores those histories, derives exact root/member peer sets
   and realms, stages/activates routes and performs readiness probes under plan 224.
   Supply initial signed logs through a supported verified importer; app frame exports
   are not `Log.dump` files. Never copy JSON into the log or edit a live holder file.
7. Custodian signs the catalog; operator commits `catalogued` then `listed` and exports
   final evidence via plan 245. Existing Space reference must not be published twice;
   reconcile local draft/export with the listing courier's exact frame and phase.
8. Each app imports final evidence. Native verifies identity, trust and capacity; the
   member owner also verifies admission/grants. Before final commit, a review-bound,
   read-only probe may dial only the cryptographically verified candidate endpoint
   with its exact service key/realm, to re-observe current history under plan 245.
   This limited probe grants no ordinary sync/post permission or installed-route
   receipt. Native re-evaluates returned evidence, commits verified histories/trust
   atomically, then enables chat. Unavailable/revoked evidence remains pending/refused.
9. Both apps connect using the derived client realm and native signer, post, sync,
   disconnect/heal and restart. Relay acknowledgement controls delivery status.

All file formats use closed keys, bounded decoding and canonical signed frame bytes.
On repeat import, reuse the exact attempt and existing signed operations. Crash recovery
must never create a second identity, genesis, admission or reference.

## Implementation slices and order

| Slice | Work and owning paths | Dependencies / exit |
| --- | --- | --- |
| A | Bounded enrollment proof and Thread authoring: `clients/lattice-client/src/treehouse_{bounded,enrollment}.ts`, Elixir Treehouse tests, workflow, Rust grammar | First; equal authority verdicts for one real-format bounded group, usable member post and wrong-recipient/revoked-grant refusals |
| B | Client-realm mapping plus versioned offline invitation evidence and supported verified provisioning import | A; no relay access needed for acceptance, identical derived peer map in app/operator, malformed/oversize files refuse |
| C | Native canonical/evaluator work from plan 245 PRs 2–3; store budget contract amendment | Can begin on fixtures alongside A/B; parity vectors, maximum-store-size acceptance and one-byte-over refusal |
| D | Root and member trust/enrollment owner extending plan 245 PR 5, native adapter and command permissions | A–C; wrong identity/group/fork refuses, token/CAS races and missing-trust recovery tests pass |
| E | Server plan 224 PRs 4–5, carried-route checks (248), boot signature verification (251), initial-log import and roster checks | A/B fixtures; real run waits on ceremony; exact signed catalog matches active served logs |
| F | Catalog-backed enrollment/sync UI: workflow, `treehouse_host.ts`, enrollment/catalog panels, desktop config and Vite contracts | D/E fixture exports; fold 255/259 into route authorization/feed reconfiguration; no `state.relay` bypass or dev-trace dependency |
| G | Ordinary packaged test gate and field exercise | F; independent Keychain identities, actual WSS, restart/heal evidence and exact artifact hashes |

### Slice A: implementation findings and remaining work

Implemented locally: bounded Thread preparation requires a root distinct from the
Space root and explicit nominee/witness parameters. It authors genesis, title and a
separate empty-delegation continuation/beacon pin. Enrollment can use a separate
signer for each child's grants. Both TS and Elixir replay the resulting signed
histories, including wrong-recipient and revoked-grant refusals and verified restore.
Kind-aware TS/Rust grammar and workflow replay now accept these bounded Threads.

The founder explicitly accepts its own invitation and enters the member roster before
inviting the second participant. Each gets its own exact-audience posting grant from
the child root. Both post as participant identities; transport likewise uses those
participant identities. This preserves the operator's roster/grant equality and avoids
needing multiple transport identities per app. The child root remains a setup/grant
authority. The proof uses disposable keys; it does not prove physical witness custody.
Existing authority accepts these unleased posting grants; no Authority rule changed.
This proves initial enrollment/posting, not permission renewal or founder-loss readiness.

The ordinary UI now supplies an explicit bounded setup to `createThread`; the dev-trace
fixture variant retains the legacy path, and existing legacy histories remain readable.
A legacy Space/Thread group is not silently migrated into a catalogued group.

Native implementation:

- Child aliases are derived natively from the participant public key and persisted nonce.
  Keychain holds the random seed; SQLite holds only its public binding. Binding is saved
  before a key is returned. An orphaned first-save key is reused; an already-bound missing
  or substituted key refuses without generation or cleanup.
- Native `initialize_thread`, read-only `thread_identity`, and `sign_thread` commands
  accept a nonce, not an alias. They check current identity and the pending intent or
  retained Thread. Signing is limited to canonical op/delegation prefixes carrying the
  exact replica and child public key, under the existing 64,000-byte limit. This scopes
  the signer; it does not add a native Authority evaluator or compromised-webview claim.
- History commits and key initialization share the process/file identity lock. The
  ordinary workflow commits child genesis/title/pin, Space reference, founder acceptance,
  admission and posting grant together, and spends the intent only on that commit.
  Public setup is immutable in the intent, so retry signs the same policy and uses the
  same key. Reopen performs a read-only ownership lookup, never key initialization.
- Posts, edits, tombstones and transport use the participant identity. Child-root signing
  is reserved for authorized administration. A revoked participant grant cannot fall
  back to the child root; the empty profile-pin delegation grants no administrative ops.
- Setup permits at most 16 witnesses and three Threads. Existing founder grants and scope
  are checked before saving an intent. A 128 KiB reserve in the 1 MiB history budget
  covers the bounded creation transaction; concurrent pending writes cannot consume it.
  Invalid setup, known unavailable grants, or insufficient capacity refuse before key creation.
- Missing child custody leaves history readable and is shown in the app. Lost keys are
  not regenerated. Backup/export/recovery of child seeds is outside this increment.

Local regressions cover interrupted key save and final commit, uncertain successful
commit, concurrent creators, missing/substituted/disappearing keys, no-write reopen,
malformed/oversized setup, scope/capacity refusals, signer dispatch and revoked grants.
The ordinary bounded workflow's actual signed frames are independently verified and
restored by Elixir. ACL tests deny remote and non-main webviews. These software tests
use isolated seed stores; they do not establish physical Keychain/witness custody.

Before operational closure, run the hosted ordinary packaged job, Linux operator
staging gate, and actual platform key/restart checks. The real ceremony, relay and
second-app field exercise remain later slices. No real-relay readiness follows here.

Before implementation, update plan 245 in the same PR for the member owner, bounded
Thread authoring, budget amendment and 255–259 dispositions (README rule 7). Update plan
224 for initial verified-log import and pre-publication enrollment. Keep build PRs small;
each gets an adversarial review, and custody/authority/carrier/workflow-CI changes get
the second independent review required by README rule 3. Do not spawn review agents
merely because this design lists future reviews.

## Verification and field acceptance

Every code slice: prepare both Node clients per AGENTS.md, use explicit asdf Mix and
OTP 28 PATH, run formatting/full suite (`mix verify`) and focused TS/Rust tests.
Run required per-app security gates for boundary changes and exact-tip hosted gates
per README rules. Browser/packaged/network exercises are heavy gates: run when the
implementation/acceptance work is authorized, not as a side effect of writing this plan.

The packaged gate must use ordinary desktop settings, actual Keychain identity paths,
no seeded key or loopback mapper, and no script injecting app state. Include:

- Wrong fingerprint/recipient, tampered/forked catalog, wrong service key and missing
  grant refuse without route installation or posting permission.
- Joining resumes after each file exchange, native commit and process restart.
- Invitation replay and acceptance replay do not duplicate admission/grants.
- Two apps post both ways; offline posts heal to identical op ids/state/verdicts.
- Restart both apps and relay; acknowledged operations and identities survive.
- Catalog route authorizes `mergeSync` without a hand-typed saved-route counterpart;
  removed routes close their sockets before reconnect or subsequent sync.
- Store exhaustion is visible and atomic; a catalog install cannot strand profiles.

Field evidence: two separately installed apps on two Macs, preferably different
networks; exact build hashes/commit, public endpoint, steps/results, redacted logs.
Restore backup onto a clean environment without changing service identity, verify
retained history, then repeat connection. Distinguish packaged CI, host operations,
field network proof and restore proof; one cannot substitute for another.

## Operator inputs and remaining decisions

Needed for adoption, not for this design's completion:

1. Accept or revise D1–D6, especially first-publication-only membership, the smaller
   storage budget and scoped release before replacement/recovery. Existing D-39/D-44
   decisions stay adopted; they are not reopened here.
2. Name the catalog custodian, separate passphrase holder, restore machine/media and
   rotation owner required by `docs/treehouse_catalog_signer_custody.md`. Supply the
   real verified ceremony report when available. Users enter secrets/prompts locally.
3. Provide the two Macs/tester and a trustworthy channel for fingerprint comparison.
4. Authorize the actual deployment/field run when ready and provide normal host/backup
   access; recheck existing host/DNS/TLS/key state first. No credentials in the plan.

Design exit: the admission circle, member trust boundary, client realm, bounded Thread,
capacity choice and ordinary-build gate have explicit recommendations and implementable
slices. Operational inputs and recommendations awaiting adoption remain labeled open.
