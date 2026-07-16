defmodule Township.Election.OfflineBundle do
  @moduledoc """
  Deterministic BEAM-only package for replaying the public election foundation.

  A bundle contains the asserted spec, complete Matter and board logs, every exact
  referenced artifact byte, and the projection observed when the package was built.
  Verification treats all of those values as untrusted and re-runs the normal pure
  projector. Extra, missing, or altered artifacts fail closed.

  This research codec is an Erlang external-term envelope. It makes no cross-runtime,
  long-term archival, data-availability, finality, or coercion-resistance claim.
  """

  alias Lattice.{Authority, Log, Op}
  alias Lattice.Authority.Delegation
  alias Lattice.Canonical.Atom, as: CanonicalAtom
  alias Township.{Election, ElectionBoard, Matter}

  alias Township.Election.{BoardSnapshot, ProfileRef, Projection, Projector, Spec}

  @schema "township-election-offline-replay-beam-v1"
  @max_envelope_byte_size 64 * 1_024 * 1_024
  @max_wire_depth 128
  @max_wire_nodes 2_000_000
  @etf_options [:deterministic, {:minor_version, 2}]
  @wire_struct_modules [
    __MODULE__,
    Delegation,
    Log,
    Op,
    ProfileRef,
    Projection,
    Spec
  ]
  @wire_atom_modules [
    Authority,
    Delegation,
    ElectionBoard,
    Log,
    Matter,
    Op,
    Projector,
    Spec,
    __MODULE__
  ]
  @fields [
    :schema,
    :spec,
    :matter_log,
    :matter_link_op_id,
    :board_log,
    :max_artifact_byte_size,
    :artifacts,
    :projection
  ]

  @enforce_keys @fields
  defstruct @fields

  @type t :: %__MODULE__{
          schema: String.t(),
          spec: Spec.t(),
          matter_log: Log.t(),
          matter_link_op_id: String.t(),
          board_log: Log.t(),
          max_artifact_byte_size: pos_integer(),
          artifacts: %{String.t() => binary()},
          projection: Projection.t()
        }

  @type reason ::
          atom()
          | {:pending, [term()]}
          | {:invalid, [term()]}
          | {:artifact_set_mismatch, %{missing: [term()], unexpected: [term()]}}

  @doc "Return the research-only wire schema."
  @spec schema() :: String.t()
  def schema, do: @schema

  @doc "Return the fixed maximum accepted external-term envelope size."
  @spec max_envelope_byte_size() :: pos_integer()
  def max_envelope_byte_size, do: @max_envelope_byte_size

  @doc "Build a complete package after re-verifying the public foundation and artifact set."
  @spec build(Spec.t(), BoardSnapshot.t(), map()) :: {:ok, t()} | {:error, reason()}
  def build(%Spec{} = spec, %BoardSnapshot{} = snapshot, artifacts) when is_map(artifacts) do
    with {:ok, view} <- Projector.foundation_view(spec, snapshot, artifacts),
         :ok <- complete_view(view),
         :ok <- exact_artifact_set(artifacts, view.artifact_records) do
      bundle = %__MODULE__{
        schema: @schema,
        spec: view.spec,
        matter_log: snapshot.matter_log,
        matter_link_op_id: snapshot.matter_link_op_id,
        board_log: snapshot.board_log,
        max_artifact_byte_size: snapshot.max_artifact_byte_size,
        artifacts: artifacts,
        projection: Election.project(view.spec, snapshot, artifacts)
      }

      case verify(bundle) do
        {:ok, _projection} -> {:ok, bundle}
        {:error, _reason} = error -> error
      end
    end
  rescue
    _ -> {:error, :malformed_offline_bundle}
  end

  def build(_spec, _snapshot, _artifacts), do: {:error, :malformed_offline_bundle}

  @doc "Re-run foundation verification from an untrusted in-memory bundle."
  @spec verify(t()) :: {:ok, Projection.t()} | {:error, reason()}
  def verify(%__MODULE__{
        schema: @schema,
        spec: %Spec{} = spec,
        matter_log: %Log{} = matter_log,
        matter_link_op_id: matter_link_op_id,
        board_log: %Log{} = board_log,
        max_artifact_byte_size: max_artifact_byte_size,
        artifacts: artifacts,
        projection: asserted_projection
      })
      when is_binary(matter_link_op_id) and is_integer(max_artifact_byte_size) and
             max_artifact_byte_size > 0 and is_map(artifacts) do
    snapshot = %BoardSnapshot{
      matter_log: matter_log,
      matter_link_op_id: matter_link_op_id,
      board_log: board_log,
      max_artifact_byte_size: max_artifact_byte_size
    }

    with {:ok, view} <- Projector.foundation_view(spec, snapshot, artifacts),
         :ok <- complete_view(view),
         :ok <- exact_artifact_set(artifacts, view.artifact_records),
         projection = Election.project(view.spec, snapshot, artifacts),
         true <- projection == asserted_projection do
      {:ok, projection}
    else
      false -> {:error, :projection_mismatch}
      {:error, _reason} = error -> error
    end
  rescue
    _ -> {:error, :malformed_offline_bundle}
  end

  def verify(_bundle), do: {:error, :malformed_offline_bundle}

  @doc "Encode a verified bundle in the deterministic research-only BEAM envelope."
  @spec encode(t()) :: {:ok, binary()} | {:error, reason()}
  def encode(%__MODULE__{} = bundle) do
    with {:ok, _projection} <- verify(bundle),
         {:ok, wire, _count} <- encode_wire(bundle, 0, 0),
         bytes = :erlang.term_to_binary([@schema, wire], @etf_options),
         true <- byte_size(bytes) <= @max_envelope_byte_size do
      {:ok, bytes}
    else
      false -> {:error, :offline_bundle_too_large}
      {:error, _reason} = error -> error
    end
  rescue
    _ -> {:error, :malformed_offline_bundle}
  end

  def encode(_bundle), do: {:error, :malformed_offline_bundle}

  @doc "Decode the schema-bound BEAM envelope without trusting or replaying its contents."
  @spec decode(binary()) :: {:ok, t()} | {:error, :corrupt_offline_bundle}
  def decode(bytes) when is_binary(bytes) do
    with :ok <- validate_envelope_bytes(bytes),
         {:ok, term} <- safe_binary_to_term(bytes),
         ^bytes <- :erlang.term_to_binary(term, @etf_options),
         [@schema, wire] <- term,
         :ok <- preload_wire_atoms(),
         {:ok, %__MODULE__{schema: @schema} = bundle, _count} <-
           decode_wire(wire, 0, 0),
         {:ok, canonical_wire, _count} <- encode_wire(bundle, 0, 0),
         ^wire <- canonical_wire do
      {:ok, bundle}
    else
      _ -> {:error, :corrupt_offline_bundle}
    end
  end

  def decode(_bytes), do: {:error, :corrupt_offline_bundle}

  @doc "Decode and fully replay one untrusted package."
  @spec verify_bytes(binary()) :: {:ok, Projection.t()} | {:error, reason()}
  def verify_bytes(bytes) when is_binary(bytes) do
    with {:ok, bundle} <- decode(bytes),
         {:ok, projection} <- verify(bundle) do
      {:ok, projection}
    end
  end

  def verify_bytes(_bytes), do: {:error, :corrupt_offline_bundle}

  defp complete_view(%{findings: [_ | _] = findings}), do: {:error, {:invalid, findings}}

  defp complete_view(%{requirements: [_ | _] = requirements}),
    do: {:error, {:pending, requirements}}

  defp complete_view(_view), do: :ok

  defp exact_artifact_set(artifacts, records) do
    if Enum.all?(artifacts, fn {digest, bytes} -> is_binary(digest) and is_binary(bytes) end) do
      expected = records |> Enum.map(& &1.ref.digest) |> Enum.uniq() |> Enum.sort()
      supplied = artifacts |> Map.keys() |> Enum.sort()
      missing = expected -- supplied
      unexpected = supplied -- expected

      if missing == [] and unexpected == [] do
        :ok
      else
        {:error, {:artifact_set_mismatch, %{missing: missing, unexpected: unexpected}}}
      end
    else
      {:error, :malformed_offline_bundle}
    end
  end

  defp validate_envelope_bytes(bytes) do
    cond do
      byte_size(bytes) == 0 -> {:error, :corrupt_offline_bundle}
      byte_size(bytes) > @max_envelope_byte_size -> {:error, :corrupt_offline_bundle}
      match?(<<131, 80, _rest::binary>>, bytes) -> {:error, :corrupt_offline_bundle}
      not match?(<<131, _rest::binary>>, bytes) -> {:error, :corrupt_offline_bundle}
      true -> :ok
    end
  end

  defp safe_binary_to_term(bytes) do
    {:ok, :erlang.binary_to_term(bytes, [:safe])}
  rescue
    _ -> {:error, :corrupt_offline_bundle}
  end

  defp preload_wire_atoms do
    modules = Enum.uniq(@wire_atom_modules ++ @wire_struct_modules)

    if Enum.all?(modules, &match?({:module, _module}, Code.ensure_loaded(&1))),
      do: :ok,
      else: {:error, :corrupt_offline_bundle}
  end

  defp encode_wire(nil, depth, count), do: wire_leaf(["nil"], depth, count)
  defp encode_wire(false, depth, count), do: wire_leaf(["bool", false], depth, count)
  defp encode_wire(true, depth, count), do: wire_leaf(["bool", true], depth, count)

  defp encode_wire(value, depth, count) when is_integer(value),
    do: wire_leaf(["int", value], depth, count)

  defp encode_wire(value, depth, count) when is_binary(value),
    do: wire_leaf(["bin", value], depth, count)

  defp encode_wire(%CanonicalAtom{name: name}, depth, count) when is_binary(name),
    do: wire_leaf(["atom", name], depth, count)

  defp encode_wire(value, depth, count) when is_atom(value),
    do: wire_leaf(["atom", Atom.to_string(value)], depth, count)

  defp encode_wire(%MapSet{} = set, depth, count) do
    with {:ok, count} <- wire_node(depth, count),
         {:ok, values, count} <- encode_wire_values(MapSet.to_list(set), depth + 1, count),
         {:ok, values} <- canonical_wire_values(values) do
      {:ok, ["mapset", values], count}
    end
  end

  defp encode_wire(%{__struct__: module} = struct, depth, count) do
    if module in @wire_struct_modules do
      with {:ok, count} <- wire_node(depth, count),
           {:ok, pairs, count} <-
             encode_wire_pairs(Map.to_list(Map.from_struct(struct)), depth + 1, count) do
        {:ok, ["struct", Atom.to_string(module), pairs], count}
      end
    else
      {:error, :malformed_offline_bundle}
    end
  end

  defp encode_wire(value, depth, count) when is_list(value) do
    with {:ok, count} <- wire_node(depth, count),
         {:ok, values, count} <- encode_wire_values(value, depth + 1, count) do
      {:ok, ["list", values], count}
    end
  end

  defp encode_wire(value, depth, count) when is_tuple(value) do
    with {:ok, count} <- wire_node(depth, count),
         {:ok, values, count} <-
           encode_wire_values(Tuple.to_list(value), depth + 1, count) do
      {:ok, ["tuple", values], count}
    end
  end

  defp encode_wire(value, depth, count) when is_map(value) do
    with {:ok, count} <- wire_node(depth, count),
         {:ok, pairs, count} <- encode_wire_pairs(Map.to_list(value), depth + 1, count) do
      {:ok, ["map", pairs], count}
    end
  end

  defp encode_wire(_value, _depth, _count), do: {:error, :malformed_offline_bundle}

  defp encode_wire_values(values, depth, count) do
    Enum.reduce_while(values, {:ok, [], count}, fn value, {:ok, encoded, count} ->
      case encode_wire(value, depth, count) do
        {:ok, wire, count} -> {:cont, {:ok, [wire | encoded], count}}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, encoded, count} -> {:ok, Enum.reverse(encoded), count}
      {:error, _reason} = error -> error
    end
  end

  defp encode_wire_pairs(pairs, depth, count) do
    Enum.reduce_while(pairs, {:ok, [], count}, fn {key, value}, {:ok, encoded, count} ->
      with {:ok, wire_key, count} <- encode_wire(key, depth, count),
           {:ok, wire_value, count} <- encode_wire(value, depth, count) do
        {:cont, {:ok, [[wire_key, wire_value] | encoded], count}}
      else
        {:error, _reason} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, encoded, count} ->
        case canonical_wire_pairs(encoded) do
          {:ok, pairs} -> {:ok, pairs, count}
          {:error, :duplicate_wire_key} -> {:error, :malformed_offline_bundle}
        end

      {:error, _reason} = error ->
        error
    end
  end

  defp decode_wire(["nil"], depth, count), do: wire_leaf(nil, depth, count)

  defp decode_wire(["bool", value], depth, count) when is_boolean(value),
    do: wire_leaf(value, depth, count)

  defp decode_wire(["int", value], depth, count) when is_integer(value),
    do: wire_leaf(value, depth, count)

  defp decode_wire(["bin", value], depth, count) when is_binary(value),
    do: wire_leaf(value, depth, count)

  defp decode_wire(["atom", name], depth, count) when is_binary(name) do
    with {:ok, count} <- wire_node(depth, count) do
      {:ok, existing_atom_or_token(name), count}
    end
  end

  defp decode_wire(["list", values], depth, count) when is_list(values) do
    with {:ok, count} <- wire_node(depth, count),
         {:ok, decoded, count} <- decode_wire_values(values, depth + 1, count) do
      {:ok, decoded, count}
    end
  end

  defp decode_wire(["tuple", values], depth, count) when is_list(values) do
    with {:ok, count} <- wire_node(depth, count),
         {:ok, decoded, count} <- decode_wire_values(values, depth + 1, count) do
      {:ok, List.to_tuple(decoded), count}
    end
  end

  defp decode_wire(["mapset", values], depth, count) when is_list(values) do
    with {:ok, count} <- wire_node(depth, count),
         {:ok, decoded, count} <- decode_wire_values(values, depth + 1, count) do
      {:ok, MapSet.new(decoded), count}
    end
  end

  defp decode_wire(["map", pairs], depth, count) when is_list(pairs) do
    with {:ok, count} <- wire_node(depth, count),
         {:ok, decoded, count} <- decode_wire_pairs(pairs, depth + 1, count),
         {:ok, map} <- unique_map(decoded) do
      {:ok, map, count}
    end
  end

  defp decode_wire(["struct", module_name, pairs], depth, count)
       when is_binary(module_name) and is_list(pairs) do
    with {:ok, module} <- wire_module(module_name),
         {:ok, count} <- wire_node(depth, count),
         {:ok, decoded, count} <- decode_wire_pairs(pairs, depth + 1, count),
         {:ok, fields} <- unique_map(decoded) do
      {:ok, struct!(module, fields), count}
    end
  rescue
    _ -> {:error, :corrupt_offline_bundle}
  end

  defp decode_wire(_wire, _depth, _count), do: {:error, :corrupt_offline_bundle}

  defp decode_wire_values(values, depth, count) do
    Enum.reduce_while(values, {:ok, [], count}, fn value, {:ok, decoded, count} ->
      case decode_wire(value, depth, count) do
        {:ok, term, count} -> {:cont, {:ok, [term | decoded], count}}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
    |> case do
      {:ok, decoded, count} -> {:ok, Enum.reverse(decoded), count}
      {:error, _reason} = error -> error
    end
  end

  defp decode_wire_pairs(pairs, depth, count) do
    Enum.reduce_while(pairs, {:ok, [], count}, fn
      [wire_key, wire_value], {:ok, decoded, count} ->
        with {:ok, key, count} <- decode_wire(wire_key, depth, count),
             {:ok, value, count} <- decode_wire(wire_value, depth, count) do
          {:cont, {:ok, [{key, value} | decoded], count}}
        else
          {:error, _reason} = error -> {:halt, error}
        end

      _pair, _acc ->
        {:halt, {:error, :corrupt_offline_bundle}}
    end)
    |> case do
      {:ok, decoded, count} -> {:ok, Enum.reverse(decoded), count}
      {:error, _reason} = error -> error
    end
  end

  defp unique_map(pairs) do
    map = Map.new(pairs)
    if map_size(map) == length(pairs), do: {:ok, map}, else: {:error, :corrupt_offline_bundle}
  end

  defp existing_atom_or_token(name) do
    String.to_existing_atom(name)
  rescue
    ArgumentError -> %CanonicalAtom{name: name}
  end

  defp wire_module(name) do
    case Enum.find(@wire_struct_modules, &(Atom.to_string(&1) == name)) do
      nil -> {:error, :corrupt_offline_bundle}
      module -> {:ok, module}
    end
  end

  defp wire_leaf(value, depth, count) do
    with {:ok, count} <- wire_node(depth, count), do: {:ok, value, count}
  end

  defp wire_node(depth, count)
       when depth <= @max_wire_depth and count < @max_wire_nodes,
       do: {:ok, count + 1}

  defp wire_node(_depth, _count), do: {:error, :corrupt_offline_bundle}

  defp canonical_wire_pairs(pairs) do
    sorted = Enum.sort_by(pairs, fn [key, _value] -> wire_sort_key(key) end)
    keys = Enum.map(sorted, fn [key, _value] -> wire_sort_key(key) end)

    if Enum.uniq(keys) == keys,
      do: {:ok, sorted},
      else: {:error, :duplicate_wire_key}
  end

  defp canonical_wire_values(values) do
    sorted = Enum.sort_by(values, &wire_sort_key/1)
    encoded = Enum.map(sorted, &wire_sort_key/1)

    if Enum.uniq(encoded) == encoded,
      do: {:ok, sorted},
      else: {:error, :duplicate_wire_value}
  end

  defp wire_sort_key(wire), do: :erlang.term_to_binary(wire, @etf_options)
end
