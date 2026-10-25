defmodule Lattice.RawObservationBoundsTest do
  use ExUnit.Case, async: true
  alias Lattice.Carrier.RawObservationBounds
  @moduletag timeout: 180_000

  test "UTF-8 byte budget includes raw keys and term tags at the exact maximum" do
    available = 67_108_864 - byte_size("bodycapatomnil")

    for value <- [:binary.copy("z", available), :binary.copy("é", div(available, 2))] do
      assert RawObservationBounds.within?(%{"body" => ["atom", value], "cap" => ["nil"]})
      refute RawObservationBounds.within?(%{"body" => ["atom", value <> "z"], "cap" => ["nil"]})
    end
  end

  test "node budget counts repeated shared subterms at the exact maximum" do
    available = 67_108_864 - 8

    assert RawObservationBounds.within?(%{
             "body" => ["nil"],
             "cap" => ["nil"],
             "padding" => forest(available)
           })

    refute RawObservationBounds.within?(%{
             "body" => ["nil"],
             "cap" => ["nil"],
             "padding" => forest(available + 1)
           })
  end

  test "raw JSON depth does not allocate an unbounded traversal stack" do
    nested = fn depth -> Enum.reduce(1..depth, 0, fn _, value -> [value] end) end

    assert RawObservationBounds.within?(%{
             "body" => ["nil"],
             "cap" => ["nil"],
             "padding" => nested.(135)
           })

    refute RawObservationBounds.within?(%{
             "body" => ["nil"],
             "cap" => ["nil"],
             "padding" => nested.(136)
           })
  end

  # Compact immutable sharing exercises the real maximum without allocating
  # sixty-seven million input cells. The production walk must count occurrences.
  defp forest(nodes) do
    trees =
      Stream.iterate({0, 1}, fn {tree, size} -> {[tree, tree], size * 2 + 1} end)
      |> Enum.take_while(fn {_, size} -> size <= nodes end)
      |> Enum.reverse()

    {values, 0} =
      Enum.reduce(trees, {[], nodes - 1}, fn {tree, size}, {acc, left} ->
        {List.duplicate(tree, div(left, size)) ++ acc, rem(left, size)}
      end)

    values
  end
end
