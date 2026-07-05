defmodule Lattice.CarrierBatchTest do
  use ExUnit.Case, async: true

  alias Lattice.Carrier.Batch

  test "splits by max op count" do
    assert Batch.chunk([1, 2, 3, 4, 5], max_ops: 2, size_fun: fn _ -> 1 end, max_bytes: 100) ==
             [[1, 2], [3, 4], [5]]
  end

  test "splits by encoded bytes" do
    chunks = Batch.chunk(["aaaa", "bbbb", "c"], max_ops: 10, size_fun: &byte_size/1, max_bytes: 5)
    assert chunks == [["aaaa"], ["bbbb", "c"]]
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
end
