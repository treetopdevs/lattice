# Plan 266: operator catalog evidence exporter

## Status and dependency

IN PROGRESS: implement plan 245 build PR 4 independently of its Rust evaluator.
The fresh worktree started from main with catalog publication and is now rebased
onto the verified listing merge for its real release/publication fixture.
No pending-parent implementation is copied or silently treated as merged.

## Outcome

An operator exports one closed `lattice-catalog-evidence-page-v1` file containing
exact committed catalog JSON strings from revision zero and complete authenticated
Space/Thread frame histories. The ordinary app will import this in later plan 245
work. This file claims only that these bytes existed on the host. It supplies no
installed trust, active route, freshness, membership or network-read attestation.

## Existing contracts

Read AGENTS.md, plans/README.md and plan 245 Designs A–D and build PR 4 gates.
Use CatalogStore, CatalogBinding, PublicHistory, Manifest, Log and the existing
CatalogTrust evaluator. Do not change core/TS trust reasons, canonical encoding,
carrier vocabulary, custody or IPC. The root's actual ceremony and device session
remain parked separately; software gates use disposable real-mode fixtures.

## Public interfaces and decisions

- `CatalogEvidence.export(root, ceremony_dir, manifest_path, output_path)` reads
  a current `listed` journal and the exact manifest whose digest it records. The
  explicit manifest argument makes the standalone command usable without starting
  another relay VM. It never accepts routes, a signer key or a caller verdict.
- `mix treehouse.catalog_evidence --root ... --ceremony ... --manifest ... --out ...`
  loads configuration only, never application listeners. Closed options reject
  duplicates and unknown arguments. Refusals are atoms, without inspected terms.
- A pending envelope or current non-listed phase refuses; export never accidentally
  promotes an unfinished publication. Only the committed linear chain is included.
- Preserve the envelope's exact validated JSON bytes. Add a narrowly shared verified
  document reader to CatalogStore if needed: its current map-only reader discards
  the bytes. Preserve the existing load_envelope API and all store validation.
- A pure packet encoder/decoder may support tests and offline inspection, but it
  must authenticate histories and run the actual CatalogTrust pipeline. It cannot
  accept a saved decision, honored flag or installed-state claim.

## Construction and observation

1. Read canonical journal bytes at listed; verify private root and exact artifact
   metadata. Capture the named manifest and require its hash to equal the listed
   manifest artifact. Reuse Manifest loading and its existing service-identity
   handling, without exporting any seed or invoking a signer.
2. Read/authenticate every relevant log under its target lock with bounded reads.
   Derive the one Space from the receipt and verify its public ceremony using
   CatalogBinding.load_log. Require the unique honored bootstrap and root profile.
3. Verify the whole catalog store with that root-bound catalog public key. Require
   one committed head and no pending envelope. Load exact validated envelope bytes
   in revision order, from zero through the current receipt's head.
4. Include every catalogued replica exactly once, with complete actual frames and
   structural rejection evidence. Refuse missing/mismatched histories or routes;
   never insert a hypothetical reference or invent a replacement history.
5. Derive a fresh explicit bootstrap review from the same verified Space. Prepare
   and evaluate the actual CatalogTrust state page by page. The final decision must
   have reason nil, no block and accepted.catalog equal the committed head. This
   remains a candidate evaluation, not native installation or a user consent.
6. Serialize a closed top-level map `{format, space, bootstrapId, head, pages}`.
   Pages use TS names `{catalogs, rotations, histories, cutoffProofs}`; rotations
   and cutoffProofs are empty in this non-replacement slice. Include histories once,
   then at most 32 exact catalog strings per page. Sort deterministically.
7. Re-read source journal/store/manifest and captured log identities/digests before
   publishing the output. Refuse drift without deleting authentic input history.

## Resource and output policy

Retain 128 KiB per artifact, 1,024/16 MiB aggregate retained artifact limits and
32 artifacts per page from the evaluator. The serialized retained snapshot must
fit the existing 32 MiB native persistence cap; the output transport cap is 64 MiB.
Measure actual encoded bytes, including escaping. Each frame must fit the existing
64,000-byte push envelope, matching the publication profile and native client;
maximum-capacity fixtures use legitimate bounded frames rather than oversized ops.
Bound source reads and allocations
before loading an oversized native dump. Do not lower the accepted evaluator-valid
capacity to make an easy test pass; prove the maximum-capacity case explicitly.

Create a new regular output file exclusively; an existing file, hard link or
symlink refuses. The selected parent must be a real directory, matching the native
Space exporter. Reject protected input targets/subtrees. Sync and close the file;
on failure remove only the file this call created, never another process's file.
Output bytes repeat exactly for unchanged inputs. No journal, catalog, log, identity
or ceremony artifact is mutated. Do not start a listener or add a network action.

## Required evidence and order

1. Build the pure format/evaluator seam against genuine signed CatalogTrustVectors.
   Prove exact JSON strings, complete histories, deterministic pages and reason-nil
   round-trip through the actual evaluator. Add tamper/fork/gap/lapse refusals.
2. After the listing parent merges, use its real disposable ceremony/publication
   fixture for pending and initial workflows through export. No forged phase plan
   or caller-supplied authority result substitutes for this root-based integration.
3. Prove exclusive output, existing file/link refusal, source drift and no mutation
   of input bytes on every refusal. Exercise the actual closed Mix command.
4. Build a maximum evaluator-valid fixture with 16 MiB of artifacts and histories
   reaching the 32 MiB retained snapshot cap. It must export/import under the 64 MiB
   transport cap; one byte beyond a limit refuses evidence_page_too_large.
5. Prepare Node/client prerequisites, run focused tests, full mix check and both
   boundary security scans. Run actual owner integration as non-root Linux; macOS
   skips do not count. Run the real TS consumer on the produced file.
6. Obtain the requested Argon/Sonnet adversarial review and resolve its findings.
   Keep unavailable review explicit. Commit/open PR, autofix feedback and pass one
   final exact-tip hosted gate before software completion. Parent closure evidence
   and decisions live in the PR and running HTML; index status stays one short line.
