defmodule Lattice.Reduce do
  @moduledoc """
  Deterministic materialization: fold a Replica's log into state.

  Reduction is a pure function of the *set* of ops (and their causal DAG), never of
  the order they arrived. Each field is built as a CRDT whose join laws make the
  result independent of delivery order (behaviors 2 and 18), and ordering tags are
  derived from causal height + op id (`Lattice.Dag`), so two realms holding the same
  ops compute byte-identical state.

  `reduce/3` accepts:

    * `:quarantine` — a set of op ids to exclude (the semantic quarantine produced
      by `Lattice.Authority`: unauthorized, stale-holder, revoked, double-transfer
      losers). Excluding them here is how "quarantined ops never reach state" is
      enforced, while the ops themselves remain in the log (design invariant 4).
    * `:frontier` — restrict reduction to the causal slice reachable from these op
      ids, which is exactly `Lattice.state_at/3` time travel (behavior 17).
  """

  alias Lattice.{Dag, Log, Op}
  alias Lattice.Crdt.{CausalList, Lww, OrSet}

  @type state :: %{atom() => term()}

  @doc "Reduce a log to its materialized state map for `replica_module`."
  @spec reduce(module(), Log.t(), keyword()) :: state()
  def reduce(replica_module, %Log{} = log, opts \\ []) do
    {crdts, _scope} = reduce_crdts(replica_module, log, opts)

    for {field, spec} <- replica_module.__lattice_fields__(), into: %{} do
      {field, materialize(field, spec, crdts)}
    end
  end

  @doc """
  Reduce to the raw CRDT structures plus the ordered op scope. Used internally and
  by callers that need element ids (e.g. the demo printing message ids).
  """
  @spec reduce_crdts(module(), Log.t(), keyword()) :: {%{atom() => term()}, %{Op.id() => Op.t()}}
  def reduce_crdts(replica_module, %Log{} = log, opts \\ []) do
    all_ops = Log.ops(log)

    scope_ids =
      case Keyword.get(opts, :frontier) do
        nil -> MapSet.new(Map.keys(all_ops))
        frontier -> Dag.reachable(all_ops, List.wrap(frontier))
      end

    ops = Map.take(all_ops, MapSet.to_list(scope_ids))
    quarantine = Keyword.get(opts, :quarantine, MapSet.new())
    heights = Dag.heights(ops)

    command_ops =
      ops
      |> Map.values()
      |> Enum.filter(&(&1.kind == :command and not MapSet.member?(quarantine, &1.id)))

    # field => list of {op, {field, mutation}}
    mutations =
      Enum.flat_map(command_ops, fn op ->
        case op.body do
          {cmd, args} when is_list(args) ->
            op
            |> apply_command(replica_module, cmd, args)
            |> Enum.map(fn {field, mutation} -> {field, op, mutation} end)

          _ ->
            []
        end
      end)

    by_field = Enum.group_by(mutations, fn {field, _op, _m} -> field end)
    add_index = build_add_index(by_field)
    all_ancestors = Dag.all_ancestors(ops)

    crdts =
      for {field, spec} <- replica_module.__lattice_fields__(), into: %{} do
        field_mutations = Map.get(by_field, field, [])

        {field,
         build_field(spec, field_mutations, %{
           heights: heights,
           all_ancestors: all_ancestors,
           add_index: add_index,
           field: field
         })}
      end

    {crdts, ops}
  end

  # Unknown/malformed commands are surfaced and excluded upstream by
  # `Lattice.Authority` (`:unknown_command` / `:malformed_command` quarantine), so a
  # gated reduction never reaches this with an undefined command. The rescue is only a
  # defensive fallback for direct (ungated) `reduce/3` calls; it returns no mutations.
  defp apply_command(_op, replica_module, cmd, args) do
    replica_module.__apply_command__(cmd, args)
  rescue
    ArgumentError -> []
  end

  # OR-Set needs, per {field, elem}, the set of add op ids (for observed removes).
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

  # --- Per-field CRDT construction ----------------------------------------

  defp build_field(%{kind: :crdt, crdt: :lww}, muts, ctx), do: build_lww(muts, ctx)
  defp build_field(%{kind: :authority}, muts, ctx), do: build_lww(muts, ctx)
  defp build_field(%{kind: :crdt, crdt: :or_set}, muts, ctx), do: build_or_set(muts, ctx)

  defp build_field(%{kind: :crdt, crdt: :causal_list}, muts, ctx),
    do: build_causal_list(muts, ctx)

  defp build_lww(muts, %{heights: heights}) do
    Enum.reduce(muts, Lww.new(), fn
      {_field, op, {:write, value}}, lww ->
        Lww.put(lww, value, {Map.fetch!(heights, op.id), op.id})

      _, lww ->
        lww
    end)
  end

  defp build_or_set(muts, %{all_ancestors: all_ancestors, add_index: add_index, field: field}) do
    elem_adds = Map.get(add_index, field, %{})

    Enum.reduce(muts, OrSet.new(), fn
      {_field, op, {:add, elem}}, set ->
        OrSet.add(set, elem, op.id)

      {_field, op, {:remove, elem}}, set ->
        ancestors = Map.get(all_ancestors, op.id, MapSet.new())
        observed = elem_adds |> Map.get(elem, MapSet.new()) |> MapSet.intersection(ancestors)
        OrSet.remove(set, observed)

      _, set ->
        set
    end)
  end

  defp build_causal_list(muts, %{heights: heights}) do
    Enum.reduce(muts, CausalList.new(), fn
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

  # --- Materialize CRDT -> plain value -------------------------------------

  defp materialize(field, %{kind: :crdt, crdt: :lww, default: default}, crdts),
    do: Lww.value(Map.fetch!(crdts, field), default)

  defp materialize(field, %{kind: :authority, default: default}, crdts),
    do: Lww.value(Map.fetch!(crdts, field), default)

  defp materialize(field, %{kind: :crdt, crdt: :or_set}, crdts),
    do: OrSet.to_list(Map.fetch!(crdts, field))

  defp materialize(field, %{kind: :crdt, crdt: :causal_list}, crdts),
    do: CausalList.value(Map.fetch!(crdts, field))
end
