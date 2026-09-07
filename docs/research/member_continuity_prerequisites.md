# Root adoption of R19b prerequisites

Adopted 2026-09-07 UTC after actual Claude Fable review of the corrected packet,
SHA256 `2154bcdb824c8da9491cf7da47ed261cdf7be12ccbfcbf2190ec94f96b1577c3`,
returned PASS with no P0–P2. The proposal text below is retained verbatim as the
implementation contract; its proposed status describes its review-time provenance.
Only its vocabulary, selected-Space loading and causal context changes are now
authorized. Command registration/continuity policy and A01–A17 remain OPEN.

Root verified the old default exporter baseline before any enum change:
2 cases, 28,258 bytes, SHA256
`21d0167dcbee9ac72216af7e1af4ab9d34ac559fd09347046671c25dcf00c0bc`.
Exporter, cutoff, codec and package-lock source blobs equal f541 exactly.
The captured file is `r19b-pre-union-default-ts-cutoff.json` with manifest/log
under the execution artifact directory. The executor may add those exact bytes
as a newly named `test/vectors/catalog/cutoff_default_pre_member_continuity.json`
fixture with that pinned hash. This is a new preserved pre-edit baseline, never
a claim that ts_cutoff.json was already checked in. No default export is recaptured
after the enum change to replace this baseline.

Root alone integrates the reviewed BEAM CatalogTrust module before its enum tests
can close. One writer owns Authority/Replica/policy/quarantine; another owns Space,
cutoff/trust enums, additive vocabulary/reciprocal fixtures and startup tests.
Neither edits compaction support or the other's files. Retained-trust behavioral
repair and new public ingress tests require their own exact integration review.

---

# R19b prerequisite adoption packet — 2026-09-06

Status: proposed for integrator adoption; no repository edits. This packet selects
only the fixed cutoff vocabulary, trusted application atom loading and additive
causal beacon context. It does not register the new command or close A01–A17.

Sources inspected: R19b `f5415cc8294fd94350d74869fb35de855d3eeb96`, BEAM retained
trust `fba17afdbf7aec13b5af2c7d026c02cb07980405`, TS retained trust
`40263ce98ad00314628b6ca4e3c9cc264e601a93`. Paths below are repository-relative;
CatalogTrust BEAM references use the separate BEAM-trust snapshot. The R19b
snapshot does not contain that later module. No source snapshot was merged.

## 1. Exact vocabulary and independently computed artifacts

Preserve the complete historical paragraph at
`docs/research/treehouse_catalog_lifecycle.md:727–731` and the bytes of
`clients/lattice-client/test/vectors/catalog/cutoff_atoms_v1.json`.

The exact additional names, in ASCII order, are:

```text
active
admission
attest_member_key_v1
new_pub
old_admission
old_membership
old_pub
removed
vouchers
```

All nine are absent from the historical set. Detached return fields are excluded.
The expanded set is the globally sorted set union, not the old list followed by
nine names. All names are ASCII, so ASCII, unsigned UTF-8 and codepoint sort agree.

| Artifact basename | Names | UTF-8 bytes | SHA-256 |
| --- | ---: | ---: | --- |
| `cutoff_atoms_v1.json` (unchanged) | 130 | 2017 | `a66d085dd185091d745d933c3145101a97b3306406aba905af07ca051d09506c` |
| `cutoff_atoms_member_continuity_v1.json` (new) | 9 | 148 | `38aab5c25051af1d009c917274cdf68ae4f61776ebef0bf3634ad3899b9ce8df` |
| `cutoff_atoms_with_member_continuity_v1.json` (new) | 139 | 2162 | `e7e7e16800327ca76b68ddabf7015c84b1750a327def5c0366c4e37f4ed7aaac` |

Proposed destination for both new fixtures is the same `test/vectors/catalog/`
directory. Exact new-file serialization: JSON array, two-space indentation,
LF newlines including one final LF, UTF-8 without BOM. Node and an independent
Python implementation derived the lists, serialized them and obtained identical
bytes/hashes. The proposed files, Node script and both derivation logs are currently only in
`/tmp/lattice-treehouse-execution-20260906/`.

### Dated lifecycle amendment to append before code

> Adopt the R19b nine-name continuity supplement and sorted 139-name union with
> the exact fixture hashes above. The preceding 130-name paragraph and fixture
> remain historical evidence unchanged. For this adopted extension, all three
> compiled validators—BEAM CatalogCutoff, BEAM CatalogTrust and TypeScript
> CatalogCutoff—must equal the 139-name union. This supersedes only their runtime
> exact-130 equality obligation. Previously supported histories retain their
> canonical bytes, cutoff records and digests. Authentic histories containing
> these nine names become cutoff-portable; this grants no command capability,
> membership, authority, catalog trust or transport admission. Every other
> unsupported atom remains unsupported. Generic wire decoding, canonical
> integer/depth rules, accepted/rejected evidence retention, the actual 64,000-byte
> per-op push envelope and caller history budgets are unchanged. No atom is
> created from input and no input selects a module to load.

## 2. Complete fixed-list and test inventory

| File / current clause | Required bounded change |
| --- | --- |
| `apps/lattice_core/lib/treehouse/catalog_cutoff.ex:15–32` | Replace only the 130 compiled literals with the sorted 139 union. `portable_value?/1` at93–94 and delegation recursion continue using this same set. |
| `apps/lattice_core/lib/treehouse/catalog_trust.ex:88–106` (fba) | Update its independent compiled list too. Its derived name map gates raw `closed_wire_term?/2` atom input at2077–2078 and embedded delegation ops/roles at2100–2102, before Wire decoding. Changing CatalogCutoff alone leaves this public raw trust ingress rejecting the new history. |
| `clients/lattice-client/src/treehouse_catalog_cutoff.ts:19–150` | Update the single TS list to the exact sorted union. Retain raw authentication and portable-term inspection. |
| `clients/lattice-client/src/treehouse_catalog_trust.ts` (402) | No copied list. `observeHistory` and `mergeHistories` call the shared raw cutoff; no production change needed for vocabulary. Exercise its actual public evaluate/reopen path. |
| `clients/lattice-client/test/treehouse_catalog_cutoff.ts:86–96` | Add an executable historical hash assertion (the current hash is a comment only), plus supplement/union count, hash, disjointness, exact sorted-union and source-literal equality assertions. Its actual signed all-name operation must cover the union. Preserve unknown-atom/forgery precedence controls. |
| `apps/lattice_core/test/treehouse/catalog_cutoff_reciprocal_test.exs:47–125` | The fresh BEAM vocabulary op currently reads the historical fixture at53 and safely converts only existing atoms at58. Use the separately checked union for new extension cases; preserve old input/result controls. |
| `clients/lattice-client/test/support/export_treehouse_catalog_cutoff.ts` | Current default emits two historical cases and has no atom-fixture dependency. Preserve those two cases. `ts_cutoff.json` is only the default output destination, not a committed vector. Capture the exact default exporter bytes at pre-edit f541 before changing any enum, then compare the later default output with that immutable baseline. Add an explicit `--with-member-continuity` mode emitting a separate additive signed corpus with full union evidence. Its verifier already accepts nonempty case arrays. |
| New `apps/lattice_core/test/treehouse/catalog_cutoff_vocabulary_test.exs` | Pin both BEAM literal sources to the exact union as well as file hashes. There is currently no equality test for the BEAM-trust copy. Source checks complement, never replace, signed public ingress tests. |
| `apps/lattice_core/test/treehouse/catalog_trust_test.exs` and TS `test/treehouse_catalog_trust.ts` | Public installation/evaluation/reopen over a valid existing catalog plus retained authenticated history containing all nine new names. Add selected bad-signature rejected evidence using new names and verify it is retained. Raw-input extra-name/forgery controls must still refuse. |
| `apps/lattice_core/test/treehouse/catalog_trust_reciprocal_test.exs` and new extension fixture/support | Carry independently signed extension history through BEAM and TS public trust/cutoff paths in both input orders, keeping every original trust fixture byte unchanged. |

No change is proposed to `Lattice.Carrier.Wire`'s generic atom decoder,
`Lattice.Canonical`, old canonical-generator atom lists, permission registries,
root-only capability ceilings, profile bytes, catalog schema or Core authority.
Runtime source equality checks read compile-time literal text; production must
not read a JSON fixture or create atoms from those strings.

### Necessary disposition of the frozen pure-codec negatives

Two immutable codec fixtures currently contain `unknown_command` historical
expectations and genuine root-genesis/attestation frames. Preserve their bytes,
including those historical labels and `expected_reason`. The live assertions
must state which implementation stage they are testing:

| Stage | Raw cutoff of same exact history | Ordinary judge |
| --- | --- | --- |
| Frozen pure codec f541 | `unsupported_cutoff` | `unknown_command` |
| This vocabulary-only prerequisite | portable, exact records/digest | `unknown_command` |
| Later command registration with unchanged original genesis cap | portable | `operation_not_granted` |

The last reason follows the existing permission clause in
`authority.ex:1466–1467`: the fixture's cap does not contain the new command.
Registry activation is outside this prerequisite and needs its own public proof.
Do not preserve an obsolete live assertion by changing the old grant or by
editing the frozen fixture's provenance. Update the live observer assertion only,
with a named stage-specific explanation; exporters must still regenerate the
original codec files byte-identically. Relevant current assertions are BEAM
`member_continuity_reciprocal_test.exs:59,61,92`, the actual command control in
`member_continuity_codec_test.exs`, and TS
`test/support/export_member_continuity.ts:76–83`, invoked by its permanent codec
tests. Only the cutoff expectation changes in this prerequisite.

## 3. Actual cold-VM loading gap and minimal selected-schema remedy

A new `/tmp` characterization used the existing signed BEAM fixture and compiled
f541 modules, in separate Elixir/OTP28 processes with `+S 4:4`:

- `Code.ensure_loaded!(Treehouse.Space)`, Authority and Delegation left the
  continuity codec unloaded. The first actual signed command frame refused
  `malformed_op`; its previously authenticated dump refused `unsafe_dump`.
- An explicit codec-load positive control verified that exact op's signature,
  restored with `Log.restore_verified/1`, reverified authenticity and obtained
  ordinary `unknown_command`. The dump was made under `/tmp` from real signed
  frames; no private material, local device identity or repository file changed.

This reproduces a loading gap, not a signature or permission defect. Log:
`r19b-space-vocabulary-probe.log`; public op ID
`FzLaiptUdY4p-lpDAN8oi824t7DeV5K-uvgESMlAci8`.

Proposed exact API amendment: add `Treehouse.Space.known_continuity_wire_atoms/0`,
`@doc false`, `@spec known_continuity_wire_atoms() :: [atom()]`, returning precisely
the sorted nine literal atoms. Reachable runtime literals are interned when the
trusted selected Space module is loaded, matching the already proven pure
codec `command_name/0` technique. No `@on_load` dependency, alias-based assumption,
input-driven `Code.ensure_loaded`, or `String.to_atom` is introduced. This is a
literal vocabulary helper, not a command registration or new authority API.
A test also compares its result to the nine-name supplement.

The library contract remains: the host loads its selected application before
Wire/restore; substrate dependencies are loaded by the existing decoder/Log
paths. Change neither `Log.ensure_dump_vocabulary/0` nor its existing global
substrate list (`log.ex:357–402`). Direct callers that omit application loading
are not silently supported by warming a cutoff or codec module in the test.

Actual path-backed server startup already does the relevant trusted preload:
`Runtime.prepare` → `preflight_instance` (`runtime.ex:153–154`) →
`Holder.restore_path` (`holder.ex:314–319`) → `preload_lattice_core/0`
(`438–447`, compiled `Application.spec(:lattice_core,:modules)`) →
`Log.restore` → `validate_log`. Only then can its WebSocket relay decode a frame
(`web_socket.ex:245–248`) and call `Holder.relay`. No new Holder production loader
is proposed. Test this actual path in a fresh VM; `source: {:log, log}` is a
separate caller-owned already-built-log path and does not establish dump-loading
proof. `Log.restore/1` remains unverified deserialization; trust consumers must
still use verified restore or the actual holder validation step.

Required permanent cold-process tests, in a new
`apps/lattice_core/test/treehouse/member_continuity_vocabulary_test.exs` and a
new carrier `member_continuity_startup_test.exs`:

1. Before any codec/cutoff/trust load, selected `Code.ensure_loaded!(Space)` alone
   supplies application literals; decode the actual first signed frame, verify
   its ID/signature, accept its complete closure and assert normal refusal/state.
2. A separate fresh process loads selected Space, restores the same genuine dump
   with `restore_verified`, verifies bytes/authenticity/reasons and retained ops.
   A forged signed-op dump refuses; an unrecognized extra atom still fails safe
   restore. Do not intern that hostile atom in child script literals.
3. Fresh path-backed manifest/Holder startup with the same signed history, first
   actual relay frame, durable stop/reopen, exact retained signed ops and ordinary
   unchanged state. Use synthetic keys and task-local paths; no live provisioning.
   Assert actual readiness only after existing authenticated restore succeeds.

The old codec-explicit-load test remains valid historical slice evidence and is
not relabeled as selected-schema startup proof. The two current `/tmp` cold
controls passed as described; the proposed fix and permanent gates have not run.

## 4. Exact causal beacon context amendment

Append a dated amendment to Plan158's **Cross-runtime Application Policy
Context** clause (`plans/158-real-device-beta-poc-program-map.md:518–546`) and
record the exact adoption in the R19b implementation document before Core edits:

> Add the required read-only context field `valid_beacons` on BEAM and
> `validBeacons` on TS, containing only the existing authority judge's validated
> beacon records whose op IDs are strict ancestors of the command and included
> in this analysis. Emit every such record once, sorted ascending by op ID ASCII,
> with exactly its op ID and exact epoch. This is a projection of the already
> computed result, not a new beacon judge. Preserve existing context maps,
> callback arities, compatibility adapter, permission/holder/consent precedence
> and final conflict phase. Existing callbacks may ignore the extra field.

Exact shapes:

```elixir
%{visible_ops: existing_ops, verdicts: existing_verdicts,
  valid_beacons: [%{op_id: id, epoch: exact_nonnegative_integer}]}
```

```typescript
interface CommandOpStatusContext {
  visibleOps: ReadonlyMap<string, Op>;
  verdicts: ReadonlyMap<string, string>;
  validBeacons: readonly Readonly<{opId: string; epoch: number | string}>[];
}
```

No beacon means `[]`. A valid signed epoch zero is `{epoch: 0}`, never absence.
Include all valid causal epochs, not just the maximum, and preserve multiple
concurrent equal-epoch beacons when the command actually observes them all.
Exclude self, concurrent/future, out-of-scope, unauthorized, stale and malformed
beacon operations. Raw beacon-shaped bodies are not evidence.

BEAM integers stay exact through `18446744073709551615`. TS keeps safe numbers
unchanged and high legacy epochs as the existing canonical decimal strings;
no numeric coercion, rounding, saturation, `Math.max` over strings, or new witnessed
certificate horizon is permitted. The later continuity consumer requires a
nonempty list, compares exact epochs, selects every maximum-epoch ID and refuses
`application_continuity_invalid_epoch` if the maximum exceeds the portable claim
horizon. The context producer must retain that high evidence, not drop it.

Source changes are limited to:

- BEAM `authority.ex:1326,1350–1360`: pass existing `cap_evidence.beacons` into the
  private causal-context builder; filter by its already-computed `anc` set,
  sort by `op_id`, project `{op_id, epoch}`. Existing collection already returns
  these exact records at957–981; keep it unchanged. Update the hook documentation
  in `replica.ex:73–87` and Authority's context comment.
- TS `policy.ts:37–41`: add the required readonly field/documentation.
  `quarantine.ts:99–110`: filter `authority.security.validBeacons` by the existing
  `visibleIds`, create new record objects and a new sorted array, then pass the
  extended context. Use `cmpHash`/ASCII comparison, never `localeCompare`.
  Do not mutate or hand through the original authoritative array/record objects.
  `authority.ts:127–144,1684–1773` already has exact epoch types/validation and
  needs no new semantic path or return-shape change.

Keep a precise semantic limit: existing `verdicts` are the prior individual
verdicts at this causal walk, not newly promised final outcomes after the later
full-frontier conflict phase. Likewise, a global concurrent authority move or
lease effect may already deny the candidate at existing gates before the
application callback; adding a causal beacon field cannot rescue it. Raw
caller-provided semantic ops are not authenticated merely by calling the callback.

## 5. Public proof and ownership before enablement

The following are implementation acceptance targets, not completed results:

| Gate | Public RED and required GREEN |
| --- | --- |
| V1 exact enum | Actual signed all-nine and all-139 histories are unsupported before the union and portable afterward, in BEAM cutoff, BEAM raw trust and TS public cutoff/trust. Verify exact old/new source-list equality and both historical/new fixture hashes. |
| V2 retention/parity | Independently sign additive BEAM and TS cases; compare exact canonical cutoff records, rejected evidence, digest/frontier and both delivery orders. Include genuine and rejected same-ID evidence. Every original vector blob remains identical; old default exporter output remains identical. |
| V3 fail-closed bounds | Unknown tenth atom, detached-return-only atom, duplicate canonical map/set, invalid uint64 spelling, excessive depth, and 64,001-byte envelope continue refusing. Reuse valid 64,000/depth/high-integer controls. No rejected evidence is pruned to recover portability. |
| V4 trusted loading | Turn the reproduced selected-Space first-frame and verified-restore failures GREEN through the real selected-module load; preserve explicit-codec and unknown-atom negative controls. Exercise real path-backed startup/relay/reopen without test prewarming. |
| B1 exact causal view | Public signed BEAM `Sim` test uses a test-local Replica callback that requires the exact beacon list before honoring a normal command. Test empty, signed zero, multiple sorted IDs, earlier plus maximum records, strict ancestor inclusion, and concurrent/future exclusion. Missing field is a real RED. No production PolicyFixture vocabulary changes. |
| B2 actual TS consumer | With the later real `attest_member_key_v1` consumer, public signed Space frames → raw signature verification → semantic decoding → materialize must cover B1's same histories, no epoch, signed zero, equal maxima, wrong/stale basis and every denied-beacon class. Preserve all preexisting PolicyFixture/Space/Thread outcomes. A typecheck or hand-built context is not this public parity proof. Until that consumer lands, this part remains OPEN. |
| B3 exact high epoch | Valid root legacy MAXSAFE+1 and uint64-max strict ancestors reach context exactly; later continuity refuses invalid epoch. Unauthorized high legacy beacons do not displace a valid safe basis. Received witnessed claims remain bounded. Include two distinct high values to detect rounding and reverse order. |
| B4 compatibility | Existing application-context tests, legacy `/2` adapter, ordinary Treehouse callbacks, authority/cap/consent refusal precedence and all historical vectors remain unchanged. No caller cache or second judge is added. |

Root should reserve the shared Core writer before implementation. Suggested
bounded ownership: Core agent owns Authority/Replica and policy/quarantine,
BEAM/TS context gates; R19b agent owns selected Space literal helper, three enums,
additive fixture/support and codec-test stage disposition; retained-trust owners
review their respective raw-ingress and reopen regressions. Root owns dated
source-plan/lifecycle adoption and final export/workflow integration. Do not run
these writers concurrently on the same shared source file.

The compaction mirror is a separately owned active packet. This proposal neither
edits `test/support/compaction_spike.ex` nor asserts it supplies the new field.
Its owner must receive the exact context contract and prove actual retained
causal epoch evidence through the same judged history before R19b compaction
acceptance can close. No blanket unsupported-history shortcut or frozen-verdict
claim is adopted here. A01–A17 and native continuity/review/return behavior remain
OPEN. No full Mix, implementation or repository test edits ran for this packet.

## 6. Proposal evidence files

All are under `/tmp/lattice-treehouse-execution-20260906/`:

- `r19b-vocabulary-proposal-hashes.mjs` and matching `.log`: Node derivation and
  actual equality of all three current literals to the frozen 130 list.
- `r19b-vocabulary-independent-hashes.log`: independent Python serialization and
  SHA-256 agreement, including interleaving-order check.
- The two exact proposed JSON fixture files named in §1.
- `r19b-space-vocabulary-probe.exs` and `.log`: real signed first-frame and
  verified-restore cold-process characterization and codec-load positive control.
- `r19b-vocabulary-proposal.dump`: temporary genuine signed retained log used by
  that read-only characterization; no private signing material.

Adoption needed: the exact dated hash/union obligation, fixed Space literal
helper and additive context contract above. No additional runtime decision,
new command capability, compaction claim or generic input relaxation is implied.
