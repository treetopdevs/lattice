# Plan 174 (SPIKE): Decide what the governance-witness ceremony must prove natively before it signs

> **Executor instructions**: This is a **design spike, not a build plan**. Its deliverable is a
> written decision document plus, at most, a throwaway prototype under the scratch path named in
> step 5 — **no production source file is modified**. Follow the steps, answer every question in
> the "Decisions this spike must make" section with evidence, and stop. If you find yourself
> editing `clients/township-tauri-shell/src-tauri/src/lib.rs` or any file under `src/`, you have
> left the spike. When done, update the status row in `plans/README.md` and open the follow-on
> build plan the spike recommends.
>
> **Drift check (run first)**:
>
> ```sh
> changed_paths="$(
>   {
>     git diff --name-only 91bb6ca6..HEAD
>     git diff --cached --name-only
>     git diff --name-only
>     git ls-files --others --exclude-standard
>   } | sed '/^$/d' | sort -u
> )"
> unexpected="$(printf '%s\n' "$changed_paths" | grep -Ev '^(docs/|plans/)' || true)"
> if [ -n "$unexpected" ]; then
>   printf 'production paths changed outside the spike boundary:\n%s\n' "$unexpected" >&2
>   exit 1
> fi
> ```
>
> This repository-wide allowlist covers committed, staged, working-tree, and untracked paths.
> If it reports any production path, compare the "Current state" excerpts against the live code
> and reconcile the plan before proceeding.

## Status

- **Priority**: P1 — the ceremony's only human control is a prompt whose text is attacker-
  influenced, over state the native side never verifies.
- **Effort**: M for the spike (reading + a decision document). The build plan it produces is L.
- **Risk**: n/a for the spike — it changes nothing. The **reason** this is a spike is that the
  build is HIGH risk and currently underspecified.
- **Depends on**: none for the spike. Its output amends
  `plans/146-witnessed-succession-witness-artifact-g1.md`, which is in progress.
- **Category**: security / direction
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Why this matters

The governance witness key is the most privileged secret in the desktop app: it authorizes clerk
recovery and succession. It is also the best-protected one — a hardened macOS keychain ACL,
`USER_PRESENCE`, a protected keychain, `synchronizable=false`. That protection terminates in a
single human decision: the OS biometric prompt.

Two things undermine that decision, and they compose.

**The native side signs a claim it has only checked syntactically.**
`sign_governance_witness` validates version, role, non-empty replica, and the base64 shapes of
`holder`, `successor`, `holder_epoch`, and `policy_id` — then signs. It never establishes that
`successor` is the successor the replica's policy actually designates, that `holder_epoch`
matches verified replica state, or that the claim corresponds to any real replica the user is
paired with. A syntactically perfect claim naming an attacker as successor is signed exactly as
readily as a true one.

**The state such a claim would be derived from is unauthenticated.**
`createJsonLocalOpLogStore.load()` reads persisted ops with `JSON.parse(raw) as Op[]` and an
`Array.isArray` check. No id recompute, no signature check, no replica check on data that has
been sitting on disk. So a mutated or rolled-back cache produces a plausible claim, and nothing
between that cache and the signature disagrees.

**And the prompt is not a reliable backstop.** `claim.replica` is interpolated straight into the
biometric prompt's localized reason with only an `is_empty()` check — no length bound, no
charset restriction, no newline stripping — so the text the user reads while deciding is partly
attacker-controlled.

The obvious instruction — "verify the claim natively before signing" — is not implementable as
written. Rust has no authority reducer, no canonical replica projection, and no way to evaluate a
delegation chain or a succession policy. Deciding *what* native verification means here is an
architecture decision about where the trust boundary sits, and it has to be made before anyone
writes code. Hence a spike.

## Current state

### The signing path — `clients/township-tauri-shell/src-tauri/src/lib.rs:570-612`

```rust
    pub fn sign_governance_witness(
        &self,
        claim: &serde_json::Value,
    ) -> Result<GovernanceWitnessSignature, String> {
        let payload = governance_witness::canonical_governance_witness_payload(claim)?;
        let replica = claim
            .get("replica")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| "malformed governance witness claim: missing replica".to_string())?;
        ...
        let reason = format!("Sign clerk recovery witness for {replica}");
        presence
            .authorize(&reason)
            .map_err(governance_presence_error)?;
```

The claim is canonicalized, the *replica string from the claim* becomes the prompt text, presence
is requested, and the payload is signed. There is no step between presence and signature that
consults any verified state.

### What canonicalization actually checks — `clients/township-tauri-shell/src-tauri/src/governance_witness.rs:27-46`

```rust
    let claim: GovernanceWitnessClaim = serde_json::from_value(value.clone())
        .map_err(|error| format!("malformed governance witness claim: {error}"))?;
    if claim.version != 1 { ... }
    if claim.role != "clerk" { ... }
    if claim.replica.is_empty() { ... }

    let holder = canonical_base64_32(&claim.holder, "holder")?;
    let successor = canonical_base64_32(&claim.successor, "successor")?;
    canonical_base64_url_digest(&claim.holder_epoch, "holder epoch")?;
    canonical_base64_url_digest(&claim.policy_id, "policy id")?;
```

Strict about *shape* — `deny_unknown_fields`, canonical base64, exact lengths. Silent about
*truth*: nothing relates `successor` to a policy, or `holder_epoch` to a frontier.

### The state a claim is built from — `clients/lattice-client/src/local_log.ts:22-30`

```typescript
    async load(): Promise<Op[]> {
      const raw = await storage.getItem(key);
      if (raw === null || raw === undefined || raw === "") return [];
      const ops = JSON.parse(raw) as unknown;
      if (!Array.isArray(ops)) throw new Error(`local op log ${key} is not an array`);
      return ops as Op[];
    },
```

`as Op[]` on disk data with no cryptographic check. This is the semantic cache the app reduces
to produce the state a witness claim would describe.

### The relevant existing protections, for contrast

- The *carrier* key uses default keychain protection while the *governance* key uses
  `use_protected_keychain()`, `AccessibleWhenUnlockedThisDeviceOnly`, and
  `AccessControlOptions::USER_PRESENCE` (`macos_governance.rs:47`, `:219`). The governance path
  is the hardened one — which is why the gap is in what it proves, not in how it stores.
- `sanitize_probe_event` (`lib.rs:1380`) already implements the newline/charset sanitisation that
  the prompt text lacks.
- The Elixir side has a real verifier: `Lattice.Authority.SuccessionCertificate.verify/3`
  (`succession_certificate.ex`) enforces claim binding, policy-id binding, known/distinct/ordered
  witnesses, and threshold. Whatever Rust ends up doing must not contradict it.

## Decisions this spike must make

Each needs a written answer with a rationale and the evidence behind it. "We will decide later"
is not an answer; "we accept X because Y, and here is the non-claim we will publish" is.

1. **What native state is authoritative?** Does the app maintain a verified replica projection in
   Rust, or does Rust hold only a signed artifact produced elsewhere? These are different
   architectures with different costs — enumerate both, do not assume.
2. **How are signed frames, replica identity, policy, frontier, and freshness each proven?** Name
   the mechanism per item. Note which are already available (`@noble`-verified frames exist on the
   TS side; `ed25519-dalek` exists on the Rust side) and which do not exist anywhere yet.
3. **How is rollback detected?** An attacker who cannot forge state can still present *old* state.
   A monotonic counter in protected storage, a frontier high-water mark, and a signed epoch are
   three candidate answers with different failure modes.
4. **Does Rust evaluate policy, or validate a proof produced elsewhere?** This is the pivotal
   question and it determines the size of everything else. Evaluating policy natively means
   porting a meaningful slice of `Lattice.Authority` to Rust — a third implementation of the
   authority judge, with a third chance to diverge. Validating a proof means designing the proof
   format and deciding who is trusted to produce it. State the trade explicitly, including what
   each option does to the BEAM↔TS↔Rust conformance burden.
5. **What must the OS prompt display?** It is the only human control. Decide the exact template,
   the sanitisation rule, the length bound, and which fields are shown (a truncated key
   fingerprint is more meaningful to a user than a full replica string, and is not attacker-
   shaped). Assume the user reads one line. Every displayed identity field must be derived from
   verified replica or policy state the native side already holds — never from submitted claim
   fields such as `claim.successor`. If verified native state cannot supply an identity field
   the prompt needs, the claim must be rejected before `presence.authorize` rather than
   displaying the unverified submitted value.
6. **Which direct IPC requests must be refused?** Today any webview-reachable caller can invoke
   the command with any syntactically valid claim. Decide what the native side requires beyond a
   well-formed claim — an origin binding, a challenge issued by the native side itself, a
   one-shot token, or a requirement that the claim reference state the native side already holds.
   Each `lattice_sign_governance_witness` request must require native authorization: bind a
   native-held claim or challenge/token to the canonical claim bytes and the caller/session,
   enforce expiry, and consume it atomically exactly once before signing. Do not treat
   presence approval or a signing mutex as sufficient authorization.

## Steps

### Step 1: Read the ceremony as it stands

Read, in this order, and take notes rather than acting:

- `plans/146-witnessed-succession-witness-artifact-g1.md` — the in-progress ceremony this spike
  amends. Understand what it already claims and what it explicitly does not.
- `apps/lattice_core/lib/lattice/authority/succession_certificate.ex` and
  `succession_witness_artifact.ex` — the Elixir verifier and artifact format.
- `docs/adr/0004-succession-validation.md` — the recorded succession decisions and their caveats.
- `clients/township-tauri-shell/src-tauri/src/governance_witness.rs` and the
  `sign_governance_witness` path in `lib.rs`.
- `clients/township-tauri-shell/src-tauri/tests/governance_witness_custody.rs` and
  `governance_release_binding.rs` — what is already pinned.

**Verify**: you can state, in two sentences each, what the Elixir verifier proves and what the
Rust signer currently proves. Write both down; they go in the deliverable.

### Step 2: Map the claim's provenance end to end

Trace where each field of a governance witness claim comes from, from persisted bytes to the
`invoke` call. Produce a diagram or an ordered list naming every hop and, at each hop, what is
verified and what is assumed.

The interesting hops: `local_log.ts` load → reduction → claim construction → `invoke` → serde
deserialization → canonicalization → presence → signature. State precisely where the first
cryptographic check happens today (answer: not until the Elixir side later verifies the
resulting artifact, which is after the fact).

**Verify**: the map names every hop and marks each one verified or assumed.

### Step 3: Enumerate the attacks the current design permits

For each, state the precondition and the outcome. At minimum cover: a compromised webview; a
mutated on-disk semantic cache; a rolled-back cache; a claim naming a replica the user is not
paired with; and a prompt-text manipulation that makes a hostile claim read as routine.

For each attack, note whether it is stopped by any *existing* control, and if so which. Be honest
where an attack is currently unmitigated — that list is the spike's justification.

**Verify**: each attack has a precondition, an outcome, and a named existing control or "none".

### Step 4: Design two candidate architectures, and recommend one

Write both up against the six decisions above:

- **Option A — native projection.** Rust maintains a verified replica projection: it verifies
  frame signatures, recomputes op ids, and evaluates enough authority to know the current policy
  and holder. Highest assurance; ports a slice of the authority judge into a third runtime.
- **Option B — validated proof.** Rust validates a compact, independently-verifiable proof
  (signed frames plus a chain) that the claim is consistent with replica state, without
  implementing the reducer. Smaller; requires designing the proof format and pinning who may
  produce it.

For each: what it proves, what it still assumes, the conformance burden it adds, and the size of
the build plan. Then **recommend one** with reasons. A spike that surveys without choosing has
failed.

**Verify**: both options are written up and one is recommended in a single explicit sentence.

### Step 5: Prototype only what the decision needs

If — and only if — the recommendation hinges on a feasibility question you cannot answer by
reading (for example, whether Rust can verify a delegation chain within an acceptable prompt
latency), build the smallest throwaway that answers it.

Prototypes go under a fresh directory from a portable temporary-directory command — e.g.
`PROTOTYPE_PATH="$(mktemp -d)"` — or another git-ignored path — **never** in
`clients/` or `apps/`. Record the resolved `PROTOTYPE_PATH` in the deliverable, record the
measurement, and delete the prototype directory afterward.

**Verify**: either no prototype was needed (say so), or the measurement is recorded, the
prototype path is recorded in the deliverable, and the prototype directory no longer exists
after cleanup (`test ! -e "$PROTOTYPE_PATH"` succeeds). `git status --porcelain` shows only
`docs/` and `plans/` changes.

### Step 6: Write the deliverable and the follow-on plan

Produce `docs/research/governance_witness_native_verification.md` containing: the two-sentence
summaries from step 1, the provenance map from step 2, the attack table from step 3, both
options and the recommendation from step 4, any measurement from step 5, and explicit answers to
all six decisions.

Then open the follow-on **build** plan implementing the recommendation, with its own scope, RED
tests, and STOP conditions. Note in it which parts of plan 146 it amends.

Include one thing regardless of which option wins: the **prompt-text fix** (step 5 of the
decisions) is small, independent of the architecture, and should be split into the build plan's
first commit or into plan 165's Part A. Do not let it wait on the architecture decision.

**Verify**: the document exists, answers all six decisions, and the follow-on plan is written.

## Done criteria

- [ ] `docs/research/governance_witness_native_verification.md` exists and answers all six
      decisions with evidence
- [ ] It contains the provenance map (step 2) and the attack table (step 3)
- [ ] It recommends exactly one architecture in an explicit sentence, with reasons
- [ ] A follow-on build plan exists in `plans/` with scope, RED tests, and STOP conditions
- [ ] The prompt-text sanitisation is assigned to a specific plan and commit, not left implicit
- [ ] `git status --porcelain` shows changes **only** under `docs/` and `plans/` — no source file
      in `apps/` or `clients/` is modified
- [ ] `plans/README.md` status row for 174 updated

## STOP conditions

Stop and report back if:

- You find yourself editing any file under `clients/township-tauri-shell/src-tauri/src/` or
  `clients/township-tauri-shell/src/`. That is the build plan, not the spike.
- The reading in step 1 shows plan 146 has already answered these questions — then this spike is
  redundant and should be closed as such, with a pointer to where 146 answers them.
- Either option turns out to require changing `Lattice.Authority`'s semantics. That is a
  substrate change and needs its own plan; the ceremony must fit the judge, not redefine it.
- You conclude that neither option is viable at POC stage. That is a legitimate outcome — write
  it up with the reasoning, recommend the interim mitigations (prompt sanitisation, refusing
  direct IPC claims, authenticating the on-disk cache), and say plainly what the ceremony does
  **not** prove so the non-claim can be published.

## Maintenance notes

- **Why this is a spike and not a plan**: "verify the claim natively" is an instruction that
  cannot be executed, because the native side has nothing to verify against. A build plan written
  now would fail its own STOP conditions on contact.
- **The cheap win is independent of the outcome**: sanitising and bounding the prompt text costs
  almost nothing and removes the attacker's influence over the one human control. Whatever the
  architecture decision, that should land first.
- **A second cheap, independent win**: authenticating `local_log.ts`'s on-disk cache — recompute
  op ids and verify signatures on load — narrows the attack surface under either option and is
  worth its own small plan. Note that plan 172's strict base64 work touches the same trust
  boundary and should land before it.
- **Do not let this block plan 146.** 146's witness-artifact work is separable; this spike
  constrains the *ceremony's* claims, not the artifact format.
