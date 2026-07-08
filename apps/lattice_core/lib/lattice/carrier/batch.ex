defmodule Lattice.Carrier.Batch do
  @moduledoc "Bounded transfer batches for carrier push/pull frames."

  @spec chunk([term()], keyword()) ::
          {:ok, [[term()]]} | {:error, {:oversized_item, non_neg_integer(), pos_integer()}}
  def chunk(items, opts) do
    max_ops = Keyword.fetch!(opts, :max_ops)
    max_bytes = Keyword.fetch!(opts, :max_bytes)
    size_fun = Keyword.fetch!(opts, :size_fun)

    items
    |> Enum.reduce_while({[], [], 0, 0}, fn item, {chunks, current, count, bytes} ->
      size = size_fun.(item)

      cond do
        size > max_bytes ->
          {:halt, {:error, {:oversized_item, size, max_bytes}}}

        current != [] and (count >= max_ops or bytes + size > max_bytes) ->
          {:cont, {[Enum.reverse(current) | chunks], [item], 1, size}}

        true ->
          {:cont, {chunks, [item | current], count + 1, bytes + size}}
      end
    end)
    |> case do
      {:error, _reason} = error ->
        error

      {chunks, current, _count, _bytes} ->
        chunks =
          if(current == [], do: chunks, else: [Enum.reverse(current) | chunks])
          |> Enum.reverse()

        {:ok, chunks}
    end
  end

  @spec chunk!([term()], keyword()) :: [[term()]]
  def chunk!(items, opts) do
    case chunk(items, opts) do
      {:ok, chunks} -> chunks
      {:error, reason} -> raise ArgumentError, "cannot chunk carrier batch: #{inspect(reason)}"
    end
  end

  @spec merge_reports([Lattice.Sync.report()]) :: Lattice.Sync.report()
  def merge_reports(reports) do
    %{
      accepted: Enum.flat_map(reports, & &1.accepted),
      quarantined: Enum.flat_map(reports, & &1.quarantined),
      rejected: Enum.flat_map(reports, & &1.rejected),
      pending: Enum.flat_map(reports, & &1.pending)
    }
  end
end
