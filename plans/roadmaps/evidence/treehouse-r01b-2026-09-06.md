# R01b Android and native witness scope

Status: concrete execution-scope amendment prepared; local contract tests passed;
Claude Fable exact-diff review passed; hosted/dependency closure remains pending. No runtime or device outcome
is delivered by this packet.

The operator instructed on 2026-09-06: “In that new work tree commit that proposal
and working together with Claude Fabel for code reviews and implementation
assistance complete that new plan as proposed”. The integrator applies that
existing authorization to the Android/native implementation required by the
proposal, after completing the concrete R17a design and Claude Fable review. No
new operator statement or cryptographic countersign is fabricated.

- Proposal: `641cbbd78bf1338a4a245e5a670ad425aa79be1b`.
- R01a merged through PR #59 at `5d1861f16e12fb950049212a9e1301dec4e86607`;
  its exact merge-result gate passed in hosted run 34037516446.
- R17a decision: `62978f05e02974905e1e1daca0cb50a1e99b7999`, final reviewed
  follow-up `0da772156a5315167eb0b383b1dd34a6ced99b94`, PR #66.
  Cross-packet follow-up `a5d605786f959f330bc003dc6c12dfbdbecf4316` adds the
  fixed final-beacon-operation signing purpose required by R03; Claude Fable
  reviewed the exact follow-up and returned PASS, no P0/P1.
- Claude Fable selected/reviewed Option A, returned PASS with no P0/P1, then
  confirmed both P2 clarifications closed at the final exact exported diff.
  It also reviewed the R01b amendment at `1beb114499e6a457d0b43cf10c731500b11731f1`: PASS,
  no P0/P1. Its stale-review-status P2 is resolved by this evidence update.
  R17b must additionally prove byte-level purpose separation: a canonical outer-op
  signature refuses as a witness-claim signature and vice versa, alongside the
  already-required cross-purpose consent refusal. This adopts the R17a review
  follow-up acceptance item without changing either signed-byte contract.
- Native program amendment is confined to Plan 158's dated R01b section and this
  evidence file. Plan 146's precise build-time amendment remains R17b work; no
  protected README/Plan 178 sentence, native source, manifest, key or artifact
  changes here.
- Read-only ADB inventory during preparation reported no connected devices.
  Android key eligibility and independent physical witness evidence remain absent.
- Full local `mix verify` passed: 663 tests and 27 properties, zero failures,
  three existing exclusions. The later final-beacon-purpose addition changes only
  the scope prose and referenced design; protected contract files/sentences remain
  unchanged. Final whitespace and local link checks pass. Log:
  `/tmp/lattice-treehouse-execution-20260906/r01b-verify.log`.

R17a's proposed budgets are acceptance targets, not measurements. The strong
candidate cannot use a device until R36 validates its actual key, authentication
and attestation combination. R17c later proves the integrated physical ceremony;
R22/R23 supply candidate and pilot evidence. The lease cadence, real signers,
hosting inputs and optional iOS scope remain their separate gates.
