defmodule Lattice.CarrierBatchTest do
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Lattice.Carrier.Batch

  test "splits by max op count" do
    assert {:ok, chunks} =
             Batch.chunk([1, 2, 3, 4, 5],
               max_ops: 2,
               size_fun: fn _ -> 1 end,
               max_bytes: 100
             )

    assert chunks ==
             [[1, 2], [3, 4], [5]]
  end

  test "splits by encoded bytes" do
    assert {:ok, chunks} =
             Batch.chunk(["aaaa", "bbbb", "c"],
               max_ops: 10,
               size_fun: &byte_size/1,
               max_bytes: 5
             )

    assert chunks == [["aaaa"], ["bbbb", "c"]]
  end

  test "rejects a single item that exceeds the frame byte budget" do
    assert {:error, {:oversized_item, 6, 5}} =
             Batch.chunk(["xxxxxx"], max_ops: 10, size_fun: &byte_size/1, max_bytes: 5)
  end

  test "merges sync reports preserving order" do
    reports = [
      %{accepted: ["a"], quarantined: [], rejected: [], pending: []},
      %{accepted: ["b"], quarantined: [{"c", :bad_signature}], rejected: [], pending: ["d"]}
    ]

    assert Batch.merge_reports(reports) == %{
             accepted: ["a", "b"],
             quarantined: [{"c", :bad_signature}],
             rejected: [],
             pending: ["d"]
           }
  end

  property "chunk then flatten preserves order and identity" do
    check all(
            entries <- list_of(batch_entry_gen(), max_length: 20),
            max_ops <- integer(1..6),
            extra_bytes <- integer(0..50)
          ) do
      max_bytes = max_entry_size(entries) + extra_bytes

      assert {:ok, batches} =
               Batch.chunk(entries,
                 max_ops: max_ops,
                 max_bytes: max_bytes,
                 size_fun: &entry_size/1
               )

      assert List.flatten(batches) == entries
    end
  end

  property "every produced batch respects op and byte bounds" do
    check all(
            entries <- list_of(batch_entry_gen(), max_length: 20),
            max_ops <- integer(1..6),
            extra_bytes <- integer(0..50)
          ) do
      max_bytes = max_entry_size(entries) + extra_bytes

      assert {:ok, batches} =
               Batch.chunk(entries,
                 max_ops: max_ops,
                 max_bytes: max_bytes,
                 size_fun: &entry_size/1
               )

      assert Enum.all?(batches, &(length(&1) <= max_ops))

      assert Enum.all?(
               batches,
               &(Enum.sum(Enum.map(&1, fn entry -> entry_size(entry) end)) <= max_bytes)
             )
    end
  end

  property "oversized single items are rejected" do
    check all(max_bytes <- integer(1..50), extra <- integer(1..50)) do
      oversized = {:oversized, max_bytes + extra}

      assert {:error, {:oversized_item, size, ^max_bytes}} =
               Batch.chunk([oversized],
                 max_ops: 10,
                 max_bytes: max_bytes,
                 size_fun: &entry_size/1
               )

      assert size > max_bytes
    end
  end

  property "merge_reports concatenation is order-preserving" do
    check all(reports <- list_of(report_gen(), max_length: 10)) do
      merged = Batch.merge_reports(reports)

      assert merged.accepted == Enum.flat_map(reports, & &1.accepted)
      assert merged.quarantined == Enum.flat_map(reports, & &1.quarantined)
      assert merged.rejected == Enum.flat_map(reports, & &1.rejected)
      assert merged.pending == Enum.flat_map(reports, & &1.pending)
    end
  end

  defp batch_entry_gen do
    gen all(
          payload <- one_of([integer(), string(:alphanumeric, max_length: 8)]),
          size <- integer(1..50)
        ) do
      {payload, size}
    end
  end

  defp max_entry_size([]), do: 1
  defp max_entry_size(entries), do: entries |> Enum.map(&entry_size/1) |> Enum.max()

  defp entry_size({_payload, size}), do: size

  defp report_gen do
    gen all(
          accepted <- list_of(id_gen(), max_length: 5),
          quarantined <- list_of(reason_pair_gen(), max_length: 5),
          rejected <- list_of(reason_pair_gen(), max_length: 5),
          pending <- list_of(id_gen(), max_length: 5)
        ) do
      %{accepted: accepted, quarantined: quarantined, rejected: rejected, pending: pending}
    end
  end

  defp reason_pair_gen do
    gen all(id <- id_gen(), reason <- member_of([:bad_signature, :malformed_op, :no_capability])) do
      {id, reason}
    end
  end

  defp id_gen, do: string(:alphanumeric, min_length: 1, max_length: 8)
end
