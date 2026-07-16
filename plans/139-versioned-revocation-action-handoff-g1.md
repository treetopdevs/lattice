# Plan 139: Versioned revocation action handoff (toward G1)

## Status

DONE (2026-07-14) - implementation and every required local gate are green. The exact v6 request,
installed-app ceremony, deterministic Sim oracle, authenticated carrier state report, and packaged
issuer/recipient proof were built one pre-agreed RED -> GREEN seam at a time. Full local
`npm run app:convergence`, OTP 28 `mix check`, both Sobelow scans, and Claude's final no-P0-P2
review are green. Hosted flagship run `29373501735` passed all three jobs at exact tip
`0e4d2b0fff8cdac281fd64f2b4e0ed923c8770c5`, including the v1-v6 packaged action ladder and
reactive carrier-feed tail.

## Objective

Add the revocation half of the versioned authority handoff without creating another authority
path. A fresh carrier-backed `/township` instrument prepares one unsigned v6 request selecting a
delegation id. The issuer app reviews that public selector, resolves it against persisted local
delegation evidence, rechecks the paired replica and issuer, signs through native custody, keeps
the existing evidence, persists the revoke locally, and publishes only after a separate explicit
Sync.

The load-bearing proof continues past carrier acceptance. An isolated recipient app must pull the
revoke before authoring a later post under the retained delegation. After explicit recipient Sync,
the stable source, Tauri projection, and LiveView must match the Sim oracle: the revoke remains
honored, the later post is `revoked_capability`, the blocked command is attributed to the selected
delegation, and the matter content does not include that post.

Versions 1 through 5 remain unchanged. The existing direct manual revoke form remains available
and continues to terminate in the same `submitTownshipRevocation` workflow. Both entry points
intentionally inherit the shared fail-fast evidence-to-replica guard added by this plan: valid
same-replica inputs retain their exact authored frame, while cross-replica evidence is newly
refused before signing or storage. This is a correction to the one shared workflow, not a second
revocation semantic.

## Why this increment

- Plans 059-065 already prove canonical revoke authoring, issuer and non-issuer semantics,
  pending-sync persistence, carrier-accepted versus authority-observed states, and delegation
  attribution. Reimplementing those primitives would cross no new seam.
- Plan 138 proves the versioned grant and isolated-recipient lifecycle. Plan 139 adds the matching
  revocation request and blocked post-revoke use without repeating the grant protocol.
- Plan 140 restores the TypeScript V-01 authority guarantee. Plan 141 prevents action, sync, and
  feed persistence races. Revocation must not ship on the pre-fix semantics.
- Plan 143 makes v6 a bounded descriptor addition instead of a sixth copied action ladder. It is a
  hard dependency even though the original Round 3 row omitted it.
- Revocation and succession remain separate. They have different authority inputs, evidence, and
  failure semantics.

## Dependencies

- Plans 059-065: revocation semantic, authoring, persistence, acknowledgement, and attribution
  foundations.
- Plan 130: strict unsigned public intent and installed-app handoff boundary.
- Plan 138: versioned grant, same-bundle isolated recipient, and Sim/source authority oracle.
- Plan 140: TypeScript authority and causal-order equivalence.
- Plan 141: serialized shell persistence and fail-loud native KV.
- Plan 143: descriptor-driven action lifecycle and shared packaged-smoke support.

**Hard start gate:** Plans 141 and 143 must both be marked `DONE` from one hosted flagship run in
which all three jobs pass and the full unit job executes its TypeScript, Rust, Credo, and Sobelow
steps. A fail-fast run that skips those steps does not unblock this plan.

## Scope

### Included

1. One exact custody-free v6 revocation request while v1-v5 stay byte-for-byte compatible.
2. One fresh-only LiveView form that accepts only a delegation id and prepares the unsigned link.
3. One Plan 143 descriptor slot for staging, Use, review, Sign, dismiss, status, and development
   routing; generic action lifecycle code remains unchanged.
4. Sign through the existing `submitTownshipRevocation` path, with an explicit target-replica
   check against the selected persisted delegation evidence shared by both the direct form and v6
   adapter.
5. Persistence assertions that revoke adds one semantic op and one outbox frame while leaving the
   delegation-evidence store byte-for-byte unchanged.
6. A deterministic Sim scenario with honored use before revoke, honored issuer revoke, and a
   causally later recipient post quarantined as `revoked_capability` with delegation attribution.
7. One dedicated no-build packaged choreography using Plan 143's shared harness and the same built
   app with isolated issuer and recipient keys/KV files.
8. Local and hosted hard gates for the v6 contracts and packaged proof.

### Explicitly deferred

- Succession, role transfer, arbitrary authority-policy editing, or a general authority request
  bus.
- Removal or redesign of the direct manual grant/revoke controls.
- Automatic Sync, background publication, direct server authoring, or pushed operation material.
- Signed intents, receipts, replay suppression, intent-to-op cryptographic binding, or private
  payload transport.
- Production ingress, TLS, notarization, deployment, cross-device transfer, mobile secure-store
  changes, physical-device work, complete G1/Phase G, or receipt-free W4.

## Public contracts

### Frozen v1 through v5

All accepted and rejected v1-v5 payloads, URLs, labels, trust checks, authoring functions, storage
formats, and explicit-Sync behavior remain unchanged. A v1-v5 payload carrying v6 authority keys
is invalid, and a v6 payload carrying a command object is invalid.

### Exact v6 request

The only accepted decoded payload is:

```json
{"v":6,"id":"<32-lowercase-hex>","replica":"<replica>","authority":{"action":"revoke","delegation":"<43-character-unpadded-base64url-id>"}}
```

- The top-level object permits exactly `authority`, `id`, `replica`, and `v`.
- The authority object permits exactly `action` and `delegation`.
- `action` is exactly `revoke`. This is an authority selector, not a `Township.Matter` command.
- `delegation` is the canonical unpadded base64url encoding of exactly 32 bytes: 43 characters,
  `^[A-Za-z0-9_-]{43}$`, no `=`, with decode/re-encode round-trip equality.
- The v6 validator is distinct from v5's padded standard-base64 public-key validator. Padded ids,
  `+` or `/`, wrong-length values, noncanonical encodings, and parser-side edge whitespace fail.
- The LiveView producer may trim ASCII edge whitespace from pasted input before canonical
  validation. The parser accepts only the already-canonical encoded field.
- `id` remains an unsigned 16-byte lowercase-hex correlation label. It does not become an
  operation id, dependency, capability, receipt, or duplicate-suppression key.
- No cap, dependency frontier, author, public/private signing key, signature, issuer assertion,
  authority verdict, or carrier acknowledgement enters the request.

### LiveView preparation

- Only a fresh carrier projection may expose and prepare the revoke form.
- The server accepts only the delegation id. It does not select capability evidence, decide who
  may revoke, or inspect participant custody.
- A successful preparation records only the exact v6 URL and its source replica.
- Freshness loss, replica replacement, another revoke preparation, or producer validation failure
  clears the prior prepared revoke.
- Staging the URL does not mutate the public read model or carrier source.

### Tauri custody ceremony

The visible ceremony remains:

```text
Use request -> Sign revoke -> Sync outbox
```

- Ingress and Use are inert: no signing, KV write, local-log/outbox/delegation mutation, carrier
  contact, source mutation, or Sync.
- The review renders the full selected delegation id and labels it `Revoke access request` without
  claiming that the browser supplied authority.
- Sign rechecks the current pairing replica. The shared revocation workflow then resolves the id
  from persisted delegation evidence, requires that evidence to belong to the same replica, and
  requires the local signer to be its issuer before any signature or KV write.
- `not_issuer`, `missing_delegation`, and `replica_mismatch` are the exact local refusal reasons for
  a non-issuer, missing evidence, and cross-replica evidence respectively. All three make zero
  signer and zero KV-write calls. These checks are fail-fast client behavior, not the semantic
  security boundary; Sim/BEAM authority remains authoritative for patched or stale clients.
- Successful Sign appends the exact semantic revoke and carrier frame under the Plan 141 writer.
  It does not add, remove, compact, or rewrite delegation evidence.
- Sign does not publish. Only the existing explicit Sync may relay the pending frame.
- Signing success copy is bounded to `Revoke signed and held for explicit Sync.` Carrier
  acceptance remains `pending authority confirmation`; it is never called access removal.
- The complete intent URL and full delegation id stay out of development trace output. A truncated
  display token is permitted.

## Independent oracle and packaged proof

A sibling deterministic node-spike scenario starts from a Sim-issued resident grant and one
honored recipient post. It derives all subsequent ids, frames, frontiers, authority reasons, read
models, and causal replay from one Sim run:

1. The recipient grant and pre-revoke post are authority-honored.
2. The issuer authors the revoke from the pre-revoke frontier; the revoke is honored.
3. The recipient synchronizes/pulls the revoke before authoring another post under the retained
   delegation. The revoke must be an ancestor of that later command.
4. The later command is exactly `revoked_capability`, cites the selected delegation, and does not
   alter materialized matter content.

The dedicated `tauri_revoke_access_handoff_smoke.ts` uses
`test/support/packaged_action_handoff.ts` and runs after the no-build v5 grant smoke:

1. Start the stable source at the Sim-derived pre-revoke stage.
2. Launch the built app as the issuer with its own key and KV file; verified pull must persist the
   issued delegation evidence.
3. Deliver the real v6 link. Ingress and Use stay inert; Sign creates the byte-identical Sim revoke
   in local log/outbox while source and delegation evidence remain unchanged.
4. Explicit issuer Sync drains only after durable acknowledgement and converges source, Tauri
   feed, and LiveView to the Sim post-revoke projection.
5. Quit the issuer and launch the same unmodified package as the recipient with a distinct key and
   KV file. Verified pull must contain the revoke while retaining the grant evidence.
6. A recipient attempt to Sign a revoke for the same delegation fails `not_issuer` without signing
   or writing.
7. The recipient authors the Sim-defined later post under the retained delegation only after the
   verified revoke pull. Explicit recipient Sync structurally relays it.
8. Source, Tauri feed, and LiveView converge to Sim's exact ids and matter projection; Tauri shows
   one additional authority quarantine and LiveView/source show `revoked_capability` attributed to
   the delegation. The attempted post is absent from proceedings.

The stable relay proves durable structural carriage plus verified projection. It is not itself an
authority-enforcement boundary. Plan 059 retains the separate live-BEAM semantic proof.

## Pre-agreed TDD seams

These are the public seams for this goal. Work one vertical RED -> GREEN slice at a time.

1. **Cross-runtime request seam.** RED exact Elixir fixture/TS parser tests for v6 and canonical
   unpadded base64url negatives; GREEN only the producer/parser/types while v1-v5 remain frozen.
2. **Connected LiveView seam.** RED fresh prepare, invalid input, stale, and replica-replacement
   behavior; GREEN one descriptor slot/event/builder/panel.
3. **Installed-app ingress seam.** RED dispatcher and mounted UI behavior for staging, trusted Use,
   replica mismatch, review, dismiss, and no side effects; GREEN one Plan 143 slot/label/render and
   runtime descriptor.
4. **Revocation authoring seam.** RED the existing direct form's byte-identical same-replica
   success, shared cross-replica/missing/non-issuer zero-sign and zero-write refusals, the v6
   adapter's exact frame, and unchanged delegation-store assertions; GREEN the minimal shared
   evidence-to-replica workflow correction and v6 submit adapter.
5. **Sim oracle seam.** RED scenario assertions for honored pre-use/revoke, causal ancestry,
   `revoked_capability`, attribution, and unchanged matter content; GREEN the deterministic
   scenario/fixture.
6. **Packaged issuer seam.** RED missing v6 choreography, inert ingress/Use, exact pending Sign,
   retained evidence, unchanged source, and explicit-Sync convergence; GREEN issuer half only.
7. **Packaged recipient seam.** RED verified revoke pull, non-issuer refusal, retained grant,
   causally later blocked post, and three-surface Sim equality; GREEN recipient half only.
8. **Hard wiring seam.** RED absent package/workflow/app-convergence entries; GREEN one fast unit
   gate and one no-build hosted packaged step.

## Required gates

- Focused `TownshipWeb.ActionIntent` and connected `InstrumentLive` tests.
- `TownshipRevocationHandoffScenario` tests.
- `npm run action-intent:contract`
- `npm run deeplink:dispatcher:contract`
- `npm run intent-ui:contract`
- `npm run runtime:wiring:contract`
- `npm run action:contract`
- `npm run frontend:contract`
- `npm run typecheck`
- `npm run build`
- `npm run tauri:revocation-action-handoff:smoke`
- Full `npm run app:convergence`, with one app build and the v6 smoke in no-build mode.
- OTP28 `mix check`, both boundary-app Sobelow gates, and `git diff --check`.
- Claude adversarial review after each evaluation/correction cycle.
- One hosted flagship run green across artifact, full unit/property/static/security, and packaged
  macOS jobs before this plan may be `DONE`.

## STOP conditions

- Plans 141 or 143 are not hosted-green, or v6 bypasses/reduplicates Plan 143's descriptors.
- The v6 parser reuses v5's padded standard-base64 audience validator.
- Browser input supplies cap, deps, author, signature, issuer, evidence, or an authority verdict.
- Use or Sign invokes Sync, or ingress/Use/Sign mutates the stable source.
- Sign selects evidence from another replica, signs before local evidence/issuer checks, or treats
  the local issuer check as the semantic authority boundary.
- Revoke adds/removes/rewrites delegation evidence, or accepted outbox compaction erases evidence.
- The recipient authors before verified pull makes the revoke causal history, or the expected
  `revoked_capability`/attribution is hand-authored instead of Sim-derived.
- Carrier acceptance is called access removal, revocation confirmation, authority confirmation,
  or proof that all future commands are blocked.
- The direct manual revoke control is removed, routed around `submitTownshipRevocation`, or given a
  distinct authoring contract; the shared cross-replica fail-fast correction above is required.
- The packaged smoke copies process/trace/deep-link/KV/cleanup infrastructure instead of using the
  shared Plan 143 harness, rebuilds the app, shares issuer/recipient custody, or stops at frame
  appearance without Sim/source authority evidence.
- Succession, mobile secure-store, production ingress, or receipt-free W4 enters this slice.

## Non-claims

- No claim that an unsigned request carries authority, proves issuer intent, prevents replay, or
  is a receipt.
- No claim that carrier acceptance confirms a specific revocation or removes access globally.
- No claim that every future command is blocked; the proof covers one causally later command under
  the selected delegation.
- No claim that TypeScript independently recomputes delegation revocation. The packaged shell
  consumes an authenticated carrier BEAM authority report only after independently verifying the
  exact signed frame set; the deterministic Sim scenario and Plan 059 own the semantic oracle.
- Revoke creates no delegation evidence and does not remove or rewrite existing frames.
- No succession, role transfer, production listener, TLS, deployment, cross-device transfer,
  mobile custody change, complete G1/Phase G, or receipt-free W4.

## Likely files

- `apps/township_web/lib/township_web/{action_intent,instrument_live}.ex`
- `apps/township_web/lib/township_web/instrument_live.html.heex`
- `apps/township_web/test/township_web/{action_intent,instrument_live}_test.exs`
- `apps/lattice_node_spike/lib/lattice_node_spike/township_revocation_handoff_scenario.ex`
- `apps/lattice_node_spike/test/township_revocation_handoff_scenario_test.exs`
- `clients/township-tauri-shell/src/{township_action_intent,use_action_intent,township_actions}.ts`
- `clients/township-tauri-shell/src/{App.vue,components/IntentReviewPanel.vue}`
- `clients/township-tauri-shell/test/fixtures/township_revoke_action_intent_v6.json`
- Focused shell parser/dispatcher/action/UI contracts.
- `clients/township-tauri-shell/test/support/stable_revocation_handoff_*.exs`
- `clients/township-tauri-shell/test/tauri_revoke_access_handoff_smoke.ts`
- `clients/township-tauri-shell/{package.json,test/runtime_wiring.ts}`
- `.github/workflows/flagship.yml`
- `plans/README.md`, `TOWNSHIP_BUILD_MAP.md`

## Pre-implementation evidence and second opinion

- Plans 059-065 show the missing seam is integration, not a missing revocation primitive.
- Plan 138 already proves the preceding grant and isolated-recipient package boundary.
- Plan 143 records the bounded v6 marginal sites and requires one dedicated choreography using the
  shared harness.
- Claude independently returned **GO to write the plan** and **STOP on implementation** until
  Plans 141 and 143 are both hosted-green. It required the distinct canonical unpadded-base64url
  validator, causal revoke-before-post order, zero-sign/zero-write non-issuer control, unchanged
  delegation evidence, a dedicated smoke, and preservation of the direct manual form. Those
  requirements are incorporated above.
- Claude's post-plan review found one P2 ambiguity between the shared evidence-to-replica guard and
  the preserved direct form. The correction now makes both entry points share the guard, freezes
  valid same-replica frame bytes, assigns exact refusal reasons, and requires cross-replica refusal
  before signing or storage. Focused re-review found no P0-P2 issue and returned
  `PROCEED WHEN HOSTED GATE CLEARS`; run `29358809212` then cleared that gate.

## Completion claim

Complete only when v1-v5 remain frozen; the exact v6 request passes strict cross-runtime parsing;
fresh LiveView preparation, inert Use, native-custody Sign, retained evidence, and explicit Sync
are proven; an isolated recipient pulls the revoke before an exact later command reduces as
Sim-derived `revoked_capability` with delegation attribution; the full local and hosted gates are
green; and Claude's final review has no unresolved P0-P2 finding.

As of 2026-07-14, all listed local evidence is green, including the mandatory v1-v6 packaged
convergence chain. Hosted run `29373501735` passed the flagship artifact,
unit/property/static/security, and packaged macOS jobs at the exact landed tip. That satisfies the
last completion gate without broadening the carrier-BEAM authority-oracle claim.
