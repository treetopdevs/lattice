# Plan 265: native catalog codec and signature parity

## Status

IN PROGRESS. Canonical/frame/catalog authenticity, bounded readers and executable
Rust↔TS/BEAM peers are implemented. Independent review fixes are confirmed; full
checks and requested external review remain. Implements plan 245 build PR 2,
independently of the pending listing consumer. Base includes catalog publication.
No native trust command,
route installation, custody mutation, authority fold or network change is in scope.

## Outcome

Rust can independently reproduce the existing canonical term, operation and catalog
signing bytes and verify exact frame/catalog signatures. Valid signatures establish
only authenticity under the supplied key. Plan 245 PR 3 still supplies authority and
retained catalog judgment; PR 5 still owns durable installation and route receipts.

## Contracts and drift

Read AGENTS.md, plans/README.md, plan 245 in full, ADR 0001, Lattice.Canonical,
TransportCatalog and the TS codec. The authorized grammar/custody and offline-enrollment
changes since plan 245 do not change the catalog codec or trust reasons. Refuse any
need to change existing BEAM/TS encoding, carrier vocabulary, trust reasons or IPC.

Use new native catalog_eval/{mod,canonical,envelope}.rs and native vector tests.
Reuse existing BEAM- and TS-authored public vectors without changing their expected
bytes. Add generated reciprocal vectors under the existing catalog vector directory;
the producer and independent consumers must execute, not merely compare checked-in text.

## Implementation order

1. Write failing native tests against both existing catalog codec vector producers.
   Add bounded canonical terms with exact tags, unsigned uint64 integers, binary/atom
   distinction, tuples, canonical map/set ordering and delegation v2/v3 preservation.
2. Add strict bounded JSON and canonical-byte readers. Reject duplicate JSON fields,
   duplicate canonical map/set elements, nonminimal/trailing/indefinite CBOR, wrong
   tag/shape, invalid UTF8/base64, integer overflow and excessive depth/nodes/bytes.
   Numeric JSON integers retain the JS safe range; canonical decimal strings permit
   the full uint64 range. No floats, negative integers or lossy coercion.
3. Verify operation payload/id and Ed25519 signature with closed frame fields. Preserve
   raw authenticated terms for the later fold; signature validity grants no authority.
4. Normalize the closed catalog envelope and entry shape, enforce existing inventory
   constraints, derive existing signing bytes and catalog id, and verify against the
   explicitly supplied public key. Refuse rotation at the installation boundary later;
   this codec must not invent replacement trust. No native mutation is introduced.
5. Execute both producer/consumer directions, mutation/refusal cases and exact limits.
   Run native tests, shell typecheck/tests, full Mix check and both boundary scans.
   Review with requested Argon/Sonnet plus a second independent reviewer; record fixes
   or rejections. Open a PR and use one final exact-tip hosted gate before merging.

## Bounds

Each decoded artifact is at most 128 KiB, matching plan 245's evidence artifact cap.
Canonical term nesting is at most 64, nodes at most 32,768 and encoded bytes at most
128 KiB. JSON separately caps all values and object keys at 32,768 nodes and
wrapper-aware depth at 130; domain term depth remains 64. A local bounded seed
replaces the generic JSON reader depth of 128. Check lengths before allocation and
output growth. Frame JSON retains the
existing 64,000-byte carrier boundary. These are native verifier resource bounds,
not new producer encodings or changes to core authority semantics. Later whole-page
assembly retains plan 245's 64 MiB transport and 32 MiB snapshot limits separately.

## Evidence and completion

- Existing BEAM and TS catalog signing bytes/id agree with Rust for valid vectors.
- Real signed operation histories verify; changed body, cap, deps, author, id or
  signature refuses. Delegation encoding and leased/unleased frames retain parity.
- Duplicate, unknown, noncanonical, over-cap and wrong-key input fails before producing
  verified output. Boundary tests include uint64 max, safe-number overflow and Unicode.
- Rust-authored canonical/signature output is consumed by the actual TS/BEAM codecs.
- All required local and exact-tip hosted gates pass; reviews are resolved.

This slice earns native codec/authenticity parity only. It cannot install a catalog,
activate a route, evaluate membership, prove freshness or complete the two-app field run.
The operator's real ceremony/device session remains a separate plan 245/261 gate.
