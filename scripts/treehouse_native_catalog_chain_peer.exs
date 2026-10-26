# Independently signed BEAM producer. Expected decisions come from CatalogTrust;
# structural links are decoded only from evidence retained by that public owner.
alias Treehouse.{CatalogTrust, CatalogTrustVectors, TransportCatalog}
Code.ensure_loaded!(CatalogTrustVectors)
f = CatalogTrustVectors.fixture(2)
expected = %{trust_revision: 0, history_generation: 0}

%{kind: :propose, next: initial} =
  CatalogTrust.prepare_installation(%{
    review: f.review,
    history: hd(f.histories),
    store: %{kind: :verified_fresh, expected: expected}
  })

cat = fn c, signer ->
  CatalogTrustVectors.artifact_json(CatalogTrustVectors.sign_catalog(c, signer))
end

rid = TransportCatalog.rotation_id(f.rotation_envelope)
one = %{f.catalog | revision: 1, previous: TransportCatalog.catalog_id(f.catalog)}
two = %{one | revision: 2, previous: TransportCatalog.catalog_id(one)}
rotated = %{f.catalog | binding: rid}

back = %{
  f.rotation
  | parent: rid,
    prior_catalog: TransportCatalog.catalog_id(rotated),
    generation: 2,
    new_catalog_key: f.space.catalog.pub
}

back_envelope = CatalogTrustVectors.sign_rotation(back, f.next_catalog, f.space.catalog)
back_catalog = %{f.catalog | binding: TransportCatalog.rotation_id(back_envelope)}

sibling = %{
  one
  | entries:
      Enum.map(
        one.entries,
        &%{&1 | route: "/r/" <> CatalogTrustVectors.id("sibling-#{&1.replica}")}
      )
}

noop = %{f.rotation | new_catalog_key: f.space.catalog.pub}
noop_envelope = CatalogTrustVectors.sign_rotation(noop, f.space.catalog, f.space.catalog)
noop_catalog = %{f.catalog | binding: TransportCatalog.rotation_id(noop_envelope)}

base = [
  {"beam-initial", [f.catalog_json], []},
  {"beam-linear-revisions",
   [cat.(two, f.space.catalog), f.catalog_json, cat.(one, f.space.catalog)], []},
  {"beam-identical-retry", [f.catalog_json, f.catalog_json], []},
  {"beam-revision-gap", [f.catalog_json, cat.(%{one | revision: 2}, f.space.catalog)], []},
  {"beam-missing-predecessor",
   [cat.(%{one | previous: CatalogTrustVectors.id("absent")}, f.space.catalog)], []},
  {"beam-inventory-shrink",
   [
     f.catalog_json,
     cat.(%{one | entries: Enum.filter(one.entries, &(&1.kind == :space))}, f.space.catalog)
   ], []},
  {"beam-rotation", [f.catalog_json, cat.(rotated, f.next_catalog)], [f.rotation_json]},
  {"beam-authorized-ancestor-return",
   [cat.(back_catalog, f.space.catalog), f.catalog_json, cat.(rotated, f.next_catalog)],
   [CatalogTrustVectors.artifact_json(back_envelope), f.rotation_json]},
  {"beam-same-key", [f.catalog_json, cat.(noop_catalog, f.space.catalog)],
   [CatalogTrustVectors.artifact_json(noop_envelope)]},
  {"beam-same-key-rotation-only", [f.catalog_json],
   [CatalogTrustVectors.artifact_json(noop_envelope)]},
  {"beam-catalog-siblings",
   [f.catalog_json, cat.(one, f.space.catalog), cat.(sibling, f.space.catalog)], []}
]

corrupt_catalog = fn catalog ->
  catalog
  |> CatalogTrustVectors.sign_catalog(f.space.catalog)
  |> Map.put(:signature, <<0::512>>)
  |> CatalogTrustVectors.artifact_json()
end

rotation_case = fn name, record, mode, reason ->
  signer = if mode == :service, do: f.space.service, else: f.next_catalog
  envelope = CatalogTrustVectors.sign_rotation(record, f.space.catalog, signer)

  envelope =
    case mode do
      :old_forged -> %{envelope | old_signature: <<0::512>>}
      :new_forged -> %{envelope | new_signature: <<0::512>>}
      _ -> envelope
    end

  catalog = %{f.catalog | binding: TransportCatalog.rotation_id(envelope)}

  {name, [f.catalog_json, cat.(catalog, signer)], [CatalogTrustVectors.artifact_json(envelope)],
   reason}
end

wrong_bootstrap = CatalogTrustVectors.id("wrong-bootstrap")

extra = [
  {"beam-scope-before-signature-conflict",
   [
     f.catalog_json,
     corrupt_catalog.(f.catalog),
     cat.(
       %{
         f.catalog
         | bootstrap: wrong_bootstrap,
           entries:
             Enum.map(f.catalog.entries, fn e ->
               if e.kind == :space, do: %{e | reference: wrong_bootstrap}, else: e
             end)
       },
       f.space.catalog
     )
   ], [], :wrong_catalog_scope},
  {"beam-signature-conflict", [f.catalog_json, corrupt_catalog.(f.catalog)], [],
   :invalid_catalog_signature},
  {"beam-forgery-before-missing",
   [corrupt_catalog.(%{one | previous: CatalogTrustVectors.id("absent")})], [],
   :invalid_catalog_signature},
  {"beam-wrong-service",
   [
     cat.(
       %{
         f.catalog
         | entries:
             Enum.map(
               f.catalog.entries,
               &%{&1 | service_id: CatalogTrustVectors.id("other-service")}
             )
       },
       f.space.catalog
     )
   ], [], :wrong_catalog_scope},
  {"beam-wrong-service-key",
   [
     cat.(
       %{
         f.catalog
         | entries: Enum.map(f.catalog.entries, &%{&1 | service_key: f.next_catalog.pub})
       },
       f.space.catalog
     )
   ], [], :wrong_catalog_scope},
  {"beam-wrong-bootstrap",
   [
     cat.(
       %{
         f.catalog
         | bootstrap: wrong_bootstrap,
           entries:
             Enum.map(f.catalog.entries, fn e ->
               if e.kind == :space, do: %{e | reference: wrong_bootstrap}, else: e
             end)
       },
       f.space.catalog
     )
   ], [], :wrong_catalog_scope},
  {"beam-previous-other-binding",
   [
     f.catalog_json,
     cat.(
       %{rotated | revision: 1, previous: TransportCatalog.catalog_id(f.catalog)},
       f.next_catalog
     )
   ], [f.rotation_json], :invalid_catalog_transition},
  {"beam-rotated-initial-inventory",
   [
     f.catalog_json,
     cat.(
       %{rotated | entries: Enum.filter(rotated.entries, &(&1.kind == :space))},
       f.next_catalog
     )
   ], [f.rotation_json], :invalid_catalog_transition},
  {"beam-rotated-revision",
   [
     f.catalog_json,
     cat.(rotated, f.next_catalog),
     cat.(
       %{rotated | revision: 1, previous: TransportCatalog.catalog_id(rotated)},
       f.next_catalog
     )
   ], [f.rotation_json], nil},
  rotation_case.(
    "beam-rotation-wrong-space",
    %{f.rotation | space: hd(f.threads).replica},
    :normal,
    :wrong_catalog_scope
  ),
  rotation_case.(
    "beam-rotation-wrong-bootstrap",
    %{f.rotation | bootstrap: wrong_bootstrap},
    :normal,
    :wrong_catalog_scope
  ),
  rotation_case.(
    "beam-rotation-generation-gap",
    %{f.rotation | generation: 2},
    :normal,
    :invalid_catalog_transition
  ),
  rotation_case.(
    "beam-rotation-missing-parent",
    %{f.rotation | parent: CatalogTrustVectors.id("absent")},
    :normal,
    :trust_pending
  ),
  rotation_case.(
    "beam-rotation-old-forgery",
    f.rotation,
    :old_forged,
    :invalid_catalog_signature
  ),
  rotation_case.(
    "beam-rotation-possession-forgery",
    f.rotation,
    :new_forged,
    :invalid_possession
  ),
  rotation_case.(
    "beam-rotation-inventory",
    %{f.rotation | inventory_digest: CatalogTrustVectors.id("other-inventory")},
    :normal,
    :invalid_catalog_transition
  ),
  rotation_case.(
    "beam-rotation-cutoff-replicas",
    %{f.rotation | cutoffs: Enum.take(f.rotation.cutoffs, 1)},
    :normal,
    :invalid_catalog_transition
  ),
  rotation_case.(
    "beam-rotation-service-key",
    %{f.rotation | new_catalog_key: f.space.service.pub},
    :service,
    :invalid_catalog_transition
  )
]

extra_reasons = Map.new(extra, fn {name, _, _, reason} -> {name, reason} end)

base =
  base ++ Enum.map(extra, fn {name, catalogs, rotations, _} -> {name, catalogs, rotations} end)

cases =
  Enum.map(base, fn {name, catalogs, rotations} ->
    decision =
      CatalogTrust.evaluate(%{
        installed: initial,
        expected: expected,
        incoming: %{
          catalogs: catalogs,
          rotations: rotations,
          histories: f.histories,
          cutoff_proofs: f.cutoff_proofs
        }
      })

    expected_reason =
      %{
        "beam-revision-gap" => :invalid_catalog_transition,
        "beam-missing-predecessor" => :trust_pending,
        "beam-inventory-shrink" => :invalid_catalog_transition,
        "beam-same-key" => :invalid_catalog_transition,
        "beam-same-key-rotation-only" => :invalid_catalog_transition,
        "beam-catalog-siblings" => :catalog_fork
      }
      |> Map.merge(extra_reasons)
      |> Map.get(name)

    true = decision.reason == expected_reason

    case expected_reason do
      nil ->
        true = decision.kind == :propose
        true = length(decision.routes) == 3

        generation =
          if name == "beam-authorized-ancestor-return",
            do: 2,
            else: if(name in ["beam-rotation", "beam-rotated-revision"], do: 1, else: 0)

        true = decision.next.accepted.generation == generation

      :catalog_fork ->
        true = decision.kind == :retain_blocked
        true = decision.routes == []

      _ ->
        true = decision.kind == :reject
    end

    result = Map.take(decision, [:kind, :reason, :detail])
    item = %{name: name, catalogs: catalogs, rotations: rotations, result: result}

    if decision.kind == :reject do
      item
    else
      bindings =
        Map.new(decision.next.rotations, fn record ->
          {:ok, %{rotation: r}} = Lattice.Carrier.Wire.decode_value(Jason.decode!(record.json))

          {record.id,
           %{
             generation: r.generation,
             key: :binary.bin_to_list(r.new_catalog_key),
             parent: r.parent,
             prior: r.prior_catalog,
             inventory: r.inventory_digest
           }}
        end)
        |> Map.put(f.space.bootstrap.id, %{
          generation: 0,
          key: :binary.bin_to_list(f.space.catalog.pub),
          parent: nil,
          prior: nil,
          inventory: nil
        })

      decoded =
        Enum.map(decision.next.catalogs, fn record ->
          {:ok, %{catalog: c}} = TransportCatalog.decode_catalog_json(record.json)
          {record.id, c}
        end)

      links =
        Map.new(decoded, fn {id, c} -> {id, Map.take(c, [:binding, :revision, :previous])} end)

      heads = Map.new(decision.observed.catalog_heads, &{&1.binding, &1.catalogs})

      if decision.next.accepted do
        accepted = decision.next.accepted
        true = bindings[accepted.binding].generation == accepted.generation
      end

      Map.put(item, :links, %{
        bindings: bindings,
        catalogs: links,
        catalog_heads: heads,
        binding_heads: decision.observed.binding_heads
      })
    end
  end)

IO.puts(Jason.encode!(%{bootstrapCatalog: f.catalog_json, histories: f.histories, cases: cases}))
