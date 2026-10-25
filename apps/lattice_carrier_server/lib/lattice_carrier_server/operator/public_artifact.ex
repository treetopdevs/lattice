defmodule LatticeCarrierServer.Operator.PublicArtifact do
  @moduledoc "Exclusive public transfer files in an existing private operator directory."
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Paths, Store}

  @spec write(Path.t(), binary()) :: :ok | {:error, atom()}
  def write(path, bytes)
      when is_binary(path) and path != "" and is_binary(bytes) and byte_size(bytes) <= 67_108_864 do
    path = Path.expand(path)

    with {:ok, _} <- Store.ceremony([ceremony: Path.dirname(path)], :real) do
      case Paths.create_private(
             path,
             fn -> bytes end,
             :catalog_output_exists,
             :catalog_output_failed
           ) do
        {:ok, _} ->
          :ok

        {:error, :catalog_output_exists} ->
          case Store.read_text(Path.dirname(path), Path.basename(path), 67_108_864) do
            {:ok, ^bytes} -> :ok
            _ -> {:error, :catalog_output_conflict}
          end

        {:error, _} = refusal ->
          refusal
      end
    end
  end

  def write(_, _), do: {:error, :catalog_output_required}
end
