defmodule Township.Divergence do
  @moduledoc """
  Explain why two `Township.Matter` logs of one replica are, or are not, the same.

  `explain/2` is a pure diagnostic over two `Lattice.Log` values. It changes no
  substrate or Matter code, and the oracle stays authoritative: two replicas have
  converged exactly when the bytes of `Lattice.state(Matter, log)` are equal
  (`state_equal?`). This module only attributes a difference once one exists. It is
  not a convergence assertion and no passing test should depend on it.

  ## Output shape

  For two logs of the same replica it returns

      %{
        converged?: boolean,
        state_equal?: boolean,
        only_in_a: [op_id], only_in_b: [op_id],
        frontier_a: [op_id], frontier_b: [op_id],
        state_mismatches: [%{field: atom, a: summary, b: summary}],
        quarantine_delta: [%{op_id: op_id, reason_a: atom | nil, reason_b: atom | nil}],
        holder_delta: [%{role: atom, a: fingerprint | nil, b: fingerprint | nil}],
        structural_delta: [%{op_id: op_id, reason_a: atom | nil, reason_b: atom | nil}]
      }

  and for logs of different replicas `%{error: :different_replicas, a: replica_a,
  b: replica_b}`.

    * `quarantine_delta` is the authority view (`Lattice.Authority.analyze/2` reasons,
      for example `:not_holder`). `structural_delta` is the log's own structural
      quarantine (`Lattice.Log.quarantine/1`, for example `:bad_signature`). The two
      reason namespaces are never merged; a reason appears only in its own list.
    * `holder_delta` compares role holders, rendered as a 12 character sha256
      fingerprint of the public key.
    * `converged?` is true only when the op sets and frontiers are equal, the state
      bytes are equal and every delta list is empty. `state_equal?` can be true while
      `converged?` is false (an extra quarantined op does not change state).
    * `state_mismatches` compares the Matter fields in declaration order, then any other
      state key in sorted order. A set and a list with the same elements are different
      values and are reported as a difference. If the state
      bytes differ but no field comparison explains it, one `%{field: :unattributed}`
      entry is returned instead of silently reporting no difference. In that case the
      tool is partial and only the byte comparison can be trusted.

  ## Determinism

  Every list is sorted (op ids ascending, roles ascending, Matter field order), so the
  output is a pure function of the two logs, and `explain(b, a)` is the exact mirror of
  `explain(a, b)`.

  ## Content privacy

  State values for `:title`, `:summary` and `:posts` can be participant content. A
  mismatch summary therefore carries only a size (`len` for a string, `entries` for a
  collection) and an 8 character sha256 prefix, never the content itself.

  ## Cost

  Each call runs `Authority.analyze/2` and `Lattice.state/2` on both logs. That is
  acceptable for a diagnostic and wrong for a hot path.

  ## Running it

  Write two divergent audit bundles, then explain them (use any writable directories):

      mix run -e '
        alias Lattice.Sim
        alias Township.{Matter, AuditBundle}
        sim = Sim.new(Matter, "replica:matter:explain", ["clerk", "resident"], seed: "explain")
        {sim, _} = Sim.create_replica(sim, "clerk")
        {sim, _} = Sim.grant(sim, "clerk", "resident", ops: [:post])
        sim = Sim.sync_all(sim)
        sim = Sim.partition(sim, "clerk", "resident")
        {sim, _} = Sim.command(sim, "resident", :post, ["offline post"])
        AuditBundle.write("div_a", Sim.log(sim, "clerk"))
        AuditBundle.write("div_b", Sim.log(sim, "resident"))
      '
      mix lattice.township.explain_divergence --a div_a --b div_b
  """

  alias Lattice.{Authority, Log}
  alias Township.Matter

  @fields [:title, :summary, :posts, :members, :clerk_locked?]

  @type op_id :: String.t()
  @type summary :: %{optional(atom()) => term()}

  @doc "Attribute the difference between two logs of one replica. See the moduledoc."
  @spec explain(Log.t(), Log.t()) :: map()
  def explain(%Log{replica: replica} = a, %Log{replica: replica} = b) do
    ids_a = Log.op_ids(a)
    ids_b = Log.op_ids(b)
    only_in_a = ids_a |> MapSet.difference(ids_b) |> Enum.sort()
    only_in_b = ids_b |> MapSet.difference(ids_a) |> Enum.sort()
    frontier_a = Log.frontier(a)
    frontier_b = Log.frontier(b)

    state_a = Lattice.state(Matter, a)
    state_b = Lattice.state(Matter, b)
    state_equal? = state_bytes(state_a) == state_bytes(state_b)
    mismatches = state_mismatches(state_a, state_b, state_equal?)

    analysis_a = Authority.analyze(Matter, a)
    analysis_b = Authority.analyze(Matter, b)

    quarantine_delta = delta(analysis_a.reasons, analysis_b.reasons)
    structural_delta = delta(structural_reasons(a), structural_reasons(b))
    holder_delta = holder_delta(analysis_a.holders, analysis_b.holders)

    %{
      converged?:
        state_equal? and only_in_a == [] and only_in_b == [] and frontier_a == frontier_b and
          mismatches == [] and quarantine_delta == [] and structural_delta == [] and
          holder_delta == [],
      state_equal?: state_equal?,
      only_in_a: only_in_a,
      only_in_b: only_in_b,
      frontier_a: frontier_a,
      frontier_b: frontier_b,
      state_mismatches: mismatches,
      quarantine_delta: quarantine_delta,
      holder_delta: holder_delta,
      structural_delta: structural_delta
    }
  end

  def explain(%Log{replica: replica_a}, %Log{replica: replica_b}) do
    %{error: :different_replicas, a: replica_a, b: replica_b}
  end

  # The universal oracle, as in `TownshipScenario.state_bytes/1`.
  defp state_bytes(state) do
    :erlang.term_to_binary(state, [:deterministic, {:minor_version, 2}])
  end

  defp state_mismatches(state_a, state_b, state_equal?) do
    found =
      Enum.flat_map(fields_to_compare(state_a, state_b), fn field ->
        value_a = Map.get(state_a, field)
        value_b = Map.get(state_b, field)

        if value_a === value_b,
          do: [],
          else: [%{field: field, a: summarize(value_a), b: summarize(value_b)}]
      end)

    cond do
      found != [] ->
        found

      state_equal? ->
        []

      true ->
        [
          %{
            field: :unattributed,
            a: summarize(state_bytes(state_a)),
            b: summarize(state_bytes(state_b))
          }
        ]
    end
  end

  # Declared fields first, in order, then any other key either state carries, sorted, so a
  # field Matter gains later is attributed instead of falling to `:unattributed`.
  defp fields_to_compare(state_a, state_b) do
    extra =
      (state_keys(state_a) ++ state_keys(state_b))
      |> Enum.uniq()
      |> Enum.reject(&(&1 in @fields))
      |> Enum.sort()

    @fields ++ extra
  end

  defp state_keys(%{} = state), do: state |> Map.keys() |> Enum.reject(&(&1 == :__struct__))
  defp state_keys(_other), do: []

  # Values are compared as they are (strict equality), so a MapSet, a list and a tuple that
  # happen to share elements never compare equal. A MapSet is summarized from its own
  # struct bytes, so its digest cannot collide with a lookalike tuple's.
  defp summarize(%MapSet{} = set), do: %{entries: MapSet.size(set), sha256: digest(set)}

  defp summarize(value) when is_list(value) do
    %{entries: length(value), sha256: digest(value)}
  end

  defp summarize(value) when is_binary(value) do
    %{len: byte_size(value), sha256: digest(value)}
  end

  defp summarize(value) when is_boolean(value) or is_nil(value), do: %{value: value}
  defp summarize(value), do: %{sha256: digest(value)}

  defp digest(value) do
    :sha256
    |> :crypto.hash(state_bytes(value))
    |> Base.encode16(case: :lower)
    |> binary_part(0, 8)
  end

  defp structural_reasons(log) do
    Map.new(Log.quarantine(log), fn %{op: op, reason: reason} -> {op.id, reason} end)
  end

  defp delta(reasons_a, reasons_b) do
    (Map.keys(reasons_a) ++ Map.keys(reasons_b))
    |> Enum.uniq()
    |> Enum.sort()
    |> Enum.flat_map(fn id ->
      reason_a = Map.get(reasons_a, id)
      reason_b = Map.get(reasons_b, id)

      if reason_a == reason_b,
        do: [],
        else: [%{op_id: id, reason_a: reason_a, reason_b: reason_b}]
    end)
  end

  defp holder_delta(holders_a, holders_b) do
    (Map.keys(holders_a) ++ Map.keys(holders_b))
    |> Enum.uniq()
    |> Enum.sort()
    |> Enum.flat_map(fn role ->
      holder_a = fingerprint(Map.get(holders_a, role))
      holder_b = fingerprint(Map.get(holders_b, role))
      if holder_a == holder_b, do: [], else: [%{role: role, a: holder_a, b: holder_b}]
    end)
  end

  defp fingerprint(nil), do: nil

  defp fingerprint(pub) when is_binary(pub) do
    :sha256 |> :crypto.hash(pub) |> Base.encode16(case: :lower) |> binary_part(0, 12)
  end
end
