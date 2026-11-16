defmodule Treehouse.CatalogResolutionModel do
  @moduledoc """
  PR #221 evidence (row 389 remainder): an independent reference model of what an honest outcome
  of the replacement resolver must satisfy, written from the contract
  (`docs/research/treehouse_catalog_lifecycle.md` sections 2 to 4 and 7, plan 316 sections 1, 3
  and 4) and the public `Treehouse.CatalogBindingGraph` input/output shapes only. It is not a
  second resolver: it states safety invariants and liveness obligations over a generated
  history, and derives every verdict it needs from the artifact bytes the generator produced
  plus Core's own `Lattice.Authority.analyze/2`. It never reads `graph.closed`,
  `graph.refusals`, `graph.raw_evidence` or any other resolver classification to decide what
  the outcome must be (property M reads them only to check the resolver against itself over
  time).

  Model facts (from bytes, `Treehouse.CatalogResolutionWorld` records them):

    * `Closing(R)`: an honest replacement R (authored by a currently valid admin and passing
      the public authoring coverage check) whose own evidence is complete: its causal closure,
      every cited parent and every cited non-nil prior catalog are delivered. Contract
      section 4 and D-275/D-276/OD-16: such a node closes every ancestor-or-self of each of its
      parents to old-key children, whether or not the full union later refuses R (a refused
      eligible node still closes).
    * `Closed`: the union of ancestor-or-self sets of `Closing(R).parents`.
    * `ClosedOut(X)`: a rotation X whose parent is closed or closed out (an uncovered old-key
      child of a closed binding, D-275), unless X itself is cited.
    * `ClosedOutCatalog(K)`: a catalog K under a binding X directly cited by a closing R, where
      K is not an ancestor-or-self (by `previous`) of the prior R cited for X; a `nil` citation
      closes out every catalog under X.
    * `Refused(X)`: a replacement op X that Core quarantines on the complete delivered Space
      log (the ops whose dependency closure is delivered), contract section 3 step 2.

  Safety invariants checked after every delivery (the persisted state is the caller's
  `%{accepted, frozen}` merged by the public `advance/2`):

    * S1: the served catalog is held, and neither its binding nor the catalog is closed,
      closed out or refused on complete authenticated evidence.
    * FZ (S1, freeze half; lifecycle section 4 "authority_changed": stop new use, do not fall
      back to the old signer): when the watermark is unchanged by the delivery and its binding
      is refused or closed out, or its catalog is closed out, `frozen` is true after `advance`.
      A `control_history_limit` result is exempt (no switching, nothing served; S1 still holds).
    * S2: a `trust_pending` result never moves the watermark and never lifts a freeze; a freeze
      is only lifted by moving the watermark to an honest replacement that is not refused; the
      watermark never moves to a closed, closed-out or refused binding or a closed-out catalog.
    * S3: when the watermark moves, every replica of the previous accepted catalog is still
      listed (lifecycle section 2: no removal of a listed Thread); when it moves onto a
      replacement binding, every replica of every cited held prior catalog is listed (plan 316
      step 5); the new binding's own cutoffs, and for a rotation those inherited from its
      rotation chain up to the nearest replacement, are proven (lifecycle section 3,
      `recovery_incomplete` gates promotion); no cumulative route is remapped.
    * M (D-279): an id once accepted is never later raw evidence or an intrinsic refusal; an id
      once intrinsically refused or raw is never later accepted.

  Liveness obligations (contract section 4 "Fresh valid admin resolution", plan 316 row g and
  the operator rule that a changed authority freezes routes rather than falling back):

    * L: after any adversary activity, an honest admin (a fresh, finite, unexpired root
      acquisition with `replace_catalog_v1`) can author through the public coverage check a
      resolution citing every current head and a choice of retained catalog heads, with fresh
      routes and full cutoff proofs, whose delivery is accepted, clears any freeze and serves
      its first catalog.
    * O: the persisted outcome after that resolution is independent of delivery order.

  Preconditions, taken only from the contract's non-claims (lifecycle section 4, plan 316
  section 10): liveness is not claimed against withheld unknown Space ops, so L is checked on a
  causally closed Space log (every Space frame is eventually delivered, in any order); a
  catalog or rotation the adversary withholds forever is in scope. The permanently withheld
  Space dependency variant is run separately and reported on its own.
  """

  alias Lattice.{Authority, Log}

  @intrinsic ~w(invalid_catalog_transition wrong_catalog_scope malformed_catalog invalid_catalog_signature invalid_possession)a

  # --- model facts ------------------------------------------------------------------

  @doc "Space ops whose whole dependency closure is delivered."
  def complete_ops(ops) do
    fix(ops, %{})
  end

  defp fix(ops, done) do
    next =
      Enum.reduce(ops, done, fn {id, op}, acc ->
        if Map.has_key?(acc, id) or not Enum.all?(op.deps, &Map.has_key?(acc, &1)),
          do: acc,
          else: Map.put(acc, id, op)
      end)

    if map_size(next) == map_size(done), do: done, else: fix(ops, next)
  end

  @doc "The facts the model derives for one delivered union."
  def facts(world, delivered) do
    complete = complete_ops(delivered.ops)
    log = Log.from_ops(world.base.replica, complete)
    quarantine = Authority.analyze(Treehouse.Space, log).quarantine

    # Only delivered binding artifacts evidence their own parents (a cited but unheld rotation
    # is closed itself; its ancestry is not yet evidence).
    held = held_bindings(world, delivered, complete)

    # A closing node's own evidence must be complete: its op closure, every cited parent and
    # every cited non-nil prior catalog held (a pending candidate's verdict is not yet fixed).
    closing =
      for {id, b} <- world.bindings,
          b.kind == :replacement and b.honest and Map.has_key?(complete, id),
          Enum.all?(b.parents, &MapSet.member?(held, &1)),
          Enum.all?(
            b.prior_catalogs,
            &(&1.catalog == nil or chain_held?(world, delivered, &1.catalog))
          ),
          do: id

    closed =
      closing
      |> Enum.flat_map(&world.bindings[&1].parents)
      |> Enum.reduce(MapSet.new(), &MapSet.union(&2, ancestry(world, &1, held)))

    cited = MapSet.new(Enum.flat_map(closing, &world.bindings[&1].parents))

    refused =
      for {id, b} <- world.bindings,
          b.kind == :replacement and MapSet.member?(quarantine, id),
          into: MapSet.new(),
          do: id

    %{
      held: held,
      closing: closing,
      closed: closed,
      cited: cited,
      refused: refused,
      complete?: map_size(complete) == map_size(delivered.ops)
    }
  end

  # A catalog and its whole `previous` chain are delivered.
  defp chain_held?(world, delivered, cid) do
    Map.has_key?(delivered.catalogs, cid) and
      case world.catalogs[cid] do
        %{previous: prev} when is_binary(prev) -> chain_held?(world, delivered, prev)
        _ -> true
      end
  end

  # Bindings whose own evidence is complete, to a fixpoint: the bootstrap; a delivered rotation
  # whose parent is complete and whose prior catalog is held; a replacement whose op closure is
  # delivered, whose parents are complete and whose cited non-nil priors are held.
  defp held_bindings(world, delivered, complete) do
    Stream.iterate(MapSet.new([world.base.boot.id]), fn acc ->
      Enum.reduce(world.bindings, acc, fn {id, b}, acc ->
        ok? =
          case b.kind do
            :rotation ->
              Map.has_key?(delivered.rotations, id) and
                Enum.all?(b.parents, &MapSet.member?(acc, &1)) and
                chain_held?(world, delivered, b.prior_catalog)

            :replacement ->
              Map.has_key?(complete, id) and Enum.all?(b.parents, &MapSet.member?(acc, &1)) and
                Enum.all?(
                  b.prior_catalogs,
                  &(&1.catalog == nil or chain_held?(world, delivered, &1.catalog))
                )

            _ ->
              true
          end

        if ok?, do: MapSet.put(acc, id), else: acc
      end)
    end)
    |> Stream.chunk_every(2, 1)
    |> Enum.find(fn [x, y] -> MapSet.equal?(x, y) end)
    |> hd()
  end

  @doc "Ancestor-or-self binding ids by declared parents (bytes), through `held` bindings only."
  def ancestry(world, id, held \\ nil), do: ancestry(world, [id], MapSet.new(), held)
  defp ancestry(_world, [], acc, _held), do: acc

  defp ancestry(world, [id | rest], acc, held) do
    if MapSet.member?(acc, id) do
      ancestry(world, rest, acc, held)
    else
      parents =
        if held == nil or MapSet.member?(held, id),
          do: get_in(world.bindings, [id, :parents]) || [],
          else: []

      ancestry(world, parents ++ rest, MapSet.put(acc, id), held)
    end
  end

  def closed_out?(world, facts, id) do
    b = world.bindings[id]

    cond do
      b == nil ->
        false

      not MapSet.member?(facts.held, id) ->
        false

      MapSet.member?(facts.cited, id) ->
        false

      b.kind != :rotation ->
        false

      true ->
        Enum.any?(b.parents, &(MapSet.member?(facts.closed, &1) or closed_out?(world, facts, &1)))
    end
  end

  def changed_binding?(world, facts, id),
    do: MapSet.member?(facts.refused, id) or closed_out?(world, facts, id)

  def unservable_binding?(world, facts, id),
    do: MapSet.member?(facts.closed, id) or changed_binding?(world, facts, id)

  @doc "A catalog past every prior a closing replacement cites for its binding."
  def closed_out_catalog?(world, facts, cid) do
    case world.catalogs[cid] do
      nil ->
        false

      %{binding: x} ->
        priors =
          for r <- facts.closing,
              p <- world.bindings[r].prior_catalogs,
              p.binding == x,
              do: p.catalog

        priors != [] and not Enum.any?(priors, &(&1 != nil and catalog_ancestor?(world, cid, &1)))
    end
  end

  # Is `a` an ancestor-or-self of `b` by `previous` links (bytes)?
  defp catalog_ancestor?(_world, a, a), do: true

  defp catalog_ancestor?(world, a, b) do
    case world.catalogs[b] do
      %{previous: prev} when is_binary(prev) -> catalog_ancestor?(world, a, prev)
      _ -> false
    end
  end

  # --- safety per delivery -------------------------------------------------------------

  @doc """
  Check one delivery. `step` is `%{label, item, delivered, result, prev, next}`. Returns a list
  of `{property, message}` violations (empty when the step is honest).
  """
  def check_step(world, step) do
    f = facts(world, step.delivered)

    s1(world, f, step) ++ fz(world, f, step) ++ s2(world, f, step) ++ s3(world, step)
  end

  defp s1(world, f, %{next: next, delivered: d}) do
    case next.serving do
      nil ->
        []

      cid ->
        k = world.catalogs[cid]

        cond do
          k == nil or not Map.has_key?(d.catalogs, cid) ->
            [{:s1, "serves #{label(world, cid)}, which is not held"}]

          unservable_binding?(world, f, k.binding) ->
            [{:s1, "serves #{label(world, cid)} under #{why(world, f, k.binding)}"}]

          closed_out_catalog?(world, f, cid) ->
            [{:s1, "serves closed-out catalog #{label(world, cid)}"}]

          true ->
            []
        end
    end
  end

  defp fz(_world, _f, %{result: {:error, :control_history_limit, _}}), do: []

  defp fz(world, f, %{prev: prev, next: next}) do
    a = prev.accepted

    cond do
      a == nil or next.accepted != a ->
        []

      changed_binding?(world, f, a.binding) and not next.frozen ->
        [{:fz, "watermark binding #{why(world, f, a.binding)} but frozen is false"}]

      closed_out_catalog?(world, f, a.catalog) and not next.frozen ->
        [{:fz, "watermark catalog #{label(world, a.catalog)} is closed out but frozen is false"}]

      true ->
        []
    end
  end

  defp s2(world, f, step),
    do: s2_pending(step) ++ s2_lifted(world, f, step) ++ s2_moved(world, f, step)

  defp s2_pending(%{result: {:error, :trust_pending, _}, prev: prev, next: next}) do
    cond do
      next.accepted != prev.accepted -> [{:s2, "trust_pending moved the watermark"}]
      prev.frozen and not next.frozen -> [{:s2, "trust_pending lifted the freeze"}]
      true -> []
    end
  end

  defp s2_pending(_step), do: []

  defp s2_lifted(world, f, %{prev: %{frozen: true}, next: %{frozen: false} = next}) do
    b = next.accepted && next.accepted.binding
    rb = b && world.bindings[b]

    if rb && rb.kind == :replacement && rb.honest && not MapSet.member?(f.refused, b),
      do: [],
      else: [{:s2, "freeze lifted onto #{label(world, b)}"}]
  end

  defp s2_lifted(_world, _f, _step), do: []

  defp s2_moved(world, f, %{prev: prev, next: %{accepted: %{} = a}}) when a != prev.accepted do
    cond do
      unservable_binding?(world, f, a.binding) ->
        [{:s2, "watermark moved onto #{why(world, f, a.binding)}"}]

      closed_out_catalog?(world, f, a.catalog) ->
        [{:s2, "watermark moved onto closed-out catalog #{label(world, a.catalog)}"}]

      true ->
        []
    end
  end

  defp s2_moved(_world, _f, _step), do: []

  defp s3(world, %{prev: prev, next: next, delivered: d}) do
    a = prev.accepted
    n = next.accepted

    if n == nil or n == a or (a != nil and a.catalog == n.catalog) do
      []
    else
      new_entries = entries(world, n.catalog)
      new_replicas = MapSet.new(new_entries, & &1.replica)

      retained =
        if a do
          for e <- entries(world, a.catalog),
              not MapSet.member?(new_replicas, e.replica),
              do:
                {:s3, "watermark move drops retained #{e.replica} of #{label(world, a.catalog)}"}
        else
          []
        end

      floor =
        case world.bindings[n.binding] do
          %{kind: :replacement, prior_catalogs: priors} ->
            for %{catalog: c} <- priors,
                c != nil and Map.has_key?(d.catalogs, c),
                e <- entries(world, c),
                not MapSet.member?(new_replicas, e.replica),
                do:
                  {:s3,
                   "#{label(world, n.catalog)} drops #{e.replica} of cited prior #{label(world, c)}"}

          _ ->
            []
        end

      proven = MapSet.new(d.proven)

      cutoffs =
        for {y, c} <- required_cutoffs(world, n.binding),
            not MapSet.member?(proven, c),
            do:
              {:s3,
               "#{label(world, n.binding)} accepted without proven cutoff of #{label(world, y)}"}

      routes = if a, do: Map.get(a, :routes, %{}), else: %{}

      remapped =
        for e <- new_entries,
            Map.get(routes, e.route, e.replica) != e.replica,
            do: {:s3, "route #{e.route} remapped"}

      retained ++ floor ++ Enum.uniq(cutoffs) ++ remapped
    end
  end

  @doc """
  The cutoffs a binding's promotion needs: its own, and for a rotation those of its rotation
  parent chain up to the nearest replacement (a rotation keeps its parent's service identity,
  so the promised restore cutoff of that service still applies; lifecycle section 3, "restore
  readiness against the new identity and exact promised cutoff"). The bootstrap has none.
  """
  def required_cutoffs(world, id) do
    case world.bindings[id] do
      %{kind: :rotation, parents: [p], cutoffs: own} ->
        Enum.map(own, &{id, &1}) ++ required_cutoffs(world, p)

      %{kind: :replacement, cutoffs: own} ->
        Enum.map(own, &{id, &1})

      _ ->
        []
    end
  end

  # --- M: D-279 over a run ------------------------------------------------------------------

  @doc "D-279 monotonicity over the resolver's own verdicts across a run's steps."
  def check_monotone(world, steps) do
    {violations, _} =
      Enum.reduce(steps, {[], {MapSet.new(), MapSet.new()}}, fn step, {acc, {ok_ids, bad_ids}} ->
        accepted =
          case step.next.accepted do
            nil -> []
            a -> [a.binding, a.catalog]
          end

        bad =
          case step.result do
            {:ok, g} ->
              Map.keys(g.raw_evidence) ++
                for {id, r} <- g.refusals, r.reason in @intrinsic, do: id

            _ ->
              []
          end

        v1 =
          for id <- bad,
              MapSet.member?(ok_ids, id),
              do:
                {:m,
                 "#{label(world, id)} accepted earlier is intrinsically refused at #{step.label}"}

        v2 =
          for id <- accepted,
              MapSet.member?(bad_ids, id),
              do:
                {:m,
                 "#{label(world, id)} intrinsically refused earlier is accepted at #{step.label}"}

        {acc ++ v1 ++ v2,
         {MapSet.union(ok_ids, MapSet.new(accepted)), MapSet.union(bad_ids, MapSet.new(bad))}}
      end)

    Enum.uniq(violations)
  end

  # --- L: the honest outcome of the final resolution ------------------------------------

  @doc "The honest resolution's delivery must accept it, clear any freeze and serve it."
  def check_liveness(%{r: r, k: k, next: next, result: result}) do
    cid = Treehouse.TransportCatalog.catalog_id(k.catalog)

    cond do
      next.accepted == nil or next.accepted.binding != r.id ->
        {:error, :verifier_refused, decision(result)}

      next.accepted.catalog != cid or next.serving != cid ->
        {:error, :not_served, decision(result)}

      next.frozen ->
        {:error, :still_frozen, decision(result)}

      true ->
        :ok
    end
  end

  def decision({:ok, g}),
    do: Map.take(g.decision, [:accepted, :reason, :block, :head, :catalog, :serving])

  def decision(other), do: other

  # --- helpers -------------------------------------------------------------------------------

  defp entries(world, cid), do: world.catalogs[cid].env.catalog.entries

  @doc "Replace every known artifact id inside a term by its script label."
  def relabel(world, term) when is_binary(term) do
    if Map.has_key?(world.bindings, term) or Map.has_key?(world.catalogs, term),
      do: label(world, term),
      else: term
  end

  def relabel(world, term) when is_list(term), do: Enum.map(term, &relabel(world, &1))
  def relabel(world, term) when is_tuple(term), do: term |> Tuple.to_list() |> relabel_list(world)

  def relabel(world, %{__struct__: _} = term), do: relabel_struct(world, term)

  def relabel(world, term) when is_map(term),
    do: Map.new(term, fn {k, v} -> {relabel(world, k), relabel(world, v)} end)

  def relabel(_world, term), do: term

  defp relabel_list(list, world), do: list |> Enum.map(&relabel(world, &1)) |> List.to_tuple()
  defp relabel_struct(_world, term), do: term

  def label(_world, nil), do: "nothing"

  def label(world, id) do
    cond do
      b = world.bindings[id] -> b.label
      k = world.catalogs[id] -> k.label
      true -> String.slice(id, 0, 8)
    end
  end

  defp why(world, f, id) do
    tags =
      [
        MapSet.member?(f.closed, id) && "closed",
        closed_out?(world, f, id) && "closed out",
        MapSet.member?(f.refused, id) && "refused"
      ]
      |> Enum.filter(& &1)

    "#{label(world, id)} (#{Enum.join(tags, ", ")})"
  end
end
