defmodule Lattice.Carrier.Uint64Test do
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Uint64

  test "canonical text is range checked before Integer.parse allocation" do
    valid = ["0", "1", "9007199254740991", "9007199254740992", "18446744073709551615"]

    invalid = [
      "",
      "00",
      "01",
      "1\n",
      " 1",
      "+1",
      "-1",
      "18446744073709551616",
      String.duplicate("9", 21),
      String.duplicate("9", 1_048_576),
      nil,
      1
    ]

    parent = self()

    worker =
      spawn(fn ->
        receive do
          :go ->
            results =
              {Enum.map(valid, &Uint64.parse_text/1), Enum.map(invalid, &Uint64.parse_text/1)}

            send(parent, {:results, results})
            receive do: (:stop -> :ok)
        end
      end)

    :erlang.trace_pattern({Integer, :parse, 1}, true, [])
    :erlang.trace(worker, true, [:call, {:tracer, self()}])

    try do
      send(worker, :go)
      assert_receive {:results, {accepted, refused}}, 5_000
      assert Enum.all?(accepted, &match?({:ok, _}, &1))
      assert List.last(accepted) == {:ok, 18_446_744_073_709_551_615}
      assert refused == List.duplicate(:error, length(invalid))
      ref = :erlang.trace_delivered(worker)
      calls = collect(worker, ref, [])
      assert Enum.sort(calls) == Enum.sort(valid)
      refute Enum.any?(calls, &(byte_size(&1) > 20))
    after
      :erlang.trace(worker, false, [:call])
      :erlang.trace_pattern({Integer, :parse, 1}, false, [])
      send(worker, :stop)
    end
  end

  defp collect(worker, ref, values) do
    receive do
      {:trace, ^worker, :call, {Integer, :parse, [value]}} ->
        collect(worker, ref, [value | values])

      {:trace_delivered, ^worker, ^ref} ->
        values
    after
      5_000 -> flunk("integer parse trace was not delivered")
    end
  end
end
