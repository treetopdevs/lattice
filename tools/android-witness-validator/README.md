# Android witness validator dependency admission

This directory admits the upstream Android Key Attestation verifier as reviewed
source tooling. It includes the bounded Treehouse fixed-profile constraint, but
does not provide a production validation service or eligibility report.

## Pin and provenance

- Repository: <https://github.com/android/keyattestation>
- Commit: `a48898a68337b920cbd368eab5824f696d7bbf3d`
- Git tree: `1e7bcbf19e46fcf68004ca99b34fcbe017bc2dee`
- License: Apache License 2.0, preserved in
  `vendor/android-keyattestation/LICENSE`

`upstream.lock.json` records every vendored file and its SHA-256 digest.
`verifyPinnedUpstream` runs before compilation and tests. Gradle dependency
verification is strict and records SHA-256 checksums in
`gradle/verification-metadata.xml`. The build copies the upstream dependency
versions and JVM 21 toolchain requirement; it does not substitute unpublished
coordinates. The upstream Gradle 8.10 wrapper is retained, and the local wrapper
adds Gradle's published distribution SHA-256 checksum.

Run with a JDK 21 `JAVA_HOME`:

```sh
./gradlew --offline --no-daemon --dependency-verification=strict clean check
```

The first build on a new machine must populate the Gradle distribution and the
already-verified dependency cache while online. The command above is the
reproducibility gate after that bootstrap.

## Current limits

This packet verifies that the pinned upstream sources and dependencies build and
that the upstream test suite passes. It does not:

- define the Treehouse closed validator request or report;
- map upstream results to Treehouse eligibility;
- fetch, authenticate, freeze, or refresh revocation status;
- establish that the vendored `roots.json` is current for a validation event;
- validate a physical device, a real certificate chain, or a fresh challenge;
- supply device-recognition trust data or make an eligibility decision.

The upstream API accepts injected trust anchors, revocation data, time, and
constraints. A later reviewed wrapper must bind those inputs to independently
recorded validator requests and official validator-controlled sources. Phone
supplied roots, revocation data, time, or policy must never be trusted.

`TreehouseWitnessProfileConstraint` is only a generation-time fixed-profile
policy at upstream's `ConstraintConfig.additionalConstraints` seam. It does not
issue a challenge, validate chain trust or revocation, verify fresh possession,
or emit an eligibility report. Those validator-controlled steps remain required.
