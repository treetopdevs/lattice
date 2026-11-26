defmodule Treehouse.CatalogArtifactBudgetTest do
  @moduledoc "Rows 355, 525: the authoring preflight's mirror of CatalogTrust's artifact budgets."
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogArtifactBudget, CatalogArtifactBudgetVectors, CatalogJSON}
  alias Treehouse.TransportCatalog

  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @vector Path.join(@client, "test/vectors/catalog/artifact_budget_v1.json")

  # Wire.decode_value/1 admits only existing atoms; loading TransportCatalog creates the
  # envelope field atoms, so the vector decodes whichever test runs first.
  setup_all do
    Code.ensure_loaded!(Treehouse.TransportCatalog)
    :ok
  end

  test "BEAM-written artifact_budget_v1.json equals regeneration" do
    assert File.read!(@vector) ==
             CatalogArtifactBudgetVectors.encode(CatalogArtifactBudgetVectors.vector())
  end

  test "vector envelopes measure to their recorded bytes and budgets keep their verdicts" do
    vector = @vector |> File.read!() |> Jason.decode!()

    assert vector["limits"] == %{
             "max_artifacts" => CatalogArtifactBudget.max_artifacts(),
             "max_artifact_bytes" => CatalogArtifactBudget.max_artifact_bytes(),
             "max_total_bytes" => CatalogArtifactBudget.max_total_bytes()
           }

    assert Enum.map(vector["envelopes"], & &1["kind"]) == ["catalog", "rotation", "catalog"]

    for %{"kind" => kind, "term" => term, "bytes" => bytes} <- vector["envelopes"] do
      assert {:ok, envelope} = Wire.decode_value(term)

      case kind do
        "catalog" -> assert {:ok, _} = TransportCatalog.normalize_catalog(envelope.catalog)
        "rotation" -> assert {:ok, _} = TransportCatalog.normalize_rotation(envelope.rotation)
      end

      assert CatalogArtifactBudget.artifact_json_bytes(envelope) == bytes
    end

    for %{"name" => name, "sizes" => sizes, "verdict" => verdict} <- vector["budgets"] do
      expected = if verdict == "ok", do: :ok, else: {:error, String.to_existing_atom(verdict)}

      assert CatalogArtifactBudget.check(CatalogArtifactBudgetVectors.expand(sizes)) == expected,
             name
    end

    assert Enum.map(vector["budgets"], &{&1["name"], &1["verdict"]}) == [
             {"empty", "ok"},
             {"one at the artifact limit", "ok"},
             {"one over the artifact limit", "control_history_limit"},
             {"total at the limit", "ok"},
             {"total over the limit", "control_history_limit"},
             {"count at the limit", "ok"},
             {"count over the limit", "control_history_limit"}
           ]
  end

  test "the per-artifact limit matches the verifier's JSON decoders" do
    max = CatalogArtifactBudget.max_artifact_bytes()
    over = String.duplicate(" ", max + 1)
    exact = "[0]" <> String.duplicate(" ", max - 3)

    assert {:error, :control_history_limit} = CatalogJSON.decode(over)
    assert {:error, :control_history_limit} = TransportCatalog.decode_catalog_json(over)
    assert {:ok, [0]} = CatalogJSON.decode(exact)
    assert {:error, :malformed_catalog} = TransportCatalog.decode_catalog_json(exact)
  end

  test "a size list fails closed unless every size is a non-negative integer" do
    max = CatalogArtifactBudget.max_artifact_bytes()
    full = List.duplicate(max, 128)

    for sizes <- [
          [:bad],
          [1.0],
          [-1],
          [-max | full],
          full ++ [nil],
          [1 | :bad],
          :not_a_list
        ] do
      assert CatalogArtifactBudget.check(sizes) == {:error, :control_history_limit},
             inspect(sizes, limit: 3)
    end

    assert CatalogArtifactBudget.check(full) == :ok
  end

  test "an envelope that does not normalize measures over the per-artifact limit" do
    over = CatalogArtifactBudget.max_artifact_bytes() + 1
    vector = @vector |> File.read!() |> Jason.decode!()

    [catalog, rotation | _] =
      for e <- vector["envelopes"], do: elem(Wire.decode_value(e["term"]), 1)

    for envelope <- [
          %{catalog: nil},
          %{catalog: 1.0},
          %{catalog: catalog.catalog, signature: make_ref()},
          %{catalog | signature: <<0::8>>},
          Map.put(catalog, :extra, 1),
          %{rotation | old_signature: self()},
          %{rotation | rotation: %{rotation.rotation | version: -1}},
          %{rotation | rotation: %{rotation.rotation | version: 1.0}},
          %{catalog | catalog: %{catalog.catalog | version: 1.0}},
          nil
        ] do
      assert CatalogArtifactBudget.artifact_json_bytes(envelope) == over
    end

    assert CatalogArtifactBudget.check_envelopes([%{catalog: nil}]) ==
             {:error, :control_history_limit}

    for envelopes <- [[catalog | :bad], [nil | :bad], :not_a_list] do
      assert CatalogArtifactBudget.check_envelopes(envelopes) ==
               {:error, :control_history_limit}
    end

    assert CatalogArtifactBudget.check_envelopes([catalog, rotation]) == :ok
  end
end
