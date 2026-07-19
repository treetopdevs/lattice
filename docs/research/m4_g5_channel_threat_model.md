# G5 decision — anonymous-channel threat model `channel-onion-clientcover-noreceipt-v1`

**Status:** decision **cleared 3-agent review**, 2026-07-17. Synthesized by arbitration
from cycle-1 EVALUATE-plan registers (agy F-01–F-10 crypto/coercion posture; codex 1–11
repo-contract posture); options A/B/C all non-viable-as-written, C rejected as a
deferral. Cycle-2 confirmation surfaced one independently-converged high finding
(agy New-01 = codex NEW-1, cover-padding contradiction), fixed in cycle 3; agy cleared,
codex pre-cleared on the exact wording correction applied. Zero unaddressed high-severity
findings; residual assumptions named (box-metadata-adversary out of scope, off-peak
anonymity-set residual, credential-surrender forced-abstention, Tor adapter assessment,
RV-G5-1 replay-nullification).
**Gate:** G5 of `m4_interface_redesign_brief.md` §15 — "The anonymous-channel threat
model, traffic observer, denial-of-service boundary, and inclusion-check behavior are
explicit."
**Binding baseline:** the closed G2 pin `chide-es-r255-v1` (box-private-v1 admission,
open-posting cover, order-free remove-all, forced-abstention/censorship/availability
`:not_claimed`). No `SecurityProfile` claim flips; no secret in any transcript; voters
never author board ops; W0–W3 unchanged.

## 0. Why this is Option D, not A/B/C

Ideation offered A (Tor onion + box dummies + acceptance receipt), B (Nym mixnet +
external cover + probes), C (adapter-agnostic envelope). The two adversarial passes
disagreed on selection — agy preferred C, codex preferred B — but converged on the
same amendments. Arbitration:

- **C is rejected** (codex #11, blocker): the ledger makes G5 a *decision* that owns
  closing R5, and the closed G2 pin already consumes a real anonymous-channel
  assumption. An L0-only envelope is a deferral that gives G12 nothing to compose and
  leaves an unledgered G5b blocker. G5 must bind a real adapter now.
- **A's acceptance receipt is rejected** (agy F-03, codex #4/#5): a box-signed digest
  receipt is a wire-transcript value (so "not a transcript, therefore G10-safe" was
  false reasoning), and its coercion composition under retry/multi-box/decoy/
  duplicate-nullification is unresolved. Default to **no receipt**.
- **Box-authored dummies are rejected** (codex #6): the brief's role table assigns
  ballot *creation* to the voter client; boxes only publish. Cover content is
  client/third-party authored; boxes still author the wrappers.
- **The frozen abort cap is rejected** (codex #9): overload *mechanism* is G5's to
  name, but the cap value and abort authorization belong to G8/G13; the brief forbids
  invented feasibility targets. Do not freeze 50,000.

Option D keeps A's honest box-inside-metadata-trust posture — consistent with the
already-closed G2 §5/R17 disposition that the box sits inside the metadata trust
boundary — binds A's Tor onion adapter under C's assessment rigor, uses client-authored
cover, and carries B's mixnet as a named future upgrade path rather than the v1 pin.

## 1. The pin

| Field | Value |
|---|---|
| Channel profile id | `channel-onion-clientcover-noreceipt-v1` |
| First-leg adapter (bound) | `transport-tor-onion-v3-v1` — each ballot box runs a Tor v3 onion service; separately assessed per §6 before any anonymity-conditioned claim |
| Test adapter | `transport-deterministic-test-v1` — seeded, replayable; proves protocol correctness only, **never** anonymity (R7) |
| Box metadata posture | box is **inside** the metadata trust boundary (consistent with G2 §5/R17); box-colluding-observer privacy is **out of scope and named** |
| Cover source | **client/third-party authored** fake-credential ballots; boxes publish, never mint (codex #6) |
| Acceptance receipt | **none** in v1; inclusion is local-lookup only (§4); receipt design deferred to a dedicated coercion-evidence review |
| Overload behavior | degrade via identity-free transport throttles; **cap value + abort authorization deferred to G8/G13** (codex #9) |
| Channel manifest home | new `township-election-v2` spec field `channel_manifest_ref` (full `ArtifactRef`), resolved in foundation verification, required in the offline bundle — **buildable work this decision authorizes** (codex #1/#2/#3) |

## 2. Traffic-observer model (explicit)

**In scope** — the model defends against each, conditional on the bound adapter's
assessment:

1. **Voter-side local observer** (ISP/LAN/national vantage): sees the voter uses Tor at
   some time; not destination, content, or that it is a ballot box.
2. **Board/carrier observer** (any replicating peer): sees every board op, its box
   author, arrival timestamps, batch boundaries. **Universal and unavoidable** — the
   board is replicated.
3. **Two-point observer (R5):** simultaneous (1)+(2). The batch-publication policy
   (§3) exists to break voter-transmission-to-publication correlation.

**Out of scope** — named, per verdict §2 and brief §16:

- Global passive adversary across all Tor links.
- **Box-as-metadata-adversary** and **box-colluding-with-voter-side-observer.** The box
  learns arrival metadata of what it receives; v1 does not defend voter privacy against
  its own box. This is the honest cost of the box-inside-trust-boundary posture and is
  why forced-abstention resistance stays `:not_claimed`. Upgrading to a mixnet
  (Option B's `transport-nym-sphinx-v1`) is the named path to close this and is a
  future channel-profile revision, not v1.
- Live device compromise, continuous physical surveillance, compromised client.
- Active Tor-level confirmation/netflow attacks (inherited from Tor's own model).

**Anonymity-set realism (agy F-02, stated not hidden):** at ≤10k voters over a
multi-day window, off-peak batches may contain few real ballots; a fixed-clock batch
can hold ~1 real ballot in a diurnal valley, and the two-point observer then wins by
counting. v1 therefore adopts a **hybrid batch trigger** (§3) — release on *either* a
time bound *or* a minimum **accepted-content** threshold (real and cover are
indistinguishable to the box and are counted together; the box never determines which
is which — agy New-01 / codex NEW-1). The batch-size target `k` is maintained by a
sustained cover stream, **not** enforced by the box: on the time bound the box releases
whatever it has accumulated, and a small off-peak batch is the named residual, priced
as a measured quantity (G13 cover-cost run), not a proven bound. Keeping the cover
stream flowing so per-interval accepted volume stays ≥ k is a system/operational
property (§5), never a box action.

## 3. Box→board publication policy (R5) — channel manifest, `spec_digest`-frozen

Carried in the `channel_manifest_ref` `ArtifactRef` (schema
`township-election-channel-v1`), whose digest enters the **v2 `spec_digest`** (so a
changed channel posture is a new `election_id`) but **not** the G2 `parameters_digest`
(which is confined to `ProfileRef` — codex #2). The manifest bytes are **required in
the offline bundle** and resolved during foundation verification (codex #3).

| Parameter | v1 value | Note |
|---|---|---|
| `batch_trigger` | release on `interval` **T=300 s ± U(0,60 s)** OR when **accepted artifacts** (real+cover, undifferentiated) ≥ `batch_min_size`, whichever first | hybrid trigger answers agy F-02; pure clock ticks rejected. The box counts accepted artifacts only — it never distinguishes real from cover (agy New-01 / codex NEW-1) |
| `batch_min_size` | k = 8 artifacts (a **target**, not a box-enforced floor) | k is maintained by the sustained client/third-party cover stream (§5); on the time bound the box releases whatever it has accumulated — the box never mints or pulls padding. A batch < k at time-out is a small off-peak batch, the named §2 residual |
| `intra_batch_order` | uniform shuffle before wrapper authoring | order-inert for tally/cleansing (§7 narrowed claim) |
| `holdback_rule` | **operational SLA only**, not seal-verifiable | codex #7: a box that accepts privately and never authors an op leaves no fact the seal can inspect; holdback is an SLA, not a completeness proof |

**Order-inertness claim (narrowed per codex #8):** publication order does not select a
duplicate winner and does not affect cleansing of the *fixed certified set*
(`CloseEvidence.ballot_digests`, consumed as a set — G2 §4). It is **not** globally
transcript-inert: each seal entry carries the wrapper `op_id`, which depends on DAG
history, so shuffling/scheduling changes seal/manifest/certificate digests, and
near-close spill changes *membership*. Spill and holdback are therefore **inclusion and
availability behavior** (availability `:not_claimed`), not an order-inertness guarantee.

## 4. Inclusion check (explicit, coercion-neutral)

- **Mechanism: pure local lookup (R12).** The client replicates the board; after
  `:closed` it checks its persisted ballot ciphertext digest against the certified
  `CloseEvidence.ballot_digests` set. **No network query leaves the device**, so there
  is no query-shaped observer channel.
- **`CheckToken` (brief §5):** the persisted ciphertext digest plus minimal context.
  Contains **no choice and no randomness** (randomness erased per G2 §2). Credential-
  blind: client, UI, and logs never label which credential is real.
- **Decoy symmetry (test-contract obligation):** a token from a decoy-credential ballot
  verifies identically to a real one — decoy ballots are members of the certified set,
  removed only inside encrypted cleansing. Surrendering a token is coercion-neutral.
- **No acceptance receipt in v1** (agy F-03, codex #4/#5). Accountability for a censored
  ballot is limited to: the voter re-submits to another box (they cannot *prove* their
  own censorship). A receipt or cryptographic acceptance commitment is a new transcript/
  coercion surface deferred to a dedicated review; it is **not** dispositioned by
  leaning on the forced-abstention non-claim.

## 5. Cover / dummy-ballot policy (open-posting compatible)

- **Generators: client and third-party** — voter clients may attach fake-credential
  cover ballots; independent cover daemons and auditor probes may submit through the
  same onion channel. **Boxes do not mint cover content** (codex #6); they publish it.
- **Legality:** open posting admits fake-credential ballots from anyone; remove-all
  silently strikes them without changing the result; publicly unclassified exactly like
  coerced-decoy ballots (the R2 property G2 preserved).
- **Rate:** aggregate floor `dummy_rate_min` in the channel manifest; per-source rates
  are unenforceable under open posting and stated as a **monitored operational target**,
  not a protocol guarantee. This sustained cover stream is what keeps per-interval
  accepted volume at the §3 `batch_min_size` target; the box does not pad — if the
  stream runs dry, off-peak batches are small (the named §2 residual), never minted up
  by the box (agy New-01).
- **Indistinguishability obligation (agy F-01):** cover ballots must be byte- and
  behavior-indistinguishable from real ballots on the board — same encoding, proof
  structure, size, batch position. Because cover is now client-authored through the same
  path as real ballots, it is indistinguishable to the board observer *and* to the box
  (the improvement over box-minted dummies). This is a named G11 conformance obligation.
- **Roster-size side-channel (agy F-10):** small-electorate real-vs-cover leakage is the
  same unavoidable ideal-result leakage G2 §5 already declines to claim away. A dynamic
  `dummy_rate` scaling with real volume is a **G13-priced** mitigation option, named not
  frozen.
- **Pricing:** `dummy_rate` is the G13 `dummy_ballots` knob; the calibrated harness
  (measured, commit 08bf1f2d) prices the cover-volume-vs-tally-cost curve. A dedicated
  cover-cost G13 run is a named precondition before any cap value is set (§6).

## 6. DoS boundary (explicit)

**What a box may reject/limit (exhaustive; anything else is forbidden under
box-private-v1):**

1. `:artifact_too_large` — G2 manifest bounds (1 MiB artifact, 4 KiB ballot proof).
2. **Public well-formedness** — Sigma ballot proofs verify without any membership
   information; invalid drops. Primary computational DoS filter.
3. **Exact-retransmission dedup** by inner artifact digest (already implemented) — and
   see §8 for why this alone does not stop replay-nullification.
4. **Identity-free transport throttles** — per-circuit/per-connection token buckets on
   the onion service, connection caps, upload pacing. **Fixed-rate buckets, not
   difficulty-scaling puzzles** (agy F-05: scaling puzzles filter by device capability
   and become admission control by another name — rejected).
5. **Nothing else.** No credential test, no roster check, no nullifier.

**Trustee-layer overload:** fake-credential stuffing changes tally *size/cost*, not
*result* (G2 §5). v1 names the overload **mechanism** — degrade via transport throttles,
then an overload signal — but **defers the cap value and the abort authorization to
G8 (abort policy) and G13 (measured cost)** (codex #9). The abort path must not become a
cheap deterministic election-kill button (agy F-06): its authorization, quorum, and the
graceful-degradation-vs-abort threshold are a G8 decision informed by a G13 cover-cost
run, explicitly not frozen here.

## 7. Adapter binding and assessment (R7)

- Every anonymity-conditioned claim binds to `(adapter_id, observer_level)`. A claim
  conditioned on `transport-deterministic-test-v1` is definitionally not an anonymity
  claim. **Structural enforcement is buildable work** (codex #10): the `Claim` schema
  today has no adapter/observer condition; versioning the claim-set schema to add
  canonical `transport_adapter` + `observer_level` conditions is authorized by this
  decision, and until it lands every claim stays `:not_claimed`.
- **`transport-tor-onion-v3-v1` assessment procedure** (must complete before any
  anonymity-conditioned claim; a named G5→G12 obligation): published threat model mapped
  to the in-scope observers; metadata-leakage inventory on both legs; latency/
  availability envelope vs. election phase durations; independent assessment; named
  reviewer sign-off. Naming Tor is **not** an anonymity claim (brief §16); the assessed
  properties are imported assumptions.

## 8. Replay-nullification (agy F-09) — arbitrated, no G2 reopen

Attack: an adversary copies/re-randomizes a voter's ciphertext and submits it under the
voter's credential to another box; under remove-all, the credential now appears on
multiple ballots and **all** are struck, nullifying the real vote.

Arbitration:

1. **Exact-byte copies** are collapsed by inner-artifact-digest dedup (§6.3) before
   cleansing — one ballot, no duplication.
2. **Re-randomized forgeries** require a *valid* well-formedness proof for the voter's
   credential. The G2 pin's ballot proofs are **NM-CPA non-malleable** (verdict §1;
   G2 §2 ballot-proof statements bind the ciphertext), so an attacker who does **not**
   hold the credential secret cannot produce a second valid ballot for it. The attack
   fails under the property the construction already assumes.
3. **The surrender case** (attacker holds the real credential secret) is the JCJ
   coercion scenario the profile already answers with **decoy credentials**: the voter
   surrenders a decoy (`make_decoy`), votes once with the real credential, and no
   duplication of the *real* credential occurs. Forced-abstention-by-duplication remains
   possible only against a voter who surrenders their real credential — which is exactly
   the forced-abstention case v1 does not claim to resist.

Disposition: **named residual, not a G2 reopen.** Added as verification item RV-G5-1:
G3/G11 must confirm the pinned revision's ballot proofs are non-malleable and bound such
that remove-all cannot be weaponized for replay-nullification by a non-credential-holder.
Cross-referenced into the ledger's G2 note as a clarification of an already-assumed
property, not a new obligation on G2.

## 9. Non-claims (brief §11) — all held

Forced-abstention resistance, censorship resistance, availability: **`:not_claimed`**,
reaffirmed. The box-inside-trust-boundary posture, the no-receipt inclusion check, the
SLA-only holdback, and the deferred abort all *depend on* these non-claims and must not
be read as machinery that makes them. Eligibility (R17), everlasting privacy (R4) remain
`:not_claimed`. This decision flips nothing; per codex #10 the R7 adapter conditions are
prospective schema work, so no claim is even *conditioned* yet.

## 10. What this decision authorizes / defers

- **Authorizes (buildable, named):** `township-election-v2` spec with
  `channel_manifest_ref` (ArtifactRef, foundation-resolved, offline-bundle-required);
  the `township-election-channel-v1` manifest schema; claim-set schema versioning with
  adapter/observer conditions; the client/third-party cover path; G11 cover-
  indistinguishability conformance.
- **Defers (named owners):** abort cap value + authorization → G8/G13; mixnet upgrade
  path → future channel-profile revision; acceptance-receipt design → dedicated
  coercion-evidence review; Tor adapter assessment sign-off → G5→G12 obligation.
- **Closes:** R5 (batch policy pinned), R7 posture (binding rule + assessment procedure,
  structural enforcement authorized), the observer/DoS/inclusion explicitness G5's gate
  text demands — with every honest limit named.

## Appendix A — consolidated G5 register (EVALUATE-plan 2026-07-17)

| # | Pass | Finding | Sev | Disposition |
|---|---|---|---|---|
| F-01 | agy | Dummy distinguishability | high | Integrated §5: client-authored cover through the same path → indistinguishable to board and box; named G11 obligation. |
| F-02 | agy | Anonymity-set collapse off-peak (clock batches) | high | Integrated §2/§3: hybrid time-or-threshold batch trigger; residual off-peak correlation named as G13-measured. |
| New-01 / NEW-1 | agy + codex (cycle 2, independent convergence) | Cover-padding contradiction: §2 said "real-content" threshold and implied box padding, but the box cannot mint cover nor distinguish real from cover. | high | Integrated §2/§3/§5: trigger counts undifferentiated **accepted** artifacts; `k` is a cover-stream-maintained target, not a box-enforced floor; box never pads; small off-peak batches are the named residual. |
| F-03 | agy | Acceptance-receipt coercion leakage | high | Integrated §4: no receipt in v1; deferred to dedicated review. |
| F-04 | agy | Probe distinguishability (B) | high | Moot — B's probe-as-primary-accountability not adopted; probes are optional cover only (§5). |
| F-05 | agy | Scaling-puzzle admission filter (B) | medium | Integrated §6.4: fixed-rate token buckets, no difficulty-scaling puzzles. |
| F-06 | agy | Abort-button DoS | high | Integrated §6: abort authorization/threshold deferred to G8/G13; must not be a cheap kill button. |
| F-07 | agy | Non-claims drift (B) | low | Integrated §9: non-claims held; no receipt/loop-cover machinery that reads as an abstention claim. |
| F-08 | agy | Batch-order transcript leakage | medium | Integrated §7 (with codex #8): order-inertness narrowed to tally/cleansing of the fixed set. |
| F-09 | agy | Replay-nullification via remove-all | high | Arbitrated §8: handled by NM-CPA + dedup + decoy; named RV-G5-1; no G2 reopen. |
| F-10 | agy | Roster-size side-channel | medium | Integrated §5: same ideal-result leakage G2 declines to claim; dynamic dummy-rate a G13-priced option. |
| 1 | codex | Channel-manifest reference has no home (Spec rejects unknown fields) | blocker | Integrated §1/§3/§10: new v2 spec field `channel_manifest_ref`. |
| 2 | codex | Change must be schema-versioned (`township-election-v1` frozen) | blocker | Integrated: `township-election-v2`; changes `spec_digest`/`election_id`, not `parameters_digest`. |
| 3 | codex | Sidecar not offline-replayable without bundle inclusion | high | Integrated §3: manifest ref is a full ArtifactRef, foundation-resolved, offline-bundle-required. |
| 4 | codex | Receipt is a wire-transcript value; "not transcript" is false | high | Integrated §4: no receipt; if ever added, private non-secret wire artifact with explicit no-log/telemetry/crash contracts. |
| 5 | codex | Receipt coercion composition unresolved | high | Integrated §4: default no receipt pending dedicated review. |
| 6 | codex | Box-authored dummies conflict with role table | high | Integrated §5: cover is client/third-party authored; boxes publish only. |
| 7 | codex | Seal cannot audit withheld ballots / holdback | high | Integrated §3: holdback recast as operational SLA, not seal-verifiable. |
| 8 | codex | Batch order tally-inert but not transcript-inert | medium | Integrated §7: narrowed claim; spill/holdback = inclusion/availability. |
| 9 | codex | Cap-triggered abort crosses gate ownership, lacks schema | high | Integrated §6: mechanism named; cap value + authorization deferred to G8/G13; 50k not frozen. |
| 10 | codex | Adapter-bound claims not structurally enforced today | high | Integrated §7: claim-set schema versioning authorized; claims stay `:not_claimed` meanwhile. |
| 11 | codex | C is deferral, not closure; starves G12 | blocker | Adopted — C rejected; Option D binds a real adapter (§1). |
