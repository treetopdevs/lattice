# Plan 138: Versioned delegation grant handoff (toward G1)

## Status

IN PROGRESS

## Objective

Advance the first capability-lifecycle slice across the proven LiveView-to-installed-app custody
rail. A fresh carrier-backed `/township` instrument prepares one unsigned v5 resident-grant
request. The issuer app validates and reviews the public policy, selects its parent from persisted
delegation evidence, derives dependencies from its local frontier, signs through native custody,
persists the authored grant locally, and publishes only after a separate explicit Sync.

The load-bearing packaged proof does not stop when a grant frame appears. After issuer Sync,
the same packaged app bundle launches as two isolated participant identities: the recipient app uses a
separate native key and KV file, pulls and persists the new delegation evidence, and authors a post under that delegation.
Stable source, Tauri feed, and LiveView must converge to `Lattice.Sim`.
A separate over-broad grant is structurally relayed and must be rejected by the projection as
`not_attenuated` with no usable authority.

v1 through v4 remain exactly unchanged. This plan adds one v5 authority request; it does not
reinterpret post, clerk-status, field-edit, or roster intents and does not create a general
authority bus.

## Why this increment

- Plan 053 already supplies canonical TypeScript delegation signing and
  `authorTownshipDelegation`; Plan 054 already supplies `submitTownshipDelegation`, local grant
  persistence, cap evidence, and a direct Vue ceremony. Rebuilding them would cross no new seam.
- Plans 057-058 prove storage redaction and both client-authored/live-BEAM handling of an unsound
  grant. This plan consumes those semantics through the stable real-app rail instead of inventing
  another authority model.
- Plans 130 and 135-137 established the frozen intent ladder, fresh-only preparation, one inert app
  ingress, native-custody Sign, separate Sync, reactive verified pull, Sim oracles, and one shared
  packaged build in hosted CI.
- An issuance-only frame-appearance test is too weak: it would not prove the recipient can use the
  issued capability or that an unsound grant fails authority reduction.
- Grant and revoke are separate plans. They have different public arguments, authoring functions,
  failure semantics, and oracle stages; revoke also requires an issued delegation. Plan 139 is the
  immediate v6 revocation follow-on.
- Succession is time/policy driven and has no Tauri authoring seam yet. It follows the ordinary
  grant/revoke lifecycle rather than being forced into this request protocol.
- iOS, QR camera, LAN discovery, physical-device behavior, cross-device pairing state exchange,
  and additional Android probe variants remain parked under `TOWNSHIP_BUILD_MAP.md` section 4a.

## Dependencies

- Plan 053: byte-identical TypeScript delegation authoring and recipient cap selection.
- Plan 054: Tauri grant ceremony, persisted parent selection, local log/outbox/delegation stores,
  and attenuation refusal.
- Plan 058: Sim-generated unsound-grant fixture and live-BEAM `not_attenuated` proof.
- Plan 130: unsigned public intent boundary and installed-app post handoff.
- Plan 137: immediately preceding v4 protocol, fresh LiveView, native review/sign/sync ceremony,
  multi-realm stable fixture, and no-build packaged CI pattern.
- Transitively, Plan 128 supplies structural durable relay and Plan 134 supplies the reactive
  verified-pull feed. Every dependency is `DONE`; none depends on Plan 138.

## Scope

### Included

1. One exact v5 unsigned authority-intent schema for a fixed resident grant profile, while keeping
   every v1-v4 producer, parser, fixture, app branch, and packaged proof frozen.
2. A fresh-only LiveView form that accepts only the public recipient Ed25519 key. The server owns
   the grant action and fixed profile; browser parameters cannot select ops, roles, or liveness.
3. Strict Tauri decoding, inert staging, command-specific review, replica recheck, native-custody
   grant signing, local log/outbox/delegation persistence, and separate explicit Sync.
4. Covered-parent success and a no-parent control that refuses before signing or persistence.
5. One Sim-generated packaged lifecycle using the same built app twice with isolated issuer and
   recipient identities. The recipient pulls the grant and uses it for an existing v1 post.
6. One Sim-generated over-broad grant negative that reaches the structural relay but reduces as
   `not_attenuated` and conveys no usable authority.
7. Focused unit/browser contracts, a no-rebuild packaged macOS smoke, hard CI wiring, cumulative
   verification, and documentation closure.

### Explicitly deferred

- Revocation handoff, succession, arbitrary delegation-policy editing, role transfer, or a general
  authority request bus. Existing direct grant/revoke controls remain available and unchanged.
- Cross-device cap exchange, recipient-device provisioning, QR/LAN pairing, mobile secure-store
  implementation, Expo, iOS, physical-device work, or another Android probe.
- Automatic Sync, background authored-frame publication, server authoring, or pushed operation
  materialization.
- Signed intents, intent receipts, duplicate suppression, cryptographic intent-to-op correlation,
  or cancellation.
- Production ingress, TLS, notarization, deployment, complete G1/Phase G, or receipt-free W4.

## Public contracts

### Frozen v1 through v4

Plans 130, 135, 136, and 137 remain byte-for-byte and behaviorally frozen.

- v1 accepts only `post` with nested `command` and `text`.
- v2 accepts only `close_matter` or `reopen_matter` with nested `command`.
- v3 accepts only `set_title` or `set_summary` with nested `command` and `text`.
- v4 accepts only `admit` or `remove_member` with nested `command` and `member`.
- Their URL shape, versions, key allowlists, UTF-8 and byte bounds, trim rules, replica and intent-id
  validation, parser results, review branches, authoring functions, and packaged behavior do not
  change.
- A v1-v4 authority payload is invalid. A v5 command payload, legacy command, `text`, or `member`
  field is invalid.

### New v5 grant intent

The exact public JSON shape is:

```json
{"v":5,"id":"<32-lowercase-hex>","replica":"<replica>","authority":{"action":"grant","audience":"<canonical-base64-ed25519-pubkey>","ops":["admit","post","set_summary","set_title"],"roles":[],"live":false}}
```

- The top-level object permits exactly `authority`, `id`, `replica`, and `v`.
- The nested authority object permits exactly `action`, `audience`, `live`, `ops`, and `roles`.
- `action` is exactly `grant`. This is an authority operation, not a `Township.Matter` command.
- The producer fixes one fixed resident grant profile: sorted ops `admit`, `post`, `set_summary`,
  and `set_title`; no roles; and `live: false`. The browser supplies only `audience`.
- `audience` is exactly one canonical padded standard base64 encoding of a 32-byte Ed25519 public
  key. Producers canonicalize public input: `TownshipWeb.ActionIntent.grant_url/3` and the Tauri
  `submitTownshipDelegation` / `normalizeAudiencePubkey` authoring path trim ASCII edge whitespace,
  then require exact canonical padded standard base64 of 32 bytes and emit the canonical trimmed
  value, following the producer rule frozen for v1-v4. The encoded v5 payload therefore always
  carries an already-canonical audience.
- The TypeScript deep-link parser requires the payload audience already canonical and rejects any
  edge whitespace, following the encoded-field rule frozen for v1-v4.
- Empty-after-trim, malformed, noncanonical, wrong-length, base64url-substituted, and oversized
  audiences fail closed in every surface. Edge whitespace is normalized by producer-role surfaces
  but fails closed in the deep-link parser because encoded wire input carrying it is noncanonical.
- Unknown versions, malformed outer base64url, extra keys, cross-version fields, parent-cap ids,
  dependencies, authors, signatures, private material, and altered policy values fail closed.
- `id` remains an unsigned diagnostic correlation label and never enters the delegation or
  enclosing authority op.

### LiveView preparation

The connected instrument exposes the grant form only while its carrier source is fresh. The
server event calls `TownshipWeb.ActionIntent.grant_url/3`; no client parameter chooses the action,
ops, roles, or liveness.

- Fresh carrier state plus a valid public audience emits the exact v5 URL.
- Verified-bundle, connecting, stale, unavailable, and unverified states do not prepare a grant.
- Grant preparation owns an independent slot. It does not clear prepared post, status, field, or
  roster requests and does not mutate the public read model.
- The prepared grant clears on freshness loss, replica replacement, another grant request, or
  producer validation failure. Validation feedback is scoped to the source replica.
- Phoenix receives no participant identity, private key, parent capability, delegation frame,
  dependency frontier, native-store contents, signature, authored op, or authority verdict.

### Tauri custody ceremony

The decoder adds `TownshipGrantActionIntent` to the existing reviewable union. The one shared
deep-link dispatcher stages v5 through the same replica-bound inert ingress as v1-v4.

The review shows the public recipient-key fingerprint and exact fixed policy. The visible sequence
is:

Use request -> Sign grant -> Sync outbox.

- Ingress and Use request do not sign, write KV, change local logs/outbox/delegation evidence,
  contact the carrier, replace unrelated accepted states, or invoke Sync.
- The app rechecks the saved pairing replica before signing.
- Sign reuses `submitTownshipDelegation`; no second delegation encoder or shell-only authority op
  is introduced.
- The app alone selects the issuer parent from persisted delegation evidence, derives deps from its
  persisted local frontier, invokes its native signer, appends the semantic authority op, retains
  the grant frame as delegation evidence, and queues that frame in the outbox.
- Sign does not publish. Only the existing explicit Sync control may relay the pending frame.
- A participant without an attenuating parent fails as `missing_delegation` before any signature or
  write. Focused spies prove zero native signatures and zero KV writes; native identity and KV reads
  remain permitted for discovery.
- Development controls invoke these production functions behind the existing dev-trace feature.
  They never log a complete intent URL, recipient key, delegation payload, private seed, or
  signature.

## Independent oracle and packaged proof

`Lattice.Sim` is the independent oracle. A BEAM fixture derives the base log, exact grant frame,
recipient-use frame, unsound grant, op ids, authority reasons, read models, and causal replay. Test
expectations are never hand-authored state or quarantine guesses.

### Sound grant and recipient use

1. Start from the existing onboarding-capable base. The issuer app identity owns the root/clerk
   parent that attenuates to the fixed v5 resident profile. A fresh pull-only LiveView observes the
   same stable path.
2. Launch the built app as the issuer app with an isolated native KV file and native development
   key seed. Wait for verified base convergence and persisted parent evidence.
3. LiveView prepares the exact v5 request for a distinct recipient public key. LaunchServices
   delivers it. Staging and Use remain inert; Sign leaves the exact Sim grant in local log,
   delegation evidence, and one-entry outbox while the stable source remains unchanged.
4. Explicit issuer Sync relays the existing frame, drains only after durable acknowledgement, and
   converges source, Tauri feed, and LiveView to Sim's post-grant projection with no authority
   quarantine.
5. Quit the issuer process. Launch the same package without rebuilding as the recipient app, using
   a second KV file, pairing realm, and native development key seed. It pulls and persists the new
   delegation evidence through verified carrier refresh.
6. A fresh existing v1 post intent is staged, reviewed, signed by the recipient app, and left
   pending. The resulting frame must be byte-identical to Sim and cite the new delegation.
7. Explicit recipient Sync publishes that already-signed post. Source, Tauri feed, and LiveView
   converge to Sim's exact op ids, proceedings, trust graph, authority reasons, and replay.

This proves two isolated packaged desktop identities using their own native keys against one stable
source. Delegating to a recipient public key is not movement of a private key, secret, or capability
object between devices.

### Unsound grant negative

A separate seeded participant authors the Sim-derived non-attenuating grant through the established
low-level client fixture. The stable relay accepts its valid structure and signature, but the full
projection must prove the over-broad grant is rejected as `not_attenuated`. Its audience cannot
author an honored command under that delegation.

The stable relay provides structural delivery and persistence only. Sim reduction through the
source projection, persisted Tauri feed ops, LiveView authority quarantine, and op DAG provides the
semantic oracle here. This does not prove live-BEAM authority honoring; Plan 058 owns that separate
live carrier proof and remains mandatory.

### Packaged and hosted shape

The dedicated `tauri_delegation_grant_handoff_smoke.ts` must additionally prove:

- v1-v4 parser and packaged handoff contracts remain runnable before it;
- the issuer pending frame and source are unchanged across ingress, Use, and Sign until Sync;
- the recipient uses its own key and isolated stores, receives no issuer private material, and
  cannot act before verified grant pull;
- the no-parent control refuses before signing/KV writes;
- server and observer identities author no participant operation;
- private seeds, full recipient keys, complete action URLs, and raw proceedings stay out of trace;
  and
- the real installed app receives `township://` through LaunchServices for both grant and recipient
  post requests.

The smoke builds only when run standalone. Hosted CI runs it after the no-build roster handoff and
before reactive feed with `TOWNSHIP_SKIP_DELEGATION_GRANT_APP_BUILD=1`, reusing the existing bundle.
A second hosted Tauri build is a STOP condition.

## TDD sequence

Work one vertical RED/GREEN at a time. Preserve all prior GREEN contracts before starting the next
RED.

1. **Plan/public-seam RED.** Add the cumulative Plan 138 contract and `IN PROGRESS` index row before
   this file. Record the one missing-file failure, obtain Claude review, strengthen the
   `not_attenuated` requirement, then add only the reviewed plan.
2. **Cross-runtime v5 RED/GREEN.** Produce a literal v5 fixture from
   `TownshipWeb.ActionIntent.grant_url/3`; consume it in the TS parser. First fail on the missing
   producer and unsupported version. Prove exact key sets, fixed policy, producer trim-then-validate
   canonical emission, parser canonical-only rejection for edge-whitespace/noncanonical/wrong-length/
   base64url/oversized audiences, frozen v1-v4, unknown versions, malformed outer encoding,
   smuggled custody fields, and extra keys.
3. **Fresh LiveView RED/GREEN.** Test fresh preparation, every non-fresh refusal, replica source and
   replacement, producer error, independent prior-intent slots, fixed policy, and client inability
   to switch the action or permissions.
4. **App ingress/review RED/GREEN.** Add v5 staging, replica mismatch, duplicate delivery, inert Use,
   public policy review, separate accepted-grant state, pre-Sign replica recheck, unrelated-state
   preservation, and no automatic Sync.
5. **Capability boundary RED/GREEN.** Drive covered Sign through `submitTownshipDelegation` and pin
   exact local log/outbox/delegation persistence. A no-parent participant fails with zero signer and
   KV-write calls.
6. **Sim fixture RED/GREEN.** Export sound grant, recipient post, unsound grant, projections, and
   quarantine from one deterministic oracle. Refuse fixture generation unless the sound post is
   honored and the unsound grant plus attempted use reduce exactly as expected.
7. **Packaged issuer RED/GREEN.** Launch the installed issuer app, deliver the real v5 link, prove
   inert ingress/Use, exact pending Sign, unchanged source, and explicit-Sync convergence.
8. **Packaged recipient RED/GREEN.** Relaunch the same bundle with isolated recipient identity and
   stores, prove verified grant pull/persistence, then drive the existing v1 post through pending
   Sign and explicit Sync to three-surface Sim equality.
9. **Unsound negative RED/GREEN.** Relay the exact unsound frame and prove Sim-equal
   `not_attenuated`, no honored use, and exact authority/op-DAG evidence without calling structural
   acceptance authority confirmation.
10. **Hard CI RED/GREEN.** Add fast v5 contracts to the unit job and one no-build packaged step
    between roster and feed. Add it to `app:convergence`; never build Tauri twice.
11. **Cumulative verification.** Run focused tests, complete app/browser/flagship convergence,
    pinned umbrella gates, warning compiles, xref, security/static checks, Rust, workflow lint,
    formatting, and diff hygiene.
12. **Independent review and closure.** Claude reviews every meaningful RED/GREEN and the exact
    final diff. Hosted implementation and branch-tip closure runs must pass before `DONE`.

## Required gates

Focused:

- pinned OTP 28 `mix test` for `TownshipWeb.ActionIntent` and `InstrumentLive`
- `npm run typecheck`
- `npm run action-intent:contract`
- `npm run deeplink:dispatcher:contract`
- `npm run action:contract`
- `npm run frontend:contract`
- `npm run build`
- `npm run tauri:delegation-grant-handoff:smoke`

Cumulative:

- existing post, clerk-status, field-edit, and roster packaged smokes
- `npm run tauri:feed:smoke`
- `npm run app:convergence`
- browser instrument/action, stable carrier, and flagship verification
- pinned OTP 28 `mix verify` and `mix check`
- forced test and production warnings-as-errors compiles
- xref, both HTTP-boundary Sobelow scans, actionlint, formatting, and `git diff --check`
- hard hosted unit, flagship, and packaged macOS jobs

## STOP conditions

- Any change to v1-v4 payloads, versions, accepted fields, parser results, review branches,
  fixtures, or packaged behavior.
- Any v5 command payload, altered policy, noncanonical audience, custody field, unknown field, or
  unknown version accepted by either runtime, or an encoded v5 audience carrying edge whitespace
  accepted by the TypeScript deep-link parser.
- Browser-supplied ops, roles, liveness, cap, deps, author, signature, or authority verdict reaches
  the authoring path.
- Any non-fresh LiveView source prepares a grant or client parameters replace the server-owned
  action/profile.
- Staging, Use, or Sign invokes Sync, mutates the source, or replaces unrelated state.
- The app skips its immediate replica recheck, bypasses `submitTownshipDelegation`, invents a new
  encoder, or selects a parent outside persisted evidence.
- A no-parent participant reaches native signing, KV mutation, outbox append, or relay.
- The recipient shares issuer key/KV state, acts before verified grant pull, receives issuer private
  material, or uses a hand-authored expected frame.
- The sound grant is considered complete without recipient use, or the unsound negative stops at
  structural acceptance without Sim-equal `not_attenuated` and failed use.
- Structural relay acceptance is called authority honoring or recipient use is called cap transfer,
  device provisioning, pairing, or mobile custody.
- The packaged gate bypasses LaunchServices, lets polling masquerade as reactive convergence,
  rebuilds Tauri, or weakens any earlier packaged gate.
- Revocation or succession is bundled into Plan 138, any section 4a area is entered, or any claim of
  automatic publication, deployment, complete G1/Phase G, or W4 is added.

## Non-claims

- No automatic authored-frame publication.
- No mobile secure-store implementation change.
- No cross-device capability transfer or recipient-device custody claim.
- No revocation or succession handoff; Plan 139 is the immediate v6 revocation follow-on.
- No live-BEAM authority-honoring claim from the stable structural relay.
- No signed receipt, production ingress, TLS, notarization, or deployment.
- No complete G1/Phase G claim and no receipt-free W4 claim.

## Likely files

- `apps/township_web/lib/township_web/action_intent.ex`
- `apps/township_web/lib/township_web/instrument_live.ex`
- `apps/township_web/lib/township_web/instrument_live.html.heex`
- focused `apps/township_web/test/township_web/*` tests and a v5 fixture
- `clients/township-tauri-shell/src/township_action_intent.ts`
- `clients/township-tauri-shell/src/township_deep_link_dispatcher.ts`
- `clients/township-tauri-shell/src/App.vue`
- focused TS intent, dispatcher, action, preview/feed, and frontend contracts
- a deterministic BEAM grant/recipient-use/unsound oracle fixture
- `clients/township-tauri-shell/test/tauri_delegation_grant_handoff_smoke.ts`
- stable-server helpers, package/workflow gates, and cumulative docs/contracts

## Pre-implementation evidence

- Plans 053-065 already prove canonical grant/revoke authoring, local persistence, no-secret KV,
  unsound grant, revocation lifecycle, cautious sync acknowledgement, authority surfacing, and
  revoked-delegation attribution. The missing seam is their integration across the 130-137
  fresh-LiveView/installed-app/stable-source/reactive-feed/hosted-packaged rail.
- `Township.ReadModel.roles.reasons`, the LiveView authority-quarantine panel, and op-DAG node
  status already expose `not_attenuated`; no speculative read-model subsystem is required.
- `refreshTownshipFromCarrier` verifies every pulled frame before persisting semantic ops and merged
  delegation evidence. A second isolated packaged identity can therefore prove real recipient pull
  and use without claiming cross-device exchange.
- Claude rejected a grant-frame-only slice as too weak, rejected succession-first as dependency
  inversion, and split grant from revoke because their public arguments, authoring paths, and
  semantics differ. Its PlanContract review returned `PROCEED` after requiring the central
  over-broad-grant rejection phrase.
- The cumulative contract first failed with 12 tests, 1 failure because this plan file was absent.
  Every Plan 127-137 contract remained green.

## Completion claim

Not yet complete. Plan 138 remains `IN PROGRESS` until every focused, packaged, cumulative, hosted,
documentation, and independent-review gate above is green.
