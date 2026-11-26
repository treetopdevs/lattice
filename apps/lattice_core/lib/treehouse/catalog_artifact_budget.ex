defmodule Treehouse.CatalogArtifactBudget do
  @moduledoc """
  CatalogTrust's retained-artifact budgets for an authoring preflight (rows 355, 525).

  `Treehouse.CatalogTrust` refuses retained evidence as `control_history_limit` when it holds
  more than `max_artifacts/0` artifacts, when one artifact's JSON is over
  `max_artifact_bytes/0`, or when the artifacts' JSON totals more than `max_total_bytes/0`.
  These limits mirror CatalogTrust's private ones; a drift test pins both.

  `artifact_json_bytes/1` measures an envelope as compact JSON of its carrier term, which is
  the length the operator distribution (`PublicHistory.canonical`) emits. It is a lower bound:
  a verifier that receives the same artifact padded with whitespace measures more, so passing
  this check does not prove a distributor's copy fits (non-claim).
  """

  alias Lattice.Carrier.Wire

  @max_artifacts 1_024
  @max_artifact_bytes 131_072
  @max_total_bytes 16 * 1_024 * 1_024

  @spec max_artifacts() :: pos_integer()
  def max_artifacts, do: @max_artifacts

  @spec max_artifact_bytes() :: pos_integer()
  def max_artifact_bytes, do: @max_artifact_bytes

  @spec max_total_bytes() :: pos_integer()
  def max_total_bytes, do: @max_total_bytes

  @doc "Compact JSON length of a catalog or rotation envelope's carrier term."
  @spec artifact_json_bytes(map()) :: non_neg_integer()
  def artifact_json_bytes(envelope),
    do: envelope |> Wire.encode_value() |> Jason.encode!() |> byte_size()

  @doc "Refuses a size list CatalogTrust would refuse: count, per-artifact or total."
  @spec check([non_neg_integer()]) :: :ok | {:error, :control_history_limit}
  def check(sizes) when is_list(sizes) do
    if length(sizes) > @max_artifacts or Enum.any?(sizes, &(&1 > @max_artifact_bytes)) or
         Enum.sum(sizes) > @max_total_bytes,
       do: {:error, :control_history_limit},
       else: :ok
  end
end
