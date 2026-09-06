# R01c module isolation contract evidence

Status: local contract verification and review passed; dependency R01a and hosted tip/merge-result
gates remain pending. No runtime module is enabled.

- Base: `fb007b26e5e83f54b00af1a2401673ef5901fe7a`.
- Contract commit: `1ed77029fbb82f2c39bef29811abb6b0809e93ff`.
- Only normative change: Plan 158's dated module collision contract and exact user-authorization record.
- Full local `mix verify` passed: 663 tests and 27 properties, zero failures, three existing
  exclusions; seed 316267. Log: `/tmp/lattice-treehouse-execution-20260906/r01c-verify.log`.
- Claude Fable (`claude-fable-5`) reviewed the exact base-to-contract diff and returned PASS.
  Its P2 tense note is resolved by saying the protected namespace is owned by R17a/R36, not
  already adopted. The quoted spelling “Claude Fabel” is retained because it is the user's exact
  instruction. Root updates the shared ledger only with the applicable integration evidence.
- Reserved Toolshed identifiers and Treehouse values match `clients/lattice-mobile-core/products.json`;
  no runtime manifest, key service, database, signing artifact or product copy changed.

R26 still owns implementation, collision/migration tests and the complete reader/host disclosure
correction after its dependency gates. This amendment proves no custody, hardware or pilot outcome.
