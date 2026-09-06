# R10 — Treehouse domain and reciprocal runtime build contract

Status: original atomic domain implementation `3d6a4443` and shared R04/R10
integration `f5fe2fb5` passed exact Claude Fable review. Final R03/R09/accepted-main
integration passed the final local gates and Sol propagation review below. Hosted integration and
downstream enablement remain open.
This packet executes unified R10 and the adopted Plan 158 amendment. Plan 178
remains the frozen vocabulary document; its protected status and claim text are
not rewritten here. One atomic XL integration contains BEAM, TypeScript,
generated vectors and the resulting local evidence.

## Scope and ownership

New domain files are `apps/lattice_core/lib/treehouse/{space,thread,invitation,read_model}.ex`.
The existing DSL and judge seams are `apps/lattice_core/lib/lattice/{replica,authority,reduce}.ex`
and `apps/lattice_core/lib/lattice/crdt/causal_list.ex`. Only command-effect
validation/ordering and an absolute list edit are changed; authority acquisition,
successor scope, canonical encoders and signed op/delegation formats stay intact.
`apps/lattice_core/lib/lattice/log.ex` may add only the fresh-VM dump vocabulary
proved necessary by the new domain commands.

The TypeScript files are `clients/lattice-client/src/{op,schema,carrier,capability,quarantine,materialize,policy,index}.ts`,
`src/crdt/reducers.ts`, and new `src/treehouse.ts`. Treehouse injects its command
decoder explicitly at the existing carrier-to-semantic seam, so identical names
such as `post` retain Township's existing interpretation by default. Existing
authority helpers and R09 root/lease parsing belong to their separate packets.

Evidence files are new `apps/lattice_core/test/treehouse/{domain,invitation,thread,parity}_test.exs`,
new `apps/lattice_core/test/lattice2/command_effects_test.exs`,
`apps/lattice_core/test/township/export_vectors_test.exs`,
`apps/lattice_core/lib/mix/tasks/lattice.export_vectors.ex`, new generated
`clients/lattice-client/test/vectors/treehouse_*.json`, new
`clients/lattice-client/test/treehouse.ts`, and the shared conformance harness
only where needed to inject the new decoder. `clients/lattice-client/package.json`
adds the named local gate; generated `dist/` accompanies its source. A new
`scripts/treehouse_demo.exs` proves the offline workflow and dump round trip.
This document records implementation evidence and limitations. README, unified
ledger, protected contract assertions, build-map copy, UI, live catalog,
grant screens, native custody and R04 production policy are outside this writer's
scope. Any additional production file requires a concrete scope amendment.

Root-approved amendment, before edit: `clients/lattice-client/src/authority.ts`
also needs an internal effects projection adapter. A Treehouse Space genesis
names both admin and moderator; visiting only the singular `op.field` omits one
holder. Expand only internal per-role views, retaining the same signed op ID,
deps and evidence. The DAG, capability-source collection and retained history
keep one operation. A globally quarantined op cannot activate any role view.
Two-role genesis and independent role-transfer parity are mandatory. Existing
single-effect input and root, beacon and successor rules remain unchanged.

Root-approved workflow amendments, recorded before implementation: Plan 178's
creation sentence now describes the fixed existing genesis followed by the
immediately dependent authorized name command. Pure preparation returns the
missing signed operations and observes retained initialization as uninitialized,
incomplete or ready; it performs no persistence and never reports a prepared name
as durable. An interrupted caller retries exactly the same signed input; a
different retained genesis or name refuses. Root-only preparation has empty
succession policies and cannot claim the separately gated R04/R14 profile.
The moderator vocabulary maps to one existing signed holder-gated authority
transfer. Admin transfer and grant revocation likewise use the existing authority
bodies. Read models derive real holders. No new genesis, delegation or wire
format and no parallel role marker are introduced. Plan 178's protected claim
sentences and ordered vocabulary remain unchanged.

## Atomic command semantics

The signed body stays `{command, args}`. The DSL returns the complete ordered
mutation list; the TS semantic op gains ordered `effects[]`. A legacy singular
effect normalizes to one element without changing historic signed bytes or vector
files. One op remains one DAG node and has one verdict. Unknown fields, malformed
mutation shapes, incompatible merge kinds, missing authority roles, or application
denial quarantine the whole command before reduction. No partial prefix applies.

Effect ordering matters within a command, while causal height and canonical op
ID retain the order between commands. Multiple list inserts use deterministic
element identifiers only when necessary; those identifiers are not DAG nodes.
The absolute `{:edit, original_post_id, text}` list mutation keeps the original
post's position/identity and uses the edit op's canonical ordering to choose its
body. Tombstones remain irreversible. The matching TS mutation carries the same
target and text. Legacy list insertion/deletion behavior is unchanged.

## Domain interpretation

`Treehouse.Space` records name, members, invitations, authorized Thread references
and admin/moderator-gated changes. The user vocabulary maps to existing authority
genesis/grant/transfer/revoke/succeed operations where those are already the
protocol action; no parallel authority primitive is introduced. Root-only test
creation is explicitly the legacy offline profile. R14 supplies the reviewed
bounded profile and real per-replica member-grant integration after R04.

An invitation is identified by its signed issue op and binds one public recipient
and the exact signed Thread-reference scope. Admission requires causal honored
issuance and a recipient signature over a domain-separated acceptance binding
Space, invitation ID, recipient and scope. Rebinding and revoked/stale invitations
refuse; an exact replay is idempotent. Admission/removal domain effects do not
pretend that one Space op grants/revokes another replica or transport route.
Tests perform the existing exact-audience grants and actual-issuer revocations on
the corresponding independent logs. R11/R14 own durable cross-replica fan-out and
`removal_pending` reconciliation.

`Treehouse.Thread` records title, posts and `archived`, with archive declared
`authority: :moderator`. Author edit/tombstone bodies explicitly identify the
original post and cited latest lineage target; every referenced post/edit must
be causally visible, honored and from this Thread. The original post signer owns
author edits and author tombstones. Moderator tombstones add an authority-field
effect so every effect in the command is holder-gated. No unarchive exists.

Denial precedence is missing/not-causal target, quarantined target, wrong
kind/Thread, wrong author, already tombstoned, archived Thread. Policy reads only
the candidate's causal `visible_ops` and `verdicts`. An honored causal archive
denies post, author edit and author tombstone; moderator tombstone remains allowed.
Concurrent posts survive. Authorized repeat archives remain distinct honored ops
writing true. Stale moderators retain the ordinary authority refusal. Space
references and external fixture routes/slots survive archive unchanged.

Signed reference fixtures distinguish semantic membership from available history:
an extra reference grants nothing, missing history means unavailable, and the
wrong replica refuses. The TS projection additionally refuses missing/mismatched
product decoder provenance. Signed service/catalog metadata validation and live
route provisioning belong to R11; these fixtures do not claim that trust path or
the R15 slot/rollover saga.

## Evidence sequence and closure

Public RED/GREEN proceeds membership/invitation, posts/effects, roles/archive,
then reciprocal integration. It includes malformed later effects, missing roles,
application-denied effects, concurrent admission/posts/edits, partition/heal,
quarantined lineage, tombstone irreversibility, admin-only archive denial,
moderator tombstone after archive, repeated/stale archive, transfer/removal,
partial-frontier replay, dump/restore and wrong input bindings. Generated vectors
carry one op per signed frame, all effects, canonical preimages, state, holders,
quarantine reasons and order. TS-authored bytes replay through the BEAM oracle;
BEAM-authored bytes replay through the TS judge. Existing vectors remain byte
identical unless a separately reviewed migration explicitly owns a change.

Final closure requires exact R09 source integration, fresh vector regeneration,
BEAM `mix check`, the three protected suites, TS typecheck/conformance/canonical/
authoring/Treehouse/build gates, the offline demo and independent dump restore,
and both per-app Sobelow gates. Review uses the complete immutable diff. Local
success is not hosted merge proof, native/physical founder-loss evidence, live
enrollment/provisioning proof or pilot readiness. No push/PR occurs before freeze.

## Implementation evidence

Public REDs retained under `/tmp/treehouse-r10-*.log` cover missing domain and TS
authoring exports, invalid invitation issuance, malformed later effects applying
a prefix, repeated same-op LWW/list edits choosing `z` instead of final `a`,
malformed Space values, missing real role transfer and creation retry, default
Township decoder acceptance against a Treehouse schema, inherited `constructor`
field acceptance, Unicode scope order divergence, and missing TS post identity
observation. Each changed production seam then passed its public GREEN. Review
also added genuine two-fork edits, concurrent honored/rejected invitation
revocation, malformed invitation argument types and non-causal revoke targets.
No legacy assertions or vectors were rewritten to conceal these failures.

R09 integration used the common reviewed resolution from `d5236619`: the
three-field witnessed beacon decoder precedes the exact-two legacy guard; other
arities remain inert. Township authoring imports were unioned, one R09 fixture
local renamed to avoid a duplicate declaration, and dist regenerated. R03's sole
post-baseline portability fix `e08e3995` is retained as `a530e25a`. The creation
helper consumes an already valid bound replica directly and verifies its root;
it does not weaken R09's reserved-marker binder.

Five new vectors carry 58 signed frames: Space membership (21), independent
roles/impostor genesis (7), existing witnessed Space role succession (5), Thread
archive (16), and concurrent Thread edits/posts (9). The succession fixture is
explicitly a legacy/root-only replay of existing witnessed role semantics, with
the founder retained as one witness. It is not R04's bounded continuation family
or an AF-2 proof. Every frame is re-authored in TS with identical canonical bytes,
ID and signature, then delivered in reverse order through the BEAM Wire/Sync
seams. State, holders, quarantine reasons, order, original post identity and
unique operation count agree. All 62 pre-R10 vector files remain byte-identical.

Public restore evidence checks each of the five histories in the current VM and
an independent VM that loads the application vocabulary. IDs, signatures,
holders, edited post identity/text, tombstones, archive, references, counts and
quarantine match exactly. No Log vocabulary, persisted format or canonical
encoding change was required. The offline `scripts/treehouse_demo.exs` also
replays interrupted creation, recipient acceptance, exact-replica fixture grants,
real moderator transfer, archive and dump/restore. It creates no live service.

The removal fixture explicitly retains the interval between semantic membership
removal and actual issuer-authored revocations on independent replica logs. A
forged recipient revocation fails; a causal post after the real Thread revocation
fails. Durable reconciliation, transport admission and `removal_pending` UI are
R11/R14 work. A stale Thread moderator cannot archive; its current holder can.

Named local results: focused domain/effects/contract suites 40 tests,
zero failures; TS typecheck, canonical, Township authoring (including witnessed
three-field and inert four-field beacons), Treehouse, all 67-vector conformance,
V01 guard, carrier, relay, relay-sync and build all exit 0. Final umbrella and
per-boundary results follow. No hosted claim is made.

The final independent input-boundary review found that BEAM preparation trusted
an in-memory retained Log while TS preparation verified retained frames. The new
public RED reproduced a forged name signature reporting ready with no pending
operations. Preparation now verifies every retained op's hash/signature, map
key/ID, replica and dependency closure before observing status or suppressing a
pending op; malformed structures fail closed. Six hostile retained-log forms
pass the focused GREEN (8 domain tests, zero failures). This changes only the
new Space helper, not Log.restore, Authority or a persisted format.

The first full `mix check` exited 0 with 737 tests and 27 properties, zero
failures and three existing exclusions. Both `lattice_server` and `township_web`
Sobelow scans exited 0. After the review fix, the final full `mix check` exited 0
with **738 tests and 27 properties, zero failures** and the same three existing
exclusions (`/tmp/treehouse-r10-mix-check-reviewed.log`). Existing Credo suggestions
retain their baseline exit-status treatment; this packet changes no lint
configuration. The final named protected check runs
`treehouse/contract_test.exs`, `township/election_protocol_contract_test.exs`,
`township/attestation_contract_test.exs` and the Plan 121 assertions in
`township/audit_bundle_test.exs`: **22 tests, zero failures**. All four test files
are byte-identical to the preparation baseline. The final reviewer reread resolves
the retained-input finding. The standalone formatted demo passes after the fix.

## Claude Fable follow-up to frozen f3fb93d3

The exact-diff review requested one P1 correction and identified three P2 edges.
The original implementation and its five vectors remain the immutable baseline;
these follow-up changes do not redefine the command vocabulary or signed bytes.

- **Structured set order (P1).** JSON serialization is not Erlang term order:
  `One more` sorted before its prefix `One`, and escaped quote/slash values also
  diverged. The Treehouse-only comparator now compares the exact admitted
  `replica`/`title` map values in Erlang's sorted-key order with UTF-8 binary
  comparison. Strings retain UTF-8 order; other shapes fail closed. It does not
  substitute CBOR encoding order. Public signed authoring RED is preserved in
  `/tmp/treehouse-r10-map-red.log`; the new BEAM-exported 17-frame
  `treehouse_space_map_order` vector fails both complete and bounded-frontier
  TS state checks under the former comparator
  (`/tmp/treehouse-r10-map-vector-red.log`). It exercises shorter prefixes,
  spaces, quotes, slashes, backslashes, BMP and supplementary Unicode in both
  replica references and titles. The existing five Treehouse and 62 earlier
  vectors stay byte-identical.
- **Duplicate flat roles (P2).** Public verification confirms this representation
  is authenticated: flat delegation role arrays have existing canonical set
  semantics, unlike the duplicate nested mapset terms rejected by R07. BEAM Wire
  decodes it to the identical original genesis. TS previously recorded two admin
  acquisitions for one signed node (`/tmp/treehouse-r10-roles-red.log`); it did
  not produce the speculative mixed honored/quarantined verdict in this case.
  Deduplicating only the generated role effects now records one acquisition per
  role without changing canonical input validation, IDs or signatures.
- **Application evaluator failures (P2).** A new public synthetic DSL command
  raises `KeyError` for an absent required argument; another raises
  `ArithmeticError` on zero division. The former previously stopped
  `Sim.quarantined` replay (`/tmp/treehouse-r10-evaluator-red.log`). Rescue now
  surrounds only the application `__apply_command__` evaluation. These errors
  refuse that command as `malformed_command`, preserve state and allow a later
  valid command. Authority, effect validation and reducer failures are outside
  this rescue boundary.
- **Future multi-append post ownership (P2).** The shipped Thread vocabulary has
  exactly one append per `post`, so the reported lookup is not reachable today.
  `Treehouse.ReadModel` now documents the precise extension prerequisite: expose
  an explicit owning-op ID from reduction before adding a multi-post command;
  never infer ownership by parsing generated element-ID suffixes. No new command
  or reducer identity representation was introduced.

Focused BEAM evaluator/domain checks pass 14 tests, zero failures. The expanded
Treehouse script includes the two public TS regressions; conformance, canonical,
Township authoring, V01 guard, typecheck and production build all pass. Final
parity, umbrella, protected and review evidence is recorded after those gates.
This remains local implementation evidence until the integrator completes exact
Claude review and hosted closure.

Final follow-up gates: `mix check` exits 0 with **740 tests and 27 properties,
zero failures**, retaining the three existing exclusions and unchanged Credo
configuration (`/tmp/treehouse-r10-fable-fix-mix-check.log`). The four protected
suites pass **22 tests, zero failures** and are byte-identical to `f3fb93d3`
(`/tmp/treehouse-r10-fable-fix-protected.log`). Reciprocal/fresh-VM checks pass
**3 tests, zero failures** over six Treehouse histories and **75 signed frames**.
The fixture now explicitly loads each domain module before strict Wire decoding;
the alphabetically earlier new vector exposed the old fixture-order dependency,
and no production decoder was loosened. All **68** conformance scenarios pass;
carrier, relay and relay-sync checks also pass. Existing **67 vector artifacts**
are byte-identical to the frozen baseline. The exporter was run through
`mix run -e 'Mix.Task.run("lattice.export_vectors")'` to compile the current source
before generation; a bare task invocation can reuse an older compiled task.


## Final shared-engine integration — 2026-09-06

The original domain and review fixes at `3d6a44431c6f3f1a3802aeab948f0dbb8e8f73a5`
passed actual Claude Fable review. Shared integration `da239a62` combines the
R04 continuation judge and raw-body decoder with R10's product decoder, ordered
effects and per-role views. Original-op family/input refusals run before role
views, and preflight and application share the same pure role decision.
Full `mix check` passed 784 tests + 27 properties at that source.

Integration `90a07e2b876fe40ac73db8bfd3a035844b315e42` adds accepted R06/R08/R09
and initial R03 remediation. Full `mix check` passed 803 tests + 27 properties,
zero failures, the same three exclusions, clean formatting and strict Credo exit 0.
The 68 R10 top-level vectors and three R04 continuation artifacts were preserved;
R03 added two top-level vectors. This is separate from physical custody/pilot proof.

The reciprocal real-Space continuation test executes the actual TS product
decoder against BEAM-authored retained histories, all ordered command effects,
valid finite continuation, stale holder and lease expiry. Follow-up
`f5fe2fb5fb588296ad68aa836ef0c3ffacb73b97` adds authentic refused consent reuse;
the focused test and format check pass. Fable's final integration review returned
PASS and closed its missing-real-product-history P2. CI now installs and builds
the existing client before this reciprocal Mix test, and AGENTS documents that
fresh-checkout prerequisite. No test skips, production bypasses or alternate
fixtures are introduced.

Final source integration `8a31683055846eeb60ac4ede15d03cde029cf02d` adds R03's
full reserved-metadata repair `a29c4510`, its generated declaration, R04's matching
integration/evidence, and accepted main `c22272ec` with R09's count correction
and the independently reviewed canonical-generator repair. The contextual body
decoder remains composed with the product decoder and raw continuation parser.
Final local/source and hosted gates will be recorded against their actual tips.

### Exact legacy epoch integration and final local gate

Integration `dd41fd6025939e35ad95d9d478231f5ba619f201` adds the then-current R04
`f58267b8` and R03 `65b5364e`. The source merge is automatic; normal client
build at `f21456ca` regenerates the widened carrier declaration. Actual Fable's
R04 integration review passes with no P0/P1/P2 and verifies the high-epoch
continuation refusal seam. Earlier R10 final review at `25fa8e93` also passed;
the new exact R10 integration review remains open after Claude's session limit.

Full `mix check` at f21456ca passes **806 tests and 27 properties, zero failures**,
three existing exclusions, clean formatting and strict Credo exit 0. Final TS
typecheck/build/conformance and Treehouse domain/review checks pass. Logs are
`/tmp/lattice-treehouse-execution-20260906/engine-high-epoch-full-check.log`,
`engine-high-epoch-conformance.log`, and `engine-high-epoch-treehouse.log`.
The existing CI unit job now runs the standalone Treehouse domain/review script
explicitly as well as reciprocal BEAM tests and conformance; no existing gate
is removed or timeout changed. Exact tip/merge CI remains required.

### Final constructor dependency and reviewed engine source

Final integration `883124b513f32bf4614a8512cd34e1da5d344893` adds R04
`ca3bd592` and R03 `39ea40da`, including the claim-constructor dependency
deduplication and its signed public regression. Configured `gpt-5.6-sol` reviewed
the exact four-file cascade: PASS, no P0/P1/P2; the previous landing blocker
from the absent constructor repair is resolved. TS product decoder, command
effects, continuation composition and CI source remain unchanged in this merge.

Full `mix check` at 883124b5 passes **807 tests and 27 properties, zero failures**,
three existing exclusions, clean formatting and strict Credo exit 0, recorded in
`/tmp/lattice-treehouse-execution-20260906/engine-ctor-final-full-check.log`.
Fresh compiled BEAM vector regeneration leaves every tracked oracle file
byte-identical (`engine-final-vector-regeneration.log`); earlier client build,
conformance and Treehouse domain/review gates apply to unchanged TS source.
Exact new-tip hosted checks, all fresh review threads and dependency/main merge
checks remain open. The staged R10 PR is #74, based on R04 #71 until it lands.

### Final raw-dependency parity propagation — 2026-09-06

Automatic source merge `2581ddc9` carries R03 `54aa2230` through R04 `640a48a4`
into `86dd122d`, with no manual conflict resolution. The sole production hunk
normalizes the expected witnessed-beacon dependency set using distinct values
and UTF-8 byte order. Raw outer dependencies remain authenticated and retained;
duplicate received certificate dependencies still refuse. Treehouse product
decoding, all-or-none effects, continuation selection and exact high legacy epoch
handling remain unchanged. Later evidence commits change documentation only.

Full `mix check` at this source passes **808 tests and 27 properties, zero
failures**, with three existing exclusions. Formatting and strict Credo exit 0;
existing low-priority suggestions remain. Commands used the prescribed asdf/PATH
toolchain and `ERL_FLAGS='+S 4:4'`, with no timeout or suite changes. TS
typecheck/build, 213 Township authoring assertions, 1,495 conformance assertions
plus 57 continuation histories, 12 codec tests, 14 continuation-authoring tests,
886 canonical assertions and 18 Treehouse checks pass. Six Treehouse scenarios
retain all 75 reciprocal signed frames.

Fresh current-source BEAM/TS exporters preserve every one of the 74 pre-existing
top-level vectors and the three continuation artifacts. The inherited signed
raw-dependency case adds the 75th top-level vector. The continuation exporter
reorders JSON object keys, but all 57 parsed histories, array order and signed
byte strings are exactly equal; regenerated output was preserved separately and
the committed presentation retained. This is not a claim of byte-deterministic
JSON object ordering. No fixture expectations or signed bytes were changed.

Actual configured `gpt-5.6-sol` read-only review of `86dd122d..2581ddc9` and
`ca3bd592..640a48a4` returned **PASS, no P0/P1/P2**. It verified identical propagated
patch IDs, the new raw vector/test blobs and preserved continuation/product
logic. Review did not execute the test gates. Full logs and preservation proofs
are under `/tmp/lattice-treehouse-execution-20260906/engine-54aa-*`; the actual
review is `sol-r04-engine-54aa-propagation-review-result.md` in that directory.
Final PR-tip, dependency and merge-result hosted checks remain required. No
native, device, provisioning or pilot readiness is inferred from this local gate.
