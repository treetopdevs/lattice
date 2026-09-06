# R10 — Treehouse domain and reciprocal runtime build contract

Status: preparation on `d08883da7d2e5a007bf66d3ffd2205d600109604`; implementation,
R09 integration, final integrated gates and exact-diff review remain pending.
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

Signed reference fixtures distinguish semantic membership from transport
availability: an extra route grants no commands, a missing route means unavailable,
and wrong replica/service/product binding refuses before a live reference is
presented. This is bounded fixture proof, not live catalog provisioning or the R15
slot/rollover saga.

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
