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
  alias Lattice.Authority.{BeaconCertificate, Continuation, Delegation, SuccessionCertificate}
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
              # role => delegation ids introduced by covered, honored
              # succession ops for that exact role.
              covered_honored_succession_ids: %{},
              policies: %{},
              root: nil,
              # Raw covered revoke refs (re-judged against the merged delegation
              # set at analysis time, since authorization can bind late).
              covered_revokes: [],
              covered_beacon_epoch: -1,
              covered_beacon_policy: nil,
              covered_continuation_pin: nil,
              covered_beacon_basis: [],
              # role => %{last_acquire: %{op_id, holder, at_tick} | nil,
              #           last_active_tick: n}
              roles: %{},
              hash: nil
  end

  defmodule ApplicationSnapshot do
    @moduledoc """
    Research-only application evidence around an unchanged default `Snapshot`.

    It retains every covered operation and therefore makes no compaction or
    storage-bound claim.
    """

    defstruct version: 1,
              authority_profile: :covered_authority_v1,
              replica: nil,
              frontier: [],
              base_snapshot: nil,
              covered_ops: %{},
              covered_individual_reasons: %{},
              covered_final_reasons: %{},
              covered_conflict_losers: %{},
              covered_valid_beacons: [],
              hash: nil

    @type t :: %__MODULE__{
            version: pos_integer(),
            authority_profile: atom(),
            replica: String.t(),
            frontier: [Lattice.Op.id()],
            base_snapshot: struct(),
            covered_ops: %{Lattice.Op.id() => Lattice.Op.t()},
            covered_individual_reasons: %{Lattice.Op.id() => atom()},
            covered_final_reasons: %{Lattice.Op.id() => atom()},
            covered_conflict_losers: %{Lattice.Op.id() => atom()},
            covered_valid_beacons: [%{op_id: Lattice.Op.id(), epoch: non_neg_integer()}],
            hash: binary()
          }
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

  @doc "Research-only application evidence at a stable frontier."
  @spec compact_application(module(), Log.t(), [Op.id()]) ::
          {:ok, ApplicationSnapshot.t(), Log.t()} | {:error, term()}
  def compact_application(module, %Log{} = log, frontier) do
    with :ok <- application_log_authenticity(log),
         {:ok, base_snapshot, retained_log} <- compact(module, log, frontier) do
      all_ops = Log.ops(log)
      covered_ids = Dag.reachable(all_ops, frontier)
      covered_ops = Map.take(all_ops, MapSet.to_list(covered_ids))

      snapshot =
        build_application_snapshot(module, base_snapshot, log.replica, covered_ops, frontier)

      {:ok, snapshot, retained_log}
    end
  end

  @doc "Reduce a verified application snapshot plus its retained log."
  @spec reduce_application(module(), ApplicationSnapshot.t(), Log.t()) ::
          map() | {:error, term()}
  def reduce_application(module, %ApplicationSnapshot{} = snapshot, %Log{} = retained_log) do
    with :ok <- verify_application_container(snapshot),
         :ok <- verify_retained_envelope(snapshot, retained_log),
         {:ok, combined_log, retained_ops} <- combine_application_logs(snapshot, retained_log),
         :ok <- verify_application_cut(snapshot, combined_log, retained_ops),
         :ok <- verify_application_profile(retained_ops),
         :ok <- verify_application_evidence(module, snapshot) do
      reduce_verified_application(module, snapshot, combined_log, retained_ops)
    end
  end

  defp build_application_snapshot(module, base_snapshot, replica, covered_ops, frontier) do
    covered_log = Log.from_ops(replica, covered_ops)

    {analysis, covered_valid_beacons} =
      Authority.analyze_with_beacon_evidence(module, covered_log)

    conflict_losers =
      for %{event: :command_conflict, op: id, reason: reason} <- analysis.audit,
          into: %{},
          do: {id, reason}

    snapshot = %ApplicationSnapshot{
      replica: replica,
      frontier: Enum.sort(frontier),
      base_snapshot: base_snapshot,
      covered_ops: covered_ops,
      covered_individual_reasons: Map.drop(analysis.reasons, Map.keys(conflict_losers)),
      covered_final_reasons: analysis.reasons,
      covered_conflict_losers: conflict_losers,
      covered_valid_beacons: covered_valid_beacons
    }

    %{snapshot | hash: application_snapshot_hash(snapshot)}
  end

  defp application_snapshot_hash(%ApplicationSnapshot{} = snapshot) do
    :crypto.hash(
      :sha256,
      :erlang.term_to_binary(%{snapshot | hash: nil}, [:deterministic, {:minor_version, 2}])
    )
  end

  defp application_log_authenticity(log) do
    case Log.verify_authenticity(log) do
      :ok -> :ok
      {:error, errors} -> {:error, {:application_log_invalid, errors}}
    end
  end

  defp verify_application_container(%ApplicationSnapshot{} = snapshot) do
    with true <- snapshot.version == 1,
         true <- snapshot.authority_profile == :covered_authority_v1,
         true <- is_binary(snapshot.replica),
         true <- is_list(snapshot.frontier),
         true <- is_map(snapshot.covered_ops),
         true <- is_map(snapshot.covered_individual_reasons),
         true <- is_map(snapshot.covered_final_reasons),
         true <- is_map(snapshot.covered_conflict_losers),
         true <- is_list(snapshot.covered_valid_beacons),
         true <- snapshot.frontier == Enum.sort(snapshot.frontier),
         true <- Enum.all?(snapshot.frontier, &Map.has_key?(snapshot.covered_ops, &1)),
         true <- covered_entries_bound?(snapshot),
         true <- application_reason_maps_closed?(snapshot),
         true <- application_beacons_closed?(snapshot),
         true <- application_snapshot_hash(snapshot) == snapshot.hash,
         covered_log = Log.from_ops(snapshot.replica, snapshot.covered_ops),
         :ok <- application_log_authenticity(covered_log),
         %Snapshot{} = base_snapshot <- snapshot.base_snapshot,
         true <- snapshot_hash(base_snapshot) == base_snapshot.hash do
      :ok
    else
      _other -> {:error, :application_snapshot_mismatch}
    end
  rescue
    _error -> {:error, :application_snapshot_mismatch}
  end

  defp covered_entries_bound?(snapshot) do
    Enum.all?(snapshot.covered_ops, fn
      {id, %Op{id: op_id, replica: replica}} -> id == op_id and replica == snapshot.replica
      _entry -> false
    end)
  end

  defp application_reason_maps_closed?(snapshot) do
    covered_ids = map_keys(snapshot.covered_ops)
    individual_ids = map_keys(snapshot.covered_individual_reasons)
    final_ids = map_keys(snapshot.covered_final_reasons)
    conflict_ids = map_keys(snapshot.covered_conflict_losers)

    MapSet.subset?(individual_ids, covered_ids) and
      MapSet.subset?(final_ids, covered_ids) and
      MapSet.subset?(conflict_ids, covered_ids) and
      MapSet.disjoint?(individual_ids, conflict_ids) and
      Map.merge(snapshot.covered_individual_reasons, snapshot.covered_conflict_losers) ==
        snapshot.covered_final_reasons
  end

  defp application_beacons_closed?(snapshot) do
    snapshot.covered_valid_beacons == Enum.sort_by(snapshot.covered_valid_beacons, & &1.op_id) and
      Enum.all?(snapshot.covered_valid_beacons, fn
        %{op_id: id, epoch: epoch} -> Map.has_key?(snapshot.covered_ops, id) and is_integer(epoch)
        _record -> false
      end)
  end

  defp verify_application_evidence(module, %ApplicationSnapshot{} = snapshot) do
    covered_log = Log.from_ops(snapshot.replica, snapshot.covered_ops)

    with :ok <- verify(module, snapshot.base_snapshot, covered_log),
         recomputed_base =
           build_snapshot(module, snapshot.replica, snapshot.covered_ops, snapshot.frontier),
         recomputed =
           build_application_snapshot(
             module,
             recomputed_base,
             snapshot.replica,
             snapshot.covered_ops,
             snapshot.frontier
           ),
         true <- recomputed.hash == snapshot.hash do
      :ok
    else
      _other -> {:error, :application_snapshot_mismatch}
    end
  rescue
    _error -> {:error, :application_snapshot_mismatch}
  end

  defp verify_retained_envelope(%ApplicationSnapshot{} = snapshot, %Log{} = retained_log) do
    expected_references = retained_references(Log.ops(retained_log))

    if match?(%MapSet{}, expected_references) and retained_log.replica == snapshot.replica and
         retained_log.quarantine == [] and
         MapSet.equal?(retained_log.referenced, expected_references),
       do: :ok,
       else: {:error, :application_retained_log_mismatch}
  end

  defp retained_references(ops) do
    Enum.reduce_while(ops, MapSet.new(), fn
      {_id, %Op{deps: deps}}, references when is_list(deps) ->
        {:cont, MapSet.union(references, MapSet.new(deps))}

      _entry, _references ->
        {:halt, :invalid}
    end)
  end

  defp combine_application_logs(%ApplicationSnapshot{} = snapshot, %Log{} = retained_log) do
    retained_ops = Log.ops(retained_log)
    overlap = MapSet.intersection(map_keys(snapshot.covered_ops), map_keys(retained_ops))

    if MapSet.size(overlap) > 0 do
      {:error, :application_cut_mismatch}
    else
      combined_log =
        Log.from_ops(snapshot.replica, Map.merge(snapshot.covered_ops, retained_ops))

      case application_log_authenticity(combined_log) do
        :ok -> {:ok, combined_log, retained_ops}
        {:error, _reason} = error -> error
      end
    end
  end

  defp verify_application_cut(snapshot, combined_log, retained_ops) do
    all_ops = Log.ops(combined_log)
    covered_ids = Dag.reachable(all_ops, snapshot.frontier)

    cond do
      not MapSet.equal?(covered_ids, map_keys(snapshot.covered_ops)) ->
        {:error, :application_cut_mismatch}

      unstable = unstable_op(all_ops, retained_ops, snapshot.frontier) ->
        {:error, {:unstable_frontier, unstable}}

      true ->
        :ok
    end
  end

  defp verify_application_profile(retained_ops) do
    outside_profile_ids =
      retained_ops
      |> Map.values()
      |> Enum.reject(&(&1.kind in [:command, :inbox]))
      |> Enum.map(& &1.id)
      |> Enum.sort()

    if outside_profile_ids == [],
      do: :ok,
      else: {:error, {:application_authority_rebinding_outside_profile, outside_profile_ids}}
  end

  defp reduce_verified_application(module, snapshot, combined_log, retained_ops) do
    base = snapshot.base_snapshot
    combined_ops = Log.ops(combined_log)
    ancestors = Dag.all_ancestors(combined_ops)
    retained_ids = map_keys(retained_ops)
    seed = application_covered_authority_seed(module, snapshot)

    ordered_retained =
      combined_ops
      |> Dag.topo_sort()
      |> Enum.filter(&MapSet.member?(retained_ids, &1.id))

    revokes =
      base
      |> Map.put(:covered_revokes, collect_raw_revokes(seed.ordered))
      |> merged_revokes(ordered_retained, seed.delegations, base.root)

    # The verified stable cut places every covered beacon in every retained op's strict past.
    covered_lease_beacons =
      Enum.map(snapshot.covered_valid_beacons, fn %{op_id: op_id, epoch: epoch} ->
        %{op_id: op_id, epoch: epoch, covered?: true}
      end)

    seeded_base = %{base | delegations: seed.delegations, roles: seed.roles}

    timelines =
      Map.new(all_roles(module), fn role ->
        {role,
         build_seeded_timeline(
           role,
           seeded_base,
           [],
           ancestors,
           seed.deleg_valid,
           base.policies,
           seed.continuation
         )}
      end)

    ctx = %{
      module: module,
      anc: ancestors,
      ops: combined_ops,
      delegations: seed.delegations,
      covered_delegation_ids: seed.delegation_ids,
      deleg_valid: seed.deleg_valid,
      retained_intros: %{},
      covered_intros: seed.covered_intros,
      covered_honored_succession_ids: base.covered_honored_succession_ids,
      revokes: revokes,
      beacons: covered_lease_beacons,
      valid_beacons: snapshot.covered_valid_beacons
    }

    unsupported_reasons =
      if seed.continuation.family == :unsupported,
        do: Map.new(ordered_retained, &{&1.id, :unsupported_authority_profile}),
        else: %{}

    {retained_command_reasons, retained_requests} =
      validate_application_commands(
        ordered_retained,
        timelines,
        ctx,
        snapshot.covered_individual_reasons,
        unsupported_reasons
      )

    retained_reasons = Map.merge(retained_command_reasons, unsupported_reasons)
    individual_reasons = Map.merge(snapshot.covered_individual_reasons, retained_reasons)

    full_verdicts =
      Map.new(combined_ops, fn {id, _op} ->
        {id, Map.get(individual_reasons, id, :honored)}
      end)

    conflict_losers =
      module.command_conflicts(combined_ops, full_verdicts, ancestors)
      |> Enum.filter(fn {id, _reason} -> Map.get(full_verdicts, id) == :honored end)
      |> Map.new()

    final_reasons = Map.merge(individual_reasons, conflict_losers)
    quarantine = final_reasons |> Map.keys() |> MapSet.new()

    %{
      state: Reduce.reduce(module, combined_log, quarantine: quarantine),
      quarantine: quarantine,
      reasons: final_reasons,
      holders: base.frozen_holders,
      requests:
        if(seed.continuation.family == :unsupported,
          do: [],
          else: base.frozen_requests ++ retained_requests
        )
    }
  end

  defp application_covered_authority_seed(module, snapshot) do
    base = snapshot.base_snapshot
    ordered = Dag.topo_sort(snapshot.covered_ops)
    records = collect_application_delegations(ordered)

    delegations =
      for {id, %{deleg: %Delegation{} = delegation}} <- records,
          into: %{},
          do: {id, delegation}

    deleg_valid =
      validate_application_delegations(
        records,
        delegations,
        base.root,
        genesis_delegation_ids(ordered),
        succession_delegation_ids(ordered),
        base.replica
      )

    covered_intros =
      for {id, %{op_ids: [_ | _]}} <- records, into: MapSet.new(), do: id

    roles =
      summarize_roles(
        module,
        snapshot.covered_ops,
        ordered,
        %{reasons: snapshot.covered_individual_reasons},
        deleg_valid
      )

    continuation =
      Continuation.context(
        base.replica,
        ordered,
        records,
        deleg_valid,
        base.root,
        snapshot.covered_valid_beacons
      )
      |> Map.put(:covered_ids, MapSet.new(Map.keys(base.covered_heights)))

    %{
      ordered: ordered,
      delegations: delegations,
      delegation_ids: Map.keys(records) |> MapSet.new(),
      deleg_valid: deleg_valid,
      covered_intros: covered_intros,
      roles: roles,
      continuation: continuation
    }
  end

  defp collect_application_delegations(ordered) do
    Enum.reduce(ordered, %{}, fn op, acc ->
      case delegation_in(op) do
        nil -> acc
        %Delegation{} = delegation -> collect_application_delegation(acc, delegation, op.id)
      end
    end)
  end

  defp collect_application_delegation(acc, %Delegation{} = delegation, op_id) do
    if Delegation.valid_sig?(delegation) do
      Map.update(
        acc,
        delegation.id,
        %{deleg: delegation, op_ids: [op_id], invalid_ops: %{}},
        fn entry ->
          %{entry | deleg: entry.deleg || delegation, op_ids: [op_id | entry.op_ids]}
        end
      )
    else
      Map.update(
        acc,
        delegation.id,
        %{deleg: nil, op_ids: [], invalid_ops: %{op_id => :bad_delegation_sig}},
        fn entry ->
          %{entry | invalid_ops: Map.put(entry.invalid_ops, op_id, :bad_delegation_sig)}
        end
      )
    end
  end

  defp validate_application_delegations(
         records,
         delegations,
         root,
         genesis_ids,
         succession_ids,
         replica
       ) do
    Map.new(records, fn
      {id, %{deleg: %Delegation{} = delegation}} ->
        {id,
         validate_delegation(
           delegation,
           delegations,
           root,
           genesis_ids,
           succession_ids,
           replica
         )}

      {id, %{deleg: nil}} ->
        {id, {:error, :bad_delegation_sig}}
    end)
  end

  defp validate_application_commands(
         ordered,
         timelines,
         ctx,
         covered_reasons,
         base_reasons
       ) do
    Enum.reduce(ordered, {%{}, []}, fn op, {reasons, requests} ->
      cond do
        op.kind == :inbox and match?({:request, _ref, _payload}, op.body) ->
          {:request, ref, payload} = op.body
          request = %{op: op.id, author: op.author, ref: ref, payload: payload}
          {reasons, requests ++ [request]}

        op.kind == :command ->
          individual_reasons =
            covered_reasons
            |> Map.merge(reasons)
            |> Map.merge(base_reasons)

          case validate_application_command(op, timelines, ctx, individual_reasons) do
            :ok -> {reasons, requests}
            {:error, reason} -> {Map.put(reasons, op.id, reason), requests}
          end

        true ->
          {reasons, requests}
      end
    end)
  end

  defp validate_application_command(op, timelines, ctx, individual_reasons) do
    with {:ok, cmd, args} <- application_command_body(ctx.module, op.body),
         {:ok, mutations} <- Lattice.Replica.command_effects(ctx.module, cmd, args),
         roles_needed = mutation_roles(ctx.module, mutations),
         :ok <- application_seeded_cap_ok(op, cmd, roles_needed, timelines, ctx),
         :ok <- seeded_authority_ok(op, roles_needed, timelines, ctx.anc) do
      strict_ancestors = Map.fetch!(ctx.anc, op.id)
      visible_ops = Map.take(ctx.ops, MapSet.to_list(strict_ancestors))

      verdicts =
        Map.new(strict_ancestors, fn id ->
          {id, Map.get(individual_reasons, id, :honored)}
        end)

      ctx.module.command_op_status(op, strict_ancestors, %{
        visible_ops: visible_ops,
        verdicts: verdicts,
        valid_beacons: ctx.valid_beacons
      })
    end
  end

  defp application_seeded_cap_ok(op, cmd, roles_needed, timelines, ctx) do
    case Map.fetch(ctx.delegations, op.cap) do
      {:ok, %Delegation{} = delegation} ->
        seeded_cap_checks(op, cmd, delegation, roles_needed, timelines, ctx)

      :error ->
        if MapSet.member?(ctx.covered_delegation_ids, op.cap),
          do: {:error, :invalid_capability},
          else: {:error, :no_capability}
    end
  end

  defp application_command_body(_module, body)
       when not (is_tuple(body) and tuple_size(body) == 2 and is_list(elem(body, 1))),
       do: {:error, :malformed_command}

  defp application_command_body(module, {cmd, args}) do
    case module.command_body(cmd, args) do
      {:ok, {^cmd, _args}} -> {:ok, cmd, args}
      {:error, {:bad_arity, ^cmd, _details}} -> {:error, :bad_command_arity}
      {:error, {:unknown_command, ^cmd}} -> {:error, :unknown_command}
    end
  end

  defp map_keys(map), do: map |> Map.keys() |> MapSet.new()

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
    deleg_valid = validate_delegations(delegations, root, genesis_ids, succession_ids, replica)
    covered_beacons = continuation_beacons(ordered, analysis.reasons)

    continuation =
      Continuation.context(replica, ordered, delegations, deleg_valid, root, covered_beacons)

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
        honored_succession_delegation_ids(module, ordered, analysis.reasons),
      policies: analysis.policies,
      root: root,
      covered_revokes: collect_raw_revokes(ordered),
      covered_beacon_epoch: covered_beacon_epoch(ordered, analysis.reasons),
      covered_beacon_policy:
        resolve_beacon_policy(beacon_policy_sources(ordered, deleg_valid, root), nil, nil),
      covered_continuation_pin: List.last(continuation.pins),
      covered_beacon_basis: max_beacon_basis(covered_beacons),
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

      heartbeat_ticks =
        recorded_heartbeat_ticks(ordered, role, acquires, covered_anc, analysis.reasons)

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
        if op.kind == :authority and deleg_valid[d.id] == :ok and
             not Map.has_key?(reasons, op.id) and MapSet.member?(d.roles, role),
           do: %{op_id: op.id, holder: d.audience, delegation_id: d.id, at_tick: 0}

      {:transfer, ^role, %Delegation{} = d, tick} ->
        if op.kind == :authority and not Map.has_key?(reasons, op.id),
          do: %{op_id: op.id, holder: d.audience, delegation_id: d.id, at_tick: tick}

      {:succeed, ^role, %Delegation{} = d, proof} ->
        if op.kind == :authority and not Map.has_key?(reasons, op.id),
          do: %{
            op_id: op.id,
            holder: d.audience,
            delegation_id: d.id,
            at_tick: acquisition_tick(proof)
          }

      _ ->
        nil
    end
  end

  defp acquisition_tick({:witnessed, _}), do: 0
  defp acquisition_tick({:continuation_v1, %{claim: %{epoch: epoch}}}), do: epoch
  defp acquisition_tick(tick), do: tick

  # A quarantined or malformed-tick heartbeat must not seed the summary: a
  # covered string tick would otherwise become `last_active_tick` and crash
  # succession replay arithmetic after compaction.
  defp recorded_heartbeat_ticks(ordered, role, acquires, covered_anc, reasons) do
    for op <- ordered,
        op.kind == :authority,
        match?({:heartbeat, ^role, _}, op.body),
        {:heartbeat, ^role, tick} = op.body,
        Authority.valid_tick?(tick),
        not Map.has_key?(reasons, op.id),
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
      validate_delegations_merged(
        delegations,
        root,
        genesis_ids,
        succession_ids,
        retained_log.replica
      )

    policies =
      Map.merge(snapshot.policies, collect_valid_policies(ordered, deleg_valid, root))

    revokes = merged_revokes(snapshot, ordered, delegations, root)
    {beacons, beacon_reasons} = seeded_beacons(snapshot, ordered, anc, deleg_valid, root)

    continuation =
      seeded_continuation_context(
        snapshot,
        ordered,
        delegations,
        retained_intros,
        deleg_valid,
        root,
        beacons
      )

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
      revokes: revokes,
      beacons: beacons
    }

    timelines =
      Map.new(all_roles(module), fn role ->
        {role,
         build_seeded_timeline(role, snapshot, ordered, anc, deleg_valid, policies, continuation)}
      end)

    role_reasons =
      Enum.reduce(timelines, %{}, fn {_r, tl}, acc -> Map.merge(acc, tl.quarantine) end)

    continuation_anc =
      Map.new(anc, fn {id, ids} -> {id, MapSet.union(ids, continuation.covered_ids)} end)

    continuation_reasons =
      Continuation.unhandled_reasons(ordered, all_roles(module), continuation, continuation_anc)

    {cmd_reasons, requests} = validate_retained_commands(ordered, timelines, ctx)
    tick_reasons = malformed_tick_reasons(ordered)

    new_reasons =
      invalid_intros
      |> Map.merge(invalid_genesis)
      |> Map.merge(role_reasons)
      |> Map.merge(continuation_reasons)
      |> Map.merge(cmd_reasons)
      |> Map.merge(tick_reasons)
      |> Map.merge(beacon_reasons)

    reasons = Map.merge(snapshot.frozen_reasons, new_reasons)

    reasons =
      if continuation.family == :unsupported,
        do: Map.merge(reasons, Map.new(ordered, &{&1.id, :unsupported_authority_profile})),
        else: reasons

    %{
      quarantine: reasons |> Map.keys() |> MapSet.new(),
      reasons: reasons,
      holders: Map.new(timelines, fn {role, tl} -> {role, tl.holder} end),
      requests: snapshot.frozen_requests ++ requests
    }
  end

  defp continuation_beacons(ordered, reasons) do
    for %Op{kind: :authority, body: body} = op <- ordered,
        is_tuple(body) and tuple_size(body) in [2, 3] and elem(body, 0) == :beacon,
        not Map.has_key?(reasons, op.id),
        do: %{op_id: op.id, epoch: elem(body, 1)}
  end

  defp max_beacon_basis(beacons) do
    maximum = beacons |> Enum.map(& &1.epoch) |> Enum.max(fn -> -1 end)
    Enum.filter(beacons, &(&1.epoch == maximum))
  end

  defp seeded_continuation_context(snapshot, ordered, delegations, intros, valid, root, beacons) do
    records =
      Map.new(delegations, fn {id, d} -> {id, %{deleg: d, op_ids: Map.get(intros, id, [])}} end)

    beacons = snapshot.covered_beacon_basis ++ Enum.filter(beacons, &(not is_nil(&1.op_id)))
    context = Continuation.context(snapshot.replica, ordered, records, valid, root, beacons)

    pins =
      if snapshot.covered_continuation_pin,
        do: [snapshot.covered_continuation_pin | context.pins],
        else: context.pins

    Map.merge(context, %{pins: pins, covered_ids: MapSet.new(Map.keys(snapshot.covered_heights))})
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

  defp validate_delegations_merged(delegations, root, genesis_ids, succession_ids, log_replica) do
    Map.new(delegations, fn {id, d} ->
      {id, validate_delegation(d, delegations, root, genesis_ids, succession_ids, log_replica)}
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

  defp malformed_tick_reasons(ordered) do
    for %Op{kind: :authority, body: body} = op <- ordered,
        malformed_tick_body?(body),
        into: %{},
        do: {op.id, :malformed_term}
  end

  defp malformed_tick_body?({:transfer, _role, %Delegation{}, tick}),
    do: not Authority.valid_tick?(tick)

  defp malformed_tick_body?({:succeed, _role, %Delegation{}, proof}) when is_integer(proof),
    do: not Authority.valid_tick?(proof)

  defp malformed_tick_body?({:heartbeat, _role, tick}),
    do: not Authority.valid_tick?(tick)

  defp malformed_tick_body?(_), do: false

  # --- Seeded role timelines -------------------------------------------------

  # The timeline seed is the covered summary: `seed_acquire` stands in for the
  # entire covered acquire history (stability makes every covered acquire visible
  # to every retained op, so only the last one is ever load-bearing), and
  # `base_tick` folds all covered activity into one dormancy floor.
  defp build_seeded_timeline(
         role,
         %Snapshot{} = snapshot,
         ordered,
         anc,
         deleg_valid,
         policies,
         continuation
       ) do
    seed = Map.get(snapshot.roles, role, %{last_acquire: nil, last_active_tick: 0})

    init = %{
      seed_acquire: seed.last_acquire,
      base_tick: seed.last_active_tick,
      holder: Map.get(snapshot.frozen_holders, role),
      acquires: [],
      heartbeats: [],
      covered_honored_succession_ids:
        Map.get(snapshot.covered_honored_succession_ids, role, MapSet.new()),
      quarantine: %{}
    }

    Enum.reduce(ordered, init, fn op, tl ->
      case if(continuation.family == :unsupported, do: nil, else: role_event(op, role)) do
        nil ->
          tl

        {:malformed_tick, op} ->
          seeded_reject(tl, op, :malformed_term)

        {:genesis, d} ->
          seeded_genesis(tl, op, role, d, deleg_valid)

        {:transfer, d, tick} ->
          seeded_transfer(tl, op, role, d, tick, anc, deleg_valid, continuation.family)

        {:succeed, d, proof} ->
          if continuation.family != :legacy or Continuation.proof?(proof),
            do: seeded_continuation(tl, op, role, d, proof, anc, continuation),
            else: seeded_succeed(tl, op, role, d, proof, anc, deleg_valid, policies)

        {:heartbeat, tick} ->
          seeded_heartbeat(tl, op, tick, anc)
      end
    end)
  end

  defp role_event(%Op{kind: :authority, body: body} = op, role) do
    case body do
      {:genesis, %Delegation{} = d, _policies} ->
        if MapSet.member?(d.roles, role), do: {:genesis, d}

      {:transfer, ^role, %Delegation{} = d, tick} ->
        if Authority.valid_tick?(tick), do: {:transfer, d, tick}, else: {:malformed_tick, op}

      {:succeed, ^role, %Delegation{} = d, proof} ->
        if is_integer(proof) and not Authority.valid_tick?(proof),
          do: {:malformed_tick, op},
          else: {:succeed, d, proof}

      {:heartbeat, ^role, tick} ->
        if Authority.valid_tick?(tick), do: {:heartbeat, tick}, else: {:malformed_tick, op}

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

  defp seeded_transfer(tl, op, role, d, tick, anc, deleg_valid, family) do
    op_anc = Map.get(anc, op.id, MapSet.new())

    cond do
      not seeded_delegation_valid_at?(deleg_valid[d.id], tl, op_anc) or
        op.author != d.issuer or not MapSet.member?(d.roles, role) ->
        seeded_reject(tl, op, :invalid_transfer)

      seeded_holder_at(tl, op_anc) != op.author ->
        seeded_reject(tl, op, :transfer_not_holder)

      tl.holder != op.author ->
        seeded_reject(tl, op, :double_transfer)

      family != :legacy and
          seeded_holder_acquire_at(tl, op_anc) != List.last(continuation_acquires(tl)) ->
        seeded_reject(tl, op, :double_transfer)

      true ->
        seeded_acquire(tl, op, d, tick)
    end
  end

  defp continuation_acquires(tl),
    do: if(tl.seed_acquire, do: [tl.seed_acquire | tl.acquires], else: tl.acquires)

  defp seeded_continuation(tl, op, role, d, proof, ancestors, context) do
    anc = MapSet.union(context.covered_ids, Map.get(ancestors, op.id, MapSet.new()))

    case Continuation.judge(context, op, role, d, proof, continuation_acquires(tl), anc) do
      {:ok, epoch} -> seeded_acquire(tl, op, d, epoch)
      {:error, reason} -> seeded_reject(tl, op, reason)
    end
  end

  defp seeded_succeed(tl, op, role, d, proof, anc, deleg_valid, policies) do
    op_anc = Map.get(anc, op.id, MapSet.new())
    policy = Map.get(policies, role)

    cond do
      not seeded_succession_delegation?(deleg_valid[d.id], d.id) or
        op.author != d.audience or op.author != d.issuer or
          not MapSet.member?(d.roles, role) ->
        seeded_reject(tl, op, :invalid_succession)

      is_nil(policy) or op.author != policy.successor ->
        seeded_reject(tl, op, :unauthorized_succession)

      Map.has_key?(policy, :recovery) and Map.has_key?(policy, :dormant_ticks) ->
        seeded_reject(tl, op, :invalid_recovery_policy)

      true ->
        seeded_succession_proof(tl, op, role, d, proof, op_anc, policy)
    end
  end

  defp seeded_succession_proof(tl, op, _role, d, at_tick, op_anc, %{
         dormant_ticks: dormant_ticks
       })
       when is_integer(at_tick) do
    if at_tick < seeded_last_active(tl, op_anc) + dormant_ticks,
      do: seeded_reject(tl, op, :premature_succession),
      else: seeded_acquire(tl, op, d, at_tick)
  end

  defp seeded_succession_proof(tl, op, _role, _d, at_tick, _op_anc, %{recovery: recovery})
       when is_integer(at_tick) do
    case SuccessionCertificate.normalize_policy(recovery) do
      {:ok, _normalized} -> seeded_reject(tl, op, :recovery_certificate_required)
      {:error, reason} -> seeded_reject(tl, op, reason)
    end
  end

  defp seeded_succession_proof(
         tl,
         op,
         role,
         d,
         {:witnessed, certificate},
         op_anc,
         %{recovery: recovery}
       ) do
    with %{holder: holder, op_id: holder_epoch} <- seeded_holder_acquire_at(tl, op_anc),
         true <- tl.holder == holder,
         {:ok, expected_claim} <-
           SuccessionCertificate.claim(
             op.replica,
             role,
             holder,
             holder_epoch,
             op.author,
             recovery
           ),
         :ok <- SuccessionCertificate.verify(certificate, expected_claim, recovery) do
      seeded_acquire(tl, op, d, 0)
    else
      {:error, reason} -> seeded_reject(tl, op, reason)
      _ -> seeded_reject(tl, op, :recovery_claim_mismatch)
    end
  end

  defp seeded_succession_proof(
         tl,
         op,
         _role,
         _d,
         {:witnessed, _certificate},
         _op_anc,
         _policy
       ),
       do: seeded_reject(tl, op, :witnessed_recovery_not_configured)

  defp seeded_succession_proof(tl, op, _role, _d, _proof, _op_anc, _policy),
    do: seeded_reject(tl, op, :invalid_succession)

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
    case seeded_holder_acquire_at(tl, op_anc) do
      nil -> nil
      %{holder: holder} -> holder
    end
  end

  defp seeded_holder_acquire_at(tl, op_anc) do
    tl.acquires
    |> Enum.filter(&MapSet.member?(op_anc, &1.op_id))
    |> List.last()
    |> case do
      nil -> tl.seed_acquire
      acquire -> acquire
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
      d.replica != op.replica ->
        {:error, :wrong_replica}

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

      seeded_expired_as_of?(op, d, ctx) ->
        {:error, :lease_expired}

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

    Enum.any?(ctx.covered_honored_succession_ids, fn {_role, ids} ->
      MapSet.member?(ids, root_id)
    end) or
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

  defp seeded_expired_as_of?(op, d, ctx) do
    d
    |> delegation_chain_ids(ctx.delegations)
    |> Enum.any?(fn id ->
      expires = ctx.delegations[id].expires_epoch

      expires != nil and
        Enum.any?(ctx.beacons, fn beacon ->
          beacon.epoch > expires and
            (beacon.covered? or
               not MapSet.member?(Map.get(ctx.anc, beacon.op_id, MapSet.new()), op.id))
        end)
    end)
  end

  # Every covered op is in the past of every retained op at a stable cut.
  # Only the maximum honored epoch and final valid beacon policy are needed.
  defp covered_beacon_epoch(ordered, reasons) do
    ordered
    |> Enum.flat_map(fn op ->
      if op.kind == :authority and not Map.has_key?(reasons, op.id) do
        case op.body do
          {:beacon, epoch} -> [epoch]
          {:beacon, epoch, _certificate} -> [epoch]
          _ -> []
        end
      else
        []
      end
    end)
    |> Enum.max(fn -> -1 end)
  end

  defp beacon_policy_sources(ordered, deleg_valid, root) do
    for %Op{kind: :authority, body: {:genesis, %Delegation{} = d, policies}} = op <- ordered,
        is_map(policies),
        deleg_valid[d.id] == :ok,
        is_nil(d.parent_id),
        op.author == d.audience,
        d.audience == root,
        Delegation.valid_sig?(d),
        Map.has_key?(policies, :__beacon__),
        do: {op.id, policies.__beacon__}
  end

  defp resolve_beacon_policy(sources, ancestors, seed) do
    Enum.reduce(sources, seed, fn {id, raw}, policy ->
      case {is_nil(ancestors) or MapSet.member?(ancestors, id),
            BeaconCertificate.normalize_policy(raw)} do
        {true, {:ok, normalized}} -> normalized
        _ -> policy
      end
    end)
  end

  defp seeded_beacons(snapshot, ordered, anc, deleg_valid, root) do
    sources = beacon_policy_sources(ordered, deleg_valid, root)
    seed = %{op_id: nil, epoch: snapshot.covered_beacon_epoch, covered?: true}

    Enum.reduce(ordered, {[seed], %{}}, fn op, {valid, reasons} ->
      case op do
        %Op{kind: :authority, body: body}
        when is_tuple(body) and tuple_size(body) in [2, 3] and elem(body, 0) == :beacon ->
          op_anc = Map.get(anc, op.id, MapSet.new())

          prior =
            valid
            |> Enum.filter(&(&1.covered? or MapSet.member?(op_anc, &1.op_id)))
            |> Enum.map(& &1.epoch)
            |> Enum.max()

          policy = resolve_beacon_policy(sources, op_anc, snapshot.covered_beacon_policy)
          epoch = elem(body, 1)
          reason = seeded_beacon_reason(op, epoch, prior, root, policy)

          if reason,
            do: {valid, Map.put(reasons, op.id, reason)},
            else: {valid ++ [%{op_id: op.id, epoch: epoch, covered?: false}], reasons}

        _ ->
          {valid, reasons}
      end
    end)
  end

  defp seeded_beacon_reason(%Op{body: {:beacon, _}} = op, epoch, prior, root, _policy) do
    cond do
      op.author != root -> :unauthorized_beacon
      not is_integer(epoch) or epoch < 0 or epoch <= prior -> :stale_beacon
      true -> nil
    end
  end

  defp seeded_beacon_reason(%Op{body: {:beacon, _, certificate}} = op, epoch, prior, root, policy) do
    claim_epoch =
      if is_map(certificate) and is_map(Map.get(certificate, :claim)),
        do: Map.get(Map.get(certificate, :claim), :epoch)

    expected = BeaconCertificate.claim(op.replica, epoch, op.author, op.deps)

    malformed =
      Enum.any?(
        [epoch, claim_epoch],
        &(is_integer(&1) and (&1 < 0 or &1 > 9_007_199_254_740_991))
      )

    cond do
      malformed -> :malformed_term
      is_nil(policy) -> :unauthorized_beacon
      op.author != root and op.author not in policy.witnesses -> :unauthorized_beacon
      BeaconCertificate.verify(certificate, expected, policy) != :ok -> :unauthorized_beacon
      not is_integer(epoch) or epoch < 0 or epoch <= prior -> :stale_beacon
      epoch > prior + policy.max_epoch_step -> :unauthorized_beacon
      true -> nil
    end
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
      {:transfer, _role, %Delegation{} = d, tick} -> if Authority.valid_tick?(tick), do: d
      {:succeed, _role, %Delegation{} = d, _tick} -> d
      _ -> nil
    end
  end

  defp delegation_in(_), do: nil

  defp validate_delegations(delegations, root, genesis_ids, succession_ids, log_replica) do
    structs = Map.new(delegations, fn {id, %{deleg: d}} -> {id, d} end)

    Map.new(structs, fn {id, d} ->
      {id, validate_delegation(d, structs, root, genesis_ids, succession_ids, log_replica)}
    end)
  end

  defp validate_delegation(
         %Delegation{} = d,
         delegations,
         root,
         genesis_ids,
         succession_ids,
         log_replica
       ) do
    cond do
      not Delegation.valid_sig?(d) ->
        {:error, :bad_delegation_sig}

      d.replica != log_replica ->
        {:error, :wrong_replica}

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
        validate_delegation_parent(d, delegations, root, genesis_ids, succession_ids, log_replica)
    end
  end

  defp validate_delegation_parent(
         %Delegation{} = d,
         delegations,
         root,
         genesis_ids,
         succession_ids,
         log_replica
       ) do
    case Map.fetch(delegations, d.parent_id) do
      {:ok, %Delegation{} = parent} ->
        parent_validation =
          validate_delegation(parent, delegations, root, genesis_ids, succession_ids, log_replica)

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

  defp honored_succession_delegation_ids(module, ordered, reasons) do
    roles = all_roles(module)
    initial = Map.new(roles, &{&1, MapSet.new()})

    Enum.reduce(ordered, initial, fn
      %Op{
        id: op_id,
        kind: :authority,
        body: {:succeed, role, %Delegation{id: id}, _proof}
      },
      acc ->
        if Map.has_key?(acc, role) and not Map.has_key?(reasons, op_id),
          do: Map.update!(acc, role, &MapSet.put(&1, id)),
          else: acc

      _op, acc ->
        acc
    end)
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
