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
             "padding" => nested.(198)
           })

    refute RawObservationBounds.within?(%{
             "body" => ["nil"],
             "cap" => ["nil"],
             "padding" => nested.(199)
           })
  end

  test "history string budget is shared across frames and replicas at the exact maximum" do
    available = 67_108_864 - 2 * byte_size("replicaframesrejectedr1bodycapatomnil")
    frame = %{"body" => ["atom", :binary.copy("z", div(available, 2))], "cap" => ["nil"]}
    one = %{replica: "r1", frames: [frame], rejected: []}
    two = %{one | replica: "r2"}
    assert RawObservationBounds.within?(frame)
    assert RawObservationBounds.within_histories?([one, two])
    extra = put_in(frame["body"], ["atom", :binary.copy("z", div(available, 2)) <> "z"])
    assert RawObservationBounds.within?(extra)
    refute RawObservationBounds.within_histories?([one, %{two | frames: [extra]}])
  end

  test "history depth preserves the maximum rejected-frame wrapper context" do
    for {depth, expected} <- [{198, true}, {199, false}] do
      nested = Enum.reduce(1..depth, 0, fn _, value -> [value] end)

      history = %{
        replica: "r",
        frames: [],
        rejected: [%{frame: %{"padding" => nested}, reason: :bad_signature}]
      }

      assert RawObservationBounds.within_histories?([history]) == expected
    end
  end

  test "history node budget counts shared occurrences at the actual maximum" do
    history = fn nodes ->
      [
        %{
          replica: "r",
          frames: [%{"body" => ["nil"], "cap" => ["nil"], "padding" => forest(nodes)}],
          rejected: []
        }
      ]
    end

    assert RawObservationBounds.within_histories?(history.(67_108_864 - 16))
    refute RawObservationBounds.within_histories?(history.(67_108_864 - 15))
  end

  test "evidence budget counts public metadata spelling and reviewed key encoding" do
    fixed = byte_size("reviewspaceRootcutoffProofspadding") + 44

    value = %{
      review: %{space_root: <<0::256>>},
      cutoff_proofs: [],
      padding: :binary.copy("z", 67_108_864 - fixed)
    }

    assert RawObservationBounds.within_evidence?(value)
    refute RawObservationBounds.within_evidence?(%{value | padding: value.padding <> "z"})
  end

  test "proof-history rejected context preserves the deepest raw frame" do
    for {depth, expected} <- [{198, true}, {199, false}] do
      nested = Enum.reduce(1..depth, 0, fn _, value -> [value] end)

      value = %{
        cutoff_proofs: [
          %{
            history: %{
              replica: "r",
              frames: [],
              rejected: [%{frame: %{"padding" => nested}, reason: :bad_signature}]
            }
          }
        ]
      }

      assert RawObservationBounds.within_evidence?(value) == expected
    end
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
