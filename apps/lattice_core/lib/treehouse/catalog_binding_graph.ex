defmodule Treehouse.CatalogBindingGraph do
  @moduledoc """
  Plan 316 PR 4a: the pure binding-graph resolver for `replace_catalog_v1` (steps 1-3 and
  5-9, D-270, D-275 to D-279, OD-16, OD-17, row 320, and the convergence design of rows 382
  and 383). Not wired: nothing in `Treehouse.CatalogTrust` calls it yet (4c), so it changes no
  route, watermark or retained client behaviour. It adds no Core primitive, wire atom or
  quarantine reason, and it produces no route.

  Input (`resolve/1`): the honored `bootstrap` (`%{id, record}`), the authenticated `space`
  union log, retained `rotations` and `catalogs` as `%{id => normalized envelope}`, the
  `proven_cutoffs` the caller already verified page-level (whole `{replica, frontier,
  log_digest}` cutoffs, D-A19), and the persisted `accepted` watermark (`%{binding,
  generation, catalog, revision, routes}`, where `routes` is the cumulative `route => replica`
  map of every route ever served). This module persists nothing: `advance/2` is the pure merge
  rule the caller applies to `%{accepted, frozen}` (row 383).

  One causal evaluation (row 382). A single memoized judgment covers rotations, replacement
  candidates and catalogs. Every verdict reads only the artifact's bytes and its causal
  ancestry, so it only ever moves out of pending (D-279). An eligible node passes steps 1, 2,
  4, 5 and 6 (`refused?` when the full union refuses it, step 3); a cited prior catalog that is
  intrinsically invalid makes a replacement raw evidence (OD-17) and a rotation a retained
  refusal. A catalog is valid when its signature, scope and service match its binding node, its
  chain is valid, its entries extend its floor (`Floor(bootstrap) = []`, `Floor(T) =
  entries(T.prior_catalog)`, and for a replacement the union of its cited catalogs' entries, or
  its parent's floor for a `nil` citation) and no route in its own ancestry names two replicas.

  Union classification (steps 7-8) only reclassifies: the closed set (D-275), closed-out
  rotation and catalog children of closed bindings, heads, forks (heads, nonce, catalog and
  rotation forks), catalog heads and per-node pending recovery cutoffs.

  The decision is derived on every call from the union and the watermark (row 383): a changed
  watermark (its binding refused or closed out, or its catalog refused, closed out or uncovered)
  sets `block.freeze`; a missing watermark artifact is a derived block that does not freeze; a
  sole promotable head is accepted when it covers the watermark; `clears_authority_changed`
  holds when that head descends from an honored replacement the watermark did not have; and
  `serving` is the catalog the caller may serve.

  `resolve/1` returns `{:error, reason, detail}` only for malformed input,
  `control_history_limit` (more than two heads) and `trust_pending` (any held op with an
  incomplete closure except a candidate already refuted from its own bytes, a pending
  candidate, a pending rotation not under a closed binding, or a pending catalog under an open
  binding or on a cited chain), the highest precedence first; everything else is in the graph
  and its `decision`.
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

  @doc """
  The merge rule over the persisted `%{accepted, frozen}` (row 383; TS
  `advanceCatalogBindingState`). Returns `%{accepted, frozen, serving}`. Only an accepting
  decision that clears (or any accepting decision while not frozen) moves the watermark and
  lifts `frozen`; it adds the accepted catalog's routes to the cumulative `routes`. A block
  with `freeze` sets `frozen`. Nothing is served while frozen. On an error the state is kept:
  `trust_pending` serves `:unchanged` (the caller keeps its previous routes, an incomplete
  page), any other error serves nothing.
  """
  @spec advance(map(), term()) :: %{accepted: map() | nil, frozen: boolean(), serving: term()}
  def advance(state, {:ok, %{decision: d, catalogs: catalogs}}) do
    frozen = Map.get(state, :frozen, false)
    accepted = Map.get(state, :accepted)

    cond do
      d.accepted and (not frozen or d.clears_authority_changed) ->
        routes =
          Enum.reduce(catalogs[d.catalog].entries, routes(accepted), fn e, acc ->
            Map.put(acc, e.route, e.replica)
          end)

        %{
          accepted: %{
            binding: d.head,
            generation: d.generation,
            catalog: d.catalog,
            revision: d.revision,
            routes: routes
          },
          frozen: false,
          serving: d.serving
        }

      d.block != nil and d.block.freeze ->
        %{accepted: accepted, frozen: true, serving: nil}

      true ->
        %{accepted: accepted, frozen: frozen, serving: if(frozen, do: nil, else: d.serving)}
    end
  end

  def advance(state, {:error, :trust_pending, _}), do: keep(state, :unchanged)
  def advance(state, _error), do: keep(state, nil)

  defp keep(state, serving),
    do: %{
      accepted: Map.get(state, :accepted),
      frozen: Map.get(state, :frozen, false),
      serving: serving
    }

  defp routes(nil), do: %{}
  defp routes(accepted), do: Map.get(accepted, :routes, %{})

  @doc """
  The authoring resolve for one claim (design section 2.7). As `resolve/1`, except that a
  `control_history_limit` whose heads all reduce to head roots the claim cites (a rotation
  head's root is its nearest non-rotation ancestor) is re-resolved without the rotations under
  those roots and the catalogs bound to them: exactly the rotations the claim closes out. The
  verifier keeps its head limit; the caller re-checks the signed op against the full input.
  """
  @spec resolve_for_claim(map(), map()) ::
          {:ok, graph()} | {:error, atom(), %{ids: [String.t()], core_reason: nil}}
  def resolve_for_claim(input, claim) do
    case resolve(input) do
      {:error, :control_history_limit, %{ids: heads}} = limit when is_map(input) ->
        rotations = Map.get(input, :rotations, %{})
        roots = Enum.map(heads, &head_root(&1, rotations, MapSet.new()))

        if Enum.all?(roots, &(&1 in claim.parents)),
          do: resolve(drop_under(input, rotations, claim.parents)),
          else: limit

      other ->
        other
    end
  end

  defp head_root(id, rotations, seen) do
    case rotations do
      %{^id => %{rotation: %{parent: parent}}} ->
        if MapSet.member?(seen, id),
          do: id,
          else: head_root(parent, rotations, MapSet.put(seen, id))

      _ ->
        id
    end
  end

  defp drop_under(input, rotations, parents) do
    dropped =
      for {id, _} <- rotations,
          under?(id, rotations, parents, MapSet.new()),
          into: MapSet.new(),
          do: id

    dropped = closure_drop(dropped, rotations)

    catalogs =
      for {id, e} <- input.catalogs,
          not MapSet.member?(dropped, e.catalog.binding),
          into: %{},
          do: {id, e}

    %{input | rotations: Map.drop(rotations, MapSet.to_list(dropped)), catalogs: catalogs}
  end

  defp under?(id, rotations, parents, seen) do
    parent = rotations[id].rotation.parent

    cond do
      id in parents or MapSet.member?(seen, id) -> false
      parent in parents -> true
      Map.has_key?(rotations, parent) -> under?(parent, rotations, parents, MapSet.put(seen, id))
      true -> false
    end
  end

  # A rotation whose parent is dropped is dropped too.
  defp closure_drop(dropped, rotations) do
    more =
      for {id, e} <- rotations,
          not MapSet.member?(dropped, id),
          MapSet.member?(dropped, e.rotation.parent),
          into: MapSet.new(),
          do: id

    if MapSet.size(more) == 0,
      do: dropped,
      else: closure_drop(MapSet.union(dropped, more), rotations)
  end

  # --- context ----------------------------------------------------------------

  defp context(%{
         bootstrap: %{id: id, record: record} = bootstrap,
         space: %Log{} = space,
         rotations: rotations,
         catalogs: catalogs,
         proven_cutoffs: proven,
         accepted: accepted
       })
       when is_map(rotations) and is_map(catalogs) and is_list(proven) and is_binary(id) and
              is_map(record) and (is_nil(accepted) or is_map(accepted)) do
    if Enum.all?(proven, &proven_shape?/1) and accepted_shape?(accepted),
      do: {:ok, build_context(bootstrap, space, rotations, catalogs, proven, accepted)},
      else: :error
  end

  defp context(_), do: :error

  defp accepted_shape?(nil), do: true

  defp accepted_shape?(%{binding: b, catalog: c, revision: r} = a)
       when is_binary(b) and is_binary(c) and is_integer(r),
       do: is_map(Map.get(a, :routes, %{}))

  defp accepted_shape?(_), do: false

  # A proven cutoff is the complete `{replica, frontier, log_digest}` triple (CatalogTrust
  # compares the whole cutoff); an entry without its frontier fails closed as malformed input.
  defp proven_shape?(%{replica: r, frontier: f, log_digest: d})
       when is_binary(r) and is_list(f) and is_binary(d),
       do: Enum.all?(f, &is_binary/1)

  defp proven_shape?(_), do: false

  defp cutoff_key(c), do: {c.replica, c.frontier, c.log_digest}

  defp build_context(bootstrap, space, rotations, catalogs, proven, accepted) do
    ops = Log.ops(space)
    complete = complete_ids(ops)
    cops = Map.take(ops, MapSet.to_list(complete))
    replica = space.replica

    candidates =
      for {oid, %{kind: :command, body: {:replace_catalog_v1, _}} = op} <- ops,
          into: %{},
          do: {oid, op}

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
      proven: MapSet.new(proven, &cutoff_key/1),
      accepted: accepted,
      boot_honored: bootstrap_honored?(bootstrap, cops, replica)
    }
  end

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
    st = %{
      memo: %{},
      cmemo: %{},
      croutes: %{},
      visiting: MapSet.new(),
      cvisiting: MapSet.new(),
      detail: %{}
    }

    st =
      (Map.keys(ctx.rotations) ++ Map.keys(ctx.candidates))
      |> Enum.sort()
      |> Enum.reduce(st, fn id, st -> id |> eval(ctx, st) |> elem(1) end)

    st =
      ctx.catalogs
      |> Map.keys()
      |> Enum.sort()
      |> Enum.reduce(st, fn id, st -> id |> judge_catalog(ctx, st) |> elem(1) end)

    memo = st.memo

    nodes_all =
      for({id, {:node, n}} <- memo, into: %{}, do: {id, n})
      |> Map.put(ctx.bootstrap.id, bootstrap_node(ctx))

    closed = closed_set(nodes_all)
    out_rot = closed_out_rotations(nodes_all, closed)
    out_pending = closed_out_pending(ctx, memo, closed, out_rot)
    final = Map.drop(nodes_all, MapSet.to_list(out_rot))
    heads = heads_of(final)

    {floors, st} =
      Enum.reduce(final, {%{}, st}, fn {id, n}, {acc, st} ->
        case floor_of(n, ctx, st) do
          {{:ok, entries, _routes}, st} -> {Map.put(acc, id, entries), st}
          {_, st} -> {acc, st}
        end
      end)

    cat =
      classify_catalogs(
        Map.merge(ctx, %{memo: memo, validity: st.cmemo}),
        nodes_all,
        closed,
        {out_rot, out_pending}
      )

    # Any held op whose closure is incomplete is a missing history page (row m): the authority
    # fold over the complete ops would judge a smaller history. Only a candidate already refuted
    # from its own bytes (D-A1) is exempt.
    incomplete =
      for {id, _op} <- ctx.ops,
          not MapSet.member?(ctx.complete, id),
          not match?({:bad, _}, Map.get(memo, id)),
          do: id

    pending =
      (for({id, :pending} <- memo, not MapSet.member?(out_pending, id), do: id) ++
         cat.pending ++ incomplete)
      |> Enum.uniq()
      |> Enum.sort()

    cond do
      length(heads) > 2 ->
        {:error, :control_history_limit, %{ids: heads, core_reason: nil}}

      pending != [] ->
        {:error, :trust_pending, %{ids: pending, core_reason: nil}}

      true ->
        assemble(ctx, memo, st.detail, {nodes_all, final, heads, closed, out_rot}, cat, floors)
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
        {{:node, p}, st} -> rotation_node(id, e, p, ctx, st)
        {{:bad, _}, st} -> {{:bad, :invalid_catalog_transition}, st}
        {_, st} -> {:pending, st}
      end
    end
  end

  defp rotation_node(id, e, p, ctx, st) do
    r = e.rotation

    cond do
      next_generation([p.generation]) != {:ok, r.generation} ->
        {{:bad, :invalid_catalog_transition}, st}

      r.new_catalog_key == p.key or r.new_catalog_key == p.service_key ->
        {{:bad, :invalid_catalog_transition}, st}

      not Identity.verify(p.key, TransportCatalog.rotation_bytes(r), e.old_signature) ->
        {{:bad, :invalid_catalog_signature}, st}

      not Identity.verify(
        r.new_catalog_key,
        TransportCatalog.rotation_possession_bytes(r),
        e.new_signature
      ) ->
        {{:bad, :invalid_possession}, st}

      true ->
        case ctx.catalogs[r.prior_catalog] do
          nil -> {:pending, st}
          %{catalog: prior} -> rotation_prior(id, r, p, prior, ctx, st)
        end
    end
  end

  # The prior catalog must be held and valid under the rotation's parent (row 382 item 3): an
  # invalid prior makes the rotation a retained refusal, never a head.
  defp rotation_prior(id, r, p, prior, ctx, st) do
    if prior.binding != r.parent or
         TransportCatalog.inventory_id(prior.entries) != r.inventory_digest or
         Enum.map(r.cutoffs, & &1.replica) != Enum.map(prior.entries, & &1.replica) do
      {{:bad, :invalid_catalog_transition}, st}
    else
      case judge_catalog(r.prior_catalog, ctx, st) do
        {:ok, st} -> {rotation_verdict(id, r, p, ctx), st}
        {v, st} when v in [:pending, :binding_pending] -> {:pending, st}
        {_, st} -> {{:bad, :invalid_catalog_transition}, st}
      end
    end
  end

  defp rotation_verdict(id, r, p, ctx) do
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
       # A rotation keeps its parent's service, so it inherits the unproven recovery cutoffs,
       # and it owes its own declared cutoffs too (CatalogTrust parity).
       pending: Enum.uniq(p.pending ++ unproven(r.cutoffs, ctx))
     }}
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
      nil -> {{:node, replacement_node(op, claim, ctx, st)}, st}
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

  defp replacement_node(op, claim, ctx, st) do
    core = ctx.analysis.reasons[op.id]

    # D-A15: a node owes its own declared cutoffs plus those it inherits from a same-service
    # parent (every parent is an eligible node here; declared_graph judged it).
    inherited =
      for p <- claim.parents,
          pn <- [parent_node(p, ctx, st)],
          {pn.service_id, pn.service_key} == {claim.new_service_id, claim.new_service_key},
          cut <- pn.pending,
          do: cut

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
      pending: Enum.uniq(inherited ++ unproven(claim.cutoffs, ctx))
    }
  end

  defp parent_node(id, ctx, st) do
    if id == ctx.bootstrap.id do
      bootstrap_node(ctx)
    else
      {:node, n} = Map.fetch!(st.memo, id)
      n
    end
  end

  defp unproven(cutoffs, ctx),
    do: Enum.reject(cutoffs, &MapSet.member?(ctx.proven, cutoff_key(&1)))

  # Steps 5 and 6, intrinsic part. Returns `{failures, pending?, st}`. A cited replacement op
  # outside the deps closure fails before it is evaluated, so recursion follows causality.
  defp declared_graph(claim, anc, ctx, st) do
    {results, st} =
      Enum.map_reduce(claim.parents, st, fn parent, st ->
        if Map.has_key?(ctx.candidates, parent) and not MapSet.member?(anc, parent) do
          {{parent, {:bad, :deps}}, st}
        else
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

    {prior_failures, prior_pending?, st} = priors(claim, ctx, st)

    {parent_failures ++ service_failures ++ generation_failures ++ prior_failures,
     held_pending? or prior_pending?, st}
  end

  # A cited prior catalog must be held, bound to its cited parent and valid (OD-17: an invalid
  # one makes the candidate raw evidence; one whose own chain is not yet held pends).
  defp priors(claim, ctx, st) do
    Enum.reduce(claim.prior_catalogs, {[], false, st}, fn %{binding: binding, catalog: catalog},
                                                          {fails, pend?, st} ->
      cond do
        binding not in claim.parents ->
          {[{:invalid_catalog_transition, :prior} | fails], pend?, st}

        catalog == nil ->
          {fails, pend?, st}

        not Map.has_key?(ctx.catalogs, catalog) ->
          {fails, true, st}

        ctx.catalogs[catalog].catalog.binding != binding ->
          {[{:invalid_catalog_transition, :prior} | fails], pend?, st}

        true ->
          case judge_catalog(catalog, ctx, st) do
            {:ok, st} -> {fails, pend?, st}
            {v, st} when v in [:pending, :binding_pending] -> {fails, true, st}
            {_, st} -> {[{:invalid_catalog_transition, :prior} | fails], pend?, st}
          end
      end
    end)
  end

  # --- catalogs (intrinsic) -------------------------------------------------------

  # A catalog verdict: `:ok` (with its cumulative route map in `croutes`), `{:refused,
  # reason}`, `:binding_pending`, `:pending` or `:bad_chain`. It reads only the catalog bytes,
  # its binding node and its own ancestry (its `previous` chain and its floor), never the union.
  defp judge_catalog(id, ctx, st) do
    cond do
      Map.has_key?(st.cmemo, id) ->
        {st.cmemo[id], st}

      not Map.has_key?(ctx.catalogs, id) ->
        {:pending, st}

      MapSet.member?(st.cvisiting, id) ->
        {:bad_chain, st}

      true ->
        st = %{st | cvisiting: MapSet.put(st.cvisiting, id)}
        {v, routes, st} = judge_catalog_new(id, ctx, st)
        st = %{st | cvisiting: MapSet.delete(st.cvisiting, id), cmemo: Map.put(st.cmemo, id, v)}
        st = if v == :ok, do: %{st | croutes: Map.put(st.croutes, id, routes)}, else: st
        {v, st}
    end
  end

  defp judge_catalog_new(id, ctx, st) do
    e = ctx.catalogs[id]
    c = e.catalog

    if c.space != ctx.replica or c.bootstrap != ctx.bootstrap.id do
      {{:refused, :wrong_catalog_scope}, nil, st}
    else
      case eval(c.binding, ctx, st) do
        {{:node, n}, st} -> catalog_under(c, e, n, ctx, st)
        {{:bad, _}, st} -> {{:refused, :invalid_catalog_transition}, nil, st}
        {_, st} -> {:binding_pending, nil, st}
      end
    end
  end

  # Scope outranks signature (plan 316 section 4: `wrong_catalog_scope` rank 2 before
  # `invalid_catalog_signature` rank 4), so the entry service pair is checked first.
  defp catalog_under(c, e, n, ctx, st) do
    cond do
      Enum.any?(c.entries, &({&1.service_id, &1.service_key} != {n.service_id, n.service_key})) ->
        {{:refused, :wrong_catalog_scope}, nil, st}

      not Identity.verify(n.key, TransportCatalog.catalog_bytes(c), e.signature) ->
        {{:refused, :invalid_catalog_signature}, nil, st}

      c.previous == nil ->
        first_catalog(c, n, ctx, st)

      not Map.has_key?(ctx.catalogs, c.previous) ->
        {:pending, nil, st}

      true ->
        chain_catalog(c, ctx, st)
    end
  end

  # First-catalog checks (plan 316 section 1 (b)): revision 0 for a replacement (the codec
  # already ties revision 0 to `previous: nil`), the declared inventory, the replacement's
  # cutoffs covering every entry (D-A15), extension of the binding's floor, and the route rule.
  defp first_catalog(c, n, ctx, st) do
    {floor, st} = floor_of(n, ctx, st)

    case floor do
      {:ok, entries, routes} ->
        cond do
          n.kind == :replacement and c.revision != 0 ->
            {:bad_chain, nil, st}

          n.inventory != nil and TransportCatalog.inventory_id(c.entries) != n.inventory ->
            {:bad_chain, nil, st}

          n.kind == :replacement and
              Enum.map(claim_of(ctx, n.id).cutoffs, & &1.replica) !=
                Enum.sort(Enum.map(c.entries, & &1.replica)) ->
            {:bad_chain, nil, st}

          not extends?(entries, c.entries) ->
            {:bad_chain, nil, st}

          true ->
            with_routes(routes, c.entries, st)
        end

      :pending ->
        {:pending, nil, st}

      :bad ->
        {:bad_chain, nil, st}
    end
  end

  defp chain_catalog(c, ctx, st) do
    {prev, st} = judge_catalog(c.previous, ctx, st)
    prior = ctx.catalogs[c.previous].catalog

    cond do
      prev in [:pending, :binding_pending] -> {:pending, nil, st}
      prev != :ok or prior.binding != c.binding -> {:bad_chain, nil, st}
      next_generation([prior.revision]) != {:ok, c.revision} -> {:bad_chain, nil, st}
      not extends?(prior.entries, c.entries) -> {:bad_chain, nil, st}
      true -> with_routes(st.croutes[c.previous], c.entries, st)
    end
  end

  # Route rule: within a catalog's own ancestry plus its entries, a route names one replica.
  defp with_routes(routes, entries, st) do
    case add_routes(routes, entries) do
      {:ok, routes} -> {:ok, routes, st}
      :conflict -> {:bad_chain, nil, st}
    end
  end

  defp add_routes(routes, entries) do
    Enum.reduce_while(entries, {:ok, routes}, fn e, {:ok, acc} ->
      if Map.get(acc, e.route, e.replica) == e.replica,
        do: {:cont, {:ok, Map.put(acc, e.route, e.replica)}},
        else: {:halt, :conflict}
    end)
  end

  # Floor(N): the entries (and route map) every valid catalog under N must extend.
  # `Floor(bootstrap) = []`, `Floor(T) = entries(T.prior_catalog)`, and for a replacement the
  # union over its cited `{P, K}` of `entries(K)`, or `Floor(P)` when `K` is nil, so a nil
  # citation of a node without a valid catalog still carries that node's inventory forward.
  defp floor_of(%{kind: :bootstrap}, _ctx, st), do: {{:ok, [], %{}}, st}

  defp floor_of(%{prior: priors}, ctx, st) do
    Enum.reduce(priors, {{:ok, [], %{}}, st}, fn
      _prior, {:bad, st} ->
        {:bad, st}

      %{binding: p, catalog: k}, {acc, st} ->
        {part, st} = floor_part(p, k, ctx, st)
        {merge_floor(acc, part), st}
    end)
  end

  defp floor_part(p, nil, ctx, st) do
    case eval(p, ctx, st) do
      {{:node, n}, st} -> floor_of(n, ctx, st)
      {_, st} -> {:pending, st}
    end
  end

  defp floor_part(_p, k, ctx, st) do
    case judge_catalog(k, ctx, st) do
      {:ok, st} -> {{:ok, ctx.catalogs[k].catalog.entries, st.croutes[k]}, st}
      {v, st} when v in [:pending, :binding_pending] -> {:pending, st}
      {_, st} -> {:bad, st}
    end
  end

  defp merge_floor(:bad, _), do: :bad
  defp merge_floor(_, :bad), do: :bad
  defp merge_floor(:pending, _), do: :pending
  defp merge_floor(_, :pending), do: :pending

  defp merge_floor({:ok, e1, r1}, {:ok, e2, r2}) do
    if Enum.all?(r2, fn {route, replica} -> Map.get(r1, route, replica) == replica end),
      do: {:ok, e1 ++ e2, Map.merge(r1, r2)},
      else: :bad
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

  # D-275 non-stall: a pending rotation whose rotation-parent chain reaches a closed or
  # closed-out binding is closed-out evidence whatever its missing prior catalog says, so an
  # old-key signer cannot withhold it to freeze recovery. A pending rotation under an open,
  # unknown or pending replacement parent still pends.
  defp closed_out_pending(ctx, memo, closed, out_rot) do
    for {id, :pending} <- memo,
        Map.has_key?(ctx.rotations, id),
        pending_out?(id, ctx, memo, MapSet.union(closed, out_rot), MapSet.new()),
        into: MapSet.new(),
        do: id
  end

  defp pending_out?(id, ctx, memo, dead, seen) do
    parent = ctx.rotations[id].rotation.parent

    cond do
      MapSet.member?(seen, id) ->
        false

      MapSet.member?(dead, parent) ->
        true

      Map.has_key?(ctx.rotations, parent) and Map.get(memo, parent) == :pending ->
        pending_out?(parent, ctx, memo, dead, MapSet.put(seen, id))

      true ->
        false
    end
  end

  defp heads_of(final) do
    cited = closure(for({_id, n} <- final, p <- n.parents, do: p), final, MapSet.new())
    final |> Map.keys() |> Enum.reject(&MapSet.member?(cited, &1)) |> Enum.sort()
  end

  # --- catalogs (union classification) ----------------------------------------------

  # Status classifies an intrinsic verdict against the union: :current (open binding),
  # :covered / :closed_out / :uncovered (closed binding), :refused (with a reason) or :pending.
  # A citation never makes an invalid catalog valid.
  defp classify_catalogs(ctx, nodes_all, closed, {out_rot, out_pending}) do
    cites = citations(nodes_all, closed)
    previous = Map.new(ctx.catalogs, fn {id, e} -> {id, e.catalog.previous} end)

    env = %{
      ctx: ctx,
      nodes_all: nodes_all,
      closed: closed,
      out_rot: out_rot,
      out_pending: out_pending,
      cites: cites,
      previous: previous,
      validity: ctx.validity
    }

    acc =
      ctx.catalogs
      |> Map.keys()
      |> Enum.sort()
      |> Enum.reduce(%{status: %{}, refusals: %{}}, fn id, acc ->
        {status, acc} = catalog_status(id, env, acc)
        %{acc | status: Map.put(acc.status, id, status)}
      end)

    pending = for {id, :pending} <- acc.status, do: id

    Map.merge(acc, %{
      pending: pending,
      cites: cites,
      previous: previous,
      validity: ctx.validity,
      out_pending: out_pending
    })
  end

  defp refuse(acc, id, reason, core),
    do:
      {:refused,
       %{acc | refusals: Map.put(acc.refusals, id, %{reason: reason, core_reason: core})}}

  defp catalog_status(id, env, acc) do
    c = env.ctx.catalogs[id].catalog
    n = env.nodes_all[c.binding]

    case env.validity[id] do
      {:refused, reason} ->
        refuse(acc, id, reason, nil)

      :binding_pending ->
        {if(MapSet.member?(env.out_pending, c.binding), do: :closed_out, else: :pending), acc}

      v ->
        cond do
          n.refused? -> refused_node_status(id, c.binding, v, env, acc, n.core_reason)
          MapSet.member?(env.out_rot, c.binding) -> {:closed_out, acc}
          MapSet.member?(env.closed, c.binding) -> closed_status(id, c.binding, v, env, acc)
          v == :pending -> {:pending, acc}
          v == :bad_chain -> refuse(acc, id, :invalid_catalog_transition, nil)
          true -> {:current, acc}
        end
    end
  end

  # A catalog under a union-refused node authorizes nothing, but under a closed binding a
  # chain-valid one is still a citable catalog head (D-A13, `citable_catalog_heads`): if the
  # citations omit it, it is an omitted head (`uncovered`, a fork), as authoring coverage reads
  # it. It keeps its `catalog_authority_refused` refusal either way.
  defp refused_node_status(id, binding, v, env, acc, core) do
    {:refused, acc} = refuse(acc, id, :catalog_authority_refused, core)

    if v == :ok and MapSet.member?(env.closed, binding) and
         not MapSet.member?(env.out_rot, binding) and
         match?({:uncovered, _}, closed_status(id, binding, v, env, acc)),
       do: {:uncovered, acc},
       else: {:refused, acc}
  end

  # Under a closed binding: covered when ancestor-or-self of a valid cited catalog, closed out
  # when a strict descendant of a cited catalog or when the binding was cited with nil,
  # otherwise an omitted head (uncovered, a fork). A catalog on a cited chain is refused when
  # invalid and pending when its chain is. Only a chain-valid catalog can be an omitted head:
  # an uncited invalid one is refused and an uncited one whose chain is not held is closed-out
  # evidence (D-A16 for catalogs), so an old-key signer can neither stall nor fork the resolve
  # with artifacts that fail their own chain.
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

      v == :bad_chain ->
        refuse(acc, id, :invalid_catalog_transition, nil)

      v == :pending ->
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

  # Is `a` ancestor-or-self of `b` along `previous` links and, for a first catalog under a
  # rotation, the edge to that rotation's prior catalog (CatLineage; used only by Seen)?
  defp cat_lineage?(a, b, parent, seen \\ MapSet.new()) do
    cond do
      a == b -> true
      b == nil or MapSet.member?(seen, b) -> false
      true -> cat_lineage?(a, Map.get(parent, b), parent, MapSet.put(seen, b))
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

  defp extends?(before, next) do
    Enum.all?(before, fn entry ->
      case Enum.find(next, &(&1.replica == entry.replica)) do
        nil -> false
        other -> Map.take(entry, @extended_keys) == Map.take(other, @extended_keys)
      end
    end)
  end

  defp route_compat?(routes, entries),
    do: Enum.all?(entries, &(Map.get(routes, &1.route, &1.replica) == &1.replica))

  # --- forks ------------------------------------------------------------------

  defp catalog_heads(final, closed, cat, ctx) do
    current = for {cid, :current} <- cat.status, do: cid
    heads_among(current, final, closed, ctx)
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

    heads_among(citable, final, closed, ctx)
  end

  defp heads_among(ids, final, closed, ctx) do
    successors =
      MapSet.new(for cid <- ids, p = ctx.catalogs[cid].catalog.previous, p != nil, do: p)

    open = for {id, _} <- final, not MapSet.member?(closed, id), into: MapSet.new(), do: id

    ids
    |> Enum.reject(&MapSet.member?(successors, &1))
    |> Enum.filter(&MapSet.member?(open, ctx.catalogs[&1].catalog.binding))
    |> Enum.group_by(&ctx.catalogs[&1].catalog.binding)
    |> Map.new(fn {binding, ids} -> {binding, Enum.sort(ids)} end)
  end

  # C1: a final rotation T whose parent P is not closed forks with any chain-valid catalog under
  # P that strictly descends from T's prior catalog (CatalogTrust `rotation_forks`); a pending
  # descendant is already pending under the open P.
  defp rotation_forks(final, closed, cat, ctx) do
    final
    |> Enum.flat_map(fn
      {tid, %{kind: :rotation, prior: [%{binding: p, catalog: prior}]}} ->
        descendants =
          for {cid, e} <- ctx.catalogs,
              not MapSet.member?(closed, p),
              e.catalog.binding == p,
              cid != prior,
              cat.validity[cid] == :ok,
              on_chain?(prior, cid, cat.previous),
              do: cid

        if descendants == [],
          do: [],
          else: [%{rotation: tid, binding: p, catalogs: Enum.sort(descendants), prior: prior}]

      _ ->
        []
    end)
    |> Enum.sort_by(& &1.rotation)
  end

  defp forks(final, heads, closed, cat, cat_heads, rot_forks, ctx) do
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

    rotation =
      for f <- rot_forks,
          do: %{kind: :rotation, binding: f.binding, ids: Enum.sort([f.prior | f.catalogs])}

    Enum.sort_by(
      heads_fork ++ nonce ++ split ++ uncovered ++ rotation,
      &{&1.kind, &1.binding || "", &1.ids}
    )
  end

  defp claim_of(ctx, id) do
    {:ok, claim} =
      ctx.candidates[id].body |> elem(1) |> hd() |> TransportCatalog.normalize_replacement_claim()

    claim
  end

  # --- assembly and decision --------------------------------------------------

  defp assemble(ctx, memo, detail, {nodes_all, final, heads, closed, out_rot}, cat, floors) do
    closed_out =
      Map.new(MapSet.union(out_rot, cat.out_pending), &{&1, :catalog_rollback})
      |> Map.merge(for({cid, :closed_out} <- cat.status, into: %{}, do: {cid, :catalog_rollback}))

    cat_heads = catalog_heads(final, closed, cat, ctx)
    rot_forks = rotation_forks(final, closed, cat, ctx)

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

    fork_bindings =
      (for({cid, :uncovered} <- cat.status, do: ctx.catalogs[cid].catalog.binding) ++
         Enum.map(rot_forks, & &1.binding))
      |> Enum.uniq()
      |> Enum.sort()

    cat_parent =
      Map.new(ctx.catalogs, fn {id, %{catalog: c}} ->
        parent =
          case {c.previous, nodes_all[c.binding]} do
            {nil, %{kind: :rotation, prior: [%{catalog: prior}]}} -> prior
            {previous, _} -> previous
          end

        {id, parent}
      end)

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
      cat_parent: cat_parent,
      forks: forks(final, heads, closed, cat, cat_heads, rot_forks, ctx),
      rotation_forks: rot_forks,
      fork_bindings: fork_bindings,
      floors: floors,
      verdicts: verdicts(memo, cat.validity),
      catalogs: Map.new(ctx.catalogs, fn {id, e} -> {id, e.catalog} end),
      decision: nil
    }

    {:ok, %{graph | decision: decide(ctx.accepted, graph, nodes_all, closed, out_rot)}}
  end

  # The intrinsic verdict of every judged rotation, candidate and catalog (D-279: each only ever
  # moves out of `:pending`): `:node`, `{:bad, reason}`, `:ok`, `{:refused, reason}`,
  # `:bad_chain` or `:pending`. Union classification never changes one.
  defp verdicts(memo, validity) do
    bindings =
      Map.new(memo, fn
        {id, {:node, _}} -> {id, :node}
        {id, v} -> {id, v}
      end)

    Map.merge(
      bindings,
      Map.new(validity, fn
        {id, :binding_pending} -> {id, :pending}
        {id, v} -> {id, v}
      end)
    )
  end

  defp decide(a, graph, nodes_all, closed, out_rot) do
    abs = accepted_binding_status(a, nodes_all, closed, out_rot)
    acs = accepted_catalog_status(a, graph)
    missing? = a != nil and (abs == :missing or acs == :missing)

    changed? =
      a != nil and not missing? and
        (abs in [:refused, :closed_out] or acs in [:refused, :closed_out])

    base = %{
      accepted: false,
      reason: nil,
      block: nil,
      head: nil,
      catalog: nil,
      generation: nil,
      revision: nil,
      clears_authority_changed: false,
      serving: nil,
      accepted_binding_status: abs,
      accepted_catalog_status: acs
    }

    cond do
      graph.forks != [] ->
        ids = graph.forks |> Enum.flat_map(& &1.ids) |> Enum.uniq() |> Enum.sort()
        %{base | reason: :catalog_fork, block: block(:catalog_fork, ids, changed?)}

      missing? ->
        [h] = graph.heads

        %{
          base
          | head: h,
            reason: :authority_changed,
            block: block(:authority_changed, [h], false)
        }

      true ->
        [h] = graph.heads
        serving = serving(a, graph, closed, changed?)
        sole(a, graph, nodes_all, {h, changed?}, %{base | head: h, serving: serving})
    end
  end

  defp block(reason, ids, freeze), do: %{reason: reason, ids: ids, freeze: freeze}

  defp sole(a, graph, nodes_all, {h, changed?}, base) do
    node = graph.nodes[h]
    ready = graph.catalog_heads |> Map.get(h, []) |> List.first()
    promotable? = not node.refused? and node.pending == [] and ready != nil
    covers = if promotable? and a != nil, do: covers(a, h, ready, graph, nodes_all), else: :ok

    cond do
      promotable? and covers == :ok ->
        %{
          base
          | accepted: true,
            catalog: ready,
            generation: node.generation,
            revision: graph.catalogs[ready].revision,
            clears_authority_changed: clears?(a, h, nodes_all),
            serving: ready
        }

      changed? ->
        %{base | reason: :authority_changed, block: block(:authority_changed, [h], true)}

      promotable? ->
        {:error, reason} = covers
        %{base | reason: reason}

      node.refused? ->
        %{
          base
          | reason: :catalog_authority_refused,
            block: block(:catalog_authority_refused, [h], false)
        }

      node.pending != [] ->
        %{base | reason: :recovery_incomplete, block: block(:recovery_incomplete, [h], false)}

      true ->
        base
    end
  end

  # Covers(H, K | A): under the watermark's own binding a previous-chain descendant at no lower
  # revision; otherwise Carry (K extends the watermark catalog's entries), Seen (H's lineage
  # cites the watermark catalog's lineage, or descends strictly from a replacement that closed
  # it) and, in both cases, RouteCompat (no entry re-points a route ever served). Every failure is
  # relative to this client's watermark, so it is `catalog_rollback` (a union-level reason),
  # never the intrinsic `invalid_catalog_transition` (D-279).
  defp covers(a, h, k, graph, nodes_all) do
    kc = graph.catalogs[k]

    cond do
      not route_compat?(routes(a), kc.entries) ->
        {:error, :catalog_rollback}

      h == a.binding ->
        if on_chain?(a.catalog, k, graph.previous) and kc.revision >= a.revision,
          do: :ok,
          else: {:error, :catalog_rollback}

      not seen?(a, h, graph, nodes_all) ->
        {:error, :catalog_rollback}

      not extends?(graph.catalogs[a.catalog].entries, kc.entries) ->
        {:error, :catalog_rollback}

      true ->
        :ok
    end
  end

  defp seen?(a, h, graph, nodes_all) do
    lineage = closure([h], nodes_all, MapSet.new())

    cited =
      for id <- lineage, %{catalog: c} <- nodes_all[id].prior, c != nil, do: c

    Enum.any?(cited, &cat_lineage?(a.catalog, &1, graph.cat_parent)) or
      closed_by_descendant?(a, lineage, graph, nodes_all)
  end

  # Some replacement in H's lineage strictly descends from a closer of the watermark catalog: an
  # eligible replacement citing the watermark binding (or, for a closed-out rotation, its nearest
  # closed ancestor) with nil or with a strict CatLineage ancestor of the watermark catalog.
  defp closed_by_descendant?(a, lineage, graph, nodes_all) do
    target = closing_target(a.binding, nodes_all, MapSet.new(graph.closed))

    closers =
      for {id, %{kind: :replacement} = n} <- nodes_all,
          %{binding: ^target, catalog: c} <- n.prior,
          c == nil or (c != a.catalog and cat_lineage?(c, a.catalog, graph.cat_parent)),
          uniq: true,
          do: id

    Enum.any?(lineage, fn y ->
      nodes_all[y].kind == :replacement and
        Enum.any?(closers, fn x ->
          x != y and MapSet.member?(closure([y], nodes_all, MapSet.new()), x)
        end)
    end)
  end

  defp closing_target(binding, nodes_all, closed) do
    case nodes_all[binding] do
      %{kind: :rotation, parents: [parent]} ->
        if MapSet.member?(closed, binding),
          do: binding,
          else: closing_target(parent, nodes_all, closed)

      _ ->
        binding
    end
  end

  # An honored replacement in H's lineage that the watermark binding did not descend from.
  defp clears?(nil, _h, _nodes_all), do: false

  defp clears?(a, h, nodes_all) do
    seen = closure([a.binding], nodes_all, MapSet.new())

    Enum.any?(closure([h], nodes_all, MapSet.new()), fn x ->
      match?(%{kind: :replacement, refused?: false}, nodes_all[x]) and
        not MapSet.member?(seen, x)
    end)
  end

  # Without promotion the caller may keep serving the watermark catalog only while it is held,
  # unchanged, its binding open, nothing forks and its routes agree with the routes served.
  defp serving(nil, _graph, _closed, _changed?), do: nil
  defp serving(_a, _graph, _closed, true), do: nil

  defp serving(a, graph, closed, false) do
    if graph.forks == [] and Map.has_key?(graph.nodes, a.binding) and
         not MapSet.member?(closed, a.binding) and
         route_compat?(routes(a), graph.catalogs[a.catalog].entries),
       do: a.catalog
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
  354, 356 and the convergence design). Order: pending (an unheld parent or prior catalog), then
  transition failures (a cited parent that is raw evidence, refused or closed out, wrong
  generation, service rule), then an omitted head, fork binding or rotation-fork rotation, or an
  omitted catalog head (`catalog_fork`), then a prior entry that is not an expected one, an
  entry list that does not extend every cited prior and every nil-cited parent's floor, and a
  route that some held catalog maps to another replica. The catalog heads are the citable ones:
  under a union-refused parent its chain-valid catalogs count; under a fork binding its
  uncovered catalogs.
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

      Enum.any?(
        graph.heads ++ graph.fork_bindings ++ Enum.map(graph.rotation_forks, & &1.rotation),
        &(&1 not in claim.parents)
      ) ->
        {:error, :catalog_fork}

      Enum.any?(expected, &(&1 not in claim.prior_catalogs)) ->
        {:error, :catalog_fork}

      Enum.any?(claim.prior_catalogs, &(&1 not in expected)) ->
        {:error, :invalid_catalog_transition}

      not carries?(graph, claim, entries) ->
        {:error, :invalid_catalog_transition}

      held_conflict?(graph, claim, entries) ->
        {:error, :invalid_catalog_transition}

      true ->
        :ok
    end
  end

  defp expected_priors(graph, parents) do
    Enum.flat_map(parents, fn parent ->
      heads =
        if parent in graph.fork_bindings and not Map.has_key?(graph.citable_catalog_heads, parent),
          do:
            for(
              {cid, :uncovered} <- graph.catalog_status,
              graph.catalogs[cid].binding == parent,
              do: cid
            ),
          else: Map.get(graph.citable_catalog_heads, parent, [])

      case Enum.sort(heads) do
        [] -> [%{binding: parent, catalog: nil}]
        heads -> for catalog <- heads, do: %{binding: parent, catalog: catalog}
      end
    end)
  end

  # Every cited prior's entries and every nil-cited parent's floor (row 382 item 2).
  defp carries?(graph, claim, entries) do
    Enum.all?(claim.prior_catalogs, fn
      %{binding: p, catalog: nil} -> extends?(Map.get(graph.floors, p, []), entries)
      %{catalog: k} -> extends?(graph.catalogs[k].entries, entries)
    end)
  end

  # The author cannot see a client's served routes, but every served route was in some held
  # catalog, so no new entry may map a held catalog's route to another replica. An entry that a
  # cited prior catalog already maps the same way is carried, not new: the claim re-points no
  # route that prior did not already point, so a closed-out old-key catalog (D-A10) cannot veto
  # carrying it. A fresh or moved route is still checked against every held catalog (C5).
  defp held_conflict?(graph, claim, entries) do
    carried =
      for %{catalog: k} <- claim.prior_catalogs,
          k != nil,
          e <- graph.catalogs[k].entries,
          into: MapSet.new(),
          do: {e.route, e.replica}

    entries
    |> Enum.reject(&MapSet.member?(carried, {&1.route, &1.replica}))
    |> Enum.any?(fn e ->
      Enum.any?(graph.catalogs, fn {_id, c} ->
        Enum.any?(c.entries, &(&1.route == e.route and &1.replica != e.replica))
      end)
    end)
  end
end
