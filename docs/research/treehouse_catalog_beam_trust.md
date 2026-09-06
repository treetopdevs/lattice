# R11a BEAM retained catalog trust interface proposal

Status: adopted by the integrator on 2026-09-06 before production/test implementation.

This packet starts from `6885a25a5cae9770315b0df679ff70e5164fc126` on `codex/treehouse-r11a-beam-trust` in `/Users/nicholas/develop/lattice-treehouse-r11a-beam-trust-20260906`. It owns only a new BEAM decision module, public tests, reciprocal tests, and named test support. It adds no persistence adapter, Core verdict, command, route activation, docs, workflow, TypeScript, native, distribution, or generated-vector change.

The matching TS implementation is frozen at `d912f5b7bb296add5e9368230fd3d47b605ed711`. The BEAM interface below uses snake_case keys and atoms but preserves the TS fields and protocol values one-for-one. At the BEAM interface, public keys and signatures are raw fixed-width binaries; only the reciprocal JSON adapter converts those closed, statically named fields to canonical padded Base64. IDs remain canonical unpadded base64url text. JSON decoding uses an exact predeclared key/atom table and never creates atoms from input.

## Deep module and public interface

Create `Treehouse.CatalogTrust` with exactly three public functions:

```elixir
@spec prepare_installation(term()) :: decision()
def prepare_installation(%{
  review: review(),
  history: raw_history(),
  store: %{kind: :verified_fresh, expected: store_token()}
})

@spec evaluate(term()) :: decision()
def evaluate(%{
  installed: installed_v1(),
  expected: store_token(),
  incoming: evidence_page()
})

@spec resolve_route(term()) :: route_decision()
def resolve_route(%{decision: decision(), replica: binary()})
```

Every public object is an exact closed map. Unexpected/missing keys, wrong atoms, malformed scalar types, noncanonical IDs/Base64, unsafe integers, improper lists, duplicate indexed IDs, or inconsistent saved indexes refuse. BEAM terms are immutable; the module validates and reconstructs all retained output instead of returning caller-owned nested maps unchanged.

`resolve_route/1` never trusts a caller-edited `routes` member. It validates the complete decision/state shape and re-derives the accepted route from the signed retained graph. This rejects edits that are inconsistent with that graph; it does not and cannot prove map-issuance provenance or distinguish a fabricated value-equivalent map. The TS WeakSet is likewise only same-process misuse resistance. Neither mechanism proves installed trust. A successful route is still an installation-required candidate.

## Closed input and retained-state shapes

```elixir
@type raw_history :: %{
  replica: binary(),
  frames: [map()],
  rejected: [%{frame: map(), reason: :bad_signature}]
}

@type review :: %{
  version: 1,
  product: :treehouse,
  space: binary(),
  space_root: binary(),
  bootstrap_id: binary(),
  observed_bootstrap_ids: [binary()],
  disposition: :pin_exact_observed_bootstrap
}

@type cutoff_proof :: %{cutoff: map(), history: raw_history()}

@type evidence_page :: %{
  catalogs: [binary()],       # exact standalone CarrierTerm JSON text
  rotations: [binary()],      # exact standalone CarrierTerm JSON text
  histories: [raw_history()],
  cutoff_proofs: [cutoff_proof()]
}

@type store_token :: %{trust_revision: non_neg_integer(), history_generation: non_neg_integer()}

@type installed_v1 :: %{
  version: 1,
  review: review(),
  histories: [raw_history()],
  catalogs: [%{id: binary(), json: binary()}],
  rotations: [%{id: binary(), json: binary()}],
  cutoff_proofs: [cutoff_proof()],
  accepted: nil | %{binding: binary(), generation: non_neg_integer(), catalog: binary(), revision: non_neg_integer()},
  blocked: nil | block()
}

@type overflow_trigger :: %{
  kind: :catalog | :rotation,
  id: binary(),
  digest: binary(),
  bytes: non_neg_integer()
}

@type block :: %{
  reason: :catalog_fork | :authority_changed | :control_history_limit,
  bindings: [binary()], catalogs: [binary()], bootstrap_ids: [binary()], op_ids: [binary()],
  pending_proof_ids: [binary()], triggers: [overflow_trigger()]
}
```

All IDs/arrays use ascending raw UTF-8 byte order. Histories are unique and ordered by replica. Catalogs/rotations are unique and ordered by ID. Existing artifact JSON text remains byte-exact; alternate presentation of the same authenticated ID is idempotent and does not replace the stored original. Raw histories remain wire maps, never trusted `Op`, `Log`, authority, holder, materialized-state, signer, or route-readiness inputs.

## Decision and route shapes

```elixir
@type refusal_detail :: %{ids: [binary()], core_reason: atom() | nil, pending_proof_ids: [binary()]}

@type decision ::
  %{kind: :reject, reason: reason(), detail: refusal_detail()}
  | %{
      kind: :unchanged | :propose | :retain_blocked,
      expected: store_token(),
      next: installed_v1(),
      reason: reason() | nil,
      detail: refusal_detail(),
      replacement_configured: boolean(),
      observed: %{
        bootstrap_ids: [binary()],
        binding_heads: [binary()],
        catalog_heads: [%{binding: binary(), catalogs: [binary()]}]
      },
      routes: [verified_route()]
    }

@type verified_route :: %{
  replica: binary(), kind: :space | :thread,
  schema: :treehouse_space_v1 | :treehouse_thread_v1,
  root: binary(), genesis: binary(), creation: binary(), reference: binary(),
  binding: binary(), catalog: binary(), revision: non_neg_integer(),
  origin: binary(), path: binary(), url: binary(),
  service_id: binary(), service_key: binary(), realm: binary()
}

@type route_decision ::
  %{ok: true, candidate: verified_route(), installation_required: true}
  | %{ok: false, reason: reason() | :thread_not_authorized | :thread_unavailable}
```

`replacement_configured` means only that the currently authenticated continuation profile still equals the pinned bootstrap profile. It proves no acquisition ceiling, live holder, epoch, possession, persistence, readiness, or replacement authorization.

## Raw-history adapter and precedence

The module privately decodes each raw carrier frame with `Lattice.Carrier.Wire.decode_op/1`; it never accepts a prebuilt `%Op{}` or `%Log{}` at the interface. It verifies all supplied accepted/rejected frames in every installed and incoming history before classifying missing closure:

1. Decode the complete raw page and reject malformed closed shapes. The adapter uses only the existing fixed raw CarrierTerm grammar and its compiled atom vocabulary; it never creates an atom or changes the global decoder.
2. For every representable accepted frame, require exact replica, unique supplied ID, correct payload hash and valid signature independently of dependency availability. This raw hash/signature pass occurs before semantic kind support is considered, so a representable forged unsupported-kind frame is `:invalid_verified_history`, while an authentic unsupported kind is `:unsupported_cutoff`.
3. For every representable rejected frame, require the same replica, exact `:bad_signature`, uniqueness within the rejected list, and an actual hash/signature failure. A genuine accepted frame and rejected evidence may share one supplied ID because they remain separate lists. Malformed or unknown-atom evidence that the fixed decoder cannot represent is `:unsupported_cutoff` only when there is no independently representable forgery elsewhere in the supplied histories; a representable forgery has precedence in either input order.
4. Merge same-replica histories deterministically. Byte-identical accepted replay is idempotent; conflicting accepted frames under one ID refuse `:invalid_verified_history`. Installed history is never repaired from incoming input.
5. Only after every representable frame in every history authenticates, classify missing accepted dependencies as `:trust_pending` for incoming history. Missing/corrupt saved closure is `:trust_recovery_required`.
6. Build a complete `%Lattice.Log{}` privately, retain validated rejected evidence, and call `CatalogCutoff.derive/1`, `CatalogBootstrap.observe/1`, `Authority.continuation_profile/1`, and `CatalogEntries.observe/2`. `CatalogEntries` continues to receive only complete R06-valid logs and keeps its strict incomplete-Log refusal unchanged. Unsupported but authentic/validated raw evidence is `:unsupported_cutoff`; a representable forgery anywhere wins over pending/unsupported evidence. No unsupported-kind value is authenticated merely because `Wire.decode_op/1` parsed it: the adapter explicitly verifies payload hash/signature first and only then applies the fixed cutoff/semantic support classification.

The original installed snapshot is validated in isolation before forming any incoming union, overflow decision, or durable-freeze return. Reconstruct its complete authenticated catalog/rotation graph, exact cutoff proofs, raw-history closure, watermark, and blocked/index coherence. Any original failure is `:trust_recovery_required`; incoming evidence cannot repair it, and an existing durable block cannot mask it. Only after that succeeds, authenticate the incoming union. Bootstrap/reference reclassification and established forks then block old-route use before a malformed new candidate can mask the security event. This ordering records the concrete P1 found by the independent Sol review of TS d912; TS repair and BEAM parity tests must cover saved corruption under both fork and overflow freezes.

## Artifact parsing, graphs, and transitions

- Parse no more than 32 incoming catalog+rotation artifacts per page. Each artifact is at most 131,072 UTF-8 bytes and remains exact JSON text. A private strict raw CarrierTerm walker rejects duplicate/unknown map fields, noncanonical Base64, unsafe integers, or depth beyond 64 before calling `Wire.decode_value/1` and the existing `TransportCatalog` normalizers.
- Catalog IDs, rotation IDs, inventory digests, catalog signatures, old-key signatures, and new-key possession signatures use only existing `TransportCatalog` functions/domains. Signer keys come from the reviewed bootstrap/binding graph, never caller input.
- Binding 0 is the reviewed bootstrap command ID, generation 0, with the bootstrap catalog key. A rotation requires exact known parent, generation+1 within the safe horizon, exact parent tip/inventory/cutoff replica set, different catalog/service keys, both signatures, no known competing head, and a first new-binding catalog at revision 0 with `previous:nil` and the frozen inventory.
- Per binding, revision 0 requires `previous:nil`; later revisions require an existing same-binding predecessor at revision-1. Missing predecessors are pending. Wrong binding/revision/digest or skip is invalid. An earlier prefix cannot lower `accepted`.
- Inventory may append through the codec ceiling but never delete or alter a listed replica's root/genesis/creation/reference tuple. Route reservations are re-derived across every authenticated proof-valid catalog in every retained binding/branch; no route can move to a different replica.
- A signed sibling catalog or second binding child freezes as `:catalog_fork` in either order. A third unresolved binding head is retained and freezes as `:control_history_limit`. Neither arrival order nor maximum revision/generation chooses a winner.
- Each rotation cutoff must match an immutable exact `cutoff_proof` derived from its historical raw history and be included in the complete current union. Later ordinary operations do not change the historical proof digest. Missing proof is `:recovery_incomplete`; unsupported retained bytes remain `:unsupported_cutoff`.
- Catalog entry proof uses `CatalogEntries.observe/2`. Missing child/reference proof retains the authenticated catalog as pending, preserves the old watermark, and exposes no new route. Invalid available proof is `:invalid_catalog_transition`.

## Retention limits and overflow

The aggregate accepts at most 1,024 distinct catalog/rotation IDs and 16 MiB of their retained original UTF-8 JSON, inclusive. Duplicate IDs do not consume capacity. Before admission, every in-scope artifact is parsed and authenticated against its graph so an invalid record cannot consume budget or poison reservations.

If the next authenticated artifact would exceed either aggregate limit, return `:retain_blocked` with reason `:control_history_limit`; preserve the entire prior artifact set and watermark, admit none of the over-limit artifact, expose no routes, and record exactly one trigger containing kind, authenticated ID, SHA-256 base64url digest of the original JSON bytes, and byte count. The operator retains the unaccepted incoming bytes outside this state. No eviction, reset, compaction, or automatic unfreeze interface is added.

## Refusal vocabulary and order

Public reasons are exactly:

`malformed_catalog`, `control_history_limit`, `wrong_catalog_scope`, `trust_pending`, `invalid_catalog_signature`, `invalid_possession`, `catalog_authority_refused`, `invalid_catalog_transition`, `catalog_rollback`, `catalog_fork`, `recovery_incomplete`, `carrier_pending`, `authority_changed`, `invalid_verified_history`, `unsupported_cutoff`, `trust_recovery_required`, `stale_trust_snapshot`, `trust_persistence_failed`.

Adapter-only reasons stay in the shared vocabulary for closed durable handoff but this pure module never manufactures successful freshness, CAS, persistence, or carrier-readiness evidence. Within a candidate: malformed/bounds; pinned scope; closure; signature/possession; current Core verdict; transition; rollback/fork; cutoff; carrier. Established security events from the complete verified union take precedence over a malformed new candidate when deciding whether old routes remain exposed.

Details are always `%{ids: [...], core_reason: atom_or_nil, pending_proof_ids: [...]}` and contain only public IDs and an actual existing Core reason.

## Test and reciprocal ownership after adoption

Create only:

- `apps/lattice_core/lib/treehouse/catalog_trust.ex`
- `apps/lattice_core/test/treehouse/catalog_trust_test.exs`
- `apps/lattice_core/test/treehouse/catalog_trust_reciprocal_test.exs`
- `apps/lattice_core/test/support/treehouse_catalog_trust_vectors.ex`

Public tests use actual signed Space/Thread logs through raw `Wire.encode_op/1`, real catalog/rotation signatures, complete/incomplete/corrupt history, siblings in both orders, historical cutoffs, 13-entry ceiling, 1,024-artifact and 16 MiB boundaries, route-history locks, closed state/input maps, and immutable caller terms. RED must fail through these public functions before implementation.

Reciprocal support reads the TS fixture `clients/lattice-client/test/vectors/catalog/ts_trust.json` after integration and compares preparation, first catalog, rotation, fork/reversed-order summaries, exact artifact IDs/bytes, cutoff records/digests, and routes. The BEAM exporter evidence script stays under `/tmp/lattice-treehouse-execution-20260906`; it writes `/tmp/lattice-treehouse-execution-20260906/r11a-beam-trust-public.json` for the TS reciprocal gate. No production exporter, index, package, workflow, docs, dist, vector, native, or Core file is owned here. The named test support may emit a fresh BEAM fixture under the test-owned temporary directory so the reciprocal release gate never depends on a developer /tmp artifact or a copied expected result.

Current TS fixture SHA-256 supplied by the TS lane: `84f75a5378696b77208b47346bae0a4d55d7d2558cf2ee6d646393c50a1f0c39`. The BEAM reciprocal test must pin that digest when the fixture is integrated; until then the test support may consume the identical temporary proof only for local RED/GREEN evidence, never as a release dependency.

## Explicit nonclaims

Pure `:propose` does not install trust or authorize route use. This packet does not close C03, C14, any C01-C15 row, native restart/CAS/durability, carrier readiness, provisioning, lost-key replacement, same-key encrypted restore, device/WSS/reboot evidence, or absence of withheld remote history.
