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
            |> Enum.with_index()
            |> Enum.map(fn {{field, mutation}, index} -> {field, op, mutation, index} end)

          _ ->
            []
        end
      end)

    by_field = Enum.group_by(mutations, fn {field, _op, _m, _index} -> field end)
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
           element_counts: insert_counts(field_mutations),
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
    case Lattice.Replica.command_effects(replica_module, cmd, args) do
      {:ok, effects} -> effects
      {:error, _} -> []
    end
  end

  # OR-Set needs, per {field, elem}, the set of add op ids (for observed removes).
  defp build_add_index(by_field) do
    for {field, muts} <- by_field, into: %{} do
      counts = insert_counts(muts)

      index =
        Enum.reduce(muts, %{}, fn
          {^field, op, {:add, elem}, index}, acc ->
            add = {effect_id(counts, op.id, index), op.id, index}
            Map.update(acc, elem, [add], &[add | &1])

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
    muts
    |> last_effects_per_target()
    |> Enum.reduce(Lww.new(), fn
      {_field, op, {:write, value}, _index}, lww ->
        Lww.put(lww, value, {Map.fetch!(heights, op.id), op.id})

      _, lww ->
        lww
    end)
  end

  defp build_or_set(muts, %{
         all_ancestors: all_ancestors,
         add_index: add_index,
         field: field,
         element_counts: counts
       }) do
    elem_adds = Map.get(add_index, field, %{})

    Enum.reduce(muts, OrSet.new(), fn
      {_field, op, {:add, elem}, index}, set ->
        OrSet.add(set, elem, effect_id(counts, op.id, index))

      {_field, op, {:remove, elem}, index}, set ->
        ancestors = Map.get(all_ancestors, op.id, MapSet.new())

        observed =
          for {tag, owner, add_index} <- Map.get(elem_adds, elem, []),
              MapSet.member?(ancestors, owner) or (owner == op.id and add_index < index),
              into: MapSet.new(),
              do: tag

        OrSet.remove(set, observed)

      _, set ->
        set
    end)
  end

  defp build_causal_list(muts, %{heights: heights, element_counts: counts}) do
    edits =
      muts
      |> Enum.filter(&match?({_, _, {:edit, _, _}, _}, &1))
      |> Enum.group_by(fn {field, op, {:edit, target, _}, _} -> {field, op.id, target} end)
      |> Map.values()
      |> Enum.map(&Enum.max_by(&1, fn {_, _, _, index} -> index end))

    ordered = Enum.reject(muts, &match?({_, _, {:edit, _, _}, _}, &1)) ++ edits

    Enum.reduce(ordered, CausalList.new(), fn
      {_field, op, {kind, value}, index}, list when kind in [:append, :insert] ->
        CausalList.insert(
          list,
          effect_id(counts, op.id, index),
          value,
          {Map.fetch!(heights, op.id), op.id}
        )

      {_field, _op, {:delete, target_id}, _index}, list ->
        CausalList.delete(list, target_id)

      {_field, op, {:edit, target_id, value}, _index}, list ->
        CausalList.edit(list, target_id, value, {Map.fetch!(heights, op.id), op.id})

      _, list ->
        list
    end)
  end

  # Preserve legacy single-insert IDs. Several inserts into one field need
  # distinct element tags, while the signed operation remains one DAG node.
  defp effect_id(counts, op_id, index) do
    if Map.get(counts, op_id, 0) == 1,
      do: op_id,
      else: op_id <> "#effect:" <> String.pad_leading(Integer.to_string(index), 10, "0")
  end

  defp insert_counts(muts) do
    Enum.reduce(muts, %{}, fn
      {_, op, {kind, _}, _}, acc when kind in [:append, :insert, :add] ->
        Map.update(acc, op.id, 1, &(&1 + 1))

      _, acc ->
        acc
    end)
  end

  defp last_effects_per_target(muts) do
    muts
    |> Enum.reduce(%{}, fn {field, op, _mutation, index} = effect, acc ->
      Map.update(acc, {field, op.id}, effect, fn {_, _, _, previous} = old ->
        if index > previous, do: effect, else: old
      end)
    end)
    |> Map.values()
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
