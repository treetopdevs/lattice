# Treehouse Android witness validator

This local JVM 21 tool retains validator-issued challenges, imports closed public
witness results, verifies the fixed generation profile and fresh possession, and
keeps the result separate from device eligibility. Run it on a separate trusted
computer. The phone never supplies trust roots, revocations, time or policy.

## Build and provenance

The official Android Key Attestation verifier is vendored byte-for-byte from
`android/keyattestation` commit `a48898a68337b920cbd368eab5824f696d7bbf3d`,
tree `1e7bcbf19e46fcf68004ca99b34fcbe017bc2dee`. Its Apache-2.0 license and
source inventory remain under `vendor/android-keyattestation` and
`upstream.lock.json`. Compilation verifies the source pin; Gradle verifies dependency
SHA-256 values and its wrapper distribution checksum. No network root replacement
or caller-provided trust file is supported.

With JDK 21 in `JAVA_HOME`:

```sh
./gradlew --no-daemon --dependency-verification=strict check installDist
```

After the first verified online dependency bootstrap, add `--offline` to repeat the
build gate. The installed launcher is
`build/install/treehouse-android-witness-validator/bin/treehouse-android-witness-validator`.
The application plugin is built into Gradle and adds no dependency coordinates.

## Manual request and response flow

The first argument is the validator-owned state directory, followed by the command
and its exact identifier arguments. JSON input is one UTF-8 object, limited to
128 KiB, with duplicate keys, unexpected fields, noncanonical numbers/Base64 and
excessive nesting refused. Each invocation writes one closed JSON result to stdout.
Usage/internal launch failures may exit nonzero; a domain refusal or incomplete
verification is a JSON result, so inspect its status rather than only the exit code.

| Command | Additional identifiers | Standard input |
|---|---|---|
| `issue-generation` | None | `{version:1, kind:"issue_generation", expected:{...}}` |
| `verify-generation` | Issuance ID | Exported `generated_unvalidated` public result |
| `issue-possession` | Issuance ID | `{version:1, kind:"issue_possession", expected:{...}}` |
| `verify-possession` | Issuance ID, fresh validator nonce | Exported signed public result, or the failed/cancelled response |
| `abandon-possession` | Issuance ID, fresh validator nonce | Exactly empty |

The `expected` object has exactly `replica`, `enrollmentId`, `recipient`,
`creationAttemptId`, `appSignerSha256`, and `creationVersionCode`. Binary fields are
canonical padded Base64 for 32 bytes. The version code is a positive signed-64-bit
decimal string. Obtain and check these expected facts independently; do not promote
phone-provided metadata into expectations merely because it parses.

Issuance output contains an `issuanceId` and a nested `uiRequest`. Retain the complete
receipt on the validator computer. Save only its `uiRequest` object to a JSON file
for the app's import control. Generation requests contain exactly
`creationAttemptId` and `generationChallenge`; possession requests contain exactly
`replica`, `enrollmentId`, `recipient` and `freshValidatorNonce`.

The original generation request remains bound to the same attempt, enrollment and
first verified certificate/key candidate after restart. Reverification cannot
substitute another chain or key. Possession issuance requires that association.
A possession nonce is durably spent before public packet parsing/signature checking,
including malformed and oversized results. A cancelled or lost response must be
consumed through verification or `abandon-possession`; obtain a new nonce for retry.
Native random/session nonces are signed context, not validator-issued observations.

For example, using files whose expected values were independently checked:

```sh
witness_validator=build/install/treehouse-android-witness-validator/bin/treehouse-android-witness-validator
"$witness_validator" ./validator-state issue-generation < generation-input.json > generation-receipt.json
"$witness_validator" ./validator-state verify-generation "$issuance_id" < generated-public-result.json
"$witness_validator" ./validator-state issue-possession "$issuance_id" < possession-input.json > possession-receipt.json
"$witness_validator" ./validator-state verify-possession "$issuance_id" "$validator_nonce" < signed-public-result.json
"$witness_validator" ./validator-state abandon-possession "$issuance_id" "$validator_nonce" < /dev/null
```

Set the two identifier variables from the retained receipts before the corresponding
commands. Abandonment is an alternative for an unused/lost response, not another
successful verification step.

## Official trust and durable state

Only generation verification calls the production official trust repository, after
strict import and retained-context checks. Roots come from the reviewed vendored
pin. Revocations come only from `https://android.googleapis.com/attestation/status`,
with redirects disabled, a 5-second connect timeout, 10-second read timeout and
512-KiB response limit. It records exact response bytes/digest, Cache-Control/Age,
root digest, fetch/expiry times and the snapshot digest.

A single unambiguous `max-age` is reduced by `Age`, with an additional 24-hour local
cap. Missing/invalid/conflicting freshness, `no-store`, `no-cache`, expired state or
unavailable required inputs yields incomplete. A still-fresh frozen snapshot can
be reused offline; stale-on-error is not supported. Root updates require a reviewed
vendored pin/provenance update. Backward wall-clock observations refuse; this is
not a hardware clock or rollback-resistant storage claim.

Both stores use an OS process lock, file force, atomic replacement, parent-directory
force and strict reopen. A failure/refusal marker or orphaned partial record is
retained and refuses subsequent use. Do not delete markers or reset a store to
bypass a refusal. Custody records retain at most 4,096 generation issuances and
4,096 possession nonces without pruning; capacity refusal preserves the old state.
Directory-force support is required. This does not claim resistance to a trusted
host administrator restoring an old disk image or prove real power-loss behavior.

## Evidence limits

An associated candidate remains `incomplete / challenge_freshness_unestablished`.
The tool does not infer a challenge freshness duration or fresh device state from
an old attestation. Successful signature verification is reported as possession
only. Current package/device/boot observation, selected physical authenticator,
exact approved APK and the R17c ceremony remain separate gates. No command returns
an eligibility decision, and software fixtures or a successful official-source fetch
cannot close physical device, custody, production signing, release or pilot gates.
