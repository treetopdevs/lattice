# ADR 0001 — Canonical encoding for op ids and signatures

## Status

Accepted (POC).

## Context

Every `Lattice.Op` id is the SHA-256 hash of a canonical encoding of its fields, and
the author's Ed25519 signature is over the same bytes. For the log to be a sound,
deterministic, tamper-evident hash-DAG, two logically-identical ops **must** encode to
identical bytes on every realm and every run, and any change to any field **must**
change the bytes.

## Decision

Encode the tagged tuple `{:lattice_op_v1, replica, author, sorted(deps), kind, body,
cap}` with `:erlang.term_to_binary/2` using the options `[:deterministic,
{:minor_version, 2}]`, then `sha256 |> Base.url_encode64(padding: false)` for the id.
`deps` is deduplicated and sorted before encoding so frontier ordering never affects
the id. Delegations use the same approach (`{:lattice_delegation_v1, ...}` with sorted
`ops`/`roles`).

## Rationale

* `:deterministic` makes `term_to_binary` emit maps in a canonical (key-sorted) order,
  removing the only common source of non-determinism for Erlang terms. Verified on the
  target toolchain (OTP 28): two maps with different insertion order encode identically.
* Pinning `minor_version: 2` fixes the external term format version so encodings are
  stable across runs.
* Sorting `deps` decouples the id from the order a realm happened to observe its
  frontier.

## Caveats (honest limitations)

* **Atoms vs. binaries are distinct.** `:post` and `"post"` encode differently. Command
  bodies use atoms consistently; a real wire protocol must pin a schema so that a
  re-serialized op hashes identically.
* **Not canonical across BEAM term-format changes.** The format is stable within a
  pinned OTP minor version; a different runtime could in principle differ. A production
  system should use an explicit, language-neutral canonical form (e.g. canonical CBOR)
  rather than `term_to_binary`. The spec explicitly permits `term_to_binary` for the
  POC if pinned and noted — this is that note.
* **No floats / pids / refs in op bodies.** Those either don't round-trip
  deterministically or are node-local. Bodies are restricted to atoms, integers,
  binaries, lists, tuples, and maps thereof.

## Alternatives considered

* Canonical CBOR / a hand-rolled deterministic serializer — more portable but more code
  than a falsifiable POC needs. Deferred to `path_to_real.md`.
