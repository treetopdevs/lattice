defmodule Lattice2.CrdtPropertyTest do
  @moduledoc """
  Phase B gate: the three hand-rolled CRDTs obey the CvRDT join laws —
  commutativity, associativity, idempotence — which is what guarantees that
  reduction converges regardless of delivery order.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  alias Lattice.Crdt.{CausalList, Lww, OrSet}

  # --- LWW -----------------------------------------------------------------

  defp lww_gen do
    gen all(writes <- list_of({integer(0..50), integer(0..3), term_value()}, max_length: 12)) do
      Enum.reduce(writes, Lww.new(), fn {height, actor, value}, acc ->
        Lww.put(acc, value, {height, actor})
      end)
    end
  end

  defp term_value, do: one_of([integer(), string(:alphanumeric, max_length: 6), boolean()])

  property "Lww.merge is commutative, associative, idempotent" do
    check all(a <- lww_gen(), b <- lww_gen(), c <- lww_gen()) do
      assert Lww.merge(a, b) == Lww.merge(b, a)
      assert Lww.merge(Lww.merge(a, b), c) == Lww.merge(a, Lww.merge(b, c))
      assert Lww.merge(a, a) == a
    end
  end

  property "Lww keeps the write with the greatest (unique) tag" do
    # Tags are unique in the real system (`{height, op_id}`); use a monotonic index
    # so the "greatest" write is unambiguous.
    check all(values <- list_of(integer(), min_length: 1, max_length: 10)) do
      indexed = Enum.with_index(values)
      reg = Enum.reduce(indexed, Lww.new(), fn {v, i}, acc -> Lww.put(acc, v, i) end)
      {expected, _i} = List.last(indexed)
      assert Lww.value(reg, :none) == expected
    end
  end

  # --- OR-Set --------------------------------------------------------------

  defp or_set_gen do
    gen all(ops <- list_of(or_set_op(), max_length: 14)) do
      Enum.reduce(ops, {OrSet.new(), 0}, fn op, {set, tag} ->
        case op do
          {:add, e} -> {OrSet.add(set, e, tag), tag + 1}
          {:remove, e} -> {OrSet.remove_elem(set, e), tag + 1}
        end
      end)
      |> elem(0)
    end
  end

  defp or_set_op do
    one_of([
      {:add, member()},
      {:remove, member()}
    ])
  end

  defp member, do: member_of([:a, :b, :c, :d])

  property "OrSet.merge is commutative, associative, idempotent" do
    check all(a <- or_set_gen(), b <- or_set_gen(), c <- or_set_gen()) do
      assert OrSet.value(OrSet.merge(a, b)) == OrSet.value(OrSet.merge(b, a))

      left = OrSet.merge(OrSet.merge(a, b), c)
      right = OrSet.merge(a, OrSet.merge(b, c))
      assert OrSet.value(left) == OrSet.value(right)

      assert OrSet.value(OrSet.merge(a, a)) == OrSet.value(a)
    end
  end

  property "OrSet add-wins: a concurrent add survives a remove that never saw its tag" do
    check all(elem <- member()) do
      # Replica A: add (tag 0) then observed-remove (retires tag 0).
      a = OrSet.new() |> OrSet.add(elem, {:a, 0})
      a = OrSet.remove(a, OrSet.tags_for(a, elem))
      # Replica B: a concurrent add with a tag A never observed.
      b = OrSet.add(OrSet.new(), elem, {:b, 0})

      merged = OrSet.merge(a, b)
      assert elem in OrSet.value(merged)
    end
  end

  # --- CausalList ----------------------------------------------------------

  # Mirrors the real-system invariant: an element's id is a content hash, so the
  # same id always carries the same value (no conflicting-id merges can occur).
  defp causal_list_gen do
    gen all(
          inserts <-
            list_of({integer(0..30), string(:alphanumeric, max_length: 4)}, max_length: 10)
        ) do
      Enum.reduce(inserts, CausalList.new(), fn {height, value}, acc ->
        id = content_id(height, value)
        CausalList.insert(acc, id, value, {height, id})
      end)
    end
  end

  defp content_id(height, value),
    do: Base.encode16(:erlang.term_to_binary({height, value}, [:deterministic]))

  property "CausalList.merge is commutative, associative, idempotent" do
    check all(a <- causal_list_gen(), b <- causal_list_gen(), c <- causal_list_gen()) do
      assert CausalList.value(CausalList.merge(a, b)) == CausalList.value(CausalList.merge(b, a))

      left = CausalList.merge(CausalList.merge(a, b), c)
      right = CausalList.merge(a, CausalList.merge(b, c))
      assert CausalList.value(left) == CausalList.value(right)

      assert CausalList.value(CausalList.merge(a, a)) == CausalList.value(a)
    end
  end

  property "CausalList orders by sort key (causal height) regardless of insert order" do
    check all(
            entries <-
              uniq_list_of({integer(0..50), string(:alphanumeric, min_length: 1, max_length: 5)},
                min_length: 1,
                max_length: 8
              )
          ) do
      tagged = Enum.with_index(entries)

      list =
        tagged
        |> Enum.shuffle()
        |> Enum.reduce(CausalList.new(), fn {{height, value}, i}, acc ->
          CausalList.insert(acc, "id#{i}", value, {height, "id#{i}"})
        end)

      expected =
        tagged
        |> Enum.sort_by(fn {{height, _value}, i} -> {{height, "id#{i}"}, "id#{i}"} end)
        |> Enum.map(fn {{_height, value}, _i} -> value end)

      assert CausalList.value(list) == expected
    end
  end
end
