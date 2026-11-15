defmodule Treehouse.CatalogBindingGraphReciprocalTest do
  @moduledoc """
  Plan 316 PR 4a reciprocal vectors. BEAM writes `binding_graph_v1.json` (inputs, hand-written
  label-space expectations, BEAM incidental outputs); the TS twin runs it and writes
  `binding_graph_ts_v1.json`. This test pins the committed BEAM vector to regeneration and
  BEAM to every TS-written outcome. The TS test checks the reverse direction.
  """
  use ExUnit.Case, async: true

  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.CatalogBindingGraphScenarios, as: S

  @dir Path.expand("../../../../clients/lattice-client/test/vectors/catalog", __DIR__)

  @tag :tmp_dir
  test "BEAM-written binding_graph_v1.json equals regeneration", %{tmp_dir: tmp} do
    path = Path.join(tmp, "binding_graph_v1.json")
    S.write(path)
    assert File.read!(path) == File.read!(Path.join(@dir, "binding_graph_v1.json"))
  end

  test "BEAM reproduces every TS-written outcome in binding_graph_ts_v1.json" do
    base = F.base()

    beam =
      for s <- S.all(base), {r, i} <- Enum.with_index(S.run(base, s), 1) do
        %{"scenario" => s.name, "step" => i, "label" => r.label_view, "ts" => r.view}
      end

    ts = @dir |> Path.join("binding_graph_ts_v1.json") |> File.read!() |> Jason.decode!()
    assert length(ts["outcomes"]) == length(beam)

    for {t, b} <- Enum.zip(ts["outcomes"], beam) do
      assert {t["scenario"], t["step"]} == {b["scenario"], b["step"]}
      assert t["label"] == b["label"], "#{b["scenario"]} delivery #{b["step"]} (label view)"
      assert t["ts"] == json(b["ts"]), "#{b["scenario"]} delivery #{b["step"]} (id view)"
    end
  end

  defp json(value), do: value |> Jason.encode!() |> Jason.decode!()
end
