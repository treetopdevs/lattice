# Private witness snapshot contract

This is the native-only result contract for the R36 integration train. It does
not change the public request shapes or enable a public command. The sole mobile
method is `dispatch`; its argument is the closed private request object, and its
result is a JSON object, never a JSON string. The Rust plugin continues to reject
every webview invocation before mobile fallback.

Successful identity, preparation and generation results have exactly these keys:

```text
protocol: "treehouse-witness-private-v1"
kind: "identity" | "prepare" | "generate"
operationId: canonical Base64 raw32
sessionDigest: canonical Base64 raw32
status: "snapshot"
eligible: false
identity: identity record below
enrollment: enrollment below, or null
```

The closed identity record contains `creationAttemptId` (raw32), `phase`,
`generationChallenge` (raw32 or null), `metadata` (below or null), and `revision`
(positive canonical decimal signed-64 string). Prepared requires null challenge
and metadata; generation_started requires a challenge and null metadata;
generated_unvalidated requires both challenge and metadata.

The closed metadata object contains `publicKey` (raw32), `spki` (exact 44-byte
Ed25519 DER prefix plus that public key), `appSignerSha256` (raw32),
`creationVersionCode` (positive canonical decimal signed-64 string), and
`certificateChain` (1–8 canonical Base64 certificates, each 1–16,384 bytes,
aggregate at most 65,536 bytes). These are retained actual metadata, not locally
validated attestation eligibility.

The closed enrollment object contains `replica` (nonempty valid UTF-8 at most
512 bytes), `enrollmentId`, `recipient`, and `creationAttemptId` (all raw32).
Its attempt must equal the identity's original attempt. All binary JSON fields
use canonical padded Base64. Every result is at most 128 KiB.

Rust matches kind, operation and session against its owned request. Identity and
generation require null enrollment. Preparation requires exactly the proposed
replica/enrollment/recipient and original attempt, and only prepared or completed
phase. Generation requires completed phase and the exact requested original
attempt and challenge. Missing, refused and cancelled results retain the existing
closed terminal protocol. Proof prepared/signed results retain their separately
reviewed handle/claim/signature contract.

Identity observation is presence-free and create-free. A missing journal plus a
genuinely absent provider entry returns missing. Journal or provider refusals
propagate. Prepared plus absent returns the prepared snapshot. A started record
with consistent observed custody remains started; observation does not reconcile
or manufacture retained creation metadata. Completed metadata is returned only
after the provider checks it against the retained identity. No result can set
`eligible` to true.

Preparation transactionally revalidates the current original attempt, phase,
capacity and exact enrollment. Its journal API does not compare an initially
observed revision; a compatible concurrent additive enrollment may increase it.
Signing and generation retain their separate exact revision/fence requirements.
