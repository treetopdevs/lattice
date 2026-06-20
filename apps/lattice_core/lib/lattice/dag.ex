defmodule Lattice.Dag do
  @moduledoc """
  Canonical total order over a set of ops.

  Determinism (design invariant 3) requires that "total order where needed =
  topological order of the causal DAG with op-hash tiebreak". This module is the
  one place that order is defined. Reduction, sync transfer order, and authority
  analysis all consume `topo_sort/1`, so every realm folds the same ops in the
  same sequence regardless of the order they arrived over the wire.

  Implementation is Kahn's algorithm with a `:gb_sets` ready-set keyed by op id,
  so among ops whose causal dependencies are already placed, the smallest id is
  always emitted next. Dependencies that point outside the provided set (e.g. when
  ordering a causal slice for `state_at/2`) are treated as already satisfied.
  """

  alias Lattice.Op

  @doc "Return the ops in canonical total order (topological + ascending-id tiebreak)."
  @spec topo_sort(%{Op.id() => Op.t()} | [Op.t()]) :: [Op.t()]
  def topo_sort(ops) when is_map(ops), do: topo_sort(Map.values(ops))

  def topo_sort(ops) when is_list(ops) do
    present = MapSet.new(ops, & &1.id)
    by_id = Map.new(ops, &{&1.id, &1})

    indegree =
      Map.new(ops, fn op -> {op.id, Enum.count(op.deps, &MapSet.member?(present, &1))} end)

    children =
      Enum.reduce(ops, %{}, fn op, acc ->
        Enum.reduce(op.deps, acc, fn dep, acc ->
          if MapSet.member?(present, dep),
            do: Map.update(acc, dep, [op.id], &[op.id | &1]),
            else: acc
        end)
      end)

    ready =
      for {id, 0} <- indegree, reduce: :gb_sets.new() do
        set -> :gb_sets.add(id, set)
      end

    kahn(ready, indegree, children, by_id, [])
  end

  defp kahn(ready, indegree, children, by_id, acc) do
    if :gb_sets.is_empty(ready) do
      Enum.reverse(acc)
    else
      {id, ready} = :gb_sets.take_smallest(ready)

      {indegree, ready} =
        children
        |> Map.get(id, [])
        |> Enum.reduce({indegree, ready}, fn child, {ind, rdy} ->
          remaining = Map.fetch!(ind, child) - 1
          ind = Map.put(ind, child, remaining)
          rdy = if remaining == 0, do: :gb_sets.add(child, rdy), else: rdy
          {ind, rdy}
        end)

      kahn(ready, indegree, children, by_id, [Map.fetch!(by_id, id) | acc])
    end
  end

  @doc """
  Causal ancestors of `id` within `ops` (not including `id` itself). Used by
  authority analysis to ask "what had this op seen when it was authored?".
  """
  @spec ancestors(%{Op.id() => Op.t()}, Op.id()) :: MapSet.t(Op.id())
  def ancestors(ops, id) when is_map(ops) do
    case Map.fetch(ops, id) do
      {:ok, op} -> collect_ancestors(ops, op.deps, MapSet.new())
      :error -> MapSet.new()
    end
  end

  defp collect_ancestors(_ops, [], acc), do: acc

  defp collect_ancestors(ops, [dep | rest], acc) do
    if MapSet.member?(acc, dep) do
      collect_ancestors(ops, rest, acc)
    else
      acc = MapSet.put(acc, dep)

      acc =
        case Map.fetch(ops, dep) do
          {:ok, op} -> collect_ancestors(ops, op.deps, acc)
          :error -> acc
        end

      collect_ancestors(ops, rest, acc)
    end
  end

  @doc """
  Causal height of every op: 0 for roots, else 1 + max height of present deps.

  Height is a deterministic, causality-respecting clock — if `a` is an ancestor of
  `b` then `height(a) < height(b)` — used as the high-order component of CRDT
  ordering tags (`{height, op_id}`). It depends only on the op set, never on
  delivery order.
  """
  @spec heights(%{Op.id() => Op.t()}) :: %{Op.id() => non_neg_integer()}
  def heights(ops) when is_map(ops) do
    Enum.reduce(topo_sort(ops), %{}, fn op, acc ->
      max_dep_height =
        case op.deps do
          [] -> -1
          deps -> deps |> Enum.map(&Map.get(acc, &1, -1)) |> Enum.max()
        end

      Map.put(acc, op.id, max_dep_height + 1)
    end)
  end

  @doc """
  Precompute the causal-ancestor set of every op in one topo pass. Authority
  analysis asks "what had this op seen?" for many ops, so amortizing it here is
  much cheaper than walking deps per query.
  """
  @spec all_ancestors(%{Op.id() => Op.t()}) :: %{Op.id() => MapSet.t(Op.id())}
  def all_ancestors(ops) when is_map(ops) do
    Enum.reduce(topo_sort(ops), %{}, fn op, acc ->
      anc =
        Enum.reduce(op.deps, MapSet.new(), fn dep, set ->
          if Map.has_key?(ops, dep) do
            set |> MapSet.put(dep) |> MapSet.union(Map.get(acc, dep, MapSet.new()))
          else
            set
          end
        end)

      Map.put(acc, op.id, anc)
    end)
  end

  @doc """
  Set of op ids causally reachable from `frontier` (the frontier ops included).
  This is the set of ops "visible as of" a given frontier — the basis for
  `Lattice.state_at/2` time travel (behavior 17).
  """
  @spec reachable(%{Op.id() => Op.t()}, [Op.id()]) :: MapSet.t(Op.id())
  def reachable(ops, frontier) when is_map(ops) and is_list(frontier) do
    seeds = Enum.filter(frontier, &Map.has_key?(ops, &1))
    # Seed the accumulator with the frontier itself, then walk each seed's deps —
    # passing the deps (not the seeds) so the already-included seeds aren't skipped
    # before their ancestors are explored.
    seed_deps = Enum.flat_map(seeds, fn id -> Map.fetch!(ops, id).deps end)
    collect_ancestors(ops, seed_deps, MapSet.new(seeds))
  end
end
