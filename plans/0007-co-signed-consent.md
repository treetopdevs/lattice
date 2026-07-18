# ADR 0007 — Co-signed consent for custody-transfer commands

## Status

Accepted (2026-07-18). First consumer: PD-003 (Toolshed) `:custody_transfer`. Blocks any
PD-003 code. Reconciled against `main` @ a96b3c4; re-verified on
`codex/township-build-map` @ ba4d4eff at acceptance (`validate_command/7`,
`command_status/3`, `Log.accept/3` id-idempotency, both `authority.ts`
`{ zip215: false }` verify sites all present as cited). Styled twin:
`adr-cosign-01.html` (Rev 2).

Implemented @ 2765413b; hosted closure: flagship run `29661633474` green across all
three jobs (unit + property suite, packaged macOS convergence, flagship artifact) at
the exact implementation tip. V-05–V-07, V-09, V-10 land in full; V-08 has a directed
race test (generator-scheduled churn left open).

## Context

The op model has exactly one signer: the `author`, whose Ed25519 signature over the
canonical encoding makes an op self-certifying. PD-003 needs a command that is valid
only if a **second** party also signed off — a custody transfer that neither the
lender nor the borrower can unilaterally assert. This is the only substrate-touching
item the product siblings (PD-002/PD-003) introduce.

Constraints inherited from the codebase:

* Property (c) demands byte-identical replay, so any consent signature must encode
  deterministically under `Lattice.Canonical` (ADR 0001).
* The single-predicate discipline (V-01) means signature-completeness must not become
  a second validation mechanism.
* `Log.accept/3` is idempotent **by id**, and the id excludes signatures
  (`lib/lattice/log.ex`, see the comment about quarantined forgeries sharing an id).
  Any design that carries co-signatures *outside* the hashed content is therefore
  broken: a single-signed variant accepted first would make the completed op a no-op
  and silently drop the co-signatures. This finding rejects the "co-sigs as an op
  field" shape outright.
* Design invariant 4 — *nothing is dropped* — means an invalid transfer must be
  quarantined and auditable, not silently rejected.
* Three shipped precedents already carry side-signatures over domain-tagged
  `Canonical.term` payloads: succession certificates
  (`Lattice.Authority.SuccessionCertificate.signing_payload/1`), election close
  certificates (`Township.Election.ClosePolicy.UnanimousBoxesV1.signature_payload/2`,
  already multi-signer), and carrier session challenges
  (`Lattice.Carrier.Session.sign_challenge/2`). This ADR is the fourth instance of
  that pattern, promoted to a first-class validity conjunct.

## Decision

Consent is a **signature over a domain-tagged canonical payload, carried inside the
command body** — inside the hashed content. The op cannot exist without the consent,
the id changes if the consent changes, and `Log.accept/3` needs no modification
because there is nothing outside the hash to merge.

Two surfaces, one validity conjunct:

### Surface 1 — the request (existing inbox mechanism, no new code)

A borrow or return request is an `:inbox` op with body `{:request, "custody",
payload}`. `Lattice.Authority.analyze/2` already collects these into the durable
requests list; the current validated holder resolves them (the Q-06 rule). An
unresolved or refused request is visible and timestamped — refusal-legibility lives
on this surface and requires nothing new.

### Surface 2 — the transfer (one new command, consent embedded)

```elixir
consent_payload =
  Lattice.Canonical.term([
    "lattice-custody-consent-v1",  # domain tag, versioned like the op tag
    replica,
    request_op_id,                 # the nonce: binds consent to ONE request
    from_pub,                      # current holder — the op's author
    to_pub                         # recipient — the consenting signer
  ])

consent_sig = Lattice.Identity.sign(recipient_identity, consent_payload)

# op: kind: :command, author: from_pub
# body: {:custody_transfer, [to_pub, request_op_id, consent_sig]}
```

The ceremony is ordered by construction: the recipient signs the consent payload
first (QR/NFC round-trip at the physical handoff — app layer, above the carrier);
the holder embeds it, builds the op, and appends. A body with a missing or invalid
consent hashes to a different id than any valid transfer, so the same-id hazard
cannot arise. An abandoned half-ceremony is ephemeral app state, never an op.

### Validity rule

A `:custody_transfer` command op `O` by author `A` is **honored** iff:

1. **Authority (unchanged).** `A` clears the existing `cap_ok` + `authority_ok`
   gates as the validated holder of the custody role at `O`'s causal position
   (ADR 0003 machinery, untouched).
2. **Consent.** `consent_sig` verifies against the recomputed payload for the signer
   `to_pub` declared in the body; the payload's `from` equals `O.author`; and
   `request_op_id` names an op in `O`'s causal past.

Failures of (2) quarantine as `:missing_consent` / `:invalid_consent` — semantic,
deps-decidable, visible, with audit events, and covered by property (d) exactly like
`:stale_holder` and `:double_transfer`.

### Implementation hook

`validate_command/7` in `Lattice.Authority` gains one consultation of a new
**optional, op-aware module callback** (defaulting to `:ok`). The existing
`command_status/3` sees only `{cmd, args}`; the consent check needs `op.author` and
causal position, hence the new callback rather than an extension of the old one.
This callback is the only substrate code this ADR adds. The consent conjunct must
land in **both** semantic-reduction implementations — `Lattice.Authority` and
`clients/lattice-client/src/authority.ts` — in lockstep (see Verification).

## Rationale

* **Consent is not authority.** The recipient's signature confers nothing; the
  author must independently be the validated holder. No delegation, revocation, or
  holder-timeline code changes. A dead or unresponsive holder cannot author a
  transfer; recovery flows through the steward role and succession (ADR 0004), on
  purpose.
* **In-body beats an op field.** Zero struct change, zero `:lattice_log_dump_v1`
  migration, zero `Lattice.Carrier.Wire` change, zero TS codec change — and the
  accept-path hazard above is structurally impossible.
* **Ordered ceremony is a feature.** The log proves consent preceded append. The
  cost — the recipient signs a payload for a transfer that does not yet exist as an
  op — is bounded by the `request_op_id` binding, which makes each consent single-use.
* **Determinism is inherited, not built.** Ed25519 signing is RFC 8032
  deterministic on both realms; verification is strict on both (OTP `:crypto` eddsa
  on the BEAM; `@noble/curves` with `{ zip215: false }` explicitly at both existing
  verify sites in `authority.ts`). Consent bytes inside the canonical body are
  therefore property-(c) safe with no new mechanism. This ADR promotes the strict
  flag from happenstance to invariant.
* **Semantic tier, not structural.** Consent validity depends on the DAG (causal
  presence of the request op), which the structural tier is documented not to
  decide. Structural quarantine keeps its current meaning.

## Adversary tax

* **A1** — every consent signature is a receipt, by design. Correct for custody and
  treasury (legibility surfaces). Any proposal to point this mechanism at
  vouch-shaped surfaces loses by default: the election work has since demonstrated
  concretely that coercion-facing signals need their own multi-role protocol and
  cannot ride legible machinery (see the frozen `Lattice.Attestation` seam).
  A quarantined forged/coerced transfer attempt is also *on the record* — for the
  legibility corner, that is the point: the failed attempt is evidence.
* **A2** — strengthened. No self-serve custody; no consent-as-backdoor-authority;
  replay dead by request-id binding.
* **A3** — neutral. The ceremony transport (QR/NFC) is app-layer and adds no
  infrastructure.
* **PQC tripwire (gap D-A1, sharpened).** With consent bytes inside the hash, a
  randomized-signature scheme (Dilithium-class) would make the op id itself
  nondeterministic per signing. Any suite swap under ADR 0001's agility path must
  re-derive the entire property-(c) claim for consent-carrying commands.

## Verification gates

* **V-05** — the consent conjunct lives inside `validate_command`'s dispatch and
  nowhere else on the BEAM side (grep-enforced: none in Log, Sync, Materializer, or
  app modules outside the declared callback).
* **V-06 (the gate that matters most)** — cross-language quarantine parity. A
  custody-consent reference vector added to the conformance harness
  (`mix lattice.export_vectors`) covering: valid consent, missing consent, invalid
  signer, wrong request id, replayed consent — green on both the Elixir and
  TypeScript reductions. Without this, property (d) diverges silently *by realm
  type*.
* **V-07** — property (c) extended over consent-carrying commands (same seed ⇒
  byte-identical logs including consent bytes), plus a static check that every
  `ed25519.verify` call in the TS client passes `{ zip215: false }`.
* **V-08** — ceremony window races authority churn: generators schedule holder
  transfer/revocation between request, consent signing, and transfer append; the
  existing `authority_ok` timeline check must quarantine a transfer whose author
  lost holdership in its own causal past.
* **V-09** — replay: a consent signature lifted from one integrated transfer and
  embedded in a second transfer op quarantines as `:invalid_consent` in every realm.
* **V-10** — the dispute story runs on the request surface: an unresolved custody
  request is visible and timestamped in the analyzer output and read model; a
  refused one shows the holder's refusal op.

## Out of scope (do not implement)

* **Co-signatures outside the hashed content** — rejected by evidence (accept-path
  idempotency); do not reintroduce in any form.
* **n-of-m threshold consent** — the payload names one consenting signer. Quorum
  semantics are a different validity question with partition edge cases;
  `UnanimousBoxesV1`-style unanimity at the app layer is the interim pattern if ever
  needed. Own ADR, on a real consumer.
* **Signature aggregation (BLS-class)** — one extra Ed25519 sig is 64 bytes inside a
  body; revisit only on compaction-scale evidence (ADR 0006).
* **Proximity binding of the ceremony** — QR/NFC proves nothing cryptographic about
  physical presence and this ADR claims nothing. `Lattice.Proximity` remains an
  *unregistered name*, not a stub in the tree — the `Lattice.Attestation` seam's
  history (a behaviour named before its research verdict, later frozen and routed
  around) is the cautionary tale.
* **Blind or deniable consent** — the election protocol's problem space. This
  mechanism is the legible corner and must not grow toward the other one.
* **Cross-replica atomic consented transactions** — consensus-shaped; the substrate
  deliberately does not have it.
* **Mandate command registration** — ADR-MANDATE-01's dual-gate is a named
  prospective beneficiary and adopts this via its own addendum or not at all.

## Notes and caveats

The consent payload schema is deliberately minimal (one domain tag, four fields).
Anything anyone wants to add — timestamps, terms, due-backs — belongs in the command
args or Cap caveats, not the signed consent, or the schema starts accreting. The
optional op-aware callback is a real (if small) change to the Authority behaviour
surface and should be reviewed against every existing replica module, not just
`Township.Matter`. Reconciliation was against `main` @ a96b3c4; if implementation
lands on a feature branch, re-verify the cited call sites there.
