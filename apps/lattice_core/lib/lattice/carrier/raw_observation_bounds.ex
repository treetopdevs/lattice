defmodule Lattice.Carrier.RawObservationBounds do
  @moduledoc """
  Bounded raw JSON observation before canonical allocation.

  This checks only nodes, UTF-8 string bytes and JSON container depth. It proves
  neither wire shape, authenticity nor authority, and permits no operation.
  Shared subterms count at every occurrence; imported names remain binary data.
  """

  # Three JSON containers per map; frame plus flat delegation add four.
  @max_json_depth 65 * 3 + 4
  @public_keys %{
    bootstrap_id: "bootstrapId",
    observed_bootstrap_ids: "observedBootstrapIds",
    cutoff_proofs: "cutoffProofs",
    log_digest: "logDigest",
    bootstrap_ids: "bootstrapIds",
    op_ids: "opIds",
    pending_proof_ids: "pendingProofIds",
    authority_witnesses: "authorityWitnesses"
  }
  @budget 67_108_864

  @spec within?(term()) :: boolean()
  def within?(value), do: bound(value, @max_json_depth, :json)

  @doc "Bound all public history evidence together before cryptographic replay."
  @spec within_histories?(term()) :: boolean()
  def within_histories?(histories) when is_list(histories),
    do: bound(histories, @max_json_depth + 4, :public)

  def within_histories?(_), do: false

  @doc "Bound a public evidence page or retained snapshot, including proof histories."
  @spec within_evidence?(term()) :: boolean()
  def within_evidence?(value), do: bound(value, @max_json_depth + 6, :public)

  @doc "Distinguish resource overflow from unreadable evidence without changing its limits."
  @spec evidence_admission(term()) :: :within | :resource_limit | :unreadable
  def evidence_admission(value),
    do: observation_admission([{:value, value, @max_json_depth + 6}], @budget, @budget, :public)

  defp bound(value, depth, mode),
    do: observation_admission([{:value, value, depth}], @budget, @budget, mode) == :within

  defp observation_admission(_pending, nodes, bytes, _mode) when nodes < 0 or bytes < 0,
    do: :resource_limit

  defp observation_admission([], _nodes, _bytes, _mode), do: :within

  defp observation_admission([{:value, value, _depth} | rest], nodes, bytes, mode)
       when is_binary(value),
       do:
         if(String.valid?(value),
           do: observation_admission(rest, nodes - 1, bytes - byte_size(value), mode),
           else: :unreadable
         )

  defp observation_admission([{:value, value, depth} | rest], nodes, bytes, mode)
       when is_list(value) and depth > 0,
       do: observation_admission([{:list, value, depth - 1} | rest], nodes - 1, bytes, mode)

  defp observation_admission([{:value, value, depth} | rest], nodes, bytes, mode)
       when is_map(value) and depth > 0,
       do:
         observation_admission(
           [{:map, :maps.iterator(value), depth - 1} | rest],
           nodes - 1,
           bytes,
           mode
         )

  defp observation_admission([{:value, value, _depth} | rest], nodes, bytes, mode)
       when is_number(value) or is_boolean(value) or is_nil(value),
       do: observation_admission(rest, nodes - 1, bytes, mode)

  defp observation_admission([{:value, value, depth} | rest], nodes, bytes, :public)
       when is_atom(value),
       do:
         observation_admission(
           [{:value, Atom.to_string(value), depth} | rest],
           nodes,
           bytes,
           :public
         )

  defp observation_admission([{:raw_json, value, depth} | rest], nodes, bytes, :public),
    do:
      observation_admission(
        [{:value, value, depth}, {:resume_mode, :public} | rest],
        nodes,
        bytes,
        :json
      )

  defp observation_admission([{:resume_mode, mode} | rest], nodes, bytes, _previous),
    do: observation_admission(rest, nodes, bytes, mode)

  defp observation_admission([{:list, [], _depth} | rest], nodes, bytes, mode),
    do: observation_admission(rest, nodes, bytes, mode)

  defp observation_admission([{:list, [head | tail], depth} | rest], nodes, bytes, mode),
    do:
      observation_admission(
        [{:value, head, depth}, {:list, tail, depth} | rest],
        nodes,
        bytes,
        mode
      )

  defp observation_admission([{:map, iterator, depth} | rest], nodes, bytes, mode) do
    case :maps.next(iterator) do
      :none ->
        observation_admission(rest, nodes, bytes, mode)

      {key, value, next} ->
        raw? = mode == :public and key in [:frames, :frame]
        {key, value} = public_pair(key, value, mode)
        entry = if raw?, do: {:raw_json, value, depth}, else: {:value, value, depth}

        observation_admission(
          [{:value, key, depth}, entry, {:map, next, depth} | rest],
          nodes,
          bytes,
          mode
        )
    end
  end

  defp observation_admission([{:value, value, depth} | _rest], _nodes, _bytes, _mode)
       when (is_map(value) or is_list(value)) and depth <= 0,
       do: :resource_limit

  defp observation_admission(_pending, _nodes, _bytes, _mode), do: :unreadable

  defp public_pair(key, value, :json), do: {key, value}

  # Only existing typed wrapper keys are translated. Wire-frame keys remain
  # binary data. The reviewed root is the sole raw byte field in a snapshot.
  defp public_pair(:space_root, value, :public) when is_binary(value) and byte_size(value) == 32,
    do: {"spaceRoot", Base.encode64(value)}

  defp public_pair(key, value, :public) when is_atom(key) do
    {Map.get(@public_keys, key, Atom.to_string(key)), value}
  end

  defp public_pair(key, value, :public), do: {key, value}
end
