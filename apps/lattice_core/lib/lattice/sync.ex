defmodule Lattice.Sync do
  @moduledoc """
  Frontier-diff exchange between two logs of the same Replica.

  `reconcile/2` computes the ops each side is missing and transfers them in causal
  (topological) order, applying each through `Lattice.Log.accept/2` — the same
  path live delivery uses. It is:

    * **integrity-checked**: tampered ops fail signature verification and are
      quarantined on receipt (behavior 4);
    * **dependency-safe**: an op whose deps have not yet arrived is buffered and
      retried (so any dep-respecting delivery order converges);
    * **idempotent**: re-syncing, or syncing already-known ops, inserts nothing
      (behavior 3).

  At POC scale the "diff" ships the set of ids each side is missing. A production
  carrier would negotiate recursively from frontiers (Beelay-style); see
  `docs/path_to_real.md`. The observable contract — converge to identical op sets,
  idempotently — is unchanged by that optimization.
  """

  alias Lattice.{Dag, Log, Op}
  alias Lattice.Sync.Shape

  @type report :: %{
          accepted: [Op.id()],
          quarantined: [{Op.id(), atom()}],
          rejected: [{Op.id(), atom()}],
          pending: [Op.id()]
        }

  @doc "Ops in `source` that a peer holding `have` ids lacks, in causal order."
  @spec missing(Log.t(), MapSet.t(Op.id())) :: [Op.t()]
  def missing(%Log{} = source, %MapSet{} = have) do
    source
    |> Log.topo_ops()
    |> Enum.reject(&MapSet.member?(have, &1.id))
  end

  @doc "Shape-filtered missing ops with causal closure for selected non-tombstone ops."
  @spec missing(Log.t(), MapSet.t(Op.id()), Shape.t()) :: [Op.t()]
  def missing(%Log{} = source, %MapSet{} = have, %Shape{} = shape) do
    selected_ops =
      source
      |> Log.topo_ops()
      |> Enum.filter(&Shape.selected?(shape, &1))

    closure_seeds =
      selected_ops
      |> Enum.reject(&(&1.kind == :tombstone))
      |> Enum.map(& &1.id)

    tombstone_ids =
      selected_ops
      |> Enum.filter(&(&1.kind == :tombstone))
      |> MapSet.new(& &1.id)

    closure =
      source
      |> Log.ops()
      |> Dag.reachable(closure_seeds)
      |> MapSet.union(tombstone_ids)

    source
    |> Log.topo_ops()
    |> Enum.filter(&(MapSet.member?(closure, &1.id) and not MapSet.member?(have, &1.id)))
  end

  @doc "Apply a batch of ops to a log, buffering missing-dep ops and retrying."
  @spec deliver(Log.t(), [Op.t()]) :: {Log.t(), report()}
  def deliver(%Log{} = log, ops) when is_list(ops) do
    deliver_loop(log, ops, %{accepted: [], quarantined: [], rejected: [], pending: []})
  end

  @doc """
  Reconcile two logs bidirectionally. Returns the two updated logs and a report
  of what was accepted/quarantined on each side.
  """
  @spec reconcile(Log.t(), Log.t()) :: {Log.t(), Log.t(), %{into_a: report(), into_b: report()}}
  def reconcile(%Log{} = a, %Log{} = b) do
    a_missing = missing(b, Log.op_ids(a))
    b_missing = missing(a, Log.op_ids(b))
    {a2, into_a} = deliver(a, a_missing)
    {b2, into_b} = deliver(b, b_missing)
    {a2, b2, %{into_a: into_a, into_b: into_b}}
  end

  defp deliver_loop(log, pending, report) do
    {log, still_pending, report, progressed} =
      Enum.reduce(pending, {log, [], report, false}, fn op, {log, pend, rep, prog} ->
        was_present = Log.has?(log, op.id)

        case Log.accept(log, op) do
          {:ok, log2} ->
            rep = if was_present, do: rep, else: prepend(rep, :accepted, op.id)
            {log2, pend, rep, true}

          {:quarantined, log2, reason} ->
            {log2, pend, prepend(rep, :quarantined, {op.id, reason}), true}

          {:missing_deps, log2, _missing} ->
            {log2, [op | pend], rep, prog}

          {:rejected, log2, reason} ->
            {log2, pend, prepend(rep, :rejected, {op.id, reason}), true}
        end
      end)

    cond do
      progressed and still_pending != [] -> deliver_loop(log, Enum.reverse(still_pending), report)
      true -> {log, finalize(report, still_pending)}
    end
  end

  defp prepend(report, key, value), do: Map.update!(report, key, &[value | &1])

  defp finalize(report, still_pending) do
    %{
      report
      | accepted: Enum.reverse(report.accepted),
        quarantined: Enum.reverse(report.quarantined),
        rejected: Enum.reverse(report.rejected),
        pending: Enum.map(still_pending, & &1.id)
    }
  end
end
