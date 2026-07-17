# Plan 146: Witnessed succession artifact with protected governance presence (toward G1)

## Status

IN PROGRESS - the hard start gate is satisfied. The user selected a distinct governance
command/key with trusted user presence, explicitly resumed the build-map goal, and the fresh
post-closure Codex, Claude Opus, and Antigravity council pass found no unresolved P0-P2 issue.

Execution starts from exact documentation tip `61a1a8685af4c119cc327eeee86800fbfb62eaaa` on
`codex/township-build-map`.

## Predecessor Closure Record (2026-07-16)

- Plan 147 implementation tip `b2ad50629d1867dab71f0de50c038480bb5fe3b7` passed hosted run
  `29525397708`; exact documentation tip `7e7a0d3e0ff65b461094db3a2c9c9037b3cba4ec` passed manual
  hosted run `29526830271`. All three jobs were green in both runs.
- Plan 148 implementation tip `1eb1e4c1ee8e65832064e6c5dd633c4fbb571a3f` passed hosted run
  `29532242436`; exact documentation tip `61a1a8685af4c119cc327eeee86800fbfb62eaaa` passed manual
  hosted run `29533793872`. All three jobs were green in both runs.
- Fresh post-closure Codex, Claude Opus, and Antigravity review confirmed the live Plan 145/148
  interfaces still satisfy this plan. The first implementation slice is the plan-ordered
  cross-runtime v7 request seam; no native custody, artifact, or v7 review UI enters that slice.

## Implementation Progress (2026-07-16)

- Seam 1 is closed at implementation tip `9c20e7b6741ea07e8324142815e51c54d5c10d7b`.
  Hosted run `29537649815` passed Unit + property, flagship artifact, and packaged macOS
  convergence. One shared fixture pins the exact custody-free v7 clerk selector; Elixir produces
  those bytes; TypeScript accepts only the closed selector shape while preserving every v1-v6
  contract.
- A valid v7 request is parseable but not yet reviewable. The installed-app dispatcher rejects it
  with the existing coarse `invalid_action` outcome until Seam 3 registers the v7 descriptor and
  review surface. The reviewable v1-v6 union remains exhaustive and compile-checked.
- The RED gate failed on the absent Elixir producer and unsupported TypeScript version. Claude
  Opus found the initial GREEN incorrectly widened the reviewable UI union; a second RED proved the
  typecheck and staging failures, and the corrected GREEN passed focused BEAM, parser, dispatcher,
  structural frontend, UI, and typecheck gates. Full OTP 28 `mix check` also passed.
- Seam 2 is closed at implementation tip `b0bcc1c0c7daee30354e752dfe668d4a171fa492`.
  Hosted run `29546424500` passed Unit + property, flagship artifact, and packaged macOS
  convergence after one failed packaged attempt was retried for an external npm DNS lookup error.
  A fresh carrier projection exposes one clerk-role form, produces the exact v7 selector, retains
  it only for the same fresh replica, and clears it on invalid input, replica replacement, or stale
  state.
- Seam 3 is closed at implementation tip `579b90786f8ca479ef40e93f75cb9e5625542b4a`.
  Hosted run `29548446639` passed Unit + property, flagship artifact, and packaged macOS
  convergence. Matching-replica v7 ingress stages only an unsigned selector; trusted
  Use moves it into one disabled local review surface; untrusted Use, pairing absence, replica
  mismatch, and dismiss remain fail-closed and inert. Development routing includes the v7 slot,
  while Sign has no reachable submission path before verified claim derivation. The RED failed on
  the temporary dispatcher refusal and absent descriptor/review arms; GREEN passed the focused UI,
  dispatcher, typecheck, frontend, runtime-wiring, handoff-support, action, and production-build
  gates. A targeted label mutation failed only the two v7 contracts and restored to 21/21. Fresh
  Claude Opus RED, GREEN, and mutation reviews reported no unresolved P0-P2 finding.
- Seam 4 is closed at implementation tip `3fb730fc9a0048dd9fb0adf8b3aff09151d45e9a`.
  Hosted run `29550692702` passed Unit + property, flagship artifact, and packaged macOS
  convergence. One public four-input pure client helper derives the exact Plan 145
  claim, winning valid-genesis policy operation, pinned witness, threshold, and deterministic
  verified frontier from the Plan 148 BEAM-pinned local authority projection. It accepts no relay
  authority input and compares every returned field when rechecking a prior review before signing.
  Legacy or malformed policy, no holder, unpinned witness, mismatched replica, incomplete operation
  set, and stale epoch, successor, policy, threshold, or frontier all fail closed. The RED initially
  exposed a missing helper; Claude found and the revised RED removed false-green relay and stale
  checks. Focused GREEN is 14/14, typecheck and full client conformance pass, and removing threshold
  binding caused exactly the intended stale-threshold failure before restoration. Fresh Claude
  Opus RED, corrected-RED, GREEN, mutation, exact-worktree, staged-index, and hosted-result reviews
  report no unresolved P0-P2 finding.
- Seam 5 is locally GREEN. BEAM and TypeScript independently produced two exact Plan 145 canonical
  claim payloads and SHA-256 digests; the primary digest is
  `534b4fb858a618734c6718d4ae2133bf563787b404f6ccb2442928c72f303f51`.
  A fixed-schema Rust parser/encoder reproduces both byte oracles, computes each digest from its
  emitted bytes, accepts reordered JSON object keys, and rejects extra, missing, unsupported, and
  noncanonical fields plus unrelated JSON terms. It uses only existing base64, serde, and SHA-256
  dependencies; all encoding helpers are private and no general Lattice term or CBOR API exists.
  The corrected RED failed only on the absent module after Claude caught one test-constant
  transcription error. GREEN is 5/5 and the full native suite is green; swapping two canonical map
  entries failed exactly the two cross-runtime oracle tests before restoration. Fresh Claude Opus
  RED, corrected-RED, GREEN, and mutation reviews report no unresolved P0-P2 finding.
- Plan 146 remains `IN PROGRESS`. Seam 6, native governance custody, is next; no governance key,
  user-presence provider, signature, artifact, persistence, export, or succession authority exists
  yet.

## Objective

Add the first participant-facing half of the witnessed-succession ceremony without pretending that
one witness can recover a role. A fresh carrier-backed Township instrument prepares one unsigned v7
request selecting only the `:clerk` role. A paired witness app reviews that public selector, derives
the exact Plan 145 claim from independently verified local operations, proves that its dedicated
governance witness key is pinned in the effective valid-genesis policy, obtains fresh OS-mediated
user presence, signs through native custody, and explicitly exports one durable public witness
artifact.

The slice stops before certificate assembly, successor operation authoring, publication, or role
change. A BEAM verifier must accept the artifact's key, claim binding, and signature but return
`:insufficient_recovery_witnesses` under a threshold-two policy. That subthreshold result is the
load-bearing success condition, not a partial authority claim.

## Proposed Ceremony Decisions

These decisions are fixed for this plan. Runtime work still requires the hard start gate below.

1. **Artifact-first collection.** One witness exports one signature artifact out of band. The
   carrier is not extended to gather signatures, and this slice does not choose the later import or
   exchange UX.
2. **One vertical witness slice.** Threshold assembly and successor publication belong to a later
   plan after this artifact contract is independently proven.
3. **Epoch-only freshness.** The signed claim is bound to the exact holder acquisition operation
   and policy id. There is no wall-clock expiry, trusted-time claim, or automatic reconfirmation.
   A changed holder epoch, successor, replica, role, or policy makes the artifact unusable. Until
   then the artifact remains usable indefinitely and cannot be revoked by this app.
4. **Verified derivation, not browser authority.** The unsigned v7 request carries only replica and
   role. Holder, holder epoch, successor, policy id, witness membership, and signature bytes are
   derived or produced inside the app from verified local state and native custody.
5. **Explicit export.** Signing persists one public artifact locally. A separate trusted user
   action copies or exports it; ingress, Use, and Sign never transmit it or contact the carrier.
6. **Dedicated governance custody.** The witness key uses a separate native command, Keychain
   service, and fixed native alias. The generic carrier signer cannot select, load, or use it.
   Every governance signature requires a fresh OS user-presence decision; no release build may
   reuse a prior approval or accept a JavaScript-only confirmation as presence.

## Why This Increment

- Plans 130 and 135-139 prove the versioned app handoff through every non-succession Matter and
  delegation action. Succession is the remaining authority action with no participant ceremony.
- Plan 145 independently proves witnessed certificate verification in BEAM and TypeScript, but
  deliberately adds no TypeScript authoring helper, witness custody, collection, or v7 surface.
- A full multi-party ceremony would silently decide an unsettled collection transport. One witness
  artifact crosses the next real custody boundary while preserving the threshold.
- Phase F2 requires cryptographic construction selection and independent review; production
  deployment is outside the current POC; Plan 077 and physical-device variants remain parked.

## Dependencies

- Plan 140: TypeScript authority and causal-order equivalence.
- Plan 141: serialized, fail-loud shell persistence.
- Plan 143: one descriptor-driven action lifecycle and shared packaged-smoke harness.
- Plan 145: exact witnessed policy, claim, canonical bytes, verifier, mutation, and cross-oracle.
- Plan 147: local TypeScript capability/revocation decision parity before any v7 surface.
- Plan 148: BEAM-pinned valid-genesis holder/policy projection parity for claim derivation.

Plan 147 is a prerequisite because the witness reviews a materialized Township state that must not
silently accept capability-invalid commands. Plan 148, not Plan 147, supplies the exact
holder/policy projection used by the succession claim.

**Hard start gate:** Plans 147 and 148 must be `DONE` with exact-tip hosted closure; the final
Codex/Claude Opus/Antigravity plan council must report no unresolved P0-P2 finding; and the user must
explicitly resume the goal. Plan 145's ceremony-review requirement is not satisfied by this draft
alone.

## Exact V7 Request

The only accepted decoded request is:

```json
{"v":7,"id":"<32-lowercase-hex>","replica":"<replica>","authority":{"action":"witness_succession","role":"clerk"}}
```

- The top level permits exactly `authority`, `id`, `replica`, and `v`.
- The authority object permits exactly `action` and `role`.
- `action` is exactly `witness_succession`; `role` is exactly `clerk`.
- `id` remains an unsigned correlation label. It is not a claim field, receipt, operation id,
  replay guard, or duplicate-suppression key.
- No holder, holder epoch, successor, policy id, witness key, threshold, capability, dependency,
  signature, authority verdict, or carrier acknowledgement enters the request.
- Versions 1 through 6 retain their exact accepted/rejected payloads and behavior.

## Claim And Artifact Contracts

The app derives this existing Plan 145 claim from verified local operations:

```json
{
  "version": 1,
  "replica": "<replica>",
  "role": "clerk",
  "holder": "<canonical-padded-base64-32-byte-key>",
  "holderEpoch": "<43-character-base64url-op-id>",
  "successor": "<canonical-padded-base64-32-byte-key>",
  "policyId": "<43-character-base64url-policy-id>"
}
```

The exact export artifact is:

```json
{
  "v": 1,
  "artifactId": "<43-character-base64url-artifact-id>",
  "claim": {
    "version": 1,
    "replica": "<replica>",
    "role": "clerk",
    "holder": "<canonical-padded-base64-32-byte-key>",
    "holderEpoch": "<43-character-base64url-op-id>",
    "successor": "<canonical-padded-base64-32-byte-key>",
    "policyId": "<43-character-base64url-policy-id>"
  },
  "witness": "<canonical-padded-base64-32-byte-key>",
  "signature": "<canonical-padded-base64-64-byte-signature>"
}
```

- Objects permit exactly the displayed keys; encodings must decode and re-encode canonically.
- `artifactId` is the unpadded base64url SHA-256 of the canonical term
  `["lattice-succession-witness-artifact-v1", <Plan 145 signing payload bytes>, <witness bytes>]`.
  It is a deterministic storage/export locator, not a receipt or authority id.
- Signature bytes cover only
  `canonicalBytesForWitnessedSuccessionClaim(claim)`, the domain-separated Plan 145 payload.
- The unsigned v7 intent id is deliberately absent from the artifact and signed claim.
- The artifact is public evidence, not a secret, receipt, consent proof, absence proof, or
  certificate. The witness private key never leaves native custody.
- JSON object ordering is not semantic. The app emits the displayed insertion order for stable
  exports, while both runtime parsers accept any object-key ordering that has the exact key set and
  canonical values.

## Dedicated Governance Custody

The governance witness key is not another caller-selected `keyId` behind
`lattice_sign_carrier`.

- Add fixed commands `lattice_ensure_governance_witness_key` and
  `lattice_sign_governance_witness`. Neither accepts a key id.
- Store the Ed25519 seed in a distinct macOS data-protection Keychain service/account using
  `SecAccessControl` user-presence protection and a device-only, unlocked accessibility class.
  Set `kSecUseDataProtectionKeychain` for every macOS query.
- Store the corresponding public key as separate non-secret native metadata so review can obtain it
  without authenticating. On every sign, derive the public key again from the authenticated seed
  and reject any mismatch with that metadata before returning.
- `lattice_ensure_governance_witness_key` is strict get-or-create under one native creation mutex:
  when neither item exists it creates the pair once; when both exist it returns the sidecar; seed
  only, sidecar only, or mismatch is a fail-loud incomplete/corrupt state. It never overwrites,
  recreates, rotates, or silently repairs a pinned governance identity. Key rotation is outside this
  plan.
- First creation must be rollback-safe across the two Keychain writes and use duplicate-item
  semantics as the cross-process race guard. RED covers concurrent ensure calls, partial first-write
  failure, duplicate creation, seed-only, sidecar-only, mismatch, and process restart.
- Never insert the governance seed or `SigningKey` into `TownshipNativeState.signing_keys`. Each
  signature creates a fresh authentication context, reads the protected seed, signs, and drops the
  seed/key before returning.
- The sign command accepts the exact structured Plan 145 claim, validates its closed shape and
  canonical encodings, reconstructs the domain-separated canonical payload natively, and returns
  the witness public key, signature, and payload digest. It never signs arbitrary caller-supplied
  bytes.
- The OS prompt reason is built from the native-parsed claim and names the clerk-recovery action.
  User cancel, authentication failure, missing protected key, malformed claim, or native/TypeScript
  payload disagreement makes zero artifact-KV writes.
- TypeScript independently reconstructs the Plan 145 bytes, checks the returned payload digest and
  public key, and verifies the signature before persistence.
- Production has no environment-variable seed or presence bypass. Unit tests inject allow, cancel,
  and unavailable presence providers. A separate `township-governance-test-presence` feature,
  compile-time-invalid unless `township-dev-trace` is also enabled, may supply the packaged harness
  with a deterministic key/presence provider and must emit an unmistakable trace. Ordinary release
  and ordinary dev-trace builds omit it.
- Non-macOS builds retain fail-closed unsupported command implementations so existing Android/iOS
  compilation remains green without claiming mobile governance custody.
- One separate local packaged macOS probe must exercise the real system authentication prompt. The
  hosted packaged gate proves ceremony choreography with the test provider, not biometric/password
  enforcement.
- An automated ordinary-release binding gate must prove the registered governance sign command is
  constructed with the macOS protected-Keychain/user-presence provider and that the
  governance-test-presence feature/provider is absent. The manual prompt is positive platform
  evidence, not the only regression guard.

Apple's platform contract for this design is the Security/LocalAuthentication integration described
in:

- https://developer.apple.com/documentation/localauthentication/accessing-keychain-items-with-face-id-or-touch-id
- https://developer.apple.com/documentation/security/secaccesscontrolcreateflags/userpresence
- https://developer.apple.com/documentation/security/ksecusedataprotectionkeychain

## App Ceremony

The visible sequence is:

```text
Use request -> Sign witness artifact -> Export artifact
```

- Only a fresh carrier projection may prepare the v7 request. Freshness loss, replica replacement,
  or another preparation clears it.
- Ingress and Use are inert: no signer call, KV write, local-log/outbox mutation, network request,
  source mutation, export, or Sync.
- Review labels the request `Witness recovery request` and renders the full app-derived replica,
  role, holder, holder epoch, successor, policy id, winning policy genesis operation id, witness key,
  threshold, and verified frontier.
  It does not repeat browser-supplied values as verified claim fields. Review and export
  confirmation both display this exact warning:
  `This artifact has no expiry and may remain valid indefinitely. Valid until the clerk or recovery policy changes; this app cannot revoke an exported signature.`
- Before signing, the app rechecks the paired replica, requires a verified local operation set,
  calls one public pure client derivation helper over those operations, obtains the effective
  valid-genesis witnessed policy plus its winning genesis operation id and the current honored
  holder/acquisition epoch, and requires the dedicated governance public key in the pinned witness
  set. The helper accepts no relay authority result and duplicates no policy reducer in the shell.
- Missing or malformed policy, a legacy policy, no current holder, replica mismatch, unpinned
  witness, stale/replaced verified state, or claim derivation failure makes zero signer and zero KV
  write calls.
- Sign calls only `lattice_sign_governance_witness`, verifies its native payload digest, witness key,
  and signature locally, and persists exactly one artifact under the Plan 141 writer at
  `township:witness-artifact:v1:<artifactId>`. It creates no semantic operation or outbox frame.
- Re-signing the identical claim with the same witness recomputes the same artifact id and is
  idempotent. A different claim or witness has a different id, requires a new review, and never
  silently replaces the prior artifact.
- Export requires a separate trusted user event and emits compact UTF-8 JSON with the displayed
  insertion order. It performs no carrier request and does not mark the artifact assembled,
  accepted, or published. Before export, a human-readable confirmation repeats replica, role,
  holder, holder epoch, successor, policy id, winning policy genesis operation id, witness key,
  threshold, and the indefinite-validity warning; those display labels do not enter the canonical
  artifact.

## Independent Oracle

Use a deterministic threshold-two witnessed policy whose pinned set includes the app witness and a
separate control witness. Add a structured JSON boundary for the literal compact UTF-8 export and a
pure core normalizer over its decoded string-key map. The normalizer enforces exact wrapper/claim
key sets and canonical encodings, recomputes `artifactId`, converts the flat witness entry into the
existing `%{claim: claim, signatures: [...]}` certificate, and only then calls
`Lattice.Authority.SuccessionCertificate.verify/3`. Do not parse JSON with string slicing:

- the exact artifact must return `{:error, :insufficient_recovery_witnesses}`;
- malformed wrapper/version/base64 must return `{:error, :malformed_witness_artifact}`;
- a changed `artifactId` must return `{:error, :witness_artifact_id_mismatch}` before certificate
  verification;
- mutating its signature must return `{:error, :invalid_recovery_signature}`;
- changing holder, holder epoch, policy id, successor, role, or replica while recomputing the
  artifact id must return the matching claim or policy error;
- replacing the witness key with an unpinned key while recomputing the artifact id must return
  `{:error, :unknown_recovery_witness}`;
- reordering JSON object keys must normalize to the same artifact and result;
- adding the independently held control signature may prove the existing Plan 145 verifier reaches
  `:ok`, but the app in this slice never receives, assembles, stores, or publishes that certificate.

Expected values come from the BEAM verifier and deterministic Sim scenario, not from a TypeScript
reimplementation of the same expected result. Exact artifact errors remain test/internal
diagnostics; the UI exposes only coarse malformed, stale, unpinned, cancelled, or unavailable
refusals. Error precedence is artifact shape/encoding, then artifact identity, then the existing
Plan 145 certificate precedence.

## Proposed Public TDD Seams

These seams require explicit user confirmation. Work one vertical RED -> GREEN slice at a time.

0. **Predecessor closure.** No Plan 146 RED exists until Plans 147 and 148 have exact-tip hosted
   closure. Record their commit/run ids in this plan before opening v7.
1. **Cross-runtime request seam.** RED exact Elixir producer and TypeScript parser fixtures for v7,
   extra/missing fields, unsupported roles, and v1-v6 compatibility; GREEN only producer, parser,
   and types.
2. **Connected LiveView seam.** RED fresh preparation plus stale, invalid, and replica-replacement
   clearing; GREEN one descriptor/event/form using only the public role selector.
3. **Installed-app ingress seam.** RED trusted Use, inert ingress/Use, review, mismatch, dismiss,
   and development routing; GREEN one Plan 143 descriptor slot and review surface.
4. **Verified claim-derivation seam.** RED the public pure review helper against Plan 148's
   BEAM-generated holder/policy projection, plus fail-closed legacy, malformed-policy, no-holder,
   unpinned-witness, changed-epoch, and relay-report-disagreement cases; GREEN only that helper.
5. **Native canonical-payload feasibility seam.** RED one fixed Plan 145 claim whose exact canonical
   bytes and SHA-256 digest come independently from BEAM and TypeScript. GREEN only a fixed-schema
   Rust encoder/parser that reproduces those bytes, rejects extra/missing/noncanonical claim fields,
   and cannot encode an arbitrary Lattice term. STOP before custody work if exact parity would
   require importing or inventing a broad third canonical stack.
6. **Native governance-custody seam.** RED command separation, no arbitrary bytes/key id, fixed
   protected service, strict get-or-create, concurrent ensure serialization, rollback-safe first
   creation, seed-only/sidecar-only/mismatch/duplicate/restart states, fresh presence per signature,
   allow/cancel/unavailable behavior, no signing-key cache, public-metadata/seed mismatch, ordinary
   release-provider binding, and zero-write refusals; GREEN the minimal Rust state/module, command
   registration, and TS bridge. Use injected presence/key stores for automated tests.
7. **Artifact contract/oracle seam.** RED exact TS artifact identity/export plus BEAM literal-wrapper
   decode, recomputation, conversion, subthreshold result, holder/artifactId/version/encoding/key-order
   mutations, and existing signature/binding mutations; GREEN the minimal TS helper and BEAM adapter.
8. **Persistence and comprehension seam.** RED idempotent durable namespaced persistence,
   distinct-claim/witness non-overwrite, process-reload behavior, coarse UI refusals, full
   human-readable review/export confirmation, exact indefinite-validity warning, and proof that
   artifact/private key/local log/cap/outbox bytes never enter traces or the export; GREEN the app
   adapter and view only.
9. **Packaged fixture preflight seam.** RED one no-build harness step that discovers the dedicated
   governance public key through the test-only provider, constructs the threshold-two valid-genesis
   fixture with that pinned key, and proves the source starts with the expected BEAM projection;
   GREEN only fixture/preflight support.
10. **Packaged ceremony seam.** RED verified pull, inert Use, trace-loud test presence, native
   governance signing, process-relaunch artifact persistence, explicit export, unchanged source and
   outbox, and BEAM wrapper-to-subthreshold verification; GREEN only that choreography. Separately
   record one local real-prompt packaged probe.
11. **Hard wiring seam.** RED absent package/workflow/app-convergence entries; GREEN one focused unit
   gate and one no-build hosted packaged step.

## Expected File Boundary

- `apps/township_web/lib/township_web/action_intent.ex`
- `apps/township_web/lib/township_web/instrument_live.ex`
- `apps/township_web/lib/township_web/instrument_live.html.heex`
- focused `apps/township_web/test/township_web/*` tests
- `clients/lattice-client/src/authority.ts`
- `clients/lattice-client/src/codec.ts` only for an exported fixed claim/artifact encoder
- `clients/lattice-client/src/op.ts` only for the public artifact type
- `clients/lattice-client/test/*` focused claim/artifact contract
- generated `clients/lattice-client/dist/**` mirrors required by the normal build
- `clients/township-tauri-shell/src/township_action_intent.ts`
- `clients/township-tauri-shell/src/use_action_intent.ts`
- `clients/township-tauri-shell/src/township_actions.ts`
- the existing descriptor/runtime/frontend files only where the v7 slot is registered or rendered
- focused shell action-intent, runtime, action, frontend, and persistence tests
- `clients/township-tauri-shell/src-tauri/src/lib.rs`
- one focused `clients/township-tauri-shell/src-tauri/src/governance_witness.rs`-class module
- `clients/township-tauri-shell/src-tauri/Cargo.toml`/lock only for the macOS
  Security/LocalAuthentication binding selected by the RED spike
- `clients/township-tauri-shell/package.json` only for the isolated governance-test-presence feature
  build/gates
- focused native command and protected-Keychain tests
- one v7 fixture and one no-build packaged witness smoke using Plan 143 support
- one `Lattice.Authority.SuccessionWitnessArtifact`-class BEAM adapter and focused tests
- package/workflow wiring, this plan, `plans/README.md`, and claim-boundary status documents

Any carrier protocol/server, mobile, iOS/Android, election/attestation, Phase F/M4, deployment, or
successor-certificate publication file is scope drift.

## Required Gates

- Focused Elixir action-intent and connected LiveView tests under explicit asdf OTP 28.
- Focused TypeScript request, claim derivation, artifact, action, persistence, and UI contracts.
- Focused Rust command/custody tests, including command separation, fresh presence, refusal, and no
  governance-key caching.
- Fixed BEAM/TypeScript/Rust canonical claim bytes and digest equality before protected custody work.
- An automated ordinary-release binding contract built without
  `township-governance-test-presence`, proving the registered command uses the macOS protected
  provider and the test provider is absent.
- The deterministic BEAM literal-artifact adapter/verifier and full mutation checks.
- One local packaged macOS real-user-presence probe; hosted CI's injected provider is not a
  substitute for this evidence.
- One no-build packaged macOS witness-artifact smoke using the shared Plan 143 harness.
- Existing v1-v6 shell contracts and full `npm run app:convergence`.
- TypeScript typecheck/build/conformance and generated-dist equality.
- Full OTP 28 `mix check`, both boundary Sobelow scans, and `git diff --check`.
- A fresh read-only Claude Code Opus review at every RED/GREEN and correction, mutation, exact
  claims, staged publication, and hosted result. Independent Codex and Antigravity rejoin at the
  Plan 148 handoff, native custody GREEN, artifact-adapter GREEN, final staged diff, and hosted
  closure.
- One exact-tip hosted flagship run green across Unit + property, flagship artifact, and packaged
  macOS before this plan may be `DONE`.

Never run Mix commands concurrently. Always use the explicit asdf OTP 28 PATH from `AGENTS.md` so
Homebrew and mise cannot provide `erl`, `elixir`, or `mix`.

## STOP Conditions

- The user has not confirmed the collection/freshness decisions and public test seams.
- Plan 147 or Plan 148 lacks exact-tip hosted closure.
- The browser supplies holder, epoch, successor, policy id, witness membership, threshold,
  signature, capability, dependency, or authority verdict.
- A clock, tick, carrier generation, process liveness, or distinct-author count is called proof of
  dormancy or artifact freshness.
- The app signs before independently deriving the claim from verified local operations or signs
  with a key absent from the effective valid-genesis witness set.
- The generic carrier key service/command can name, load, or sign with the governance key.
- The governance command accepts arbitrary bytes or a caller-selected key id, caches the protected
  seed/key after authentication, reuses prior authentication, or has a release presence bypass.
- Rust cannot reproduce the exact fixed Plan 145 claim bytes without a broad third canonical codec.
- Ensure overwrites, recreates, rotates, or auto-repairs an incomplete governance identity.
- An automated test presence provider is called evidence of trusted OS user presence.
- Ingress, Use, Sign, or Export contacts the carrier, mutates the source, creates an operation or
  outbox frame, or implies automatic publication.
- One artifact is called a certificate, threshold authorization, role recovery, consent, witness
  independence, honesty, non-coercion, consensus, or receipt-freeness.
- The slice assumes an import, collection, assembly, successor-authoring, or publication transport.
- The carrier gains semantic authority or a new witness-artifact protocol.
- Plan 077/mobile, physical-device probes, Phase F/M4, production deployment, or W4 enters scope.

## Non-Claims

- One valid witness artifact is deliberately subthreshold and changes no role or matter state.
- A signature proves only that one pinned key signed one exact claim. It does not prove physical
  absence, elapsed time, liveness, informed consent, witness independence or honesty,
  non-coercion, consensus, or receipt-freeness.
- Epoch binding is deterministic replay binding, not trusted time, expiry, or recentness.
- OS user presence proves only that the device owner authenticated for one protected key access. It
  does not prove informed consent, independence, honesty, non-coercion, or comprehension.
- The export path is out-of-band public evidence, not private transport, anonymous ingress,
  delivery, acknowledgement, or publication.
- The carrier remains transport-only. The Phoenix instrument remains custody-free.
- No successor certificate assembly, succession operation, v7 role change, mobile custody,
  production deployment, complete G1/Phase G, Phase F/M4, or W4 claim lands here.

## Completion Gate

Plan 146 is `DONE` only when every confirmed seam is RED then GREEN, one real packaged app produces
and retains the exact artifact through dedicated governance custody, a local packaged probe records
the real macOS user-presence prompt, BEAM independently decodes the literal wrapper and distinguishes
its valid subthreshold signature from all load-bearing mutations, all prior contracts remain green,
the final Codex/Claude Opus/Antigravity council finds no P0-P2 issue, and exact-tip hosted CI passes
all three jobs.

Even then, witnessed succession remains user-incomplete until a later reviewed plan defines
artifact import, threshold assembly, successor custody, explicit succession-op review/signing, and
publication.
