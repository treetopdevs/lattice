defmodule Treehouse.CatalogBindingGraphPropertyTest do
  @moduledoc """
  Plan 316 PR 4a convergence properties (rows 382 and 383) for `Treehouse.CatalogBindingGraph`
  over pools of pre-signed disposable-key artifacts. Each pool is the full final evidence of a
  scenario in `Treehouse.CatalogBindingGraphScenarios`. A run takes a causal order of the pool's
  artifacts (an op after its deps, a rotation after its parent and prior catalog, a catalog after
  its binding and `previous`) and delivers cumulative unions in turn through `advance/2`, from the
  empty state and from a frozen B/C0 watermark. A pool of six or fewer artifacts enumerates every
  causal order, delivered one artifact at a time; larger pools sample orders with random cuts
  (50 runs, 200 for the route-rule pools S4, S12 and S17), and some intermediate deliveries of a
  sampled run also hold an unresolvable page (an op with a random-hash dependency and a keyless
  catalog with an unknown binding) that the final delivery evicts (the 4c simulation).

  The freeze, clear, serving, Seen and RouteCompat expectations come from a test-side oracle
  (PR #221 round 5, finding 8). The oracle reads the artifacts' own parents, priors and catalog
  links from the pool, plus the graph's union classification (refused nodes, the closed and
  closed-out sets, catalog status and forks). It never reads a decision flag: it recomputes the
  merge rule of design section 1.3 and compares the persisted state and served routes. Per run:

    (a) D-279: every intrinsic verdict only ever moves out of `:pending`;
    (m) the persisted state and served routes equal the oracle's merge (design 1.3) on every
        step, errors included. A `trust_pending` step (row 386, repair (a)) is merged from its
        complete part, the same union without the pending ids, which must resolve: the freeze
        bit is a non-accepting change of the watermark there, ORed into the sticky `frozen`;
    (h1) a `trust_pending` detail's `freeze` and `serving` are the complete part's, and nothing
        is served under a changed or closed watermark; (h2) a freeze survives every error;
        (h3) nothing is served while frozen;
    (c) an accepting decision covers the watermark (Seen, Carry, RouteCompat, or a
        previous-chain descendant under the same binding), and its `clears_authority_changed` is
        the oracle's;
    (d) consecutive watermarks extend each other's entries, and a route once served is never
        re-pointed;
    (g) an accepting decision's catalog carries the entries of every covered catalog (the
        settled D-275 trade drops only closed-out catalogs);
    (e2) for a pool whose final union holds a resolution R* carrying every catalog any order
        could have accepted, every order from the empty state ends at R*/K*, not frozen.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  @moduletag timeout: 1_800_000

  alias Lattice.Log
  alias Treehouse.CatalogBindingGraphFixtures, as: F
  alias Treehouse.CatalogBindingGraphScenarios, as: S

  @extended_keys ~w(root genesis creation reference kind schema)a
  @enumerate 6

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
    {"S7: a missing accepted catalog serves nothing and does not freeze", nil, nil},
    {"S8: a closed-out rotation watermark freezes and clears (cite)", "R3", "K3"},
    {"S8: a closed-out rotation watermark freezes and clears (nil)", "R3", "K3"},
    {"S9: a resolution carrying the watermark's Thread clears", "R2t", "K2t"},
    {"S9: a resolution dropping the watermark's Thread stays frozen", nil, nil},
    {"S10: a rotation from an ancestor catalog forks until a resolution cites both", "Rs", "KRs"},
    {"S10: a rotation from the current catalog is a planned rotation", nil, nil},
    {"S11: three rotation heads under a refused watermark are resolved by one citation", "R2",
     "K2"},
    {"S12: a resolution with fresh routes clears", "R2f", "K2f"},
    {"S12: a route served earlier is never re-pointed", nil, nil},
    {"S13: a missing watermark catalog is a derived block that does not freeze", nil, nil},
    {"S14: a catalog accepted before the closing resolution freezes", nil, nil},
    {"S15: a resolution carrying the watermark's entries without seeing it freezes", "R2", "K2"},
    {"C13: concurrent revoke after accepting R1, then a fresh resolution clears", "R2", "K2"},
    {"C13: a revoke-first client holds R1 as a refused node", "R2", "K2"},
    {"S16a: a withheld page beside a holder change freezes and serves nothing", "R2", "K2"},
    {"S16b: a withheld prior under a refused binding freezes", "R2", "K2"},
    {"S16d: a withheld page beside an honored closing replacement serves nothing without freezing",
     "R", "KR"},
    {"S16i: a refused binding freezes even while its catalog's chain is withheld", nil, nil},
    {"S17a: route-conflicting siblings reserve the route and a fresh-route resolution promotes",
     "R", "KR"},
    {"S17c: a reservation survives a nil citation", nil, nil},
    {"S17a: a resolution keeping a reserved route is refused", nil, nil},
    {"S17e: a resolution keeping the other sibling on a reserved route is refused", nil, nil},
    {"F1: a replacement whose bootstrap is stale in its own prefix is raw evidence", "B", "C0"},
    {"F2: a withheld chain under a rotated ancestor is closed out by a resolution", "R", "KR"},
    {"S17b: a revoked key's route-conflicting catalogs cannot block recovery", "R2", "K2"},
    {"B1: a chain-invalid catalog under a refused node keeps its own reason", nil, nil}
  ]

  # Row 389: enough runs that the route rule and the withheld-page action are exercised.
  @heavy ~w(S4 S12 S17a S17b S17c S17e)
  defp max_runs(name),
    do: if(Enum.any?(@heavy, &String.starts_with?(name, &1 <> ":")), do: 200, else: 50)

  setup_all do
    base = F.base()
    scenarios = Map.new(S.all(base), &{&1.name, &1})

    pools =
      for {name, rstar, kstar} <- @pools do
        s = Map.fetch!(scenarios, name)
        evidence = List.last(s.steps).evidence
        pool = pool(base, evidence)
        {name, pool, s.labels[rstar], s.labels[kstar], frozen_start(base, pool, s.labels["C0"])}
      end

    %{base: base, pools: pools}
  end

  for {name, _r, _k} <- @pools do
    @name name
    property "convergence properties over #{@name}", %{base: base, pools: pools} do
      {_name, pool, rstar, kstar, frozen} = Enum.find(pools, &(elem(&1, 0) == @name))

      if length(pool.items) <= @enumerate do
        for order <- orders(pool.items) do
          deliveries = for i <- 1..length(order), do: {Enum.take(order, i), false}
          check_run(base, pool, deliveries, {rstar, kstar}, frozen, "order")
        end
      end

      check all(seed <- integer(1..1_000_000_000), max_runs: max_runs(@name)) do
        check_run(base, pool, deliveries(pool, seed), {rstar, kstar}, frozen, "seed #{seed}")
      end
    end
  end

  defp check_run(base, pool, deliveries, {rstar, kstar}, frozen, tag) do
    for start <- [F.empty_state() | List.wrap(frozen)] do
      steps = run(base, pool, deliveries, start)
      monotone!(steps)
      merge!(steps, pool, tag)
      covers!(steps, pool, tag)
      watermarks!(steps, pool)
      carried!(steps)
      if rstar && start == F.empty_state(), do: converged!(steps, rstar, kstar, tag)
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

    %{items: Enum.sort(items), ops: ops, evidence: evidence, facts: facts(base, ops, evidence)}
  end

  # A frozen B/C0 watermark: a valid persisted state (the merge rule must not lift it without
  # a clearing resolution, whatever the union holds).
  defp frozen_start(base, pool, c0) do
    case pool.evidence.catalogs[c0] do
      nil ->
        nil

      %{catalog: c} ->
        %{
          accepted: %{
            binding: base.boot.id,
            generation: 0,
            catalog: c0,
            revision: c.revision,
            routes: Map.new(c.entries, &{&1.route, &1.replica})
          },
          frozen: true
        }
    end
  end

  # Every causal order of the items.
  defp orders([]), do: [[]]

  defp orders(items) do
    for {_id, _k, deps} = item <- items,
        rest = List.delete(items, item),
        Enum.all?(deps, fn dep -> not Enum.any?(rest, &(elem(&1, 0) == dep)) end),
        tail <- orders(rest),
        do: [item | tail]
  end

  # A random causal order of the pool's items, cut into cumulative deliveries (the full union
  # last).
  # Row 389 (C1): some intermediate deliveries also hold an unresolvable page (an op whose
  # dependency is a random hash and a keyless catalog with an unknown binding) whose completion
  # never arrives; the final delivery evicts it (the 4c simulation).
  defp deliveries(pool, seed) do
    :rand.seed(:exsss, {seed, seed + 7, seed + 13})
    order = topo(pool.items, MapSet.new(), [])
    n = length(order)
    cuts = for i <- 1..n, i == n or :rand.uniform(2) == 1, do: i
    Enum.map(cuts, &{Enum.take(order, &1), &1 != n and :rand.uniform(3) == 1})
  end

  defp topo([], _placed, acc), do: Enum.reverse(acc)

  defp topo(items, placed, acc) do
    ready =
      Enum.filter(items, fn {_id, _k, deps} -> Enum.all?(deps, &MapSet.member?(placed, &1)) end)

    {id, _k, _deps} = pick = Enum.at(ready, :rand.uniform(length(ready)) - 1)
    topo(List.delete(items, pick), MapSet.put(placed, id), [pick | acc])
  end

  defp evidence(base, pool, {prefix, unresolvable?}) do
    ops = for {id, :op, _} <- prefix, do: pool.ops[id]
    ids = MapSet.new(prefix, &elem(&1, 0))
    log = F.append(base.log, ops)
    catalogs = Map.filter(pool.evidence.catalogs, fn {id, _} -> MapSet.member?(ids, id) end)

    {log, catalogs} =
      if unresolvable? do
        o = F.beacon(base, [F.id("property-orphan-dep")], 9)
        u = unknown_binding(base)

        {Log.from_ops(log.replica, Map.put(Log.ops(log), o.id, o)),
         Map.put(catalogs, F.cid(u), u)}
      else
        {log, catalogs}
      end

    %{
      space: log,
      rotations: Map.filter(pool.evidence.rotations, fn {id, _} -> MapSet.member?(ids, id) end),
      catalogs: catalogs,
      proven: pool.evidence.proven
    }
  end

  defp unknown_binding(base),
    do:
      F.catalog(
        base,
        F.id("property-unknown-binding"),
        0,
        nil,
        F.identity("property-unknown-signer"),
        F.base_entries(base, "property-unknown")
      )

  defp run(base, pool, deliveries, start) do
    deliveries
    |> Enum.map_reduce(start, fn prefix, state ->
      evidence = evidence(base, pool, prefix)
      {result, next} = F.deliver(base, state, evidence)
      result = with_complete_part(base, state, evidence, result)
      {%{state: state, result: result, next: next}, F.persisted(next)}
    end)
    |> elem(0)
  end

  # The complete part of a trust_pending union: the same evidence without the pending ids. It
  # must resolve (every pending artifact is outside the complete part, row 386 lemma); the
  # oracle derives the expected freeze bit and serving from it.
  defp with_complete_part(base, state, evidence, {:error, :trust_pending, detail}) do
    ids = detail.ids
    ops = evidence.space |> Log.ops() |> Map.drop(ids)

    dropped = %{
      evidence
      | space: Log.from_ops(evidence.space.replica, ops),
        rotations: Map.drop(evidence.rotations, ids),
        catalogs: Map.drop(evidence.catalogs, ids)
    }

    {part, _} = F.deliver(base, %{state | frozen: false}, dropped)

    assert match?({:ok, _}, part) or match?({:error, :control_history_limit, _}, part),
           "(h1) the complete part of #{inspect(ids)} is #{inspect(elem(part, 1))}"

    {:error, :trust_pending, Map.put(detail, :complete_part, part)}
  end

  defp with_complete_part(_base, _state, _evidence, result), do: result

  # --- the oracle's facts (artifact bytes only) -----------------------------------------

  # Parents and priors of every binding artifact, and each catalog's binding, `previous` and
  # CatLineage parent (`previous`, or a first catalog under a rotation's prior catalog).
  defp facts(base, ops, evidence) do
    replacements =
      for {id, %{body: {:replace_catalog_v1, [claim | _]}}} <- ops,
          is_map(claim),
          into: %{},
          do: {id, %{kind: :replacement, parents: claim.parents, prior: claim.prior_catalogs}}

    rotations =
      Map.new(evidence.rotations, fn {id, e} ->
        r = e.rotation

        {id,
         %{
           kind: :rotation,
           parents: [r.parent],
           prior: [%{binding: r.parent, catalog: r.prior_catalog}]
         }}
      end)

    bindings =
      replacements
      |> Map.merge(rotations)
      |> Map.put(base.boot.id, %{kind: :bootstrap, parents: [], prior: []})

    lineage =
      Map.new(evidence.catalogs, fn {id, %{catalog: c}} ->
        parent =
          case {c.previous, rotations[c.binding]} do
            {nil, %{prior: [%{catalog: prior}]}} -> prior
            {previous, _} -> previous
          end

        {id, parent}
      end)

    previous = Map.new(evidence.catalogs, fn {id, e} -> {id, e.catalog.previous} end)
    %{bindings: bindings, lineage: lineage, previous: previous}
  end

  defp anc(facts, ids), do: anc(facts, ids, MapSet.new())
  defp anc(_facts, [], acc), do: acc

  defp anc(facts, [id | rest], acc) do
    if MapSet.member?(acc, id),
      do: anc(facts, rest, acc),
      else: anc(facts, parents(facts, id) ++ rest, MapSet.put(acc, id))
  end

  defp parents(facts, id), do: get_in(facts.bindings, [id, :parents]) || []

  defp chain?(a, b, links, seen \\ MapSet.new()) do
    cond do
      a == b -> true
      b == nil or MapSet.member?(seen, b) -> false
      true -> chain?(a, Map.get(links, b), links, MapSet.put(seen, b))
    end
  end

  # --- the oracle ---------------------------------------------------------------------

  defp binding_held?(a, g),
    do: Map.has_key?(g.nodes, a.binding) or Map.has_key?(g.closed_out, a.binding)

  # The watermark catalog is held when its own verdict is out of pending (row 386 lemma).
  defp held?(a, g) do
    binding_held?(a, g) and g.verdicts[a.catalog] not in [nil, :pending] and
      Map.get(g.catalog_status, a.catalog) in [
        :covered,
        :closed_out,
        :uncovered,
        :current,
        :refused
      ]
  end

  # C6: a refused or closed-out binding is a change even when its catalog is not held.
  defp changed?(nil, _g), do: false

  defp changed?(a, g) do
    match?(%{refused?: true}, g.nodes[a.binding]) or Map.has_key?(g.closed_out, a.binding) or
      (held?(a, g) and g.catalog_status[a.catalog] in [:refused, :closed_out, :uncovered])
  end

  # An honored replacement in H's lineage that the watermark binding did not descend from.
  defp clears?(nil, _h, _g, _facts), do: false

  defp clears?(a, h, g, facts) do
    seen = anc(facts, [a.binding])

    facts
    |> anc([h])
    |> Enum.any?(fn x ->
      not MapSet.member?(seen, x) and match?(%{kind: :replacement, refused?: false}, g.nodes[x])
    end)
  end

  defp seen?(a, h, g, facts) do
    lineage = anc(facts, [h])

    cited =
      for id <- lineage,
          %{catalog: c} <- get_in(facts.bindings, [id, :prior]) || [],
          c != nil,
          do: c

    Enum.any?(cited, &chain?(a.catalog, &1, facts.lineage)) or
      closed_by_descendant?(a, lineage, g, facts)
  end

  defp closed_by_descendant?(a, lineage, g, facts) do
    target = target(a.binding, g, facts)

    closers =
      for {x, %{kind: :replacement, prior: prior}} <- facts.bindings,
          Map.has_key?(g.nodes, x),
          %{binding: ^target, catalog: c} <- prior,
          c == nil or (c != a.catalog and chain?(c, a.catalog, facts.lineage)),
          do: x

    Enum.any?(lineage, fn y ->
      facts.bindings[y].kind == :replacement and
        Enum.any?(closers, &(&1 != y and MapSet.member?(anc(facts, [y]), &1)))
    end)
  end

  defp target(binding, g, facts) do
    case facts.bindings[binding] do
      %{kind: :rotation, parents: [parent]} ->
        if binding in g.closed, do: binding, else: target(parent, g, facts)

      _ ->
        binding
    end
  end

  defp route_compat?(routes, entries),
    do: Enum.all?(entries, &(Map.get(routes, &1.route, &1.replica) == &1.replica))

  # Serving without promotion: the watermark catalog while it is held, unchanged, its binding
  # open and eligible, nothing forks and its routes agree with every route served.
  defp keep_serving(nil, _g), do: nil

  defp keep_serving(a, g) do
    if held?(a, g) and not changed?(a, g) and g.forks == [] and Map.has_key?(g.nodes, a.binding) and
         a.binding not in g.closed and
         route_compat?(a.routes, g.catalogs[a.catalog].entries),
       do: a.catalog
  end

  # Design section 1.3, recomputed from the oracle.
  defp model(state, {:ok, g}, facts) do
    d = g.decision
    a = state.accepted

    cond do
      d.accepted and (not state.frozen or clears?(a, d.head, g, facts)) ->
        k = g.catalogs[d.catalog]
        base = if a, do: a.routes, else: %{}
        routes = Enum.reduce(k.entries, base, &Map.put(&2, &1.route, &1.replica))

        accepted = %{
          binding: d.head,
          generation: d.generation,
          catalog: d.catalog,
          revision: k.revision,
          routes: routes
        }

        %{accepted: accepted, frozen: false, serving: d.catalog}

      not d.accepted and changed?(a, g) ->
        %{accepted: a, frozen: true, serving: nil}

      state.frozen ->
        %{accepted: a, frozen: true, serving: nil}

      true ->
        %{accepted: a, frozen: false, serving: keep_serving(a, g)}
    end
  end

  # Row 386, repair (a): the freeze bit and serving of the complete part (the graph of the union
  # without the pending ids, which must itself resolve), ORed into the sticky `frozen`.
  defp model(state, {:error, :trust_pending, _} = result, facts) do
    case complete_part(result) do
      {:ok, g} ->
        a = state.accepted
        freeze = not g.decision.accepted and changed?(a, g)
        frozen = state.frozen or freeze
        %{accepted: a, frozen: frozen, serving: if(frozen, do: nil, else: keep_serving(a, g))}

      _ ->
        _ = facts
        %{accepted: state.accepted, frozen: state.frozen, serving: nil}
    end
  end

  defp model(state, {:error, _, _}, _facts),
    do: %{accepted: state.accepted, frozen: state.frozen, serving: nil}

  defp complete_part({:error, :trust_pending, %{complete_part: g}}), do: g
  defp complete_part(_), do: nil

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

  defp merge!(steps, pool, tag) do
    for %{state: state, result: result, next: next} <- steps do
      expected = model(state, result, pool.facts)

      assert next == expected,
             "(m) #{tag}: merge of #{inspect(state, limit: 4)} gave " <>
               "#{inspect(Map.take(next, [:frozen, :serving]))}, the oracle " <>
               "#{inspect(Map.take(expected, [:frozen, :serving]))}"

      # (h3) nothing is served while frozen.
      if next.frozen, do: assert(next.serving == nil, "(h3) #{tag}: served while frozen")

      # (h2) a freeze is sticky through every error.
      if match?({:error, _, _}, result) and state.frozen,
        do: assert(next.frozen, "(h2) #{tag}: an error lifted the freeze")

      pending!(state, result, tag)
    end
  end

  # (h1) the trust_pending detail is the complete part's: its freeze bit is a non-accepting
  # change of the watermark, and its serving is the watermark's own, never served under a
  # changed or closed binding.
  defp pending!(state, {:error, :trust_pending, %{complete_part: {:ok, g}} = d}, tag) do
    a = state.accepted
    freeze = not g.decision.accepted and changed?(a, g)
    assert d.freeze == freeze, "(h1) #{tag}: freeze #{d.freeze}, the complete part's #{freeze}"
    assert d.serving == keep_serving(a, g), "(h1) #{tag}: serving #{inspect(d.serving)}"

    if a && (changed?(a, g) or a.binding in g.closed),
      do: assert(d.serving == nil, "(h3) #{tag}: served under a changed or closed watermark")
  end

  defp pending!(_state, _result, _tag), do: :ok

  defp covers!(steps, pool, tag) do
    for %{state: %{accepted: a}, result: {:ok, %{decision: %{accepted: true} = d} = g}} <- steps do
      k = g.catalogs[d.catalog]

      assert d.clears_authority_changed == clears?(a, d.head, g, pool.facts),
             "(c) #{tag}: clears of #{d.head}"

      if a do
        assert route_compat?(a.routes, k.entries), "(c) #{tag}: #{d.catalog} re-points a route"

        if d.head == a.binding do
          assert chain?(a.catalog, d.catalog, pool.facts.previous) and k.revision >= a.revision,
                 "(c) #{tag}: #{d.catalog} is no descendant of #{a.catalog}"
        else
          assert seen?(a, d.head, g, pool.facts),
                 "(c) #{tag}: #{d.head} has not seen #{a.catalog}"

          assert extends?(entries(pool, a.catalog), k.entries),
                 "(c) #{tag}: #{d.catalog} does not carry #{a.catalog}"
        end
      end
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

  defp converged!(steps, rstar, kstar, tag) do
    %{next: next} = List.last(steps)

    assert next.frozen == false and next.accepted != nil and
             {next.accepted.binding, next.accepted.catalog} == {rstar, kstar},
           "(e2) #{tag} ended at #{inspect(next.accepted && next.accepted.binding)}, " <>
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
