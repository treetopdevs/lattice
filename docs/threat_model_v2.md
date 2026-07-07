# Lattice 2.0 — Threat Model (delta from v1)

This is a falsifiable POC, not a production system. This document states plainly what
the 2.0 model defends against, what it explicitly does **not**, and the trust
assumptions on each realm. Read it before drawing any security conclusion.

## What v2 adds over v1

v1 established **capability-mediated authority**: tabs have zero implicit authority and
may only act through unforgeable `Lattice.Cap` tokens validated by `Lattice.Gateway`
(ungranted targets denied, per-realm isolation, eject revokes). Those invariants still
hold (behavior 19).

v2 adds a **durable, signed, content-addressed op-log** as the unit of identity and an
**in-log delegation chain** that authorizes both log ops and live messages:

* **Integrity & tamper-evidence.** Every op is hashed and Ed25519-signed by its author.
  A mutated op fails verification and is quarantined at sync (behavior 4); because ids
  are content hashes chained through `deps`, mutating history is detectable.
* **Attribution.** Every op carries its author's public key and signature; you can
  prove which realm authored which op.
* **Authorization provenance.** Each op cites a delegation chain rooting at the
  replica's genesis key; unauthorized, stale, revoked, and double-spent-authority ops
  are deterministically quarantined and audited (behaviors 5–10, 15, 16).
* **Authenticated carrier sessions and bounded transfer behavior.** The real WebSocket
  carrier now verifies the peer realm/key with a signed challenge/response before sync,
  uses explicit reconnect backoff, and splits large pushes into bounded frames. These
  harden the transport boundary; they do not add confidentiality or consensus.

## What v2 does NOT provide

> **Signed logs give integrity and attribution, not confidentiality. This POC signs;
> it does not seal.**

* **No confidentiality / no encryption of any kind.** Op bodies are plaintext. Anyone
  who can read a realm's log (or observe `Lattice.Net`/a real carrier) sees all content
  — messages, titles, participants, and the entire authority structure. E2EE
  (Keyhive/BeeKEM-style key agreement, encrypted ops) is explicitly **out of scope**
  (see the spec's "Do not implement").
* **No metadata privacy.** Authorship, causal structure, timing (logical ticks), and
  who-holds-what authority are all in the clear.
* **No availability guarantees against a malicious carrier.** A carrier can withhold or
  reorder delivery. Lattice converges for any *dep-respecting* delivery and detects
  *tampered* ops, but a carrier that simply drops ops degrades availability (the log is
  still internally consistent; it is just incomplete until sync completes).
* **No consensus or global truth service.** Peer-authenticated sessions prove which key
  answered a carrier connection; they do not decide which log head is globally
  canonical, prevent forks, or provide Byzantine agreement.
* **No protection against a compromised key.** If a realm's private key leaks, the
  attacker can author validly-signed ops as that realm and exercise exactly the
  authority that realm legitimately holds. Revocation (`:revoke`) bounds future damage
  for *delegated* capabilities but not for the genesis/root key.
* **No Sybil / identity binding.** Public keys are identities; nothing binds a key to a
  real-world principal. That is the carrier/PKI's job.

### What Keyhive-style E2EE would add

Keyhive/BeeKEM would layer **confidentiality** on top of this integrity substrate:
op bodies encrypted under group keys, with capability changes (grant/transfer/revoke)
driving key rotation so that a removed member cannot read subsequent ops. The op-log,
authority semantics, and convergence designed here are intended to be the layer
*beneath* such a scheme — encryption would wrap `body` and the delegation payloads
without changing the DAG, reduction, or quarantine logic. It is deliberately not built
here.

## Trust assumptions per realm

* **Each realm trusts its own private key** and the runtime hosting it (BEAM node or
  browser AtomVM node). A realm that is itself malicious can author any op it is
  authorized for and can equivocate (fork its own history); the design tolerates this
  for *convergent* state (CRDTs merge) and resolves it deterministically for
  *authoritative* state (double-transfer and stale-holder quarantine), but a malicious
  realm can still spam its own valid ops.
* **The genesis/root key is fully trusted** for a replica — it grants all initial
  authority and can revoke any delegation. Compromise of the root is unrecoverable in
  this POC.
* **The carrier (`Lattice.Net` in simulation, WebSocket in the real spike) is untrusted
  for confidentiality and availability but cannot forge or tamper** — any modification
  is caught by signature/hash verification. M2 authenticates the peer key before sync
  and bounds transfer behavior; the carrier is still trusted only to eventually deliver
  for liveness.
* **The simulated realms** stand for real server/browser nodes; in-process locality is
  a test convenience, not a trust assumption.
