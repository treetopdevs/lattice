defmodule Lattice.CarrierValueTest do
  use ExUnit.Case, async: true
  alias Lattice.Carrier.Wire

  test "public standalone values preserve existing bounded grammar and normalization" do
    value = %{catalog: [1, <<0, 255>>, :treehouse], previous: nil}
    assert {:ok, ^value} = Wire.decode_value(Wire.encode_value(value))

    nested = fn count -> Enum.reduce(1..count, ["int", 0], fn _, term -> ["list", [term]] end) end
    assert {:ok, _} = Wire.decode_value(nested.(64))
    assert {:error, :malformed_term} = Wire.decode_value(nested.(65))
    assert {:ok, 18_446_744_073_709_551_615} = Wire.decode_value(["int", "18446744073709551615"])
    assert {:error, :malformed_term} = Wire.decode_value(["int", "18446744073709551616"])
    assert {:error, :malformed_term} = Wire.decode_value(["int", -1])
    assert {:error, :malformed_term} = Wire.decode_value(["atom", "unregistered-r11a-atom-name"])
    assert_raise ArgumentError, fn -> Wire.encode_value(self()) end

    # Preserve generic op-wire normalization; catalog ingress adds its own closed-map refusal.
    assert {:ok, %{catalog: 2}} =
             Wire.decode_value([
               "map",
               [[["atom", "catalog"], ["int", 1]], [["atom", "catalog"], ["int", 2]]]
             ])

    assert {:ok, MapSet.new([1])} == Wire.decode_value(["mapset", [["int", 1], ["int", 1]]])
  end
end
