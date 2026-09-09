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

## Hosted review repair (2026-09-08)

Hosted review of tip `23add70a9` reported six inventory findings on the semantic
staging inspection. All six were reproduced first as failing tests against the
unchanged production module: 11 tests, 5 failures, and then the revised
duplicate-Space fixture (the earlier one passed for the wrong reason) as the
sixth. The repair replaces the previous per-artifact checks with one closed
predicate in `LatticeCarrierServer.Operator.Staging.inspect_staged/2`:

1. exactly one child log, one signed Space reference and one candidate manifest
   per attempt, refused before any log is read;
2. the child's authority operations are whitelisted to the pinned root genesis,
   the reviewed continuation profile pin and the reviewed grant introductions,
   whose honored active set must equal the reviewed inventory exactly;
3. the referenced Space must have exactly one active history, and an unreadable
   sibling instance log refuses instead of being skipped;
4. a reference operation already present in that history is published, not
   carrier pending;
5. the candidate manifest reproduces the manifest health listener and every
   existing instance configuration verbatim, excluding only the positional
   `:ref` and the opaque identity wrapper, and adds exactly one instance;
6. the admitted child's bootstrap transport peers are exactly the current Space
   members plus the independently rooted child, and it declares no relay realms.

Three independent Sol reviews were obtained. The first returned REVISE with a P0:
a grant is not the only shape that introduces an active delegation, so a role
transfer on the child log conferred an honored `:moderator` capability plus
`:post` to an unreviewed key while staging returned `:ok`. That escape was
reproduced as a test and closed by whitelisting authority rather than
blacklisting grant shapes. The second review returned PASS and found that the
reviewed `profile_id` digests only the continuation profile while any
root-authored genesis policy map also sources the epoch-beacon policy: a
candidate could keep a byte-identical reviewed profile id and name its own
beacon witnesses, giving a party absent from the reviewed inventory a unilateral
lapse over every reviewed grant. It also found that a candidate could open
Plan 128 relay write ingress on the admitted child. Both were reproduced and
closed; the child root genesis must now carry no policies at all. The third
review returned PASS and found the beacon witness comparison was order
sensitive against a normalized list, which would have refused an honest
operator; that too was reproduced and corrected.

One P2 was deliberately not taken: the fail-closed net around `inspect_staged/2`
stays, because letting an exception escape into the staging lock owner's
callback is worse than an imprecise refusal atom. It was widened from `rescue`
to `catch` so throws and exits are covered as well.

Two assertions changed meaning rather than being relaxed. An omitted grant now
refuses as `:invalid_staged_signed_artifact` on the artifact itself instead of
`:invalid_candidate_manifest` through the roster comparison, and the previously
reachable `:invalid_child_admission`, `:reference_refused` and
`:missing_space_history` atoms have no remaining production consumer.

Focused checks passed 31 operator tests with zero failures and 12 explicit
Linux-only skips. Root `mix check` exited zero on the repaired source: 1,061
tests and 27 properties, zero failures, 12 Linux-only skips and three existing
exclusions, with formatting and strict Credo clean
(`/tmp/treehouse-operator-repair-root-check.log`). The first root run in this
worktree reported 17 failures that were entirely environmental — a build root
outside the worktree that the second-BEAM child processes could not resolve, and
missing `clients/lattice-client` and `clients/treehouse-tauri-shell`
dependencies. No production or assertion change was made to address them; the
worktree was given its own build root and those dependencies were installed.

Signed authority semantics are unchanged. Space-root membership is never
manufactured, the result stays candidate only, and BEAM still writes no operator
files. Linux mutation-owner execution, hosted tip and merge-result checks, and
the separately reviewed quiesce/drain/acknowledgement seam remain open.
