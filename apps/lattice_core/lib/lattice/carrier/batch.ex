defmodule Lattice.Carrier.Batch do
  @moduledoc "Bounded transfer batches for carrier push/pull frames."

  @spec chunk([term()], keyword()) :: [[term()]]
  def chunk(items, opts) do
    max_ops = Keyword.fetch!(opts, :max_ops)
    max_bytes = Keyword.fetch!(opts, :max_bytes)
    size_fun = Keyword.fetch!(opts, :size_fun)

    {chunks, current, _count, _bytes} =
      Enum.reduce(items, {[], [], 0, 0}, fn item, {chunks, current, count, bytes} ->
        size = size_fun.(item)

        if current != [] and (count >= max_ops or bytes + size > max_bytes) do
          {[Enum.reverse(current) | chunks], [item], 1, size}
        else
          {chunks, [item | current], count + 1, bytes + size}
        end
      end)

    if(current == [], do: chunks, else: [Enum.reverse(current) | chunks])
    |> Enum.reverse()
  end

  @spec merge_reports([Lattice.Sync.report()]) :: Lattice.Sync.report()
  def merge_reports(reports) do
    Enum.reduce(reports, %{accepted: [], quarantined: [], rejected: [], pending: []}, fn report,
                                                                                         acc ->
      %{
        accepted: acc.accepted ++ report.accepted,
        quarantined: acc.quarantined ++ report.quarantined,
        rejected: acc.rejected ++ report.rejected,
        pending: acc.pending ++ report.pending
      }
    end)
  end
end
