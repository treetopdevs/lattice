# ADR 0001 — Canonical encoding for op ids and signatures

## Status

Accepted (M2).

## Context

Every `Lattice.Op` id is the SHA-256 hash of a canonical encoding of its fields, and
the author's Ed25519 signature is over the same bytes. For the log to be a sound,
deterministic, tamper-evident hash-DAG, two logically-identical ops **must** encode to
identical bytes on every realm and every run, and any change to any field **must**
change the bytes.

## Decision

Encode signed op and delegation payloads with `Lattice.Canonical`, a deliberately small,
CBOR-shaped term subset. Op payloads are tagged `lattice-op-v2`; delegations are tagged
`lattice-delegation-v2`. The resulting bytes are hashed with SHA-256 and
Base64url-encoded for ids, and the same bytes are signed with Ed25519.

`deps` are deduplicated and sorted before encoding so frontier ordering never affects
the id. Delegation `ops` and `roles` are sorted before encoding. Unsupported local terms
(pids, refs, ports, functions, floats, negative integers, and unknown structs) are
rejected before signing.

Full-op carrier frames now use `Lattice.Carrier.Wire`, a JSON-safe schema that still
reconstructs `%Lattice.Op{}` structs inside the BEAM implementation. Browser/AtomVM
realms must consume that shared wire schema directly before they can author or verify
ops without a BEAM bridge.

## Cryptographic agility

This POC deliberately pins SHA-256 for content addressing and Ed25519 for signatures so
the behavior suite can be deterministic and falsifiable. Those choices are not meant to
be permanent protocol commitments. A production wire format should version the hash and
signature suite in the encoded op/delegation schema, so future realms can verify old
entries while admitting a new suite through an explicit migration.

The current structs do **not** carry an encoding-suite field, so M2 is not a migration
format for pre-M2 persisted logs. A production migration needs either legacy-suite
verification during restore or a new per-entry suite marker before old and new signed
bytes can coexist in one durable store.

The expected post-quantum path is a sibling or successor suite rather than an in-place
reinterpretation of existing ids: for example, Dilithium-class signatures for general
post-quantum signing, or SPHINCS+-class signatures where conservative stateless signing
is preferred. Rotation is modeled as a future log operation or delegation update that
binds a successor key/suite to the current authority chain; it must not change how
already-authored ops hash, sign, or verify. Implementing post-quantum crypto, key
rotation, or key recovery remains outside this POC.

## Rationale

* Maps sort lexicographically by fully encoded key bytes, so insertion order cannot
  change signed bytes. This is not RFC 7049 canonical-CBOR map ordering; browser
  runtimes must implement this Lattice rule directly rather than delegating to a stock
  canonical-CBOR library.
* MapSet elements are encoded first and then sorted lexicographically by their canonical
  bytes, avoiding BEAM term-order dependencies.
* Sorting `deps` decouples the id from the order a realm happened to observe its
  frontier.
* The encoded term subset is small enough for non-BEAM runtimes to implement without
  inheriting Erlang external-term-format semantics.

## Caveats (honest limitations)

* **Atoms vs. binaries are distinct.** `:post` and `"post"` encode differently. Command
  bodies use atoms consistently; browser runtimes must preserve that distinction in the
  shared schema.
* **The encoder is intentionally narrow.** It is not general CBOR and does not attempt
  to serialize arbitrary BEAM terms. Bodies are restricted to nil, booleans,
  non-negative integers, binaries, atoms, lists, tuples, maps, MapSets, and explicit
  Lattice delegation structs.
* **Full browser parity is not complete yet.** Signed bytes are no longer BEAM-term-only,
  but the current carrier implementation still reconstructs BEAM structs internally
  until the browser realm consumes `Lattice.Carrier.Wire` natively.

## Alternatives considered

* `:erlang.term_to_binary/2` with deterministic options — sufficient for the original
  BEAM-only POC, but rejected for M2 because non-BEAM realms cannot reproduce it.
* Full canonical CBOR — more interoperable, but larger than the term subset needed to
  harden signed Lattice values for M2.
