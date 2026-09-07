defmodule Treehouse.CatalogTrustReciprocalTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogTrust, CatalogTrustVectors, TransportCatalog}

  @expected %{trust_revision: 0, history_generation: 0}
  @fixture_sha "64688429c8306d83c4d3236743dceffb6348278ccdca51bbaaa0644af8e88036"

  @tag :tmp_dir
  test "named support emits a self-contained public BEAM reciprocal fixture", %{tmp_dir: tmp_dir} do
    path = Path.join(tmp_dir, "beam_trust.json")
    vector = CatalogTrustVectors.write_public_fixture!(path)
    assert File.exists?(path)
    assert Jason.decode!(File.read!(path))["expected"]["catalogId"] == vector.expected.catalogId
    refute File.read!(path) =~ "private"
    refute File.read!(path) =~ "seed"
  end

  test "TS fixture matches BEAM bytes, IDs, cutoffs and public decisions in both input orders" do
    path =
      System.get_env("TREEHOUSE_TS_TRUST_VECTOR") ||
        Path.expand(
          "../../../../clients/lattice-client/test/vectors/catalog/ts_trust.json",
          __DIR__
        )

    assert File.regular?(path), "integrated TS trust fixture is required"
    sha = :crypto.hash(:sha256, File.read!(path)) |> Base.encode16(case: :lower)
    assert sha == @fixture_sha
    fixture = CatalogTrustVectors.read_ts_fixture!(path)
    {:ok, catalog_envelope} = decode_artifact(fixture.catalog_json)
    {:ok, rotation_envelope} = decode_artifact(fixture.rotation_json)
    {:ok, rotated_envelope} = decode_artifact(fixture.rotated_catalog_json)

    assert TransportCatalog.catalog_id(catalog_envelope.catalog) == fixture.expected["catalogId"]
    assert TransportCatalog.rotation_id(rotation_envelope) == fixture.expected["rotationId"]

    assert TransportCatalog.catalog_id(rotated_envelope.catalog) ==
             fixture.expected["rotationObservation"]["accepted"]["catalog"]

    assert Base.encode64(TransportCatalog.catalog_bytes(catalog_envelope.catalog)) ==
             fixture.expected["catalogBytes"]

    assert Base.encode64(TransportCatalog.rotation_bytes(rotation_envelope.rotation)) ==
             fixture.expected["rotationBytes"]

    assert Base.encode64(TransportCatalog.rotation_possession_bytes(rotation_envelope.rotation)) ==
             fixture.expected["possessionBytes"]

    for reverse <- [false, true] do
      histories = if reverse, do: reverse_histories(fixture.histories), else: fixture.histories
      space_history = Enum.find(histories, &(&1.replica == fixture.review.space))

      assert %{kind: :propose, next: prepared} =
               CatalogTrust.prepare_installation(%{
                 review: fixture.review,
                 history: space_history,
                 store: %{kind: :verified_fresh, expected: @expected}
               })

      assert %{kind: :propose, reason: nil, next: initial, routes: initial_routes} =
               evaluate(prepared, catalogs: [fixture.catalog_json], histories: histories)

      assert initial.accepted.catalog == fixture.expected["catalogId"]

      assert route_projection(initial_routes) ==
               entry_projection(catalog_envelope.catalog.entries)

      assert %{kind: :propose, reason: nil, next: rotated, routes: rotated_routes} =
               evaluate(initial,
                 catalogs: [fixture.rotated_catalog_json],
                 rotations: [fixture.rotation_json],
                 cutoff_proofs: fixture.cutoff_proofs
               )

      assert rotated.accepted.catalog ==
               fixture.expected["rotationObservation"]["accepted"]["catalog"]

      assert route_projection(rotated_routes) ==
               entry_projection(rotated_envelope.catalog.entries)

      if fixture.fork_catalog_json do
        assert %{kind: :retain_blocked, reason: :catalog_fork, routes: []} =
                 evaluate(rotated, catalogs: [fixture.fork_catalog_json])
      end
    end
  end

  defp evaluate(installed, incoming) do
    incoming = Map.new(incoming)

    CatalogTrust.evaluate(%{
      installed: installed,
      expected: @expected,
      incoming: %{
        catalogs: Map.get(incoming, :catalogs, []),
        rotations: Map.get(incoming, :rotations, []),
        histories: Map.get(incoming, :histories, []),
        cutoff_proofs: Map.get(incoming, :cutoff_proofs, [])
      }
    })
  end

  defp decode_artifact(json) do
    with {:ok, raw} <- Jason.decode(json), do: Wire.decode_value(raw)
  end

  defp reverse_histories(histories) do
    histories
    |> Enum.reverse()
    |> Enum.map(&%{&1 | frames: Enum.reverse(&1.frames), rejected: Enum.reverse(&1.rejected)})
  end

  defp route_projection(routes) do
    routes
    |> Enum.map(
      &Map.take(&1, [
        :replica,
        :root,
        :genesis,
        :creation,
        :reference,
        :service_id,
        :service_key,
        :path,
        :schema,
        :kind
      ])
    )
    |> Enum.sort_by(& &1.replica)
  end

  defp entry_projection(entries) do
    entries
    |> Enum.map(fn entry ->
      entry
      |> Map.take([
        :replica,
        :root,
        :genesis,
        :creation,
        :reference,
        :service_id,
        :service_key,
        :schema,
        :kind
      ])
      |> Map.put(:path, entry.route)
    end)
    |> Enum.sort_by(& &1.replica)
  end
end
