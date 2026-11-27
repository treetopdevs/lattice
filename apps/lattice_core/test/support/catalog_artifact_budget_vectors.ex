defmodule Treehouse.CatalogArtifactBudgetVectors do
  @moduledoc """
  Shared retained-artifact budget evidence (rows 355, 525): CatalogTrust's limits, measured
  JSON lengths of small catalog and rotation envelopes, and size lists with their verdicts.

  Disposable seeded keys only. Budget sizes are run-length `[size, count]` pairs.
  """

  alias Lattice.Carrier.Wire
  alias Lattice.Identity
  alias Treehouse.{CatalogArtifactBudget, CatalogVectors}
  alias Treehouse.TransportCatalog, as: Catalog

  @path "catalog/artifact_budget_v1.json"
  @padding 1_024

  @spec vector() :: map()
  def vector do
    codec = CatalogVectors.codec_vector()
    {:ok, catalog} = Wire.decode_value(codec.catalog_envelope_term)
    {:ok, rotation} = Wire.decode_value(codec.rotation_envelope_term)

    envelopes =
      [{"catalog", catalog}, {"rotation", rotation}, {"catalog", padded(catalog)}]
      |> Enum.map(fn {kind, envelope} ->
        %{
          "kind" => kind,
          "term" => Wire.encode_value(envelope),
          "bytes" => CatalogArtifactBudget.artifact_json_bytes(envelope)
        }
      end)

    max = CatalogArtifactBudget.max_artifact_bytes()

    budgets =
      for {name, sizes} <- [
            {"empty", []},
            {"one at the artifact limit", [[max, 1]]},
            {"one over the artifact limit", [[max + 1, 1]]},
            {"total at the limit", [[max, 128]]},
            {"total over the limit", [[max, 128], [1, 1]]},
            {"count at the limit", [[1, 1_024]]},
            {"count over the limit", [[1, 1_025]]}
          ] do
        verdict =
          case CatalogArtifactBudget.check(expand(sizes)) do
            :ok -> "ok"
            {:error, reason} -> to_string(reason)
          end

        %{"name" => name, "sizes" => sizes, "verdict" => verdict}
      end

    %{
      "version" => 1,
      "limits" => %{
        "max_artifacts" => CatalogArtifactBudget.max_artifacts(),
        "max_artifact_bytes" => max,
        "max_total_bytes" => CatalogArtifactBudget.max_total_bytes()
      },
      "envelopes" => envelopes,
      "budgets" => budgets
    }
  end

  @spec expand([[non_neg_integer()]]) :: [non_neg_integer()]
  def expand(sizes), do: Enum.flat_map(sizes, fn [size, count] -> List.duplicate(size, count) end)

  @spec write(String.t()) :: :ok
  def write(directory) do
    path = Path.join(directory, @path)
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, encode(vector()))
  end

  @spec encode(map()) :: String.t()
  def encode(vector), do: Jason.encode!(vector, pretty: true) <> "\n"

  # Padding the last entry's replica keeps the entries in replica order.
  defp padded(%{catalog: catalog}) do
    {last, rest} = List.pop_at(catalog.entries, -1)
    entries = rest ++ [%{last | replica: last.replica <> String.duplicate("p", @padding)}]
    catalog = %{catalog | entries: entries}
    key = Identity.from_seed("catalog", "r11a-beam-catalog")
    %{catalog: catalog, signature: Identity.sign(key, Catalog.catalog_bytes(catalog))}
  end
end
