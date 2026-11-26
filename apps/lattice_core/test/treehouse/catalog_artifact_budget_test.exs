defmodule Treehouse.CatalogArtifactBudgetTest do
  @moduledoc "Rows 355, 525: the authoring preflight's mirror of CatalogTrust's artifact budgets."
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias Treehouse.{CatalogArtifactBudget, CatalogArtifactBudgetVectors, CatalogJSON}
  alias Treehouse.TransportCatalog

  @client Path.expand("../../../../clients/lattice-client", __DIR__)
  @vector Path.join(@client, "test/vectors/catalog/artifact_budget_v1.json")
  @catalog_trust Path.expand("../../lib/treehouse/catalog_trust.ex", __DIR__)

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

  test "CatalogTrust's budget literals are the mirrored ones" do
    source = File.read!(@catalog_trust)
    message = "CatalogTrust budgets changed: update Treehouse.CatalogArtifactBudget"

    for literal <- [
          "@max_artifacts 1_024",
          "@max_artifact_bytes 131_072",
          "@max_total_bytes 16 * 1_024 * 1_024"
        ] do
      assert String.contains?(source, literal), message
    end
  end
end
