# Plan 172: Close two TypeScript canonical-encoder gaps that let a peer wedge sync or diverge quarantine

> **Executor instructions**: Follow this plan step by step. Run every verification command
> and confirm the expected result before moving to the next step. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise. When done, update
> the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 91bb6ca6..HEAD -- clients/lattice-client/src/codec.ts clients/lattice-client/src/authority.ts clients/lattice-client/test/canonical.ts
> ```
> If any in-scope file changed since this plan was written, compare the "Current state"
> excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1 — both defects let a peer, with **no key material**, cause the TypeScript
  realm to disagree with BEAM about which operations are valid. One of them permanently wedges
  the client's sync loop.
- **Effort**: S–M — three small changes plus negative vectors.
- **Risk**: MED — the strict base64 decoder will reject any persisted frame or fixture that
  carries non-canonical base64. That is the intended behaviour, but it can surface as churn in
  stored state; step 2 measures it first.
- **Depends on**: none. (Adjacent to plan 163, which owns replica pinning in `authority.ts` —
  see Scope.)
- **Category**: security
- **Planned at**: commit `91bb6ca6`, 2026-08-06

## Why this matters

`clients/lattice-client` is a second implementation of a signed protocol whose Elixir side is
authoritative. `clients/lattice-client/CLAUDE.md` is explicit that the library "only earns the
right to exist because `test/conformance.ts` pins it to Sim". Any input where the two
implementations disagree is a security defect, in one of two directions: the client accepts what
BEAM rejects (ops in the client's log that no BEAM replica will ever hold), or it rejects what
BEAM accepts (divergence and, here, a hard stop).

Two such inputs exist, and both were confirmed by executing the real encoder.

**1. Duplicate map keys and duplicate MapSet elements.** Elixir's `Lattice.Canonical` raises on
both. The TypeScript encoder sorts but never checks. Meanwhile the Elixir *wire decoder*
silently collapses duplicates — `decode_map` folds with `Map.put`, `MapSet.new` dedupes. So a
peer can duplicate one `[key, value]` pair inside any `"map"` term, or one element inside any
`"mapset"` term, of a **legitimately signed** frame **without touching `id` or `sig`**. BEAM
re-derives identical canonical bytes after the collapse and accepts unchanged; TypeScript
encodes both copies, computes a different hash, and fails verification. Because
`syncCarrierOnce` throws on any failed verification rather than quarantining, the frame never
enters `localOps`, so the next pull re-fetches it and throws again — a **permanent, key-free
sync wedge**. In Township the reachable map-bearing bodies are the genesis `policies` map and
the witnessed-succession certificate, so the wedge targets the replica's root of trust.

**2. Lenient base64 on the trust boundary.** BEAM uses `Base.decode64/1` (strict: padding
required, alphabet enforced) and returns `{:error, :malformed_op}` otherwise. TypeScript uses
`Buffer.from(value, "base64")`, which accepts unpadded input, over-padding, embedded whitespace,
characters outside the alphabet, and the base64url alphabet. Confirmed by execution: four
different encodings of one key all decode to the same 32 bytes and produce byte-identical
canonical op bytes. So TypeScript fully verifies frames BEAM rejects as malformed before they
ever reach a log. Compounding it, realm identity is keyed on the **raw base64 string**
(`realmForPubkey`, `delegationKey`), so one Ed25519 key has unboundedly many principal
identities on the TS side and realm-equality checks can be made to disagree with each other.

The library already contains the correct primitive twice — `canonicalEvidenceBytes` in
`codec.ts` and `canonicalBase64Bytes` in `authority.ts` both round-trip-check — but they are
applied only to witness/holder/successor evidence, never to `author`, `sig`, `issuer`,
`audience`, or `"bin"` terms.

Neither defect is covered by the existing vectors, which use ASCII and well-formed fixtures
only. That is why both survived a green CI.

## Current state

### Gap 1a — `encodeMap` has no duplicate-key check, `clients/lattice-client/src/codec.ts:307-312`

```typescript
function encodeMap(pairs: [CarrierTerm, CarrierTerm][]): Uint8Array {
  const encoded = pairs
    .map(([key, value]) => [encodeCarrierTerm(key), encodeCarrierTerm(value)] as const)
    .sort(([left], [right]) => compareBytes(left, right));

  return concat(major(5, BigInt(encoded.length)), ...encoded.flatMap(([key, value]) => [key, value]));
```

### Gap 1b — the mapset arm has no duplicate-element check, `codec.ts:280-286`

```typescript
    case "mapset":
      return encodeTagged(
        mapsetTag,
        encodeArray(term[1].map(encodeCarrierTerm).sort(compareBytes)),
      );
```

### The Elixir behaviour both must match — `apps/lattice_core/lib/lattice/canonical.ex:203-216` and `:168-180`

```elixir
    if Enum.uniq(keys) != keys do
      raise ArgumentError, "duplicate canonical map key"
    end
```

```elixir
    if Enum.uniq(elements) != elements do
      raise ArgumentError, "duplicate canonical mapset element"
    end
```

### Why the tamper survives on the BEAM side — `apps/lattice_core/lib/lattice/carrier/wire.ex:237` and `:253`

`decode_map` folds pairs with `Map.put` (last duplicate wins, silently) and `MapSet.new(values)`
dedupes silently. BEAM therefore re-derives the pre-tamper canonical bytes and accepts.

### Gap 2 — the lenient decoder, `clients/lattice-client/src/codec.ts:418-424`

```typescript
function base64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));

  const atobFn = (globalThis as unknown as { atob?: (encoded: string) => string }).atob;
  if (!atobFn) throw new Error("base64 decoding unavailable");
  return Uint8Array.from(atobFn(value), (char) => char.charCodeAt(0));
}
```

Used for `frame.author` (`codec.ts:106`), `frame.sig` (`codec.ts:134`), delegation
`issuer`/`audience` (`codec.ts:167`), delegation `sig` (`codec.ts:302`), and every `"bin"` term
(`codec.ts:271`). A **second, identical** copy lives at `clients/lattice-client/src/authority.ts:1199`.

### The correct primitive, already present — `codec.ts:426-430`

```typescript
function canonicalEvidenceBytes(value: string): Uint8Array {
  const decoded = base64ToBytes(value);
  if (bytesToBase64(decoded) !== value) throw new Error("non-canonical base64 evidence");
  return decoded;
}
```

and `authority.ts:1207-1216` (`canonicalBase64Bytes`), which additionally takes an expected
length and returns `null` rather than throwing.

### The BEAM counterpart — `apps/lattice_core/lib/lattice/carrier/wire.ex:50`

`Base.decode64(author_b64)` / `Base.decode64(sig_b64)`, strict, `{:error, :malformed_op}` on
failure. Same at `wire.ex:223` (`"bin"`) and `wire.ex:303` (delegation keys).

### Repo conventions to match

- Strict ESM TypeScript, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. No `any`,
  no `as` casts to silence errors, no `@ts-ignore`.
- Fail-closed: rejections are thrown `Error`s or `null` returns, never a permissive default.
- Test scripts are `tsx` entry points registered as npm scripts; match the surrounding
  assertion/reporting style of the file you edit.
- Vectors are generated by `mix lattice.export_vectors`, **never hand-edited**.

## Commands you will need

```bash
export MIXCMD="$HOME/.asdf/shims/mix"
export PATH="$HOME/.asdf/installs/erlang/28.3.1/bin:$HOME/.asdf/installs/elixir/1.19.5-otp-28/bin:$PATH"
```

| Purpose | Command | Expected on success |
|---|---|---|
| TS typecheck | `cd clients/lattice-client && npm run typecheck` | exit 0 |
| Canonical parity | `cd clients/lattice-client && npm run canonical` | exit 0 |
| Conformance | `cd clients/lattice-client && npm run conformance` | exit 0 |
| Township authoring | `cd clients/lattice-client && npm run township:authoring` | exit 0 |
| Carrier suites | `cd clients/lattice-client && npm run carrier:township && npm run carrier:relay && npm run carrier:township:live` | exit 0 |
| Build (regenerates `dist/`) | `cd clients/lattice-client && npm run build` | exit 0 |
| Shell typecheck | `cd clients/township-tauri-shell && npm run typecheck` | exit 0 |
| Elixir suite | `$MIXCMD test` | exit 0 |

Baseline at the planned-at commit: `$MIXCMD test` exits 0 and all TS scripts above exit 0.

## Scope

**In scope**:

- `clients/lattice-client/src/codec.ts` — `encodeMap`, the `"mapset"` arm, and the base64
  decoder consolidation
- `clients/lattice-client/src/authority.ts` — **only** the duplicate `base64ToBytes` at
  `:1199`, replaced by the shared strict decoder. Nothing else in this file.
- `clients/lattice-client/test/canonical.ts` — negative cases
- `clients/lattice-client/dist/**` — regenerated by `npm run build`, **never hand-edited**
- `plans/README.md` — status row

**Out of scope** (do NOT touch, even though they look related):

- `apps/lattice_core/lib/lattice/canonical.ex` — the Elixir encoder is **correct**. TypeScript
  is the side that is behind.
- `apps/lattice_core/lib/lattice/carrier/wire.ex` — the silent duplicate-collapse on decode is
  worth a follow-on (see Maintenance notes) but changing BEAM's decode behaviour is a wire
  contract change and does not belong in a TS-side fix.
- `clients/lattice-client/src/authority.ts` beyond the one decoder — **plans 162 and 163 own
  this file.** If you find yourself editing authority logic, root-commitment handling, or the
  `outerReplica` inference, STOP: the plans have collided.
- `clients/lattice-client/src/carrier.ts` — `syncCarrierOnce`'s throw-on-failure behaviour is
  the *amplifier* for gap 1, and converting it to per-frame quarantine is the right follow-on.
  It is **plan 169**'s neighbourhood and a contract change to `SyncCarrierResult`. Do not do it
  here.
- The `CarrierTerm` tree validator (tag/arity/element-type checking at the frame boundary).
  Real and related, deliberately deferred — see Maintenance notes.

## Git workflow

- Branch: `codex/172-ts-canonical-encoder-strictness`
- Conventional commits matching `git log`, e.g.
  `test(codec): add RED duplicate-term and non-canonical-base64 cases`, then
  `fix(codec): reject duplicate canonical keys and non-canonical base64`.
- Commit the RED tests separately from the fix.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing (RED) cases first

Add to `clients/lattice-client/test/canonical.ts`, following that file's existing check/report
style:

1. Encoding a `"map"` term whose pair list contains the **same key twice** must throw.
2. Encoding a `"mapset"` term whose element list contains the **same element twice** must throw.
3. Decoding an op frame whose `author` is unpadded base64 must be rejected.
4. Decoding an op frame whose `author` carries a trailing newline must be rejected.
5. Decoding an op frame whose `author` contains a character outside the base64 alphabet must be
   rejected.

For 3–5, the assertion that matters is that the frame is **rejected**, not merely that it
decodes to different bytes — today all three decode to the *same* 32 bytes and verify clean,
which is the defect.

**Verify**: `cd clients/lattice-client && npm run canonical` → **all five new cases FAIL**,
every pre-existing check still passes. If any passes before you change source, note which and
narrow the plan accordingly.

### Step 2: Measure what strict base64 will reject

Strict decoding rejects previously-accepted input. Find out whether any committed fixture,
vector, or persisted-state sample carries non-canonical base64:

```bash
cd clients/lattice-client
grep -roh '"author": *"[^"]*"' test/vectors | sort -u | head -20
node -e '
const fs=require("fs"),path=require("path");
const bad=[];
const walk=d=>fs.readdirSync(d,{withFileTypes:true}).forEach(e=>{
  const p=path.join(d,e.name);
  if(e.isDirectory())return walk(p);
  if(!p.endsWith(".json"))return;
  const check=v=>{ if(typeof v!=="string")return;
    if(!/^[A-Za-z0-9+/]+={0,2}$/.test(v))return;
    if(Buffer.from(v,"base64").toString("base64")!==v) bad.push([p,v.slice(0,12)+"..."]); };
  const walkv=v=>{ if(Array.isArray(v))v.forEach(walkv);
    else if(v&&typeof v==="object")Object.values(v).forEach(walkv); else check(v); };
  walkv(JSON.parse(fs.readFileSync(p,"utf8")));
});
walk("test/vectors");
console.log(bad.length?bad:"ALL VECTOR BASE64 IS CANONICAL");
'
```

Record the result. `ALL VECTOR BASE64 IS CANONICAL` is expected and means the change is
inert for the corpus. Any hit must be reported — a non-canonical value in a generated vector
would mean the *Elixir* exporter emits one, which is its own finding.

**Verify**: the command runs and you have recorded the output. No files changed yet.

### Step 3: Reject duplicates in the encoder

In `codec.ts`, after sorting in `encodeMap`, throw if any adjacent encoded keys compare equal.
Do the same for adjacent encoded elements in the `"mapset"` arm. Adjacent comparison after a
sort is sufficient and is O(n) — do not build a `Set` of stringified bytes.

Match Elixir's error wording so cross-runtime failures are greppable: `"duplicate canonical map
key"` and `"duplicate canonical mapset element"`.

**Verify**: `npm run typecheck` → exit 0; `npm run canonical` → the two duplicate cases from
step 1 now pass.

### Step 4: Make the strict decoder the only decoder

Promote a single strict decoder — the `canonicalEvidenceBytes` round-trip check is already the
right predicate — and route **every** boundary decode through it: `frame.author`,
`frame.sig`, delegation `issuer`/`audience`/`sig`, and `"bin"` terms.

Requirements:

- **One implementation.** Delete the duplicate `base64ToBytes` at `authority.ts:1199` and
  import the shared one. There are currently two copies of the lenient decoder and two copies
  of the canonicality check; end with one of each.
- **Enforce expected lengths where they are known** — 32 bytes for an Ed25519 public key, 64 for
  a signature. `canonicalBase64Bytes` already takes a `length` parameter; reuse that shape.
- **Preserve each call site's failure mode.** Some sites throw, some return `null` into a
  fail-closed branch. Do not convert one into the other — read each call site and keep its
  contract. Changing a `null` return into a throw could turn a quarantine into a crash, which is
  the failure mode plan 169 is trying to remove elsewhere.

**Verify**: `npm run typecheck` → exit 0; `npm run canonical` → the three base64 cases from
step 1 now pass; `grep -c "Buffer.from(value, \"base64\")" src/*.ts` shows exactly one
occurrence remaining (inside the shared decoder).

### Step 5: Regenerate and prove cross-runtime parity

```bash
cd ../..
$MIXCMD lattice.export_vectors --out clients/lattice-client/test/vectors
git diff --stat clients/lattice-client/test/vectors
cd clients/lattice-client && npm run build
```

The vector diff must be **empty** — this plan changes only what is *rejected*, never what
honest input encodes to. A non-empty diff means you changed the encoding of valid input; STOP.

Then run every TS gate:

```bash
npm run typecheck && npm run conformance && npm run canonical && npm run township:authoring \
  && npm run carrier:township && npm run carrier:relay && npm run carrier:relay-sync \
  && npm run carrier:feed && npm run carrier:township:live
cd ../township-tauri-shell && npm run typecheck
```

**Verify**: all exit 0 and the vector diff is empty.

### Step 6: Full green

```bash
cd /Users/nicholas/develop/lattice && $MIXCMD test
```

**Verify**: exit 0.

## Test plan

New cases in `clients/lattice-client/test/canonical.ts`, following its existing style:

1. `"map"` term with a duplicated key → throws `duplicate canonical map key`.
2. `"mapset"` term with a duplicated element → throws `duplicate canonical mapset element`.
3. Op frame with unpadded-base64 `author` → rejected.
4. Op frame with whitespace in `author` → rejected.
5. Op frame with an out-of-alphabet character in `author` → rejected.
6. A **positive** control: a well-formed frame with canonical base64 still verifies and produces
   the same op id as before the change. This is the guard against over-rejection and it matters
   as much as the five negatives.

Verification: `npm run canonical` → exit 0 with 6 new checks reported.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `cd clients/lattice-client && npm run typecheck` exits 0
- [ ] `cd clients/lattice-client && npm run conformance && npm run canonical && npm run township:authoring` — all exit 0
- [ ] `cd clients/lattice-client && npm run carrier:township && npm run carrier:relay && npm run carrier:relay-sync && npm run carrier:feed && npm run carrier:township:live` — all exit 0
- [ ] `cd clients/township-tauri-shell && npm run typecheck` exits 0
- [ ] `$MIXCMD test` exits 0
- [ ] `git diff --stat clients/lattice-client/test/vectors` is empty
- [ ] `grep -c 'Buffer.from(value, "base64")' clients/lattice-client/src/*.ts` totals 1
- [ ] The 6 checks named in the test plan exist and pass
- [ ] `git status --porcelain` lists no file outside the in-scope list
- [ ] `plans/README.md` status row for 172 updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any step-1 case passes before you change source — narrow the plan to the remaining gaps and
  say which were already closed.
- Step 2 finds non-canonical base64 in a **generated** vector. That means the Elixir exporter
  emits it, which is a separate and more serious finding.
- Step 5's vector diff is non-empty. You have changed the encoding of valid input, not just
  what is rejected.
- Any carrier or conformance suite goes red after step 4 because a **fixture** carries
  non-canonical base64. Report which fixture; do not loosen the decoder to accommodate it.
- Consolidating the decoder requires changing a call site's failure contract (throw ↔ null) to
  make types work. Report it — that is a design question about the boundary, not a mechanical
  edit.

## Maintenance notes

For the human or agent who owns this next:

- **What a reviewer should scrutinize**: the positive control (test 6) and the empty vector
  diff. Together they prove the change is purely subtractive — it rejects more, and encodes
  nothing differently.
- **The rule this establishes**: the TypeScript side must reject exactly what
  `Lattice.Canonical` raises on and exactly what `Base.decode64/1` refuses. When either Elixir
  side changes, this file changes with it.
- **Explicitly deferred, and why**:
  - *`CarrierTerm` tree validation.* `assertCarrierOpFrame` checks the envelope and that
    `body`/`cap` are arrays, but does not validate the term tree, so malformed bodies produce
    raw `TypeError`s out of the encoder. Real, and a natural follow-on to this plan.
  - *Per-frame quarantine instead of throwing.* `syncCarrierOnce` aborts the whole batch on any
    verification failure, which is what turns gap 1 into a permanent wedge rather than a single
    rejected op. It also contradicts the substrate doctrine that failing ops are quarantined
    with a deterministic reason, never dropped. Changing it alters `SyncCarrierResult`'s
    contract and belongs with plan 169's work on the same file.
  - *BEAM's silent duplicate-collapse on decode.* `Wire.decode_map`/`decode_mapset` accept a
    duplicated term and normalise it. Rejecting it outright would close the tamper at both
    ends, but it is a wire contract change.
- **A related divergence found in the same audit, not in this plan's scope**: `or_set` members
  are sorted with JavaScript string comparison (`crdt/reducers.ts:78`) while Elixir sorts
  binaries bytewise (`crdt/or_set.ex:69`). The two orderings invert for any set mixing an
  astral-plane character with one in U+E000–U+FFFF — so a single emoji in a member name makes
  `materialize()` disagree with `Lattice.Sim`. Small, real, and worth its own change; the
  existing vectors are ASCII-only so CI cannot catch it.
