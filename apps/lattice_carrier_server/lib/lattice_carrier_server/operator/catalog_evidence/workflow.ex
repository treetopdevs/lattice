defmodule LatticeCarrierServer.Operator.CatalogEvidence.Workflow do
  @moduledoc """
  Root first-install PreviewState size for a catalog evidence page.

  Plan 261 D5 requires the exporter to calculate the serialized post-import
  profile size, including metadata and outbox, and refuse before writing if it
  exceeds the 1 MiB workflow store. This is not the native owner's check against
  a device that already holds extra history, and it does not install trust.
  """
  alias Lattice.Log
  alias LatticeCarrierServer.Operator.PublicHistory
  alias Treehouse.CatalogBootstrap

  # Matches HISTORY_BYTES in treehouse_state.ts and preview.rs (plan 257).
  @history_bytes 1_048_576

  @spec record(Log.t(), %{String.t() => Log.t()}) :: {:ok, map()} | {:error, atom()}
  def record(%Log{} = space, histories) when is_map(histories) do
    with true <- histories[space.replica] == space,
         true <- map_size(histories) in 1..13,
         {:ok, %{bootstraps: [%{record: %{space_root: root}}]}} <- CatalogBootstrap.observe(space) do
      profiles =
        histories
        |> Enum.sort_by(&elem(&1, 0))
        |> Enum.map(fn {replica, log} ->
          %{
            "product" => product(space.replica, replica),
            "replica" => replica,
            "frames" => PublicHistory.frames(log),
            "outbox" => [],
            "acked" => []
          }
        end)

      {:ok,
       %{
         "version" => 2,
         "product" => "treehouse",
         "revision" => 1,
         "publicKey" => Base.encode64(root),
         "profiles" => profiles,
         "active" => space.replica,
         "intent" => nil,
         "clearedDrafts" => %{},
         "relay" => nil
       }}
    else
      _ -> {:error, :invalid_verified_history}
    end
  end

  def record(_, _), do: {:error, :invalid_verified_history}

  @spec fit(Log.t(), %{String.t() => Log.t()}) :: :ok | {:error, atom()}
  def fit(space, histories) do
    with {:ok, record} <- record(space, histories) do
      same(byte_size(PublicHistory.canonical(record)) <= @history_bytes, :preview_storage_limit)
    end
  end

  defp product(space, replica) when space == replica, do: "Treehouse.Space"
  defp product(_, _), do: "Treehouse.Thread"

  defp same(true, _), do: :ok
  defp same(_, reason), do: {:error, reason}
end
