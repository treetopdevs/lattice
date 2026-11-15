defmodule Treehouse.CatalogBindingGraph do
  @moduledoc """
  Plan 316 PR 4a: the pure binding-graph resolver for `replace_catalog_v1` (steps 1-3 and
  5-9, D-270, D-275 to D-279, OD-16, OD-17 and row 320). Not wired: nothing in
  `Treehouse.CatalogTrust` calls it yet (4c), so it changes no route, watermark or retained
  client behaviour. It adds no Core primitive, wire atom or quarantine reason, and it produces
  no route.

  Input (`resolve/1`): the honored `bootstrap` (`%{id, record}`), the authenticated `space`
  union log, retained `rotations` and `catalogs` as `%{id => normalized envelope}`, the
  `proven_cutoffs` the caller already verified page-level, and the persisted `accepted` and
  `blocked` state. `blocked` is read only to decide whether `authority_changed` may be lifted;
  this module never writes it and never decides stickiness.

  Intrinsic verdicts. Every Space `replace_catalog_v1` op is a candidate with one verdict: an
  eligible node (D-276: steps 1, 2, 4, 5 and 6 pass; `refused?` when the full union refuses
  it, step 3), raw evidence (any intrinsic failure, with the highest-precedence reason; no head,
  no closure, OD-17) or pending (closure, or a cited parent or prior catalog, not yet held). A
  candidate with an incomplete closure is refuted early only from facts no missing ancestor can
  change (`CatalogReplacementAuthority.refute_without_closure/3`, its own literal bindings and
  possession signatures); otherwise it stays pending. Rotations are nodes when their chain
  checks pass under their parent node and inherit its service, origin, `refused?` and unproven
  recovery cutoffs; a failing rotation is a retained refusal. A verdict only ever moves out of
  pending.

  Union classification (steps 7-8) only reclassifies: the closed set (D-275), closed-out
  rotation and catalog children of closed bindings, heads, forks, catalog heads and per-node
  pending recovery cutoffs. Catalog validity (chain and cited priors) is judged before that
  classification, so a citation never makes an invalid catalog valid. Catalog failures are
  retained refusals, never a resolve error.

  `resolve/1` returns `{:error, reason, detail}` only for malformed input,
  `control_history_limit` (more than two heads) and `trust_pending` (any held op with an
  incomplete closure except a candidate already refuted from its own bytes, a pending
  candidate, a pending rotation, or a pending catalog under an open binding or on a cited
  chain), the highest precedence first; everything else is in the graph and its `decision`.
  """

  alias Lattice.{Authority, Dag, Identity, Log}
  alias Treehouse.{CatalogReplacementAuthority, Space, TransportCatalog}

  @max_safe 9_007_199_254_740_991
  @extended_keys ~w(root genesis creation reference kind schema)a
  @rank %{
    malformed_catalog: 1,
    control_history_limit: 1,
    wrong_catalog_scope: 2,
    trust_pending: 3,
    invalid_catalog_signature: 4,
    invalid_possession: 4,
    catalog_authority_refused: 5,
    invalid_catalog_transition: 6,
    catalog_rollback: 7,
    catalog_fork: 7,
    recovery_incomplete: 8
  }

  @type graph :: map()

  @spec heads(graph()) :: [String.t()]
  def heads(graph), do: graph.heads
  @spec closed(graph()) :: [String.t()]
  def closed(graph), do: graph.closed
  @spec closed_out(graph()) :: %{String.t() => atom()}
  def closed_out(graph), do: graph.closed_out
  @spec node(graph(), String.t()) :: map() | nil
  def node(graph, id), do: Map.get(graph.nodes, id)

  @doc "The precedence rank of a reason (plan 316 section 4; lower wins)."
  @spec rank(atom()) :: pos_integer()
  def rank(reason), do: Map.fetch!(@rank, reason)

  @doc "`max(generations) + 1` within the safe-integer horizon, or `:error` (finding 9)."
  @spec next_generation([non_neg_integer()]) :: {:ok, pos_integer()} | :error
  def next_generation([_ | _] = generations) do
    next = Enum.max(generations) + 1
    if next <= @max_safe, do: {:ok, next}, else: :error
  end

  def next_generation(_), do: :error

  @spec resolve(map()) ::
          {:ok, graph()} | {:error, atom(), %{ids: [String.t()], core_reason: nil}}
  def resolve(input) do
    case context(input) do
      {:ok, ctx} -> run(ctx)
      :error -> {:error, :malformed_catalog, %{ids: [], core_reason: nil}}
    end
  end

  # --- context ----------------------------------------------------------------

  defp context(%{
         bootstrap: %{id: id, record: record} = bootstrap,
         space: %Log{} = space,
         rotations: rotations,
         catalogs: catalogs,
         proven_cutoffs: proven,
         accepted: accepted,
         blocked: blocked
       })
       when is_map(rotations) and is_map(catalogs) and is_list(proven) and is_binary(id) and
              is_map(record) do
    ops = Log.ops(space)
    complete = complete_ids(ops)
    cops = Map.take(ops, MapSet.to_list(complete))
    replica = space.replica

    candidates =
      for {oid, %{kind: :command, body: {:replace_catalog_v1, _}} = op} <- ops,
          into: %{},
          do: {oid, op}

    {:ok,
     %{
       bootstrap: bootstrap,
       replica: replica,
       ops: ops,
       cops: cops,
       complete: complete,
       ancestors: Dag.all_ancestors(cops),
       analysis: Authority.analyze(Space, Log.from_ops(replica, cops)),
       candidates: candidates,
       rotations: rotations,
       catalogs: catalogs,
       proven: MapSet.new(proven, &{&1.replica, &1.log_digest}),
       accepted: accepted,
       blocked: blocked,
       boot_honored: bootstrap_honored?(bootstrap, cops, replica)
     }}
  end

  defp context(_), do: :error

  # An op's closure is complete when every dep is held and itself complete.
  defp complete_ids(ops) do
    ops
    |> Dag.topo_sort()
    |> Enum.reduce(MapSet.new(), fn op, acc ->
      if Enum.all?(op.deps, &MapSet.member?(acc, &1)), do: MapSet.put(acc, op.id), else: acc
    end)
  end

  defp bootstrap_honored?(%{id: id, record: record}, cops, replica) do
    case Map.get(cops, id) do
      %{kind: :command, body: {:catalog_bootstrap_v1, [^record]}} ->
        Authority.analyze(Space, prefix_log(cops, replica, [id])).reasons[id] == nil

      _ ->
        false
    end
  end

  defp prefix_log(cops, replica, seeds),
    do: Log.from_ops(replica, Map.take(cops, MapSet.to_list(Dag.reachable(cops, seeds))))

  # --- run --------------------------------------------------------------------

  defp run(ctx) do
    st = %{memo: %{}, visiting: MapSet.new(), detail: %{}}

    st =
      (Map.keys(ctx.rotations) ++ Map.keys(ctx.candidates))
      |> Enum.sort()
      |> Enum.reduce(st, fn id, st -> id |> eval(ctx, st) |> elem(1) end)

    memo = st.memo

    nodes_all =
      for({id, {:node, n}} <- memo, into: %{}, do: {id, n})
      |> Map.put(ctx.bootstrap.id, bootstrap_node(ctx))

    closed = closed_set(nodes_all)
    out_rot = closed_out_rotations(nodes_all, closed)
    final = Map.drop(nodes_all, MapSet.to_list(out_rot))
    heads = heads_of(final)

    cat = classify_catalogs(Map.put(ctx, :memo, memo), nodes_all, final, closed, out_rot)

    # Any held op whose closure is incomplete is a missing history page (row m): the authority
    # fold over the complete ops would judge a smaller history. Only a candidate already refuted
    # from its own bytes (D-A1) is exempt.
    incomplete =
      for {id, _op} <- ctx.ops,
          not MapSet.member?(ctx.complete, id),
          not match?({:bad, _}, Map.get(memo, id)),
          do: id

    pending =
      (for({id, :pending} <- memo, do: id) ++ cat.pending ++ incomplete)
      |> Enum.uniq()
      |> Enum.sort()

    cond do
      length(heads) > 2 ->
        {:error, :control_history_limit, %{ids: heads, core_reason: nil}}

      pending != [] ->
        {:error, :trust_pending, %{ids: pending, core_reason: nil}}

      true ->
        assemble(ctx, memo, st.detail, nodes_all, final, heads, closed, out_rot, cat)
    end
  end

  # --- binding evaluation (intrinsic) -----------------------------------------

  defp eval(id, ctx, st) do
    cond do
      id == ctx.bootstrap.id -> {{:node, bootstrap_node(ctx)}, st}
      Map.has_key?(st.memo, id) -> {st.memo[id], st}
      MapSet.member?(st.visiting, id) -> {{:bad, :invalid_catalog_transition}, st}
      true -> eval_new(id, ctx, %{st | visiting: MapSet.put(st.visiting, id)})
    end
  end

  defp eval_new(id, ctx, st) do
    {res, st} =
      cond do
        Map.has_key?(ctx.rotations, id) -> eval_rotation(id, ctx, st)
        Map.has_key?(ctx.candidates, id) -> eval_candidate(id, ctx, st)
        Map.has_key?(ctx.ops, id) or Map.has_key?(ctx.catalogs, id) -> {{:bad, :not_binding}, st}
        true -> {:unknown, st}
      end

    st = %{st | visiting: MapSet.delete(st.visiting, id)}

    if res in [:unknown] or match?({:bad, :not_binding}, res),
      do: {res, st},
      else: {res, %{st | memo: Map.put(st.memo, id, res)}}
  end

  defp bootstrap_node(ctx) do
    r = ctx.bootstrap.record

    %{
      id: ctx.bootstrap.id,
      kind: :bootstrap,
      generation: 0,
      key: r.catalog_key,
      service_id: r.service_id,
      service_key: r.service_key,
      origin: r.origin,
      parents: [],
      prior: [],
      inventory: nil,
      refused?: false,
      core_reason: nil,
      pending: []
    }
  end

  # --- rotations --------------------------------------------------------------

  defp eval_rotation(id, ctx, st) do
    e = ctx.rotations[id]
    r = e.rotation

    if r.space != ctx.replica or r.bootstrap != ctx.bootstrap.id do
      {{:bad, :wrong_catalog_scope}, st}
    else
      case eval(r.parent, ctx, st) do
        {{:node, p}, st} -> {rotation_node(id, e, p, ctx), st}
        {{:bad, _}, st} -> {{:bad, :invalid_catalog_transition}, st}
        {_, st} -> {:pending, st}
      end
    end
  end

  defp rotation_node(id, e, p, ctx) do
    r = e.rotation

    cond do
      next_generation([p.generation]) != {:ok, r.generation} ->
        {:bad, :invalid_catalog_transition}

      r.new_catalog_key == p.key or r.new_catalog_key == p.service_key ->
        {:bad, :invalid_catalog_transition}

      not Identity.verify(p.key, TransportCatalog.rotation_bytes(r), e.old_signature) ->
        {:bad, :invalid_catalog_signature}

      not Identity.verify(
        r.new_catalog_key,
        TransportCatalog.rotation_possession_bytes(r),
        e.new_signature
      ) ->
        {:bad, :invalid_possession}

      true ->
        case ctx.catalogs[r.prior_catalog] do
          nil -> :pending
          %{catalog: prior} -> rotation_prior(id, r, p, prior)
        end
    end
  end

  defp rotation_prior(id, r, p, prior) do
    if prior.binding != r.parent or
         TransportCatalog.inventory_id(prior.entries) != r.inventory_digest or
         Enum.map(r.cutoffs, & &1.replica) != Enum.map(prior.entries, & &1.replica) do
      {:bad, :invalid_catalog_transition}
    else
      {:node,
       %{
         id: id,
         kind: :rotation,
         generation: r.generation,
         key: r.new_catalog_key,
         service_id: p.service_id,
         service_key: p.service_key,
         origin: p.origin,
         parents: [r.parent],
         prior: [%{binding: r.parent, catalog: r.prior_catalog}],
         inventory: r.inventory_digest,
         refused?: p.refused?,
         core_reason: p.core_reason,
         # A rotation keeps its parent's service, so it inherits the unproven recovery cutoffs.
         pending: p.pending
       }}
    end
  end

  # --- candidates -------------------------------------------------------------

  defp eval_candidate(id, ctx, st) do
    op = ctx.candidates[id]

    case shape(op, ctx) do
      {:bad, reason} ->
        {{:bad, reason}, st}

      {:ok, claim, catalog, service} ->
        if MapSet.member?(ctx.complete, id),
          do: evaluate(op, claim, {catalog, service}, ctx, st),
          else: {early(op, claim, {catalog, service}, ctx), st}
    end
  end

  # Step 1: closed three-argument shape, claim codec and pinned scope.
  defp shape(%{body: {:replace_catalog_v1, [claim, catalog, service]}}, ctx)
       when is_binary(catalog) and byte_size(catalog) == 64 and is_binary(service) and
              byte_size(service) == 64 do
    record = ctx.bootstrap.record

    case TransportCatalog.normalize_replacement_claim(claim) do
      {:ok, claim} ->
        if claim.version == 1 and claim.product == :treehouse and claim.space == ctx.replica and
             claim.bootstrap == ctx.bootstrap.id and
             claim.profile_genesis == record.profile_genesis and
             claim.profile_id == record.profile_id,
           do: {:ok, claim, catalog, service},
           else: {:bad, :wrong_catalog_scope}

      _ ->
        {:bad, :malformed_catalog}
    end
  end

  defp shape(_op, _ctx), do: {:bad, :malformed_catalog}

  # Literal bindings that read only the op's own bytes.
  defp own_literal?(op, claim),
    do:
      claim.author == op.author and claim.cap == op.cap and
        claim.deps == Enum.sort(Enum.uniq(op.deps))

  defp possession?(claim, {catalog, service}),
    do: TransportCatalog.verify_replacement_possession(claim, catalog, service) == :ok

  # An incomplete closure: refute only from facts no missing ancestor can change.
  defp early(op, claim, possession, ctx) do
    failures =
      if(possession?(claim, possession), do: [], else: [{:invalid_possession, :possession}]) ++
        case CatalogReplacementAuthority.refute_without_closure(ctx.ops, op.author, claim) do
          nil -> []
          predicate -> [{:catalog_authority_refused, predicate}]
        end ++
        if(own_literal?(op, claim),
          do: [],
          else: [{:invalid_catalog_transition, :literal_binding}]
        )

    case lowest(failures) do
      nil -> :pending
      {reason, _why} -> {:bad, reason}
    end
  end

  defp lowest([]), do: nil
  defp lowest(failures), do: Enum.min_by(failures, fn {reason, _} -> @rank[reason] end)

  defp evaluate(op, claim, possession, ctx, st) do
    anc = ctx.ancestors[op.id]
    prefix = prefix_log(ctx.cops, ctx.replica, op.deps)

    literal? =
      own_literal?(op, claim) and MapSet.member?(anc, claim.holder_epoch) and
        MapSet.member?(anc, ctx.bootstrap.id) and ctx.boot_honored

    auth =
      case CatalogReplacementAuthority.check(
             prefix,
             %{author: op.author, cap: op.cap},
             claim,
             ctx.bootstrap.record.space_root
           ) do
        :ok -> own_closure(op, ctx)
        {:error, reason, %{predicate: predicate}} -> [{reason, predicate}]
      end

    {declared, pending?, st} = declared_graph(claim, anc, ctx, st)

    failures =
      auth ++
        if(literal?, do: [], else: [{:invalid_catalog_transition, :literal_binding}]) ++
        if(possession?(claim, possession), do: [], else: [{:invalid_possession, :possession}]) ++
        declared

    case lowest(failures) do
      {reason, why} -> {{:bad, reason}, %{st | detail: Map.put(st.detail, op.id, why)}}
      nil when pending? -> {:pending, st}
      nil -> {{:node, replacement_node(op, claim, ctx)}, st}
    end
  end

  # Step 4, intrinsic Core judgment: Core refusing the op on its own causal closure (its strict
  # prefix plus itself; a revoke or lapse already in the prefix, which `holder_epochs` does not
  # show) is `catalog_authority_refused`. Stage A's own refusal is excluded: its literal and
  # possession checks are re-run above with their own reasons. A refusal that appears only on the
  # wider union is step 3 (`refused?`).
  defp own_closure(op, ctx) do
    case Authority.analyze(Space, prefix_log(ctx.cops, ctx.replica, [op.id])).reasons[op.id] do
      nil -> []
      :application_invalid_catalog -> []
      _core -> [{:catalog_authority_refused, :core_refused_at_prefix}]
    end
  end

  defp replacement_node(op, claim, ctx) do
    core = ctx.analysis.reasons[op.id]

    %{
      id: op.id,
      kind: :replacement,
      generation: claim.generation,
      key: claim.new_catalog_key,
      service_id: claim.new_service_id,
      service_key: claim.new_service_key,
      origin: claim.new_origin,
      parents: claim.parents,
      prior: claim.prior_catalogs,
      inventory: claim.inventory_digest,
      refused?: core != nil,
      core_reason: core,
      pending:
        Enum.reject(claim.cutoffs, &MapSet.member?(ctx.proven, {&1.replica, &1.log_digest}))
    }
  end

  # Steps 5 and 6, intrinsic part. Returns `{failures, pending?, st}`. A cited replacement op
  # outside the deps closure fails before it is evaluated, so recursion follows causality.
  defp declared_graph(claim, anc, ctx, st) do
    {results, st} =
      Enum.map_reduce(claim.parents, st, fn parent, st ->
        cond do
          Map.has_key?(ctx.candidates, parent) and not MapSet.member?(anc, parent) ->
            {{parent, {:bad, :deps}}, st}

          true ->
            {res, st} = eval(parent, ctx, st)
            {{parent, res}, st}
        end
      end)

    known = for {_p, {:node, n}} <- results, do: n
    all_known? = length(known) == length(results)

    parent_failures =
      for {_p, {:bad, why}} <- results do
        {:invalid_catalog_transition, if(why == :deps, do: :deps, else: :parent)}
      end

    held_pending? = Enum.any?(results, fn {_p, res} -> res in [:pending, :unknown] end)

    service_failures =
      for n <- known,
          claim.new_service_key != n.service_key and claim.new_service_id == n.service_id,
          do: {:invalid_catalog_transition, :service}

    generation_failures =
      if all_known? and
           next_generation(Enum.map(known, & &1.generation)) != {:ok, claim.generation},
         do: [{:invalid_catalog_transition, :generation}],
         else: []

    {prior_failures, prior_pending?} = priors(claim, ctx)

    {parent_failures ++ service_failures ++ generation_failures ++ prior_failures,
     held_pending? or prior_pending?, st}
  end

  defp priors(claim, ctx) do
    Enum.reduce(claim.prior_catalogs, {[], false}, fn %{binding: binding, catalog: catalog},
                                                      {fails, pend?} ->
      cond do
        binding not in claim.parents ->
          {[{:invalid_catalog_transition, :prior} | fails], pend?}

        catalog == nil ->
          {fails, pend?}

        not Map.has_key?(ctx.catalogs, catalog) ->
          {fails, true}

        ctx.catalogs[catalog].catalog.binding != binding ->
          {[{:invalid_catalog_transition, :prior} | fails], pend?}

        true ->
          {fails, pend?}
      end
    end)
  end

  # --- closure and heads ------------------------------------------------------

  # D-275: ancestor-or-self of every parent cited by an eligible replacement node.
  defp closed_set(nodes) do
    seeds = for {_id, %{kind: :replacement} = n} <- nodes, p <- n.parents, do: p
    closure(seeds, nodes, MapSet.new())
  end

  defp closure([], _nodes, acc), do: acc

  defp closure([id | rest], nodes, acc) do
    cond do
      MapSet.member?(acc, id) -> closure(rest, nodes, acc)
      Map.has_key?(nodes, id) -> closure(nodes[id].parents ++ rest, nodes, MapSet.put(acc, id))
      true -> closure(rest, nodes, acc)
    end
  end

  # A rotation child of a closed binding that is not itself closed, and anything under it.
  defp closed_out_rotations(nodes, closed) do
    for {id, %{kind: :rotation}} <- nodes, out?(id, nodes, closed), into: MapSet.new(), do: id
  end

  defp out?(id, nodes, closed) do
    [parent] = nodes[id].parents

    cond do
      MapSet.member?(closed, id) -> false
      MapSet.member?(closed, parent) -> true
      true -> nodes[parent].kind == :rotation and out?(parent, nodes, closed)
    end
  end

  defp heads_of(final) do
    cited = closure(for({_id, n} <- final, p <- n.parents, do: p), final, MapSet.new())
    final |> Map.keys() |> Enum.reject(&MapSet.member?(cited, &1)) |> Enum.sort()
  end

  # --- catalogs ---------------------------------------------------------------

  # Two passes. Validity is intrinsic to the catalog bytes, its binding node and its chain
  # (`previous` links and, for a replacement's first catalog, every cited prior): `{:refused,
  # reason}`, `:binding_pending`, `:pending`, `:bad_chain` or `:ok`. Status then classifies a
  # valid catalog: :current (open binding), :covered / :closed_out / :uncovered (closed binding),
  # :refused (with a reason) or :pending. A citation never makes an invalid catalog valid: an
  # invalid cited catalog covers nothing, and a first catalog extending it is itself invalid.
  defp classify_catalogs(ctx, nodes_all, final, closed, out_rot) do
    cites = citations(nodes_all, closed)
    previous = Map.new(ctx.catalogs, fn {id, e} -> {id, e.catalog.previous} end)

    env = %{
      ctx: ctx,
      nodes_all: nodes_all,
      final: final,
      closed: closed,
      out_rot: out_rot,
      cites: cites,
      previous: previous
    }

    ids = ctx.catalogs |> Map.keys() |> Enum.sort()
    validity = Enum.reduce(ids, %{}, fn id, memo -> id |> validity(env, memo) |> elem(1) end)
    env = Map.put(env, :validity, validity)

    acc =
      Enum.reduce(ids, %{status: %{}, refusals: %{}}, fn id, acc ->
        {status, acc} = catalog_status(id, env, acc)
        %{acc | status: Map.put(acc.status, id, status)}
      end)

    acc = route_history(ctx, acc)

    pending = for {id, :pending} <- acc.status, do: id
    Map.merge(acc, %{pending: pending, cites: cites, previous: previous, validity: validity})
  end

  defp refuse(acc, id, reason, core),
    do:
      {:refused,
       %{acc | refusals: Map.put(acc.refusals, id, %{reason: reason, core_reason: core})}}

  # --- pass 1: validity ---------------------------------------------------------

  defp validity(id, env, memo) do
    case Map.fetch(memo, id) do
      {:ok, v} ->
        {v, memo}

      :error ->
        {v, memo} = validity_new(id, env, memo)
        {v, Map.put(memo, id, v)}
    end
  end

  defp validity_new(id, env, memo) do
    e = env.ctx.catalogs[id]
    c = e.catalog
    n = env.nodes_all[c.binding]

    cond do
      c.space != env.ctx.replica or c.bootstrap != env.ctx.bootstrap.id ->
        {{:refused, :wrong_catalog_scope}, memo}

      n == nil ->
        {binding_missing(c.binding, env), memo}

      not Identity.verify(n.key, TransportCatalog.catalog_bytes(c), e.signature) ->
        {{:refused, :invalid_catalog_signature}, memo}

      Enum.any?(c.entries, &({&1.service_id, &1.service_key} != {n.service_id, n.service_key})) ->
        {{:refused, :wrong_catalog_scope}, memo}

      c.previous == nil ->
        first_validity(c, n, env, memo)

      not Map.has_key?(env.ctx.catalogs, c.previous) ->
        {:pending, memo}

      true ->
        chain_validity(c, env, memo)
    end
  end

  # The binding is a refused rotation, raw evidence, pending or unknown.
  defp binding_missing(binding, env) do
    cond do
      Map.has_key?(env.ctx.candidates, binding) or Map.has_key?(env.ctx.rotations, binding) ->
        if Map.has_key?(env.nodes_all, binding) or
             match?({:bad, _}, Map.get(env.ctx.memo, binding)),
           do: {:refused, :invalid_catalog_transition},
           else: :binding_pending

      Map.has_key?(env.ctx.ops, binding) or Map.has_key?(env.ctx.catalogs, binding) ->
        {:refused, :invalid_catalog_transition}

      true ->
        :binding_pending
    end
  end

  defp chain_validity(c, env, memo) do
    {prev, memo} = validity(c.previous, env, memo)
    prior = env.ctx.catalogs[c.previous].catalog

    v =
      cond do
        prev in [:pending, :binding_pending] -> :pending
        prev != :ok or prior.binding != c.binding -> :bad_chain
        next_generation([prior.revision]) != {:ok, c.revision} -> :bad_chain
        not extends?(prior.entries, c.entries) -> :bad_chain
        true -> :ok
      end

    {v, memo}
  end

  # First-catalog checks (plan 316 section 1 (b)): revision 0 for a replacement (the codec
  # already ties revision 0 to `previous: nil`), the declared inventory, and extension of every
  # cited prior, which must itself be valid. A rotation's `prior_catalog` is a cited prior too,
  # so an old-key rotation naming a refused catalog cannot drop a replica either.
  defp first_validity(c, n, env, memo) do
    priors = for %{catalog: k} <- n.prior, k != nil, do: k

    {prior_vs, memo} =
      Enum.map_reduce(priors, memo, fn k, memo ->
        if Map.has_key?(env.ctx.catalogs, k), do: validity(k, env, memo), else: {:pending, memo}
      end)

    extends_all? =
      Enum.all?(priors, fn k ->
        case env.ctx.catalogs[k] do
          nil -> true
          %{catalog: prior} -> extends?(prior.entries, c.entries)
        end
      end)

    v =
      cond do
        n.kind == :replacement and c.revision != 0 ->
          :bad_chain

        n.inventory != nil and TransportCatalog.inventory_id(c.entries) != n.inventory ->
          :bad_chain

        not extends_all? ->
          :bad_chain

        Enum.any?(prior_vs, &(&1 not in [:ok, :pending, :binding_pending])) ->
          :bad_chain

        prior_vs != [] and not Enum.all?(prior_vs, &(&1 == :ok)) ->
          :pending

        true ->
          :ok
      end

    {v, memo}
  end

  # --- pass 2: status -------------------------------------------------------------

  defp catalog_status(id, env, acc) do
    c = env.ctx.catalogs[id].catalog
    n = env.nodes_all[c.binding]

    case env.validity[id] do
      {:refused, reason} ->
        refuse(acc, id, reason, nil)

      :binding_pending ->
        {:pending, acc}

      v ->
        cond do
          n.refused? -> refuse(acc, id, :catalog_authority_refused, n.core_reason)
          MapSet.member?(env.out_rot, c.binding) -> {:closed_out, acc}
          MapSet.member?(env.closed, c.binding) -> closed_status(id, c.binding, v, env, acc)
          v == :pending -> {:pending, acc}
          v == :bad_chain -> refuse(acc, id, :invalid_catalog_transition, nil)
          true -> {:current, acc}
        end
    end
  end

  # Under a closed binding: covered when ancestor-or-self of a valid cited catalog, closed out
  # when a strict descendant of a cited catalog or when the binding was cited with nil,
  # otherwise an omitted head (uncovered, a fork). A catalog on a cited chain is refused when
  # invalid and pending when its chain is; an uncited old-key catalog is never pending, so it
  # cannot stall the resolve.
  defp closed_status(id, binding, v, env, acc) do
    cited = Map.get(env.cites, binding, [])
    real = Enum.reject(cited, &is_nil/1)
    valid = Enum.filter(real, &(env.validity[&1] in [:ok, :pending]))

    cond do
      v == :bad_chain and Enum.any?(real, &on_chain?(id, &1, env.previous)) ->
        refuse(acc, id, :invalid_catalog_transition, nil)

      Enum.any?(valid, &on_chain?(id, &1, env.previous)) ->
        {if(v == :pending, do: :pending, else: :covered), acc}

      Enum.any?(real, &(&1 != id and on_chain?(&1, id, env.previous))) ->
        {:closed_out, acc}

      nil in cited ->
        {:closed_out, acc}

      true ->
        {:uncovered, acc}
    end
  end

  # Is `a` ancestor-or-self of `b` along `previous` links?
  defp on_chain?(a, b, previous, seen \\ MapSet.new()) do
    cond do
      a == b -> true
      b == nil or MapSet.member?(seen, b) -> false
      true -> on_chain?(a, Map.get(previous, b), previous, MapSet.put(seen, b))
    end
  end

  # D-275 / D-10: the catalogs a closed binding was cited with. A replacement cites its parents'
  # `prior_catalogs`; for an ancestor binding a closed rotation's `prior_catalog` stands in.
  defp citations(nodes, closed) do
    for {_id, n} <- nodes,
        n.kind == :replacement or (n.kind == :rotation and MapSet.member?(closed, n.id)),
        %{binding: b, catalog: c} <- n.prior,
        reduce: %{} do
      acc -> Map.update(acc, b, [c], &[c | &1])
    end
  end

  # Across every current or covered catalog a route names one replica (CatalogTrust route
  # history); a later conflicting one (id order) is refused, never a resolve error. Closed-out
  # and uncovered old-key catalogs reserve no route, so they cannot refuse an honest head.
  defp route_history(ctx, acc) do
    ctx.catalogs
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.reduce({%{}, acc}, fn {id, %{catalog: c}}, {used, acc} ->
      if acc.status[id] in [:current, :covered] do
        conflict? =
          Enum.any?(c.entries, fn e -> Map.get(used, e.route, e.replica) != e.replica end)

        if conflict? do
          {:refused, acc} = refuse(acc, id, :invalid_catalog_transition, nil)
          {used, %{acc | status: Map.put(acc.status, id, :refused)}}
        else
          {Enum.reduce(c.entries, used, &Map.put(&2, &1.route, &1.replica)), acc}
        end
      else
        {used, acc}
      end
    end)
    |> elem(1)
  end

  defp extends?(before, next) do
    Enum.all?(before, fn entry ->
      case Enum.find(next, &(&1.replica == entry.replica)) do
        nil -> false
        other -> Map.take(entry, @extended_keys) == Map.take(other, @extended_keys)
      end
    end)
  end

  # --- forks ------------------------------------------------------------------

  defp catalog_heads(final, closed, cat, ctx) do
    current = for {cid, :current} <- cat.status, do: cid

    successors =
      MapSet.new(for cid <- current, p = ctx.catalogs[cid].catalog.previous, p != nil, do: p)

    open = for {id, _} <- final, not MapSet.member?(closed, id), into: MapSet.new(), do: id

    current
    |> Enum.reject(&MapSet.member?(successors, &1))
    |> Enum.filter(&MapSet.member?(open, ctx.catalogs[&1].catalog.binding))
    |> Enum.group_by(&ctx.catalogs[&1].catalog.binding)
    |> Map.new(fn {binding, ids} -> {binding, Enum.sort(ids)} end)
  end

  # The catalog heads a resolution must cite per open binding (authoring coverage): the current
  # heads plus, under a union-refused node, the chain-valid catalogs refused only because that
  # node authorizes nothing (C13: R2 cites `{R1, K1}` after R1 is refused).
  defp citable_catalog_heads(final, closed, cat, ctx) do
    citable =
      for {cid, status} <- cat.status,
          status == :current or
            (status == :refused and cat.validity[cid] == :ok and
               cat.refusals[cid].reason == :catalog_authority_refused),
          do: cid

    successors =
      MapSet.new(for cid <- citable, p = ctx.catalogs[cid].catalog.previous, p != nil, do: p)

    open = for {id, _} <- final, not MapSet.member?(closed, id), into: MapSet.new(), do: id

    citable
    |> Enum.reject(&MapSet.member?(successors, &1))
    |> Enum.filter(&MapSet.member?(open, ctx.catalogs[&1].catalog.binding))
    |> Enum.group_by(&ctx.catalogs[&1].catalog.binding)
    |> Map.new(fn {binding, ids} -> {binding, Enum.sort(ids)} end)
  end

  defp forks(final, heads, closed, cat, cat_heads, ctx) do
    heads_fork = if length(heads) > 1, do: [%{kind: :heads, binding: nil, ids: heads}], else: []

    # Differing claims sharing a nonce fork, sequential reuse included (a child reusing its
    # closed parent's nonce). A group whose members are all closed has been resolved by a later
    # citation, so it no longer forks.
    nonce =
      final
      |> Enum.filter(fn {_id, n} -> n.kind == :replacement end)
      |> Enum.group_by(fn {id, _} -> claim_of(ctx, id).nonce end, &elem(&1, 0))
      |> Enum.flat_map(fn {_nonce, ids} ->
        ids = Enum.sort(ids)

        if length(Enum.uniq(Enum.map(ids, &claim_of(ctx, &1)))) > 1 and
             Enum.any?(ids, &(not MapSet.member?(closed, &1))),
           do: [%{kind: :nonce, binding: nil, ids: ids}],
           else: []
      end)

    split =
      for {binding, [_, _ | _] = ids} <- cat_heads,
          do: %{kind: :catalog, binding: binding, ids: ids}

    uncovered =
      for({cid, :uncovered} <- cat.status, do: cid)
      |> Enum.group_by(&ctx.catalogs[&1].catalog.binding)
      |> Enum.map(fn {binding, ids} ->
        %{kind: :catalog, binding: binding, ids: Enum.sort(ids)}
      end)

    Enum.sort_by(heads_fork ++ nonce ++ split ++ uncovered, &{&1.kind, &1.binding || "", &1.ids})
  end

  defp claim_of(ctx, id) do
    {:ok, claim} =
      ctx.candidates[id].body |> elem(1) |> hd() |> TransportCatalog.normalize_replacement_claim()

    claim
  end

  # --- assembly and decision --------------------------------------------------

  defp assemble(ctx, memo, detail, nodes_all, final, heads, closed, out_rot, cat) do
    closed_out =
      Map.new(out_rot, &{&1, :catalog_rollback})
      |> Map.merge(for({cid, :closed_out} <- cat.status, into: %{}, do: {cid, :catalog_rollback}))

    cat_heads = catalog_heads(final, closed, cat, ctx)

    raw =
      for {id, {:bad, reason}} <- memo,
          Map.has_key?(ctx.candidates, id),
          into: %{},
          do: {id, reason}

    rotation_refusals =
      for {id, {:bad, reason}} <- memo,
          Map.has_key?(ctx.rotations, id),
          into: %{},
          do: {id, %{reason: reason, core_reason: nil}}

    refused_rotations =
      for {id, %{kind: :rotation, refused?: true} = n} <- final,
          into: %{},
          do: {id, %{reason: :catalog_authority_refused, core_reason: n.core_reason}}

    graph = %{
      nodes: final,
      heads: heads,
      closed: closed |> MapSet.to_list() |> Enum.sort(),
      closed_out: closed_out,
      pending: for({id, %{pending: [_ | _]}} <- final, do: id) |> Enum.sort(),
      raw_evidence: raw,
      raw_detail: Map.take(detail, Map.keys(raw)),
      refusals: cat.refusals |> Map.merge(rotation_refusals) |> Map.merge(refused_rotations),
      catalog_heads: cat_heads,
      citable_catalog_heads: citable_catalog_heads(final, closed, cat, ctx),
      catalog_status: cat.status,
      citations: cat.cites,
      previous: cat.previous,
      forks: forks(final, heads, closed, cat, cat_heads, ctx),
      catalogs: Map.new(ctx.catalogs, fn {id, e} -> {id, e.catalog} end),
      decision: nil
    }

    {:ok, %{graph | decision: decide(ctx, graph, nodes_all, closed, out_rot)}}
  end

  defp decide(ctx, graph, nodes_all, closed, out_rot) do
    accepted = ctx.accepted
    abs = accepted_binding_status(accepted, nodes_all, closed, out_rot)
    acs = accepted_catalog_status(accepted, graph)

    base = %{
      accepted: false,
      reason: nil,
      block: nil,
      head: nil,
      catalog: nil,
      generation: nil,
      revision: nil,
      clears_authority_changed: false,
      accepted_binding_status: abs,
      accepted_catalog_status: acs
    }

    if graph.forks != [] do
      ids = graph.forks |> Enum.flat_map(& &1.ids) |> Enum.uniq() |> Enum.sort()
      %{base | reason: :catalog_fork, block: %{reason: :catalog_fork, triggers: ids}}
    else
      [h] = graph.heads
      sole(ctx, graph, h, {abs, acs}, base)
    end
  end

  # Step 9 triggers: the accepted binding refused or closed out, or the accepted catalog
  # closed out or not covered by a citation of its closed binding. "Closed" alone is the
  # ordinary success state and is never a trigger. With an accepted state, an accepted binding
  # or catalog absent from the input fails closed as a trigger rather than promoting silently.
  defp trigger?(nil, _statuses), do: false

  defp trigger?(_accepted, {abs, acs}),
    do: abs in [:refused, :closed_out, :missing] or acs in [:closed_out, :refused, :missing]

  defp sole(ctx, graph, id, statuses, base) do
    node = graph.nodes[id]
    ready = graph.catalog_heads |> Map.get(id, []) |> List.first()
    base = %{base | head: id}
    promotable? = not node.refused? and node.pending == [] and ready != nil

    cond do
      promotable? and row_320?(ctx, graph, id) ->
        promote_or_rollback(ctx, graph, base, id, ready, true)

      promotable? and resolves_refusal?(ctx, graph, id, statuses) ->
        promote_or_rollback(ctx, graph, base, id, ready, false)

      trigger?(ctx.accepted, statuses) ->
        %{
          base
          | reason: :authority_changed,
            block: %{reason: :authority_changed, triggers: triggers(ctx, id)}
        }

      node.refused? ->
        %{base | reason: :catalog_authority_refused}

      node.pending != [] ->
        %{base | reason: :recovery_incomplete}

      ready == nil ->
        base

      true ->
        promote_or_rollback(ctx, graph, base, id, ready, false)
    end
  end

  # A standing `authority_changed` block keeps its triggers (the heads at first block time), so a
  # resolution delivered before its first catalog is still fresh on the next delivery.
  defp triggers(%{blocked: %{reason: :authority_changed, triggers: triggers}}, _id), do: triggers
  defp triggers(_ctx, id), do: [id]

  # Row 320: after an `authority_changed` block, a fresh honored admin resolution (not a block
  # trigger) that closes every trigger, as the sole head, clears it.
  defp row_320?(ctx, graph, id) do
    blocked = ctx.blocked

    with %{reason: :authority_changed, triggers: triggers} <- blocked,
         %{kind: :replacement} <- graph.nodes[id],
         false <- id in triggers do
      closed = MapSet.new(graph.closed)

      Enum.all?(triggers, &MapSet.member?(closed, &1))
    else
      _ -> false
    end
  end

  # A refused accepted binding is resolved in the same delivery by an honored replacement head
  # that closes it and covers the accepted catalog (C13 with the resolution delivered together).
  defp resolves_refusal?(ctx, graph, id, {abs, _acs}) do
    a = ctx.accepted

    abs == :refused and graph.nodes[id].kind == :replacement and a.binding in graph.closed and
      graph.citations
      |> Map.get(a.binding, [])
      |> Enum.any?(&(&1 != nil and on_chain?(a.catalog, &1, graph.previous)))
  end

  defp promote_or_rollback(ctx, graph, base, id, ready, clears?) do
    if rollback?(ctx.accepted, graph, id, ready) do
      %{base | reason: :catalog_rollback}
    else
      %{
        base
        | accepted: true,
          catalog: ready,
          generation: graph.nodes[id].generation,
          revision: graph.catalogs[ready].revision,
          clears_authority_changed: clears?
      }
    end
  end

  # A lower generation, or a lower catalog revision under the accepted binding.
  defp rollback?(nil, _graph, _id, _ready), do: false

  defp rollback?(accepted, graph, id, ready) do
    graph.nodes[id].generation < accepted.generation or
      (id == accepted.binding and graph.catalogs[ready].revision < accepted.revision)
  end

  defp accepted_binding_status(nil, _n, _closed, _o), do: :missing

  defp accepted_binding_status(%{binding: b}, nodes_all, closed, out_rot) do
    cond do
      MapSet.member?(out_rot, b) -> :closed_out
      not Map.has_key?(nodes_all, b) -> :missing
      nodes_all[b].refused? -> :refused
      MapSet.member?(closed, b) -> :closed
      true -> :current
    end
  end

  defp accepted_catalog_status(nil, _g), do: :missing

  defp accepted_catalog_status(%{catalog: c}, graph) do
    case Map.get(graph.catalog_status, c) do
      :covered -> :ancestor_of_cited
      status when status in [:closed_out, :uncovered] -> :closed_out
      :current -> :current
      :refused -> :refused
      _ -> :missing
    end
  end

  # --- authoring coverage -----------------------------------------------------

  @doc """
  Check a candidate claim against a resolved graph, for the authoring preflight (rows 352,
  354, 356). Order: pending (an unheld parent or prior catalog), then transition failures (a
  cited parent that is raw evidence, refused or closed out, wrong generation, service rule),
  then an omitted head (citing a non-head ancestor instead is a sibling of that head) or an
  omitted catalog head (`catalog_fork`), then a prior entry that is not a retained catalog head
  of its parent and first-catalog extension of every cited prior against `entries`. The catalog
  heads are the citable ones: under a union-refused parent its chain-valid catalogs count.
  """
  @spec cover_claim(graph(), map(), [map()]) :: :ok | {:error, atom()}
  def cover_claim(graph, claim, entries) do
    known? = &Map.has_key?(graph.nodes, &1)

    dead? =
      &(Map.has_key?(graph.raw_evidence, &1) or Map.has_key?(graph.closed_out, &1) or
          Map.has_key?(graph.refusals, &1))

    unknown = Enum.reject(claim.parents, known?)
    expected = expected_priors(graph, claim.parents)

    cond do
      Enum.any?(unknown, &(not dead?.(&1))) ->
        {:error, :trust_pending}

      Enum.any?(
        claim.prior_catalogs,
        &(&1.catalog != nil and not Map.has_key?(graph.catalogs, &1.catalog))
      ) ->
        {:error, :trust_pending}

      unknown != [] ->
        {:error, :invalid_catalog_transition}

      next_generation(Enum.map(claim.parents, &graph.nodes[&1].generation)) !=
          {:ok, claim.generation} ->
        {:error, :invalid_catalog_transition}

      Enum.any?(claim.parents, fn p ->
        n = graph.nodes[p]
        claim.new_service_key != n.service_key and claim.new_service_id == n.service_id
      end) ->
        {:error, :invalid_catalog_transition}

      Enum.any?(graph.heads, &(&1 not in claim.parents)) ->
        {:error, :catalog_fork}

      Enum.any?(expected, &(&1 not in claim.prior_catalogs)) ->
        {:error, :catalog_fork}

      Enum.any?(claim.prior_catalogs, &(&1 not in expected)) ->
        {:error, :invalid_catalog_transition}

      Enum.any?(
        claim.prior_catalogs,
        &(&1.catalog != nil and not extends?(graph.catalogs[&1.catalog].entries, entries))
      ) ->
        {:error, :invalid_catalog_transition}

      true ->
        :ok
    end
  end

  defp expected_priors(graph, parents) do
    Enum.flat_map(parents, fn parent ->
      case Map.get(graph.citable_catalog_heads, parent, []) do
        [] -> [%{binding: parent, catalog: nil}]
        heads -> for catalog <- heads, do: %{binding: parent, catalog: catalog}
      end
    end)
  end
end
