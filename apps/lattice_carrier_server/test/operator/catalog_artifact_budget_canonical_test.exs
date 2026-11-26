defmodule LatticeCarrierServer.Operator.CatalogArtifactBudgetCanonicalTest do
  # Rows 355, 525: the operator's distribution encoding is the length the authoring preflight
  # measures. Pure reads of the shared vector; the lattice_core vector module is not on this
  # app's test path.
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.PublicHistory
  alias Treehouse.CatalogArtifactBudget

  @vector Path.expand(
            "../../../../clients/lattice-client/test/vectors/catalog/artifact_budget_v1.json",
            __DIR__
          )

  # Wire.decode_value/1 admits only existing atoms; loading TransportCatalog creates the
  # envelope field atoms, so the vector decodes whichever test runs first.
  setup_all do
    Code.ensure_loaded!(Treehouse.TransportCatalog)
    :ok
  end

  test "PublicHistory.canonical of each vector envelope measures its recorded bytes" do
    envelopes = (@vector |> File.read!() |> Jason.decode!())["envelopes"]
    assert length(envelopes) == 3

    for %{"term" => term, "bytes" => bytes} <- envelopes do
      assert {:ok, envelope} = Wire.decode_value(term)
      assert byte_size(PublicHistory.canonical(Wire.encode_value(envelope))) == bytes
      assert CatalogArtifactBudget.artifact_json_bytes(envelope) == bytes
    end
  end
end
