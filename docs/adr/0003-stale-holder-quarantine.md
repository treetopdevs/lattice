# ADR 0003 — Stale-holder quarantine policy

## Status
Accepted (POC).

## Context
A serialized `authority:` field (e.g. `Thread.locked?`, role `:moderator`) is a
single-writer token that moves between realms via transfers and successions. When the
token moves away from a realm and that realm — not having observed the move — authors
an authoritative op, the op must be handled deterministically: not merged (it would
violate single-writer), and not silently dropped (invariant 4). Every realm must reach
the same verdict from the merged log (property d, behaviors 8 and 15).

## Decision
An authoritative command op `O` by author `A` on a role `R` is **honored** iff:

1. **Holder-at-causal-position.** `A` is the holder of `R` computed by reducing the
   valid holder-change events (genesis/transfer/succession) that are causal ancestors
   of `O` — i.e. `A` legitimately held the token in its own causal view; **and**
2. **Not concurrently superseded.** Let `H` be `A`'s acquisition event (an ancestor of
   `O`) and `E` the next valid holder-change after `H` in the global valid
   holder-chain. If `E` exists and `O` is **not** a causal ancestor of `E`
   (i.e. `E` did not "see" `O`), then `O` is **stale**.

Stale ops are quarantined with reason `:stale_holder`, excluded from reduction, and
recorded in the audit trail. Holder-changes themselves are validated separately (a
transfer must be authored by the holder-at-its-deps; the double-transfer loser is
`:double_transfer`).

## Why clause 2 is needed and correct
Clause 1 alone would honor a returning holder's op: from `A`'s causal view it still
holds the token (it never saw the move). Clause 2 says: if a *valid* holder-change `E`
moved the token away from `A` and `E` was authored without seeing `O` (they are causally
concurrent — `O ∉ ancestors(E)`), then the holder-change wins and `O` is stale. This is
the deterministic policy choice: **a holder-change beats a concurrent command by the
superseded holder.** It is symmetric to how succession (behavior 15) supersedes a
returning, dormant holder.

Crucially the verdict does **not** depend on the relative total-order position of `O`
and `E` — only on the causal relationship (concurrent) and the validity of `E`. That is
what makes it identical on every realm regardless of merge order. (A realm authors its
own ops in a causal chain, so a realm never produces an op concurrent with its *own*
transfer — `A` either ordered the command before the transfer, `O ∈ ancestors(E)`, and
it is honored, or after, and clause 1 already rejects it.)

## Consequences
* The returning original holder in the succession scenario (behavior 15) has its lock
  op quarantined as `:stale_holder` on every realm; the successor is the holder.
* This favours **availability of the new holder over the work of the lagging old
  holder**: a genuinely-concurrent legitimate-looking command can be lost from state
  (but never from the log/audit). For a moderator-lock this is the safe choice; an
  application needing the old holder's work to survive would model it as convergent
  (CRDT) state rather than authoritative.
