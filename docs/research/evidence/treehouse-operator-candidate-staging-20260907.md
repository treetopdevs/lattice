# Treehouse operator candidate staging — September 7, 2026

This packet provides candidate-only R11b journal and staging primitives. It does
not activate a carrier, publish a catalog entry, install catalog trust, or close
R11b/R11c, enrollment, device, production, or pilot gates.

## Immutable source and review

Author base: `03f127f56f28c219439747ea2770778e5fef196e`.
Initial packet: `272d0f0530fde79b5af25624fe5c6737ac3af3ac`.
Repair: `96d55ec79d664947468330c7d33c375b9f54440d`.
Helper naming repair: `e4233acd7159c8aef3721fa1181e5794eb07ca82`.
Validation decomposition/test-support repair: `efe2aee537c6ccaac1c3b538128b29fcef989cc1`.
Root integration base: catalog merge `33af72ab5021233c65ab6767bc9a3dc7ba87ac21`.
Source integrations: `abf274657`, `3f3beedf9`, `80b31419b`, `9a215a631`.

Independent Sol review initially found an unenforced OS-lock precondition, missing
ordinary child-authority/profile/grant checks, and an exception on reference
operations with missing dependencies. The repaired cumulative immutable packet
passed independent Sol review with no remaining P0–P2 findings; the helper-only
rename and final behavior-preserving validation decomposition also passed review.

## Ownership and behavior

A single Linux Python3 standard-library process owns the nonblocking `flock` and
all artifact/journal writes, file and directory synchronization, atomic rename,
reopen, and compare-and-set rechecks. BEAM performs read-only inspection of signed
staged bytes while that same process holds the lock. There is no separate BEAM
writer that can continue after the lock owner dies. Missing Python/helper support
and unsupported hosts refuse. The helper must be deployed with the operator
checkout; packaged-release installation is not established by these primitives.

The bounded closed protocol rejects duplicate keys, noncanonical identifiers and
binary encodings, unsafe paths/files, changed active manifest/log snapshots,
stale journal comparisons, and conflicting immutable artifacts. Ambiguous files
are retained. Candidate generation and catalog-head fields are reviewed intent,
not new authority inferred from the current version-one carrier manifest.

Child logs undergo ordinary signed `Treehouse.Thread` authority replay. Staging
requires the reviewed bounded continuation profile, creation operation and exact
honored member-grant inventory. The child root is a transport bootstrap peer;
the Space root is not automatically made a current member. Signed Space
references use closed `Log.accept` outcomes. No withheld-history or globally
complete current-roster claim follows from a candidate snapshot.

## Validation and remaining closure

Behavioral RED: replacing the repaired child verifier with its old implementation
failed three of five semantic regressions (`/tmp/operator-child-review-red.log`).
Initial journal RED remains in `/tmp/operator-journal-red.log`.

Author focused host checks passed 20 tests with zero failures and 12 explicit
Linux-only skips; the Python parser subprocess passed four tests. Formatting and
diff checks passed. These skipped tests are not Linux mutation proof.

Root full checks passed 1,051 tests and 27 properties with zero failures, 12
explicit Linux-only skips and three existing exclusions; formatting and strict
Credo passed. The first root run in the fresh integration checkout
reported eight missing client-executable failures before the TypeScript client
and preview dependencies were installed; that environment failure is retained in
`/tmp/treehouse-operator-root-missing-deps.log`. No production or assertion changes
were made to address it. The next run passed every test but exposed two new
complexity/nesting findings and a helper-discovery warning, retained in
`/tmp/treehouse-operator-root-complexity-failure.log`. The reviewed repair split
validation into named helpers and compiled test support only in the test
environment. The final root `mix check` exited zero with no discovery warning
(`/tmp/treehouse-operator-root-check.log`).

The permanent Linux tests must prove competing actual mutations refuse while the
owner holds the lock, killing that owner stops mutation, and a successor can
mutate/reopen only after obtaining the lock. This host has no available Linux
Docker daemon, so actual Linux execution remains a hosted gate. Hosted tip and
merge-result checks are also pending. Activation still requires a separately
reviewed service quiesce/drain/acknowledgment seam and lifecycle reconciliation.
