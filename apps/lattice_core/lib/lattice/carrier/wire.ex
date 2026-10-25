defmodule Lattice.Carrier.Wire do
  @moduledoc """
  Versioned carrier wire frames.

  This module serializes complete `%Lattice.Op{}` structs for transport;
  integrity is still decided by `Lattice.Log.accept/2`.

  Body and capability terms may contain at most 64 nested generic composites.
  Scalars and flat delegation records do not recurse through that budget.

  An atom name inside an op's signed terms or a delegation is admitted only if it is on
  the closed `Lattice.Carrier.WireVocabulary`: a listed name decodes to its atom (created on
  demand, so the atom table stays bounded by the list) and any other name refuses the frame.
  Admission is therefore a function of the frame bytes and that one list, never of which
  atoms this VM happens to hold (row 190). The op kind and report reasons stay closed sets.
  `encode_op_checked/1` and `Lattice.Op.authored/6` apply the same list on the authoring side.
  """

  alias Lattice.Authority.Delegation
  alias Lattice.Canonical
  alias Lattice.Canonical.Atom, as: CanonicalAtom
  alias Lattice.Carrier.RawObservationBounds
  alias Lattice.Carrier.WireVocabulary
  alias Lattice.Op

  @version 1
  @max_json_safe_integer 9_007_199_254_740_991
  @max_canonical_integer 18_446_744_073_709_551_615
  @max_decode_depth 64
  @max_observation_depth 65
  @op_kinds [:command, :authority, :inbox, :tombstone]

  @spec version() :: pos_integer()
  def version, do: @version

  @doc "The op kinds a carrier frame may name."
  @spec op_kinds() :: [Op.kind()]
  def op_kinds, do: @op_kinds

  @doc "Encode one signable value using the unchanged carrier term grammar."
  @spec encode_value(term()) :: list()
  def encode_value(value) do
    if Canonical.signable?(value),
      do: encode_term(value),
      else: raise(ArgumentError, "unsupported wire value")
  end

  @doc """
  Decode a standalone signable value with the existing term depth/integer rules.

  Like op decoding, this preserves generic map/mapset normalization. A closed
  artifact protocol must reject duplicate raw fields before calling this seam.
  It is not a strict canonical-envelope or signature verifier. Unlike op frames, a
  standalone value still refuses an atom name this VM does not hold, because the
  closed artifact protocols built on it match their vocabulary as atoms.
  """
  @spec decode_value(term()) :: {:ok, term()} | {:error, :malformed_term}
  def decode_value(value) do
    with {:ok, decoded} <- decode_term(value, @max_decode_depth, :value),
         true <- existing_atoms_only?(decoded),
         true <- Canonical.signable?(decoded) do
      {:ok, decoded}
    else
      _ -> {:error, :malformed_term}
    end
  end

  @spec encode_op(Op.t()) :: map()
  def encode_op(%Op{} = op) do
    %{
      "v" => @version,
      "id" => op.id,
      "replica" => op.replica,
      "author" => Base.encode64(op.author),
      "deps" => op.deps,
      "kind" => Atom.to_string(op.kind),
      "body" => encode_term(op.body),
      "cap" => encode_term(op.cap),
      "sig" => Base.encode64(op.sig)
    }
  end

  @doc """
  Encode an op for a peer that will admit it, or refuse it.

  Returns `{:error, :unknown_atom}` when the op kind is not one `decode_op/1` admits, or when
  an atom name in the body, the cap, or a delegation is off the closed vocabulary (a legacy `Lattice.Canonical.Atom` struct counts as the name
  it carries), before anything is emitted. A listed name encodes to the same bytes as
  `encode_op/1`, which stays the unchecked encoder for the simulator and adversarial tests.
  """
  @spec encode_op_checked(Op.t()) :: {:ok, map()} | {:error, :unknown_atom}
  def encode_op_checked(%Op{} = op) do
    if op.kind in @op_kinds and listed_term?(op.body) and listed_term?(op.cap),
      do: {:ok, encode_op(op)},
      else: {:error, :unknown_atom}
  end

  @doc """
  Whether every atom name in a signable term, delegation names included, is on
  `Lattice.Carrier.WireVocabulary.names/0`.
  """
  @spec listed_term?(term()) :: boolean()
  def listed_term?(value) when is_nil(value) or is_boolean(value), do: true
  def listed_term?(value) when is_atom(value), do: WireVocabulary.known?(Atom.to_string(value))
  def listed_term?(%CanonicalAtom{name: name}), do: WireVocabulary.known?(name)

  # Delegation ops and roles ride the wire as bare names, so `nil` and booleans are names here.
  def listed_term?(%Delegation{ops: ops, roles: roles}),
    do: Enum.all?(ops, &listed_name?/1) and Enum.all?(roles, &listed_name?/1)

  def listed_term?(%MapSet{} = value), do: value |> MapSet.to_list() |> listed_term?()
  def listed_term?(value) when is_list(value), do: Enum.all?(value, &listed_term?/1)
  def listed_term?(value) when is_tuple(value), do: value |> Tuple.to_list() |> listed_term?()

  def listed_term?(value) when is_map(value) and not is_struct(value),
    do: Enum.all?(value, fn {k, v} -> listed_term?(k) and listed_term?(v) end)

  def listed_term?(_value), do: true

  defp listed_name?(value) when is_atom(value), do: WireVocabulary.known?(Atom.to_string(value))
  defp listed_name?(%CanonicalAtom{name: name}), do: WireVocabulary.known?(name)
  defp listed_name?(_value), do: false

  @doc """
  Authenticate raw public history without admitting an operation.

  Unknown names remain canonical atom-name wrappers. Only header metadata is
  returned; callers must still use closed wire decoding before semantics. The
  observation has bounded nodes/string bytes and a depth-65 observation limit.
  Ordinary wire admission retains its separate depth-64 limit.
  """
  @spec authenticate_observation(term()) :: {:ok, map()} | {:error, :malformed_op}
  def authenticate_observation(frame) do
    with true <- RawObservationBounds.within?(frame),
         true <- is_map(frame) and map_size(frame) == 9,
         %{
           "v" => 1,
           "id" => id,
           "replica" => replica,
           "author" => author64,
           "deps" => deps,
           "kind" => kind,
           "body" => body,
           "cap" => cap,
           "sig" => sig64
         } <- frame,
         true <- is_binary(id) and is_binary(replica) and is_binary(kind),
         true <- is_list(deps) and Enum.all?(deps, &is_binary/1),
         {:ok, author} <- Base.decode64(author64),
         true <- byte_size(author) == 32 and Base.encode64(author) == author64,
         {:ok, sig} <- Base.decode64(sig64),
         true <- byte_size(sig) == 64 and Base.encode64(sig) == sig64,
         {:ok, body} <- decode_term(body, @max_observation_depth, :observation),
         {:ok, cap} <- decode_term(cap, @max_observation_depth, :observation),
         true <- Canonical.signable?(body) and Canonical.signable?(cap),
         true <-
           Op.valid?(%Op{
             id: id,
             replica: replica,
             author: author,
             deps: deps,
             kind: %CanonicalAtom{name: kind},
             body: body,
             cap: cap,
             sig: sig
           }) do
      {:ok, %{id: id, replica: replica, deps: deps}}
    else
      _ -> {:error, :malformed_op}
    end
  rescue
    _ -> {:error, :malformed_op}
  end

  @spec decode_op(term()) :: {:ok, Op.t()} | {:error, :malformed_op}
  def decode_op(%{
        "v" => @version,
        "id" => id,
        "replica" => replica,
        "author" => author_b64,
        "deps" => deps,
        "kind" => kind,
        "body" => body,
        "cap" => cap,
        "sig" => sig_b64
      })
      when is_binary(id) and is_binary(replica) and is_binary(author_b64) and is_list(deps) and
             is_binary(kind) and is_binary(sig_b64) do
    with true <- Enum.all?(deps, &is_binary/1),
         {:ok, author} <- Base.decode64(author_b64),
         {:ok, sig} <- Base.decode64(sig_b64),
         {:ok, kind} <- op_kind(kind),
         {:ok, body} <- decode_term(body, @max_decode_depth, :op),
         {:ok, cap} <- decode_term(cap, @max_decode_depth, :op),
         true <- Canonical.signable?(body),
         true <- Canonical.signable?(cap) do
      {:ok,
       %Op{
         id: id,
         replica: replica,
         author: author,
         deps: deps,
         kind: kind,
         body: body,
         cap: cap,
         sig: sig
       }}
    else
      _ -> {:error, :malformed_op}
    end
  end

  def decode_op(_), do: {:error, :malformed_op}

  @spec encode_ops([Op.t()]) :: [map()]
  def encode_ops(ops), do: Enum.map(ops, &encode_op/1)

  @spec decode_ops(term()) :: {:ok, [Op.t()]} | {:error, :malformed_op}
  def decode_ops(list) when is_list(list) do
    list
    |> Enum.reduce_while({:ok, []}, fn item, {:ok, acc} ->
      case decode_op(item) do
        {:ok, op} -> {:cont, {:ok, [op | acc]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, ops} -> {:ok, Enum.reverse(ops)}
      {:error, _reason} = err -> err
    end
  end

  def decode_ops(_), do: {:error, :malformed_op}

  @spec encode_report(map()) :: map()
  def encode_report(%{
        accepted: accepted,
        quarantined: quarantined,
        rejected: rejected,
        pending: pending
      }) do
    %{
      "accepted" => accepted,
      "quarantined" => encode_reason_pairs(quarantined),
      "rejected" => encode_reason_pairs(rejected),
      "pending" => pending
    }
  end

  @spec encode_push_result(map()) :: map()
  def encode_push_result(report), do: Map.put(encode_report(report), "type", "push_result")

  @spec decode_report(map()) ::
          {:ok, Lattice.Sync.report()} | {:error, :malformed_term}
  def decode_report(%{
        "accepted" => accepted,
        "quarantined" => quarantined,
        "rejected" => rejected,
        "pending" => pending
      }) do
    with true <- string_list?(accepted),
         {:ok, quarantined} <- decode_reason_pairs(quarantined),
         {:ok, rejected} <- decode_reason_pairs(rejected),
         true <- string_list?(pending) do
      {:ok,
       %{
         accepted: accepted,
         quarantined: quarantined,
         rejected: rejected,
         pending: pending
       }}
    else
      _ -> {:error, :malformed_term}
    end
  end

  def decode_report(_), do: {:error, :malformed_term}

  defp encode_reason_pairs(pairs) do
    Enum.map(pairs, fn {id, reason} -> [id, Atom.to_string(reason)] end)
  end

  defp decode_reason_pairs(pairs) when is_list(pairs) do
    Enum.reduce_while(pairs, {:ok, []}, fn
      [id, reason], {:ok, acc} when is_binary(id) and is_binary(reason) ->
        case report_reason(reason) do
          {:ok, reason} -> {:cont, {:ok, [{id, reason} | acc]}}
          :error -> {:halt, {:error, :malformed_term}}
        end

      _other, _acc ->
        {:halt, {:error, :malformed_term}}
    end)
    |> case do
      {:ok, pairs} -> {:ok, Enum.reverse(pairs)}
      {:error, _reason} = error -> error
    end
  end

  defp decode_reason_pairs(_pairs), do: {:error, :malformed_term}

  # A report reason is admitted by the closed list, not by whether this VM holds the atom: op
  # admission creates atoms for listed names, so existence would depend on decode history.
  defp report_reason(name) do
    case Enum.find(WireVocabulary.reasons(), &(Atom.to_string(&1) == name)) do
      nil -> :error
      reason -> {:ok, reason}
    end
  end

  defp string_list?(values), do: is_list(values) and Enum.all?(values, &is_binary/1)

  defp encode_term(nil), do: ["nil"]
  defp encode_term(value) when is_boolean(value), do: ["bool", value]

  defp encode_term(value)
       when is_integer(value) and value >= 0 and value <= @max_json_safe_integer,
       do: ["int", value]

  defp encode_term(value)
       when is_integer(value) and value > @max_json_safe_integer and
              value <= @max_canonical_integer,
       do: ["int", Integer.to_string(value)]

  defp encode_term(value) when is_binary(value), do: ["bin", Base.encode64(value)]
  defp encode_term(value) when is_atom(value), do: ["atom", Atom.to_string(value)]
  defp encode_term(%CanonicalAtom{name: name}) when is_binary(name), do: ["atom", name]
  defp encode_term(value) when is_list(value), do: ["list", Enum.map(value, &encode_term/1)]

  defp encode_term(value) when is_tuple(value) do
    ["tuple", value |> Tuple.to_list() |> Enum.map(&encode_term/1)]
  end

  defp encode_term(%MapSet{} = value) do
    values =
      value
      |> MapSet.to_list()
      |> Enum.sort_by(&Canonical.term/1)
      |> Enum.map(&encode_term/1)

    ["mapset", values]
  end

  defp encode_term(%Delegation{} = delegation), do: ["delegation", encode_delegation(delegation)]

  defp encode_term(value) when is_map(value) do
    pairs =
      value
      |> Enum.map(fn {k, v} -> {Canonical.term(k), [encode_term(k), encode_term(v)]} end)
      |> Enum.sort_by(fn {key_bytes, _pair} -> key_bytes end)
      |> Enum.map(fn {_key_bytes, pair} -> pair end)

    ["map", pairs]
  end

  defp encode_term(value) do
    raise ArgumentError, "unsupported wire term: #{inspect(value)}"
  end

  # `mode` picks how an atom name is admitted: `:op` (op frames) by the closed vocabulary,
  # `:value` (standalone values) by atoms this VM already holds.
  defp decode_term(["nil"], _depth, _mode), do: {:ok, nil}
  defp decode_term(["bool", value], _depth, _mode) when is_boolean(value), do: {:ok, value}

  defp decode_term(["int", value], _depth, _mode)
       when is_integer(value) and value >= 0 and value <= @max_json_safe_integer,
       do: {:ok, value}

  defp decode_term(["int", value], depth, :observation) when is_binary(value) do
    if byte_size(value) <= 20 and Regex.match?(~r/^(0|[1-9][0-9]*)$/, value),
      do: decode_term(["int", value], depth, :value),
      else: {:error, :malformed_term}
  end

  defp decode_term(["int", value], _depth, _mode) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} when int >= 0 and int <= @max_canonical_integer -> {:ok, int}
      _other -> {:error, :malformed_term}
    end
  end

  defp decode_term(["bin", value], _depth, _mode) when is_binary(value) do
    case Base.decode64(value) do
      {:ok, bin} -> {:ok, bin}
      :error -> {:error, :malformed_term}
    end
  end

  defp decode_term(["atom", value], _depth, mode) when is_binary(value),
    do: decode_atom(value, mode)

  defp decode_term(["list", values], depth, mode) when is_list(values) and depth > 0,
    do: decode_list(values, depth - 1, mode)

  defp decode_term(["tuple", values], depth, mode) when is_list(values) and depth > 0 do
    with {:ok, values} <- decode_list(values, depth - 1, mode), do: {:ok, List.to_tuple(values)}
  end

  defp decode_term(["mapset", values], depth, :observation) when is_list(values) and depth > 0 do
    with {:ok, values} <- decode_list(values, depth - 1, :observation),
         encoded = Enum.map(values, &Canonical.term/1),
         true <- MapSet.size(MapSet.new(encoded)) == length(encoded) do
      {:ok, MapSet.new(values)}
    else
      _ -> {:error, :malformed_term}
    end
  end

  defp decode_term(["mapset", values], depth, mode) when is_list(values) and depth > 0 do
    with {:ok, values} <- decode_list(values, depth - 1, mode), do: {:ok, MapSet.new(values)}
  end

  defp decode_term(["delegation", value], _depth, mode) when is_map(value),
    do: decode_delegation(value, mode)

  defp decode_term(["map", pairs], depth, mode) when is_list(pairs) and depth > 0,
    do: decode_map(pairs, depth - 1, mode)

  defp decode_term(_, _depth, _mode), do: {:error, :malformed_term}

  defp decode_list(values, depth, mode), do: reduce_decode(values, [], depth, mode)

  defp reduce_decode([], acc, _depth, _mode), do: {:ok, Enum.reverse(acc)}

  defp reduce_decode([value | rest], acc, depth, mode) do
    with {:ok, value} <- decode_term(value, depth, mode),
         do: reduce_decode(rest, [value | acc], depth, mode)
  end

  defp decode_map(pairs, depth, :observation) do
    Enum.reduce_while(pairs, {:ok, %{}, MapSet.new()}, fn
      [k, v], {:ok, acc, seen} ->
        with {:ok, k} <- decode_term(k, depth, :observation),
             {:ok, v} <- decode_term(v, depth, :observation),
             bytes = Canonical.term(k),
             false <- MapSet.member?(seen, bytes) do
          {:cont, {:ok, Map.put(acc, k, v), MapSet.put(seen, bytes)}}
        else
          _ -> {:halt, {:error, :malformed_term}}
        end

      _, _ ->
        {:halt, {:error, :malformed_term}}
    end)
    |> case do
      {:ok, map, _seen} -> {:ok, map}
      error -> error
    end
  end

  defp decode_map(pairs, depth, mode) do
    Enum.reduce_while(pairs, {:ok, %{}}, fn
      [k, v], {:ok, acc} ->
        with {:ok, k} <- decode_term(k, depth, mode), {:ok, v} <- decode_term(v, depth, mode) do
          {:cont, {:ok, Map.put(acc, k, v)}}
        else
          _ -> {:halt, {:error, :malformed_term}}
        end

      _other, _acc ->
        {:halt, {:error, :malformed_term}}
    end)
  end

  defp encode_delegation(%Delegation{} = delegation) do
    frame = %{
      "id" => delegation.id,
      "replica" => delegation.replica,
      "issuer" => Base.encode64(delegation.issuer),
      "audience" => Base.encode64(delegation.audience),
      "parent_id" => delegation.parent_id,
      "ops" => delegation.ops |> Enum.map(&Canonical.atom_name/1) |> Enum.sort(),
      "roles" => delegation.roles |> Enum.map(&Canonical.atom_name/1) |> Enum.sort(),
      "live" => delegation.live,
      "sig" => Base.encode64(delegation.sig)
    }

    # Plan 149: the lease rides the wire only when set, so every unleased
    # delegation frame keeps its existing shape byte-for-byte.
    case delegation.expires_epoch do
      nil -> frame
      epoch -> Map.put(frame, "expires_epoch", epoch)
    end
  end

  defp decode_delegation(
         %{
           "id" => id,
           "replica" => replica,
           "issuer" => issuer_b64,
           "audience" => audience_b64,
           "ops" => ops,
           "roles" => roles,
           "live" => live,
           "sig" => sig_b64
         } = frame,
         mode
       )
       when is_binary(id) and is_binary(replica) and is_binary(issuer_b64) and
              is_binary(audience_b64) and is_list(ops) and is_list(roles) and is_boolean(live) and
              is_binary(sig_b64) do
    parent_id = Map.get(frame, "parent_id")

    with true <- is_nil(parent_id) or is_binary(parent_id),
         {:ok, issuer} <- Base.decode64(issuer_b64),
         {:ok, audience} <- Base.decode64(audience_b64),
         {:ok, sig} <- Base.decode64(sig_b64),
         {:ok, ops} <- decode_atoms(ops, mode),
         {:ok, roles} <- decode_atoms(roles, mode),
         {:ok, expires_epoch} <- decode_expires_epoch(Map.get(frame, "expires_epoch")) do
      {:ok,
       %Delegation{
         id: id,
         replica: replica,
         issuer: issuer,
         audience: audience,
         parent_id: parent_id,
         ops: MapSet.new(ops),
         roles: MapSet.new(roles),
         live: live,
         sig: sig,
         expires_epoch: expires_epoch
       }}
    else
      _ -> {:error, :malformed_term}
    end
  end

  defp decode_delegation(_, _mode), do: {:error, :malformed_term}

  defp decode_expires_epoch(nil), do: {:ok, nil}

  defp decode_expires_epoch(epoch)
       when is_integer(epoch) and epoch >= 0 and epoch <= @max_canonical_integer,
       do: {:ok, epoch}

  defp decode_expires_epoch(_), do: {:error, :malformed_term}

  defp existing_atoms_only?(%CanonicalAtom{}), do: false

  defp existing_atoms_only?(%Delegation{ops: ops, roles: roles}),
    do: Enum.all?(ops, &is_atom/1) and Enum.all?(roles, &is_atom/1)

  defp existing_atoms_only?(%MapSet{} = set), do: Enum.all?(set, &existing_atoms_only?/1)

  defp existing_atoms_only?(value) when is_map(value),
    do: Enum.all?(value, fn {k, v} -> existing_atoms_only?(k) and existing_atoms_only?(v) end)

  defp existing_atoms_only?(value) when is_list(value),
    do: Enum.all?(value, &existing_atoms_only?/1)

  defp existing_atoms_only?(value) when is_tuple(value),
    do: value |> Tuple.to_list() |> existing_atoms_only?()

  defp existing_atoms_only?(_value), do: true

  @op_kind_names Map.new(@op_kinds, &{Atom.to_string(&1), &1})

  defp op_kind(name), do: Map.fetch(@op_kind_names, name)

  defp decode_atoms(names, mode) when is_list(names), do: reduce_atoms(names, [], mode)

  defp reduce_atoms([], acc, _mode), do: {:ok, Enum.reverse(acc)}

  defp reduce_atoms([name | rest], acc, mode) do
    with {:ok, atom} <- decode_atom(name, mode), do: reduce_atoms(rest, [atom | acc], mode)
  end

  # Op frames: only a listed name becomes an atom, so the VM's atom table never decides
  # admission and input can create at most the listed atoms.
  defp decode_atom(name, :op) when is_binary(name) do
    if WireVocabulary.known?(name),
      do: {:ok, String.to_atom(name)},
      else: {:error, :unknown_atom}
  end

  defp decode_atom(name, :observation) when is_binary(name), do: {:ok, %CanonicalAtom{name: name}}

  defp decode_atom(name, :value), do: existing_atom(name)
  defp decode_atom(_name, _mode), do: {:error, :unknown_atom}

  defp existing_atom(value) when is_binary(value) do
    {:ok, String.to_existing_atom(value)}
  rescue
    ArgumentError -> {:error, :unknown_atom}
  end

  defp existing_atom(_), do: {:error, :unknown_atom}
end
