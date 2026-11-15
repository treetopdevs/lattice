defmodule Treehouse.CatalogBindingGraphPropertyTest do
  @moduledoc """
  Plan 316 PR 4a convergence properties (rows 382 and 383) for `Treehouse.CatalogBindingGraph`
  over pools of pre-signed disposable-key artifacts. Each pool is the full final evidence of a
  scenario in `Treehouse.CatalogBindingGraphScenarios`; a run draws a random causal order of the
  pool's artifacts (an op after its deps, a rotation after its parent and prior catalog, a catalog
  after its binding and `previous`) and random cut points, and delivers the cumulative unions in
  turn from the empty state, persisting through `advance/2`. Per run:

    (a) D-279: every intrinsic verdict only ever moves out of `:pending`;
    (c) `frozen` lifts only on an accepting decision that clears, and nothing is served while
        frozen;
    (d) consecutive watermarks extend each other's entries, and a route once served is never
        re-pointed;
    (g) an accepting decision's catalog carries the entries of every covered catalog (the
        settled D-275 trade drops only closed-out catalogs);
    (e2) for a pool whose final union holds a resolution R* carrying every catalog any order
        could have accepted, every order ends at R*/K*, not frozen.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  @moduletag timeout: 900_000

  alias Lattice.Log
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.CatalogBindingGraphScenarios, as: S

  @extended_keys ~w(root genesis creation reference kind schema)a

  # {scenario whose final evidence is the pool, R* label, K* label}; a nil R* checks only the
  # safety properties.
  @pools [
    {"S1: a rotation beside a holder change freezes, and an admin resolution clears it/ab", "R2",
     "K2"},
    {"S2: a withheld resolution catalog stays frozen until a descendant clears", "R3", "K3"},
    {"S3: a second replacement carrying the floor's Thread promotes", "R2f", "K2f"},
    {"S3: a nil citation of a node without a valid catalog carries its floor", nil, nil},
    {"S4: a route-reusing catalog is invalid in any order and validates no replacement/ab", "B",
     "C0"},
    {"S6: rotations naming an invalid prior catalog are refusals, not heads", "B", "C0"},
    {"S8: a closed-out rotation watermark freezes and clears (cite)", "R3", "K3"},
    {"S8: a closed-out rotation watermark freezes and clears (nil)", "R3", "K3"},
    {"S9: a resolution carrying the watermark's Thread clears", "R2t", "K2t"},
    {"S9: a resolution dropping the watermark's Thread stays frozen", nil, nil},
    {"S10: a rotation from an ancestor catalog forks until a resolution cites both", "Rs", "KRs"},
    {"S11: three rotation heads under a refused watermark are resolved by one citation", "R2",
     "K2"},
    {"S12: a resolution with fresh routes clears", "R2f", "K2f"},
    {"S12: a route served earlier is never re-pointed", nil, nil},
    {"S14: a catalog accepted before the closing resolution freezes", nil, nil},
    {"C13: concurrent revoke after accepting R1, then a fresh resolution clears", "R2", "K2"}
  ]

  setup_all do
    base = F.base()
    scenarios = Map.new(S.all(base), &{&1.name, &1})

    pools =
      for {name, rstar, kstar} <- @pools do
        s = Map.fetch!(scenarios, name)
        evidence = List.last(s.steps).evidence
        {name, pool(base, evidence), s.labels[rstar], s.labels[kstar]}
      end

    %{base: base, pools: pools}
  end

  for {name, _r, _k} <- @pools do
    @name name
    property "convergence properties over #{@name}", %{base: base, pools: pools} do
      {_name, pool, rstar, kstar} = Enum.find(pools, &(elem(&1, 0) == @name))

      check all(seed <- integer(1..1_000_000_000), max_runs: 6) do
        steps = run(base, pool, seed)
        monotone!(steps)
        sticky!(steps)
        watermarks!(steps, pool)
        carried!(steps)
        if rstar, do: converged!(steps, rstar, kstar, seed)
      end
    end
  end

  # --- pools and deliveries -------------------------------------------------------

  defp pool(base, evidence) do
    held = base.log |> Log.ops() |> Map.keys() |> MapSet.new()

    ops =
      for {id, op} <- Log.ops(evidence.space),
          not MapSet.member?(held, id),
          into: %{},
          do: {id, op}

    known =
      MapSet.new(Map.keys(ops) ++ Map.keys(evidence.rotations) ++ Map.keys(evidence.catalogs))

    keep = &Enum.filter(&1, fn id -> id != nil and MapSet.member?(known, id) end)

    items =
      Enum.map(ops, fn {id, op} -> {id, :op, keep.(op.deps)} end) ++
        Enum.map(evidence.rotations, fn {id, e} ->
          {id, :rotation, keep.([e.rotation.parent, e.rotation.prior_catalog])}
        end) ++
        Enum.map(evidence.catalogs, fn {id, e} ->
          {id, :catalog, keep.([e.catalog.binding, e.catalog.previous])}
        end)

    %{items: Enum.sort(items), ops: ops, evidence: evidence}
  end

  # A random causal order of the pool's items, cut into cumulative deliveries (the full union
  # last).
  defp deliveries(pool, seed) do
    :rand.seed(:exsss, {seed, seed + 7, seed + 13})
    order = topo(pool.items, MapSet.new(), [])
    n = length(order)
    cuts = for i <- 1..n, i == n or :rand.uniform(2) == 1, do: i
    Enum.map(cuts, &Enum.take(order, &1))
  end

  defp topo([], _placed, acc), do: Enum.reverse(acc)

  defp topo(items, placed, acc) do
    ready =
      Enum.filter(items, fn {_id, _k, deps} -> Enum.all?(deps, &MapSet.member?(placed, &1)) end)

    {id, _k, _deps} = pick = Enum.at(ready, :rand.uniform(length(ready)) - 1)
    topo(List.delete(items, pick), MapSet.put(placed, id), [pick | acc])
  end

  defp evidence(base, pool, prefix) do
    ops = for {id, :op, _} <- prefix, do: pool.ops[id]
    ids = MapSet.new(prefix, &elem(&1, 0))

    %{
      space: F.append(base.log, ops),
      rotations: Map.filter(pool.evidence.rotations, fn {id, _} -> MapSet.member?(ids, id) end),
      catalogs: Map.filter(pool.evidence.catalogs, fn {id, _} -> MapSet.member?(ids, id) end),
      proven: pool.evidence.proven
    }
  end

  defp run(base, pool, seed) do
    pool
    |> deliveries(seed)
    |> Enum.map_reduce(F.empty_state(), fn prefix, state ->
      {result, next} = F.deliver(base, state, evidence(base, pool, prefix))
      {%{state: state, result: result, next: next}, F.persisted(next)}
    end)
    |> elem(0)
  end

  # --- properties -----------------------------------------------------------------

  defp monotone!(steps) do
    graphs = for %{result: {:ok, g}} <- steps, do: g

    for {earlier, i} <- Enum.with_index(graphs),
        later <- Enum.drop(graphs, i + 1),
        {id, v} <- earlier.verdicts,
        v != :pending,
        Map.has_key?(later.verdicts, id) do
      assert later.verdicts[id] == v, "(a) verdict of #{id} moved from #{inspect(v)}"
    end
  end

  defp sticky!(steps) do
    for %{state: state, result: result, next: next} <- steps do
      if state.frozen and not next.frozen do
        assert {:ok, %{decision: %{accepted: true, clears_authority_changed: true}}} = result,
               "(c) frozen lifted without an accepting, clearing decision"
      end

      if next.frozen, do: assert(next.serving in [nil, :unchanged], "(c) served while frozen")
    end
  end

  defp watermarks!(steps, pool) do
    for %{state: %{accepted: a}, next: %{accepted: b}} <- steps, a != nil, b != a do
      assert extends?(entries(pool, a.catalog), entries(pool, b.catalog)),
             "(d) watermark #{b.catalog} dropped an entry of #{a.catalog}"

      for {route, replica} <- a.routes do
        assert Map.get(b.routes, route) == replica, "(d) route #{route} re-pointed"
      end
    end
  end

  defp carried!(steps) do
    for %{result: {:ok, %{decision: %{accepted: true, catalog: k}} = g}} <- steps,
        {cid, :covered} <- g.catalog_status do
      assert extends?(g.catalogs[cid].entries, g.catalogs[k].entries),
             "(g) accepted #{k} drops an entry of covered #{cid}"
    end
  end

  defp converged!(steps, rstar, kstar, seed) do
    %{next: next} = List.last(steps)

    assert next.frozen == false and next.accepted != nil and
             {next.accepted.binding, next.accepted.catalog} == {rstar, kstar},
           "(e2) seed #{seed} ended at #{inspect(next.accepted && next.accepted.binding)}, " <>
             "frozen #{next.frozen}"
  end

  defp entries(pool, cid), do: pool.evidence.catalogs[cid].catalog.entries

  defp extends?(before, next) do
    Enum.all?(before, fn entry ->
      case Enum.find(next, &(&1.replica == entry.replica)) do
        nil -> false
        other -> Map.take(entry, @extended_keys) == Map.take(other, @extended_keys)
      end
    end)
  end
end
