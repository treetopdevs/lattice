defmodule Lattice.Carrier.Uint64Test do
  use ExUnit.Case, async: false
  alias Lattice.Carrier.Uint64
  alias Lattice.IntegerParseTrace

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

    {{accepted, refused}, calls} =
      IntegerParseTrace.capture(fn ->
        {Enum.map(valid, &Uint64.parse_text/1), Enum.map(invalid, &Uint64.parse_text/1)}
      end)

    assert Enum.all?(accepted, &match?({:ok, _}, &1))
    assert List.last(accepted) == {:ok, 18_446_744_073_709_551_615}
    assert refused == List.duplicate(:error, length(invalid))
    assert Enum.sort(calls) == Enum.sort(valid)
    refute Enum.any?(calls, &(byte_size(&1) > 20))
  end
end
