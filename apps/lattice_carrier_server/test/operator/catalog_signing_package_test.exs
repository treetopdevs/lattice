defmodule LatticeCarrierServer.Operator.CatalogSigningPackageTest do
  use ExUnit.Case, async: false
  alias Lattice.{Authority, Log, Sim}

  alias LatticeCarrierServer.Operator.{
    CatalogBinding,
    CatalogSigningPackage,
    CeremonyFixture,
    Fixture,
    PublicHistory
  }

  setup do
    {:ok, fixture} = Fixture.new(second_member: true)
    space = fixture[:updated_log]
    child = Sim.log(fixture[:child], "creator")
    {:ok, binding} = CatalogBinding.load_log(fixture[:ceremony_dir], space)

    entries =
      for {log, kind, schema, reference, route} <- [
            {space, :space, :treehouse_space_v1, binding.bootstrap_id, fixture[:space_route]},
            {child, :thread, :treehouse_thread_v1, fixture[:reference].id, fixture[:child_route]}
          ] do
        command = if kind == :space, do: :create_space, else: :create_thread
        genesis = Enum.find(Map.values(log.ops), &(&1.kind == :authority and &1.deps == []))
        creation = Enum.find(Map.values(log.ops), &match?(%{body: {^command, [_]}}, &1))

        %{
          product: :treehouse,
          replica: log.replica,
          kind: kind,
          schema: schema,
          root: Authority.root(log),
          genesis: genesis.id,
          creation: creation.id,
          reference: reference,
          route: route,
          service_id: binding.record.service_id,
          service_key: binding.record.service_key
        }
      end

    catalog = %{
      version: 1,
      product: :treehouse,
      space: space.replica,
      bootstrap: binding.bootstrap_id,
      binding: binding.bootstrap_id,
      revision: 0,
      previous: nil,
      entries: Enum.sort_by(entries, & &1.replica)
    }

    {:ok,
     fixture: fixture,
     catalog: catalog,
     histories: %{space.replica => space, child.replica => child}}
  end

  test "initial reference is independently reviewed against the custodian ceremony", f do
    assert {:ok, bytes} = encode(f)
    assert {:ok, package} = CatalogSigningPackage.review(bytes, f.fixture[:ceremony_dir])
    assert package.catalog == f.catalog
    assert package.histories == f.histories
    assert package.observed == f.histories
    assert package.reference == f.fixture[:reference]
    assert package.binding.bootstrap_id == f.catalog.bootstrap
  end

  test "pending reference is hypothetical and does not modify the supplied Space", f do
    reference = f.fixture[:reference]
    space = f.histories[f.catalog.space]

    histories =
      Map.put(
        f.histories,
        space.replica,
        Log.from_ops(space.replica, Map.delete(space.ops, reference.id))
      )

    assert :ok = Log.verify_authenticity(histories[space.replica])
    assert {:ok, bytes} = CatalogSigningPackage.encode(f.catalog, histories, reference, "pending")
    assert {:ok, package} = CatalogSigningPackage.decode(bytes)
    refute Map.has_key?(package.histories[space.replica].ops, reference.id)
    assert package.observed == f.histories

    assert {:error, :invalid_catalog_package} =
             CatalogSigningPackage.encode(f.catalog, f.histories, reference, "pending")
  end

  test "closed canonical package refuses malformed and incomplete public evidence", f do
    {:ok, bytes} = encode(f)
    doc = JSON.decode!(bytes)
    [first | rest] = doc["histories"]
    [frame | frames] = first["frames"]
    bad = %{first | "frames" => [Map.put(frame, "sig", Base.encode64(<<0::512>>)) | frames]}

    for changed <- [
          Map.put(doc, "trusted", true),
          Map.put(doc, "digest", String.duplicate("0", 64)),
          Map.put(doc, "histories", rest),
          Map.put(doc, "histories", [first | doc["histories"]]),
          Map.put(doc, "histories", [bad | rest]),
          Map.put(doc, "reference", Map.put(doc["reference"], "mode", "listed"))
        ] do
      assert {:error, :invalid_catalog_package} =
               changed |> PublicHistory.canonical() |> CatalogSigningPackage.decode()
    end

    for altered <- [
          " " <> bytes,
          <<255>>,
          String.replace(bytes, "{", "{\"trusted\":true,", global: false)
        ] do
      assert {:error, :invalid_catalog_package} = CatalogSigningPackage.decode(altered)
    end
  end

  test "catalog metadata cannot replace the actual creation or independent root", f do
    thread = Enum.find(f.catalog.entries, &(&1.kind == :thread))

    for change <- [
          %{root: Authority.root(f.histories[f.catalog.space])},
          %{creation: thread.genesis}
        ] do
      catalog = %{
        f.catalog
        | entries:
            Enum.map(f.catalog.entries, fn entry ->
              if entry.kind == :thread, do: Map.merge(entry, change), else: entry
            end)
      }

      assert {:error, :invalid_catalog_package} = encode(%{f | catalog: catalog})
    end
  end

  test "a missing custodian ceremony cannot establish the package's binding", f do
    {:ok, bytes} = encode(f)

    assert {:error, _} =
             CatalogSigningPackage.review(bytes, f.fixture[:ceremony_dir] <> "/missing")
  end

  test "a different completed ceremony refuses despite valid public histories", f do
    {:ok, bytes} = encode(f)
    base = Path.join(System.tmp_dir!(), "catalog-other-#{System.unique_integer([:positive])}")
    on_exit(fn -> File.rm_rf!(base) end)
    other = CeremonyFixture.build(base)
    assert {:error, _} = CatalogSigningPackage.review(bytes, other.ceremony)
  end

  test "duplicate envelope keys and oversized public input refuse", f do
    {:ok, bytes} = encode(f)

    duplicate =
      ~s({"format":"treehouse-catalog-signing-v1",) <>
        binary_part(bytes, 1, byte_size(bytes) - 1)

    assert {:error, :invalid_catalog_package} = CatalogSigningPackage.decode(duplicate)

    assert {:error, :invalid_catalog_package} =
             CatalogSigningPackage.decode(:binary.copy(" ", 64 * 1024 * 1024 + 1))
  end

  defp encode(f),
    do:
      CatalogSigningPackage.encode(
        f.catalog,
        f.histories,
        f.fixture[:reference],
        "initial_existing"
      )
end
