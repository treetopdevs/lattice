# M4 receipt-free attestation verdict

**Status:** concluded research gate, 2026-07-13

**Verdict:** **DO NOT LAND** a real M4 implementation behind the current four
callbacks. Keep `receipt_free?/0 == false`.

The failure is falsifiable and construction-independent: the unchanged interface
requires a public deterministic singleton tally, an immutable signed/content-addressed
logged body, and an alternative body that counts for a different choice. Those three
requirements give the coercer a perfect distinguisher. JCJ-family protocols use a
different semantic shape: fake-credential ballots must look plausible but be excluded
from the tally.

This verdict does **not** say that append-only or replicated storage is incompatible
with coercion-resistant voting. Civitas and CHide already use public append-only boards.
It says Lattice can contribute the board and replay substrate only after the ballot
identity, election lifecycle, tally authority, callback contracts, and an accountable
close/finalize rule for the exact ballot set are designed. Lattice's current eventual
delivery model does not by itself provide one globally canonical, non-equivocating
election close.

### Council process

The verdict was reached through independent and adversarial passes by:

- Codex, inspecting the live repo and primary cryptographic sources;
- Claude Code 2.1.205 using `claude-opus-4-8` at high effort, followed by a separate
  tools-disabled falsification pass; and
- Antigravity `agy` 1.0.16 using Gemini 3.1 Pro (High), across three rounds that
  separated ballot privacy from receipt-freeness and challenged the impossibility
  argument.

All three converged on **DO NOT LAND**. A final shared-document dissent audit preserved
the verdict and added the closure, ideal-leakage, and citation qualifications reflected
below.

## 0. Live-repo correction to the research premise

The brief describes vouches as already-appended `:command` ops, but the checkout does
not currently wire them through the canonical log path:

- [`vouch_body` is `{:vouch, term()}`](../../apps/lattice_core/lib/lattice/attestation.ex),
  while Lattice command bodies must be `{command, args}` with `args` a list.
- [`Lattice.Authority`](../../apps/lattice_core/lib/lattice/authority.ex) classifies
  the current shape as `:malformed_command`; list-wrapping it would instead produce
  `:unknown_command` because `Township.Matter` declares no `vouch` command.
- [`Township.ReadModel`](../../apps/lattice_core/lib/township/read_model.ex) explicitly
  accepts caller-held vouch bodies outside `Township.Matter` and tallies those values.
- The contract's “appendable” test only pattern-matches `{:vouch, _}`; it never builds,
  authorizes, appends, syncs, or replays an op.

A local source-level probe confirmed both facts:

```text
list-shaped vouch: {:error, {:unknown_command, :vouch}}
current vouch matches command shape: false
```

The cryptographic verdict below assumes the intended future design from the brief—a
vouch becomes a public Lattice op—and shows that the intended four-callback swap still
cannot work. The present plumbing gap separately falsifies the “zero other changes”
claim.

## 1. Specific constructions evaluated

### Closest serious positive construction: CHide

The closest construction that meets a modern, explicit coercion-resistance definition
is Cortier, Gaudry, and Yang's **CHide**, a strengthened JCJ-family protocol:

1. trustees run threshold distributed key generation for exponential ElGamal;
2. a registrar issues private credentials and publishes encrypted credential material;
3. voters anonymously post an encryption of `(choice, credential)` plus
   well-formedness and knowledge proofs;
4. trustees use encrypted equality tests, logical gates, conditional zeroing, an
   oblivious sort/mix, and threshold decryption to hide which fake or duplicate ballots
   were removed; and
5. anyone verifies the published proof transcript and final result.

CHide's coercion-resistance theorem is under DDH, SUC-secure DKG and mixnet protocols,
and the programmable random-oracle model. Its tally protocol is shown to SUC-securely
compute the ideal tally functionality; the ballot argument uses IND-PA0/NM-CPA security
for the ElGamal encryption plus proofs. See
[Cortier, Gaudry, and Yang, “Is the JCJ voting system really coercion-resistant?”](https://eprint.iacr.org/2022/430.pdf),
especially §§IV–V and Appendix C.

This is a protocol, not a local attestation primitive. It requires setup, registration,
an anonymous voting channel, election closure, threshold trustees, interactive MPC,
and proof verification. It cannot be reduced to `cast_vouch/3`, a public pure
`tally/2`, and `produce_alt/2`.

The current CHide estimates are also outside the brief's “plausible at 10k” comfort
zone: with three trustees and paper parameter `t = 2` (decryption needs `t + 1`, or all
three, shares), its table estimates 48 single-core days and 668 GB exchanged at 10,000
voters. A separate
[encrypted-sorting CHide treatment](https://eprint.iacr.org/2023/837.pdf) also reaches
`O(n log n)` and notes that the CHide preprint was independently updated from its
original quadratic form. It still retains threshold ElGamal, DKG,
designated-verifier proofs, encrypted cleansing, mixnet work, and a phased tally. That
improves a possible redesign; it does not repair the current callbacks.

### Other concrete candidates

| Construction | Security property it actually supplies | Why it does not fit |
|---|---|---|
| Voter-held chameleon-hash commitment + designated-verifier proof | Trapdoor collision generation and non-transferable proof to a named verifier | If an opening is logged, changing it changes Lattice's outer signed body; if only the chameleon digest is logged, the body can stay identical but keyless `tally/2` cannot recover the choice. A public opening is a receipt. Chameleon collision resistance is not a reduction to vote privacy or coercion resistance. See the [modern chameleon-hash taxonomy](https://link.springer.com/article/10.1007/s00145-024-09510-9). |
| Hirt–Sako homomorphic receipt-free voting | Receipt-freeness through authority-generated encrypted choices, secret one-way authority-to-voter channels, homomorphic tallying, and designated-verifier proofs | It is multi-authority and channel-dependent. The paper says deniable encryption's “incoercibility” is weaker than its receipt-freeness target because a willing seller can make evidence undeniable. See [Hirt and Sako](https://www.iacr.org/archive/eurocrypt2000/1807/18070545-new.pdf). |
| Canetti–Dwork–Naor–Ostrovsky sender-deniable encryption | Fake randomness can make one ciphertext appear consistent with another plaintext | Somebody still needs decryption authority. Giving every replica the key gives it to the coercer; withholding it makes tally an authority-mediated protocol. The original paper describes its constructions as achieving limited deniability. See [the authors' abstract](https://www.wisdom.weizmann.ac.il/~naor/PAPERS/deniable_abs.html). |
| Short linkable ring signatures | Signer ambiguity plus public same-signer linkability, reduced in the cited construction to LD-RSA | LRS does not hide a clear choice. Encryption still needs a tallier, and Lattice's outer Ed25519 `author` field defeats the inner ring's anonymity. See [Tsang and Wei](https://eprint.iacr.org/2004/281). |
| MACI | Encrypted commands, private off-chain processing, and a ZK proof of the result | The coordinator holds the decryption key and processes ordered key-change/vote messages. Official material describes off-chain tally with on-chain proof verification, not coordinator-free public reduction. See [MACI's protocol overview](https://paragraph.com/%40privacy-scaling-explorations/a-technical-introduction-to-maci-1-0-privacy-scaling-explorations) and [current docs](https://maci.pse.dev/). |

No candidate supplies a reduction from “equivocable local body” to the security claim
made by this interface. The candidates that have meaningful proofs all introduce the
missing protocol structure.

## 2. Adversary model and scope

### Minimum in-scope coercer

The current interface already fails against a weak polynomial-time coercer who:

- has the capability needed to read the matter's replicated public view;
- sees every vouch body plus the containing op's `author`, `cap`, `deps`, ID, and
  signature;
- can invoke the same public deterministic `tally/2` as every replica;
- demands a particular choice; and
- after casting, demands the opaque token, randomness, openings, and any alleged
  alternative evidence.

The coercer does not need to break a primitive, compromise the client while it runs, or
control the carrier.

No voting protocol can hide information that the ideal tally result itself reveals.
A future claim must therefore compare `comply` and `resist` executions to an ideal
functionality exposing the **same** result and background-vote distribution. The claim
is that the full transcript leaks no additional advantage beyond that unavoidable
ideal leakage—not that every pair of executions has an identical public result.

### Stronger JCJ-style coercer

JCJ considers forced choice, secret/credential disclosure, and forced abstention. Its
evasion strategy relies on fake credentials, an untappable registration opportunity,
an anonymous casting channel, and an honest threshold of election authorities. The
original [JCJ paper](https://eprint.iacr.org/2002/165.pdf) defines coercion resistance
against these stronger demands; [Civitas](https://www.cs.cornell.edu/Projects/civitas/papers/clarkson_civitas.pdf)
shows the system roles needed to instantiate them.

For this POC:

- **Post-hoc token/randomness disclosure:** in scope; the interface fails.
- **Forced choice:** in scope; the interface fails.
- **Forced abstention:** in scope for the requested strong claim; the interface fails
  because author-attributed log participation is public. Civitas explicitly notes that
  forced-abstention resistance is incompatible with a public record of who voted.
- **Network timing beyond committed log metadata, live device compromise, and continuous
  physical surveillance:** may remain out of scope. Excluding them does not fix the
  body, author, or causal-metadata distinguishers already on the log.
- **Identity private-key compromise:** Lattice's general threat model excludes recovery
  from compromised keys. Excluding that attack still does not save M4.

Receipt-freeness is weaker than coercion resistance: the former prevents transferable
post-election evidence, while the latter also models interactive compliance demands.
The formal distinction and implication chain are developed by
[Delaune, Kremer, and Ryan](https://members.loria.fr/SKremer/files/Publications/b2hd-DKR-csfw06.html).
This interface fails even the weaker property.

## 3. Indistinguishability argument and the contract finish line

Let:

```text
{token_c, body_c} = cast_vouch(identity, c, opts)
body_d             = produce_alt(token_c, d)    where d != c
T(body)            = tally([body], opts)
```

The contract requires `T(body_c)` to count `c` and `T(body_d)` to count `d`. The brief
also requires `body_c` to be placed in the public log.

The coercer's algorithm is:

1. Read the target identity's logged body `body_c`.
2. Run the public `T(body_c)`; this reveals `c` with probability 1.
3. When shown `body_d`, compare it with the logged body and verify the containing op.

There are only two cases:

- If `body_d != body_c`, the claim is rejected by byte comparison. In Lattice this is
  cryptographically bound: [`Lattice.Op`](../../apps/lattice_core/lib/lattice/op.ex)
  hashes and signs canonical bytes containing `author`, `deps`, `kind`, `body`, and
  `cap`; changing the body changes the ID and invalidates the original signature.
- If `body_d == body_c`, determinism requires `T(body_d) == T(body_c)`, so the same
  bytes cannot count both `d` and `c`.

This is a perfect distinguisher under the unchanged interface, not a conjectured attack
on a particular curve or hash.

There is a second, independent contradiction with JCJ. A fake-credential ballot must
look acceptable on the public board but be silently removed during cleansing. The
current contract instead requires:

```elixir
alt = Attestation.produce_alt(@impl_mod, token, :no)
assert %{counts: %{no: 1}} = Attestation.tally(@impl_mod, [alt])
```

Counting coerced fake evidence would let the coercer change the result. The
[encrypted-sorting CHide paper](https://eprint.iacr.org/2023/837.pdf) states the JCJ
semantics directly: fake-credential votes are discarded in the cleansing phase.

### What should replace the current `flunk`?

Nothing should replace it inside the current contract. An equality assertion or a
sample-distribution test cannot prove computational indistinguishability, and the
current API is already contradicted by an explicit distinguisher.

After an interface redesign, executable tests should enforce consequences of a named
construction and its published proof:

1. construct, authorize, append, sync, and replay the **complete** public artifact;
2. expose to the test adversary the body, author/linkability metadata, deps, ID,
   signature, phase, transcript length, proof outputs, and final result;
3. model `comply` and `resist` worlds, including fake credentials and background/dummy
   ballots, without asserting that fake evidence counts;
4. verify construction-specific test vectors, ballot proofs, tally proofs, domain
   separation, nullifiers/duplicates, late ballots, missing trustee shares, and
   threshold boundaries;
5. verify that all arrival permutations of the same finalized transcript produce the
   same **verification result**, and include every adversary-visible `state_at` view in
   the security game so it is simulatable beyond the ideal tally leakage; and
6. keep forced-choice, forced-abstention, ballot privacy, and receipt-freeness as
   separate gates.

Those tests are regression evidence. The cryptographic property still rests on the
construction's formal game and reduction, not on ExUnit sampling.

## 4. Composition with Lattice

| Property | Current four callbacks | CHide/JCJ-style protocol over Lattice | Verdict |
|---|---|---|---|
| CRDT merge and convergence | Plain bodies can merge as a set, but public singleton tally reveals each choice. | Encrypted ballot and proof messages can merge as append-only sets. A completed proof transcript can be verified deterministically from any arrival order. Generating it requires threshold/MPC work and an election close. | **Compatible only with redesign.** Replace pure plaintext tally generation with phased transcript generation plus pure verification. |
| Authority/capability model | `Identity` authors the vouch; the outer op publishes author and capability provenance. | Capabilities can authorize registrar/trustee roles, but capabilities alone do not provide anonymous credentials, secret shares, anonymous submission, or an honest-threshold assumption. | **Incompatible as written.** Ballot eligibility must be unlinkable to the public Lattice author, and trustee assumptions must be explicit. |
| Append-only causal replay | `produce_alt` cannot rewrite the signed logged body. `deps` and time-travel preserve participation and ordering evidence. | Public boards in Civitas and CHide are append-only. Setup, ballot, close, trustee-share, and proof messages can all remain immutable; replay can re-verify the transcript. Lattice still needs an assumed or accountable rule that fixes one complete ballot set despite withholding or split/incomplete views. | **Storage is compatible; board finality and the current representation are not.** Never use a chameleon hash to rewrite Lattice history. |
| Coordinator-free local tally | Required by `tally/2`. | JCJ, Civitas, CHide, Hirt–Sako, and MACI all need trustees or a coordinator for cleansing/decryption/tally generation. | **Incompatible.** Threshold authority can reduce single-party trust, but it is still protocol authority. |

The DAG is therefore useful as part of the election bulletin board and audit transcript,
provided eventual complete delivery and a non-equivocating closure rule are explicit.
It does not “absorb” anonymous credential issuance, encrypted cleansing, decryption,
ballot-set finality, or coercion-resistant tallying. The deterministic Lattice
operation should be `verify_finalized_tally(transcript)`, not
`decrypt_and_tally(public_bodies)`.

## 5. Mapping onto the four callbacks

| Callback | Mapping result |
|---|---|
| `receipt_free?/0` | Must remain `false`. A future result is conditional on setup, channel, threshold, phase, and adversary assumptions; one global boolean is too coarse. Report ballot privacy, receipt-freeness, forced-choice resistance, and forced-abstention resistance separately. |
| `cast_vouch(Identity.t(), choice, opts)` | No sound mapping. CHide needs election parameters, an anonymously presented private credential, encryption, and proofs. Passing an identity into an outer identity-signed op defeats participation privacy. A redesigned cast may create an encrypted ballot envelope, but submission must not expose the member's ordinary Lattice identity. |
| `tally([vouch_body], opts)` | No sound mapping. At most, a pure function can aggregate ciphertexts or verify a finalized proof transcript. Setup, close, cleansing, trustee contributions, decryption, and result verification need explicit protocol operations. |
| `produce_alt(token, demanded)` | The abstraction is wrong. Chameleon/deniable schemes simulate evidence for the **same** public artifact; JCJ creates a fake credential and coerced ballot that intentionally does **not** count. Neither returns a second valid, counting body after the actual body was immutably logged. |

At least three callbacks and the public op envelope must change. This is not a drop-in
module swap.

## 6. Final verdict

**DO NOT LAND** `Lattice.Attestation.M4Placeholder` behind the current behaviour, and
do not set `receipt_free?/0` to `true`.

The falsifying properties are:

1. public deterministic singleton tally is a choice oracle;
2. the signed/content-addressed op makes a byte-different alternative detectably not
   the logged vote;
3. a byte-identical alternative cannot tally as a different choice;
4. the contract requires JCJ fake evidence to count, while coercion resistance requires
   it to be excluded; and
5. the outer author/cap/deps metadata makes participation—and therefore forced
   abstention—observable.

### Meaningful next research/build decision

Choose one of two honest tracks before implementation:

1. **Narrow ballot privacy:** encrypted vouch bodies, order-independent encrypted
   aggregation, threshold decryption-share ops, and deterministic final verification.
   This can compose with the DAG, but must remain explicitly **not receipt-free** and
   **not forced-abstention-resistant**.
2. **Actual coercion resistance:** write an interface-redesign brief around CHide or
   encrypted-sorting CHide. Treat Lattice as the append-only board; add setup,
   registration/credential issuance, anonymous ballot submission, close/finalize,
   trustee/MPC contributions, fake/duplicate cleansing, and proof verification. State
   the honest-threshold, complete-delivery, canonical-close, and channel assumptions as
   capabilities plus non-capability trust assumptions.

If Township will not accept those roles, phases, and anonymity assumptions, W4 must
remain a clearly labelled stub. There is no known chameleon-hash, deniable-encryption,
or ring-signature substitution that preserves the current interface and clears the
stated gate.
