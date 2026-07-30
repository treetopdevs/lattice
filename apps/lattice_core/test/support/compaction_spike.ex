defmodule Lattice.CompactionSpike do
  @moduledoc """
  Plan 013 THROWAWAY prototype — log compaction (Sedimentree-style) feasibility.

  Test-support only: compiled in the `:test` env, wired into nothing. It exists to
  prove one property (the plan-013 GATE): for a log `L` and a **stable** frontier
  `F`, `compact(L, F)` yields a snapshot such that reducing
  `snapshot ⊕ (ops of L above F)` is byte-identical — state, quarantine set,
  reasons, holders, requests — to reducing `L` with the real
  `Lattice.Authority` + `Lattice.Reduce` pipeline.

  **Stable frontier**: every op of `L` not in `reachable(F)` has all of `F` (and
  therefore every covered op) in its causal ancestry. `compact/3` rejects an
  unstable `F`. Stability is what makes a *bounded* authority summary sound: all
  covered delegations/acquires/revokes are visible to every retained op, so
  per-op ancestry into the covered region never needs to be reconstructed.

  The snapshot base (CRDTs at `F`, frozen quarantine verdicts, holder summary) is
  computed by the REAL engine (`Authority.analyze/2` + `Reduce.reduce_crdts/3`
  over the covered slice); only the *continuation* over retained ops is
  reimplemented here, seeded from the summary. Where this module mirrors
  `Lattice.Authority` internals, divergence is caught by the GATE test comparing
  against the real pipeline over the full log.

  Do NOT promote this into `lib/` — see `docs/adr/0006-compaction.md` for the
  design, its preconditions, and what production integration still needs.
  """

  alias Lattice.{Authority, Dag, Log, Op, Reduce}
  alias Lattice.Authority.Delegation
  alias Lattice.Crdt.{CausalList, Lww, OrSet}

  defmodule Snapshot do
    @moduledoc """
    Reduced state at a stable frontier `F` plus the authority summary that keeps
    stale-holder / revocation / capability checks sound after the ops beneath `F`
    are dropped. `hash` is the verification hash: any realm holding the covered
    ops can recompute the snapshot and compare (see `CompactionSpike.verify/3`).
    """

    defstruct replica: nil,
              # Sorted op ids of the stable frontier F.
              frontier: [],
              # op_id => causal height for covered ops. The spike keeps all of
              # them (simplest sound choice); production only needs F plus the
              # covered ops directly referenced by retained deps (the boundary).
              covered_heights: %{},
              # field => CRDT struct at F, compacted to live entries only.
              crdts: %{},
              # Frozen (final) authority verdicts for covered ops, kept for audit
              # and for quarantine-set equality with the uncompacted log.
              frozen_reasons: %{},
              frozen_holders: %{},
              frozen_requests: [],
              # deleg_id => %Delegation{} — the delegation set is NEVER compacted
              # (retained grants may attenuate from covered parents).
              delegations: %{},
              # Deleg ids introduced by covered ops: visible to all retained ops.
              covered_intros: MapSet.new(),
              covered_genesis_ids: MapSet.new(),
              covered_succession_ids: MapSet.new(),
              covered_honored_succession_ids: MapSet.new(),
              policies: %{},
              root: nil,
              # Raw covered revoke refs (re-judged against the merged delegation
              # set at analysis time, since authorization can bind late).
              covered_revokes: [],
              # role => %{last_acquire: %{op_id, holder, at_tick} | nil,
              #           last_active_tick: n}
              roles: %{},
              hash: nil
  end

  # --- Compaction -----------------------------------------------------------

  @doc """
  Compact `log` at stable frontier `frontier`.

  Returns `{:ok, snapshot, retained_log}` where `retained_log` holds exactly the
  ops above `F`, or `{:error, {:unstable_frontier, op_id}}` if some op above `F`
  does not causally dominate all of `F` (such a log must not be compacted at `F`).
  """
  @spec compact(module(), Log.t(), [Op.id()]) ::
          {:ok, Snapshot.t(), Log.t()} | {:error, {:unstable_frontier, Op.id()}}
  def compact(module, %Log{} = log, frontier) do
    all_ops = Log.ops(log)
    covered_ids = Dag.reachable(all_ops, frontier)
    covered_ops = Map.take(all_ops, MapSet.to_list(covered_ids))
    retained_ops = Map.drop(all_ops, MapSet.to_list(covered_ids))

    case unstable_op(all_ops, retained_ops, frontier) do
      nil ->
        snapshot = build_snapshot(module, log.replica, covered_ops, frontier)
        {:ok, snapshot, Log.from_ops(log.replica, retained_ops)}

      op_id ->
        {:error, {:unstable_frontier, op_id}}
    end
  end

  @doc """
  Re-reduce verification: a snapshot is valid iff recomputing it from the ops it
  summarizes reproduces its hash. Any realm still holding the covered ops can run
  this deterministically.
  """
  @spec verify(module(), Snapshot.t(), Log.t()) :: :ok | {:error, :snapshot_mismatch}
  def verify(module, %Snapshot{} = snapshot, %Log{} = covered_log) do
    recomputed =
      build_snapshot(module, covered_log.replica, Log.ops(covered_log), snapshot.frontier)

    content = snapshot_hash(snapshot)

    # The stored hash must commit to the snapshot's actual content AND that
    # content must be what the covered ops deterministically reduce to.
    if content == snapshot.hash and content == recomputed.hash,
      do: :ok,
      else: {:error, :snapshot_mismatch}
  end

  defp unstable_op(all_ops, retained_ops, frontier) do
    anc = Dag.all_ancestors(all_ops)
    f = MapSet.new(frontier)

    Enum.find_value(retained_ops, fn {id, _op} ->
      if MapSet.subset?(f, Map.fetch!(anc, id)), do: nil, else: id
    end)
  end

  defp build_snapshot(module, replica, covered_ops, frontier) do
    covered_log = Log.from_ops(replica, covered_ops)
    # The REAL engine computes the base: verdicts + CRDTs at F.
    analysis = Authority.analyze(module, covered_log)
    {crdts, _scope} = Reduce.reduce_crdts(module, covered_log, quarantine: analysis.quarantine)

    ordered = Log.topo_ops(covered_log)
    delegations = collect_delegations(ordered)
    root = Authority.root(covered_log)
    genesis_ids = genesis_delegation_ids(ordered)
    succession_ids = succession_delegation_ids(ordered)
    deleg_valid = validate_delegations(delegations, root, genesis_ids, succession_ids)

    snapshot = %Snapshot{
      replica: replica,
      frontier: Enum.sort(frontier),
      covered_heights: Dag.heights(covered_ops),
      crdts: Map.new(crdts, fn {field, crdt} -> {field, compact_crdt(crdt)} end),
      frozen_reasons: analysis.reasons,
      frozen_holders: analysis.holders,
      frozen_requests: analysis.requests,
      delegations: Map.new(delegations, fn {id, %{deleg: d}} -> {id, d} end),
      covered_intros: delegations |> Map.keys() |> MapSet.new(),
      covered_genesis_ids: genesis_ids,
      covered_succession_ids: succession_ids,
      covered_honored_succession_ids:
        honored_succession_delegation_ids(ordered, analysis.reasons),
      policies: analysis.policies,
      root: root,
      covered_revokes: collect_raw_revokes(ordered),
      roles: summarize_roles(module, covered_ops, ordered, analysis, deleg_valid)
    }

    %{snapshot | hash: snapshot_hash(snapshot)}
  end

  defp snapshot_hash(%Snapshot{} = snapshot) do
    :crypto.hash(
      :sha256,
      :erlang.term_to_binary(%{snapshot | hash: nil}, [:deterministic, {:minor_version, 2}])
    )
  end

  # Drop tombstoned/removed entries: retained ops causally dominate everything
  # covered, so re-removing an already-retired tag (or re-tombstoning a dropped
  # element) is an idempotent no-op — materialized values cannot differ.
  defp compact_crdt(%Lww{} = lww), do: lww

  defp compact_crdt(%OrSet{adds: adds, removed: removed}) do
    live =
      for {elem, tags} <- adds,
          live_tags = MapSet.difference(tags, removed),
          MapSet.size(live_tags) > 0,
          into: %{},
          do: {elem, live_tags}

    %OrSet{adds: live, removed: MapSet.new()}
  end

  defp compact_crdt(%CausalList{elements: elements, tombstones: tombstones}) do
    %CausalList{
      elements: Map.drop(elements, MapSet.to_list(tombstones)),
      tombstones: MapSet.new()
    }
  end

  # Per-role summary at F. Acquires are recoverable from the real analysis: an
  # honored (unquarantined) holder-change IS an acquire. Recorded heartbeats are
  # re-derived with the covered ancestor sets (a heartbeat by a non-holder is
  # silently ignored by the engine, so it leaves no analysis trace).
  defp summarize_roles(module, covered_ops, ordered, analysis, deleg_valid) do
    covered_anc = Dag.all_ancestors(covered_ops)

    Map.new(all_roles(module), fn role ->
      acquires =
        ordered
        |> Enum.map(&classify_acquire(&1, role, analysis.reasons, deleg_valid))
        |> Enum.reject(&is_nil/1)

      heartbeat_ticks = recorded_heartbeat_ticks(ordered, role, acquires, covered_anc)
      ticks = Enum.map(acquires, & &1.at_tick) ++ heartbeat_ticks

      {role,
       %{
         last_acquire: List.last(acquires),
         last_active_tick: Enum.max([0 | ticks])
       }}
    end)
  end

  defp classify_acquire(%Op{} = op, role, reasons, deleg_valid) do
    case op.body do
      {:genesis, %Delegation{} = d, _policies} ->
        if op.kind == :authority and deleg_valid[d.id] == :ok and MapSet.member?(d.roles, role),
          do: %{op_id: op.id, holder: d.audience, delegation_id: d.id, at_tick: 0}

      {:transfer, ^role, %Delegation{} = d, tick} ->
        if op.kind == :authority and not Map.has_key?(reasons, op.id),
          do: %{op_id: op.id, holder: d.audience, delegation_id: d.id, at_tick: tick}

      {:succeed, ^role, %Delegation{} = d, tick} ->
        if op.kind == :authority and not Map.has_key?(reasons, op.id),
          do: %{op_id: op.id, holder: d.audience, delegation_id: d.id, at_tick: tick}

      _ ->
        nil
    end
  end

  defp recorded_heartbeat_ticks(ordered, role, acquires, covered_anc) do
    for op <- ordered,
        op.kind == :authority,
        match?({:heartbeat, ^role, _}, op.body),
        {:heartbeat, ^role, tick} = op.body,
        heartbeat_recorded?(op, acquires, covered_anc),
        do: tick
  end

  defp heartbeat_recorded?(op, acquires, covered_anc) do
    anc = Map.get(covered_anc, op.id, MapSet.new())

    holder =
      acquires
      |> Enum.filter(&MapSet.member?(anc, &1.op_id))
      |> List.last()
      |> case do
        nil -> nil
        %{holder: h} -> h
      end

    op.author == holder
  end

  # --- Compacted materialization (the GATE's left-hand side) ----------------

  @doc """
  Reduce `snapshot ⊕ retained_log`: the seeded continuation of authority analysis
  and CRDT folding over the ops above `F`. Returns the materialized state plus
  the combined (frozen ∪ retained) quarantine/reasons/holders/requests — the
  exact quantities the GATE compares byte-for-byte against the full-log pipeline.
  """
  @spec reduce_compacted(module(), Snapshot.t(), Log.t()) :: %{
          state: map(),
          quarantine: MapSet.t(Op.id()),
          reasons: %{Op.id() => atom()},
          holders: %{atom() => term()},
          requests: [map()]
        }
  def reduce_compacted(module, %Snapshot{} = snapshot, %Log{} = retained_log) do
    analysis = analyze_compacted(module, snapshot, retained_log)
    state = materialize_compacted(module, snapshot, retained_log, analysis.quarantine)
    Map.put(analysis, :state, state)
  end

  # --- Seeded authority analysis --------------------------------------------

  defp analyze_compacted(module, %Snapshot{} = snapshot, %Log{} = retained_log) do
    ops = Log.ops(retained_log)
    ordered = Dag.topo_sort(ops)
    anc = Dag.all_ancestors(ops)

    {delegations, retained_intros} = merge_delegations(snapshot, ordered)
    root = snapshot.root || root_creator(ordered)

    genesis_ids =
      MapSet.union(snapshot.covered_genesis_ids, genesis_delegation_ids(ordered))

    succession_ids =
      MapSet.union(snapshot.covered_succession_ids, succession_delegation_ids(ordered))

    deleg_valid =
      validate_delegations_merged(delegations, root, genesis_ids, succession_ids)

    policies =
      Map.merge(snapshot.policies, collect_valid_policies(ordered, deleg_valid, root))

    revokes = merged_revokes(snapshot, ordered, delegations, root)
    invalid_intros = invalid_intro_reasons(retained_intros, deleg_valid)
    invalid_genesis = invalid_genesis_reasons(ordered, deleg_valid, root)

    ctx = %{
      module: module,
      anc: anc,
      delegations: delegations,
      deleg_valid: deleg_valid,
      retained_intros: retained_intros,
      covered_intros: snapshot.covered_intros,
      covered_honored_succession_ids: snapshot.covered_honored_succession_ids,
      revokes: revokes
    }

    timelines =
      Map.new(all_roles(module), fn role ->
        {role, build_seeded_timeline(role, snapshot, ordered, anc, deleg_valid, policies)}
      end)

    role_reasons =
      Enum.reduce(timelines, %{}, fn {_r, tl}, acc -> Map.merge(acc, tl.quarantine) end)

    {cmd_reasons, requests} = validate_retained_commands(ordered, timelines, ctx)

    new_reasons =
      invalid_intros
      |> Map.merge(invalid_genesis)
      |> Map.merge(role_reasons)
      |> Map.merge(cmd_reasons)

    reasons = Map.merge(snapshot.frozen_reasons, new_reasons)

    %{
      quarantine: reasons |> Map.keys() |> MapSet.new(),
      reasons: reasons,
      holders: Map.new(timelines, fn {role, tl} -> {role, tl.holder} end),
      requests: snapshot.frozen_requests ++ requests
    }
  end

  defp merge_delegations(%Snapshot{} = snapshot, ordered) do
    Enum.reduce(ordered, {snapshot.delegations, %{}}, fn op, {delegs, intros} ->
      case delegation_in(op) do
        nil ->
          {delegs, intros}

        %Delegation{} = d ->
          {Map.put_new(delegs, d.id, d), Map.update(intros, d.id, [op.id], &[op.id | &1])}
      end
    end)
  end

  defp validate_delegations_merged(delegations, root, genesis_ids, succession_ids) do
    Map.new(delegations, fn {id, d} ->
      {id, validate_delegation(d, delegations, root, genesis_ids, succession_ids)}
    end)
  end

  defp merged_revokes(%Snapshot{} = snapshot, ordered, delegations, root) do
    covered = Enum.map(snapshot.covered_revokes, &Map.put(&1, :covered?, true))

    retained =
      for op <- ordered,
          match?({:revoke, _}, op.body),
          {:revoke, deleg_id} = op.body,
          do: %{op_id: op.id, deleg_id: deleg_id, author: op.author, covered?: false}

    Enum.filter(covered ++ retained, fn r ->
      revoke_authorized?(r.author, r.deleg_id, delegations, root)
    end)
  end

  defp invalid_intro_reasons(retained_intros, deleg_valid) do
    for {id, op_ids} <- retained_intros,
        {:error, reason} <- [deleg_valid[id]],
        op_id <- op_ids,
        into: %{},
        do: {op_id, reason}
  end

  # --- Seeded role timelines -------------------------------------------------

  # The timeline seed is the covered summary: `seed_acquire` stands in for the
  # entire covered acquire history (stability makes every covered acquire visible
  # to every retained op, so only the last one is ever load-bearing), and
  # `base_tick` folds all covered activity into one dormancy floor.
  defp build_seeded_timeline(role, %Snapshot{} = snapshot, ordered, anc, deleg_valid, policies) do
    seed = Map.get(snapshot.roles, role, %{last_acquire: nil, last_active_tick: 0})

    init = %{
      seed_acquire: seed.last_acquire,
      base_tick: seed.last_active_tick,
      holder: Map.get(snapshot.frozen_holders, role),
      acquires: [],
      heartbeats: [],
      covered_honored_succession_ids: snapshot.covered_honored_succession_ids,
      quarantine: %{}
    }

    Enum.reduce(ordered, init, fn op, tl ->
      case role_event(op, role) do
        nil -> tl
        {:genesis, d} -> seeded_genesis(tl, op, role, d, deleg_valid)
        {:transfer, d, tick} -> seeded_transfer(tl, op, role, d, tick, anc, deleg_valid)
        {:succeed, d, tick} -> seeded_succeed(tl, op, role, d, tick, anc, deleg_valid, policies)
        {:heartbeat, tick} -> seeded_heartbeat(tl, op, tick, anc)
      end
    end)
  end

  defp role_event(%Op{kind: :authority, body: body}, role) do
    case body do
      {:genesis, %Delegation{} = d, _policies} ->
        if MapSet.member?(d.roles, role), do: {:genesis, d}

      {:transfer, ^role, %Delegation{} = d, tick} ->
        {:transfer, d, tick}

      {:succeed, ^role, %Delegation{} = d, tick} ->
        {:succeed, d, tick}

      {:heartbeat, ^role, tick} ->
        {:heartbeat, tick}

      _ ->
        nil
    end
  end

  defp role_event(_op, _role), do: nil

  defp seeded_genesis(tl, op, role, d, deleg_valid) do
    cond do
      deleg_valid[d.id] != :ok or not MapSet.member?(d.roles, role) ->
        tl

      not is_nil(d.parent_id) ->
        seeded_reject(tl, op, :invalid_genesis)

      op.author != d.audience ->
        seeded_reject(tl, op, :unauthorized_genesis)

      true ->
        seeded_acquire(tl, op, d, 0)
    end
  end

  defp seeded_transfer(tl, op, role, d, tick, anc, deleg_valid) do
    cond do
      not seeded_delegation_valid_at?(deleg_valid[d.id], tl, anc) or
        op.author != d.issuer or not MapSet.member?(d.roles, role) ->
        seeded_reject(tl, op, :invalid_transfer)

      seeded_holder_at(tl, Map.get(anc, op.id, MapSet.new())) != op.author ->
        seeded_reject(tl, op, :transfer_not_holder)

      tl.holder != op.author ->
        seeded_reject(tl, op, :double_transfer)

      true ->
        seeded_acquire(tl, op, d, tick)
    end
  end

  defp seeded_succeed(tl, op, role, d, tick, anc, deleg_valid, policies) do
    op_anc = Map.get(anc, op.id, MapSet.new())
    last_active = seeded_last_active(tl, op_anc)
    policy = Map.get(policies, role)

    cond do
      not seeded_succession_delegation?(deleg_valid[d.id], d.id) or
        op.author != d.audience or op.author != d.issuer or
          not MapSet.member?(d.roles, role) ->
        seeded_reject(tl, op, :invalid_succession)

      is_nil(policy) or op.author != policy.successor ->
        seeded_reject(tl, op, :unauthorized_succession)

      tick < last_active + policy.dormant_ticks ->
        seeded_reject(tl, op, :premature_succession)

      true ->
        seeded_acquire(tl, op, d, tick)
    end
  end

  defp seeded_heartbeat(tl, op, tick, anc) do
    if op.author == seeded_holder_at(tl, Map.get(anc, op.id, MapSet.new())) do
      %{tl | heartbeats: tl.heartbeats ++ [%{op_id: op.id, at_tick: tick}]}
    else
      tl
    end
  end

  defp seeded_acquire(tl, op, %Delegation{} = delegation, tick) do
    %{
      tl
      | holder: delegation.audience,
        acquires:
          tl.acquires ++
            [
              %{
                op_id: op.id,
                holder: delegation.audience,
                delegation_id: delegation.id,
                at_tick: tick
              }
            ]
    }
  end

  defp seeded_reject(tl, op, reason) do
    %{tl | quarantine: Map.put(tl.quarantine, op.id, reason)}
  end

  # Holder at a retained op's causal position: the last retained acquire visible
  # to it, else the seed (all covered acquires are visible under stability).
  defp seeded_holder_at(tl, op_anc) do
    tl.acquires
    |> Enum.filter(&MapSet.member?(op_anc, &1.op_id))
    |> List.last()
    |> case do
      nil -> tl.seed_acquire && tl.seed_acquire.holder
      %{holder: h} -> h
    end
  end

  # Dormancy floor: covered activity collapses to base_tick; retained events
  # count only if causally visible (mirrors Authority.last_active_from/3).
  defp seeded_last_active(tl, op_anc) do
    ticks =
      for ev <- tl.acquires ++ tl.heartbeats,
          MapSet.member?(op_anc, ev.op_id),
          do: ev.at_tick

    Enum.max([tl.base_tick | ticks])
  end

  # --- Retained command validation -------------------------------------------

  defp validate_retained_commands(ordered, timelines, ctx) do
    Enum.reduce(ordered, {%{}, []}, fn op, {reasons, requests} ->
      cond do
        op.kind == :inbox and match?({:request, _ref, _payload}, op.body) ->
          {:request, ref, payload} = op.body
          {reasons, requests ++ [%{op: op.id, author: op.author, ref: ref, payload: payload}]}

        op.kind == :command ->
          case validate_retained_command(op, timelines, ctx) do
            :ok -> {reasons, requests}
            {:error, reason} -> {Map.put(reasons, op.id, reason), requests}
          end

        true ->
          {reasons, requests}
      end
    end)
  end

  defp validate_retained_command(op, timelines, ctx) do
    {cmd, args} =
      case op.body do
        {cmd, args} when is_list(args) -> {cmd, args}
        _ -> {nil, nil}
      end

    cond do
      is_nil(cmd) ->
        {:error, :malformed_command}

      not command_defined?(ctx.module, cmd) ->
        {:error, :unknown_command}

      true ->
        mutations = command_mutations(ctx.module, cmd, args)
        roles_needed = mutation_roles(ctx.module, mutations)

        with :ok <- seeded_cap_ok(op, cmd, roles_needed, timelines, ctx) do
          seeded_authority_ok(op, roles_needed, timelines, ctx.anc)
        end
    end
  end

  defp seeded_cap_ok(op, cmd, roles_needed, timelines, ctx) do
    case Map.fetch(ctx.delegations, op.cap) do
      :error ->
        {:error, :no_capability}

      {:ok, %Delegation{} = d} ->
        seeded_cap_checks(op, cmd, d, roles_needed, timelines, ctx)
    end
  end

  defp seeded_cap_checks(op, cmd, d, roles_needed, timelines, ctx) do
    cond do
      not compacted_delegation_valid_at?(
        ctx.deleg_valid[d.id],
        op,
        timelines,
        ctx
      ) ->
        {:error, :invalid_capability}

      op.author != d.audience ->
        {:error, :capability_wrong_audience}

      not MapSet.member?(d.ops, cmd) ->
        {:error, :operation_not_granted}

      not intro_visible?(d.id, op, ctx) ->
        {:error, :capability_not_visible}

      not Enum.all?(roles_needed, &MapSet.member?(d.roles, &1)) ->
        {:error, :role_not_granted}

      seeded_revoked_as_of?(op, d, ctx) ->
        {:error, :revoked_capability}

      true ->
        :ok
    end
  end

  # A covered introduction is an ancestor of every retained op (stability);
  # a retained introduction must be causally visible the ordinary way.
  defp intro_visible?(deleg_id, op, ctx) do
    op_anc = Map.get(ctx.anc, op.id, MapSet.new())

    MapSet.member?(ctx.covered_intros, deleg_id) or
      ctx.retained_intros |> Map.get(deleg_id, []) |> Enum.any?(&MapSet.member?(op_anc, &1))
  end

  defp seeded_succession_delegation?(:ok, _delegation_id), do: true
  defp seeded_succession_delegation?({:candidate, delegation_id}, delegation_id), do: true
  defp seeded_succession_delegation?(_validation, _delegation_id), do: false

  defp seeded_delegation_valid_at?(:ok, _timeline, _ancestors), do: true

  defp seeded_delegation_valid_at?({:candidate, root_id}, timeline, ancestors) do
    MapSet.member?(timeline.covered_honored_succession_ids, root_id) or
      Enum.any?(timeline.acquires, fn acquire ->
        acquire.delegation_id == root_id and MapSet.member?(ancestors, acquire.op_id)
      end)
  end

  defp seeded_delegation_valid_at?(_validation, _timeline, _ancestors), do: false

  defp compacted_delegation_valid_at?(:ok, _op, _timelines, _ctx), do: true

  defp compacted_delegation_valid_at?({:candidate, root_id}, op, timelines, ctx) do
    op_anc = Map.get(ctx.anc, op.id, MapSet.new())

    MapSet.member?(ctx.covered_honored_succession_ids, root_id) or
      Enum.any?(timelines, fn {_role, timeline} ->
        Enum.any?(timeline.acquires, fn acquire ->
          acquire.delegation_id == root_id and MapSet.member?(op_anc, acquire.op_id)
        end)
      end)
  end

  defp compacted_delegation_valid_at?(_validation, _op, _timelines, _ctx), do: false

  # A covered revoke can never be causally after a retained op, so it always
  # applies; a retained revoke applies unless the op is causally before it.
  defp seeded_revoked_as_of?(op, d, ctx) do
    chain_ids = delegation_chain_ids(d, ctx.delegations)

    Enum.any?(ctx.revokes, fn r ->
      r.deleg_id in chain_ids and
        (r.covered? or
           not MapSet.member?(Map.get(ctx.anc, r.op_id, MapSet.new()), op.id))
    end)
  end

  defp seeded_authority_ok(_op, [], _timelines, _anc), do: :ok

  defp seeded_authority_ok(op, roles_needed, timelines, anc) do
    op_anc = Map.get(anc, op.id, MapSet.new())

    Enum.reduce_while(roles_needed, :ok, fn role, _ ->
      tl = Map.fetch!(timelines, role)

      cond do
        seeded_holder_at(tl, op_anc) != op.author ->
          {:halt, {:error, :not_holder}}

        seeded_stale_holder?(op, tl, op_anc, anc) ->
          {:halt, {:error, :stale_holder}}

        true ->
          {:cont, :ok}
      end
    end)
  end

  # Mirrors Authority.stale_holder?/4 with the covered prefix collapsed to the
  # seed: if the op's last visible acquire is the seed, the "next" holder-change
  # is the first retained acquire; otherwise it is the next retained acquire.
  defp seeded_stale_holder?(op, tl, op_anc, anc) do
    visible = Enum.filter(tl.acquires, &MapSet.member?(op_anc, &1.op_id))

    next =
      case List.last(visible) do
        nil ->
          if tl.seed_acquire, do: List.first(tl.acquires)

        %{op_id: last_id} ->
          idx = Enum.find_index(tl.acquires, &(&1.op_id == last_id))
          Enum.at(tl.acquires, idx + 1)
      end

    case next do
      nil -> false
      %{op_id: next_op} -> not MapSet.member?(Map.get(anc, next_op, MapSet.new()), op.id)
    end
  end

  # --- Seeded CRDT fold -------------------------------------------------------

  defp materialize_compacted(module, %Snapshot{} = snapshot, %Log{} = retained_log, quarantine) do
    ops = Log.ops(retained_log)
    heights = seeded_heights(ops, snapshot.covered_heights)
    anc = Dag.all_ancestors(ops)

    command_ops =
      ops
      |> Map.values()
      |> Enum.filter(&(&1.kind == :command and not MapSet.member?(quarantine, &1.id)))

    mutations =
      Enum.flat_map(command_ops, fn op ->
        case op.body do
          {cmd, args} when is_list(args) ->
            module
            |> command_mutations(cmd, args)
            |> Enum.map(fn {field, mutation} -> {field, op, mutation} end)

          _ ->
            []
        end
      end)

    by_field = Enum.group_by(mutations, fn {field, _op, _m} -> field end)
    add_index = build_add_index(by_field)

    for {field, spec} <- module.__lattice_fields__(), into: %{} do
      seed = Map.fetch!(snapshot.crdts, field)
      muts = Map.get(by_field, field, [])

      ctx = %{
        heights: heights,
        anc: anc,
        adds: Map.get(add_index, field, %{}),
        seed: seed
      }

      {field, materialize_value(spec, fold_field(spec, seed, muts, ctx))}
    end
  end

  # Retained op heights continue the covered height function: a dep beneath F
  # resolves through the snapshot's covered heights, so causal tags — and with
  # them every LWW winner and list position — are identical to the full log's.
  defp seeded_heights(ops, covered_heights) do
    Enum.reduce(Dag.topo_sort(ops), %{}, fn op, acc ->
      max_dep_height =
        case op.deps do
          [] ->
            -1

          deps ->
            deps
            |> Enum.map(fn dep -> Map.get(acc, dep) || Map.get(covered_heights, dep, -1) end)
            |> Enum.max()
        end

      Map.put(acc, op.id, max_dep_height + 1)
    end)
  end

  defp build_add_index(by_field) do
    for {field, muts} <- by_field, into: %{} do
      index =
        Enum.reduce(muts, %{}, fn
          {^field, op, {:add, elem}}, acc ->
            Map.update(acc, elem, MapSet.new([op.id]), &MapSet.put(&1, op.id))

          _, acc ->
            acc
        end)

      {field, index}
    end
  end

  defp fold_field(%{kind: :crdt, crdt: :lww}, seed, muts, ctx), do: fold_lww(seed, muts, ctx)
  defp fold_field(%{kind: :authority}, seed, muts, ctx), do: fold_lww(seed, muts, ctx)

  defp fold_field(%{kind: :crdt, crdt: :or_set}, seed, muts, ctx),
    do: fold_or_set(seed, muts, ctx)

  defp fold_field(%{kind: :crdt, crdt: :causal_list}, seed, muts, ctx),
    do: fold_causal_list(seed, muts, ctx)

  defp fold_lww(seed, muts, %{heights: heights}) do
    Enum.reduce(muts, seed, fn
      {_field, op, {:write, value}}, lww ->
        Lww.put(lww, value, {Map.fetch!(heights, op.id), op.id})

      _, lww ->
        lww
    end)
  end

  # Observed remove across F: every live covered add is observed (stability);
  # retained adds are observed only if causally visible to the remove.
  defp fold_or_set(seed, muts, %{anc: anc, adds: adds, seed: orig_seed}) do
    Enum.reduce(muts, seed, fn
      {_field, op, {:add, elem}}, set ->
        OrSet.add(set, elem, op.id)

      {_field, op, {:remove, elem}}, set ->
        op_anc = Map.get(anc, op.id, MapSet.new())

        observed_retained =
          adds |> Map.get(elem, MapSet.new()) |> MapSet.intersection(op_anc)

        OrSet.remove(set, MapSet.union(OrSet.tags_for(orig_seed, elem), observed_retained))

      _, set ->
        set
    end)
  end

  defp fold_causal_list(seed, muts, %{heights: heights}) do
    Enum.reduce(muts, seed, fn
      {_field, op, {:append, value}}, list ->
        CausalList.insert(list, op.id, value, {Map.fetch!(heights, op.id), op.id})

      {_field, op, {:insert, value}}, list ->
        CausalList.insert(list, op.id, value, {Map.fetch!(heights, op.id), op.id})

      {_field, _op, {:delete, target_id}}, list ->
        CausalList.delete(list, target_id)

      _, list ->
        list
    end)
  end

  defp materialize_value(%{kind: :crdt, crdt: :lww, default: default}, crdt),
    do: Lww.value(crdt, default)

  defp materialize_value(%{kind: :authority, default: default}, crdt),
    do: Lww.value(crdt, default)

  defp materialize_value(%{kind: :crdt, crdt: :or_set}, crdt), do: OrSet.to_list(crdt)
  defp materialize_value(%{kind: :crdt, crdt: :causal_list}, crdt), do: CausalList.value(crdt)

  # --- Shared helpers mirroring Lattice.Authority internals ------------------

  defp collect_delegations(ordered) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case delegation_in(op) do
        nil ->
          acc

        %Delegation{} = d ->
          Map.update(acc, d.id, %{deleg: d, op_ids: [op.id]}, fn entry ->
            %{entry | op_ids: [op.id | entry.op_ids]}
          end)
      end
    end)
  end

  defp delegation_in(%Op{kind: :authority, body: body}) do
    case body do
      {:genesis, %Delegation{} = d, _policies} -> d
      {:grant, %Delegation{} = d} -> d
      {:transfer, _role, %Delegation{} = d, _tick} -> d
      {:succeed, _role, %Delegation{} = d, _tick} -> d
      _ -> nil
    end
  end

  defp delegation_in(_), do: nil

  defp validate_delegations(delegations, root, genesis_ids, succession_ids) do
    structs = Map.new(delegations, fn {id, %{deleg: d}} -> {id, d} end)

    Map.new(structs, fn {id, d} ->
      {id, validate_delegation(d, structs, root, genesis_ids, succession_ids)}
    end)
  end

  defp validate_delegation(%Delegation{} = d, delegations, root, genesis_ids, succession_ids) do
    cond do
      not Delegation.valid_sig?(d) ->
        {:error, :bad_delegation_sig}

      is_nil(d.parent_id) ->
        cond do
          d.issuer != d.audience ->
            {:error, :nongenesis_root}

          MapSet.member?(genesis_ids, d.id) and (is_nil(root) or d.audience == root) ->
            :ok

          MapSet.member?(succession_ids, d.id) ->
            {:candidate, d.id}

          MapSet.member?(genesis_ids, d.id) ->
            {:error, :impostor_genesis}

          true ->
            {:error, :unrooted_delegation}
        end

      true ->
        validate_delegation_parent(d, delegations, root, genesis_ids, succession_ids)
    end
  end

  defp validate_delegation_parent(
         %Delegation{} = d,
         delegations,
         root,
         genesis_ids,
         succession_ids
       ) do
    case Map.fetch(delegations, d.parent_id) do
      {:ok, %Delegation{} = parent} ->
        parent_validation =
          validate_delegation(parent, delegations, root, genesis_ids, succession_ids)

        cond do
          not Delegation.attenuates?(d, parent) -> {:error, :not_attenuated}
          parent_validation == :ok -> :ok
          match?({:candidate, _root_id}, parent_validation) -> parent_validation
          true -> {:error, :invalid_parent}
        end

      :error ->
        {:error, :missing_parent}
    end
  end

  defp delegation_chain_ids(%Delegation{} = d, delegations) do
    case d.parent_id && Map.fetch(delegations, d.parent_id) do
      {:ok, %Delegation{} = parent} -> [d.id | delegation_chain_ids(parent, delegations)]
      _ -> [d.id]
    end
  end

  defp genesis_delegation_ids(ordered) do
    for %Op{kind: :authority, body: {:genesis, %Delegation{id: id}, _policies}} <- ordered,
        into: MapSet.new(),
        do: id
  end

  defp succession_delegation_ids(ordered) do
    for %Op{kind: :authority, body: {:succeed, _role, %Delegation{id: id}, _proof}} <- ordered,
        into: MapSet.new(),
        do: id
  end

  defp honored_succession_delegation_ids(ordered, reasons) do
    for %Op{id: op_id, kind: :authority, body: {:succeed, _role, %Delegation{id: id}, _proof}} <-
          ordered,
        not Map.has_key?(reasons, op_id),
        into: MapSet.new(),
        do: id
  end

  defp invalid_genesis_reasons(ordered, deleg_valid, root) do
    for %Op{id: op_id, kind: :authority, body: {:genesis, %Delegation{} = d, _policies}} <-
          ordered,
        Delegation.valid_sig?(d),
        reason = invalid_genesis_reason(d, deleg_valid[d.id], root),
        not is_nil(reason),
        into: %{},
        do: {op_id, reason}
  end

  defp invalid_genesis_reason(%Delegation{parent_id: parent_id}, _validation, _root)
       when not is_nil(parent_id),
       do: :invalid_genesis

  defp invalid_genesis_reason(%Delegation{audience: audience}, {:candidate, _root_id}, root)
       when not is_nil(root) and audience != root,
       do: :impostor_genesis

  defp invalid_genesis_reason(_delegation, _validation, _root), do: nil

  defp collect_valid_policies(ordered, deleg_valid, root) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case op.body do
        {:genesis, %Delegation{} = d, policies}
        when is_map(policies) ->
          if deleg_valid[d.id] == :ok and is_nil(d.parent_id) and op.author == d.audience and
               (is_nil(root) or d.audience == root),
             do: Map.merge(acc, policies),
             else: acc

        _ ->
          acc
      end
    end)
  end

  defp root_creator(ordered) do
    Enum.find_value(ordered, fn op ->
      case op.body do
        {:genesis, %Delegation{audience: aud}, _policies} -> aud
        _ -> nil
      end
    end)
  end

  defp collect_raw_revokes(ordered) do
    for op <- ordered,
        match?({:revoke, _}, op.body),
        {:revoke, deleg_id} = op.body,
        do: %{op_id: op.id, deleg_id: deleg_id, author: op.author}
  end

  defp revoke_authorized?(author, deleg_id, delegations, root) do
    case Map.fetch(delegations, deleg_id) do
      {:ok, %Delegation{} = d} -> author == d.issuer or author == root
      :error -> false
    end
  end

  defp command_defined?(module, cmd) do
    Enum.any?(module.__lattice_commands__(), fn {name, _arity, _args} -> name == cmd end)
  end

  defp command_mutations(_module, nil, _args), do: []

  defp command_mutations(module, cmd, args) do
    module.__apply_command__(cmd, args)
  rescue
    ArgumentError -> []
  end

  defp mutation_roles(module, mutations) do
    mutations
    |> Enum.map(fn {field, _m} -> module.authority_role(field) end)
    |> Enum.reject(&is_nil/1)
    |> Enum.uniq()
  end

  defp all_roles(module) do
    field_roles =
      module.__lattice_fields__()
      |> Enum.map(fn {field, _spec} -> module.authority_role(field) end)
      |> Enum.reject(&is_nil/1)

    succession_roles = Map.keys(module.__lattice_succession__())
    MapSet.new(field_roles ++ succession_roles)
  end
end
