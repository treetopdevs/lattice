defmodule Lattice.Carrier.Wire do
  @moduledoc """
  Versioned carrier wire frames.

  This module serializes complete `%Lattice.Op{}` structs for transport;
  integrity is still decided by `Lattice.Log.accept/2`.
  """

  alias Lattice.Authority.Delegation
  alias Lattice.Op

  @version 1

  @spec version() :: pos_integer()
  def version, do: @version

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
         {:ok, kind} <- existing_atom(kind),
         {:ok, body} <- decode_term(body),
         {:ok, cap} <- decode_term(cap) do
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

  @spec decode_report(map()) :: map()
  def decode_report(%{
        "accepted" => accepted,
        "quarantined" => quarantined,
        "rejected" => rejected,
        "pending" => pending
      }) do
    %{
      accepted: accepted,
      quarantined: decode_reason_pairs(quarantined),
      rejected: decode_reason_pairs(rejected),
      pending: pending
    }
  end

  defp encode_reason_pairs(pairs) do
    Enum.map(pairs, fn {id, reason} -> [id, Atom.to_string(reason)] end)
  end

  defp decode_reason_pairs(pairs) do
    Enum.map(pairs, fn [id, reason] -> {id, String.to_existing_atom(reason)} end)
  end

  defp encode_term(nil), do: ["nil"]
  defp encode_term(value) when is_boolean(value), do: ["bool", value]
  defp encode_term(value) when is_integer(value), do: ["int", value]
  defp encode_term(value) when is_binary(value), do: ["bin", Base.encode64(value)]
  defp encode_term(value) when is_atom(value), do: ["atom", Atom.to_string(value)]
  defp encode_term(value) when is_list(value), do: ["list", Enum.map(value, &encode_term/1)]

  defp encode_term(value) when is_tuple(value) do
    ["tuple", value |> Tuple.to_list() |> Enum.map(&encode_term/1)]
  end

  defp encode_term(%MapSet{} = value) do
    ["mapset", value |> MapSet.to_list() |> Enum.sort() |> Enum.map(&encode_term/1)]
  end

  defp encode_term(%Delegation{} = delegation), do: ["delegation", encode_delegation(delegation)]

  defp encode_term(value) when is_map(value) do
    ["map", Enum.map(value, fn {k, v} -> [encode_term(k), encode_term(v)] end)]
  end

  defp decode_term(["nil"]), do: {:ok, nil}
  defp decode_term(["bool", value]) when is_boolean(value), do: {:ok, value}
  defp decode_term(["int", value]) when is_integer(value), do: {:ok, value}
  defp decode_term(["bin", value]) when is_binary(value), do: Base.decode64(value)
  defp decode_term(["atom", value]) when is_binary(value), do: existing_atom(value)
  defp decode_term(["list", values]) when is_list(values), do: decode_list(values)

  defp decode_term(["tuple", values]) when is_list(values) do
    with {:ok, values} <- decode_list(values), do: {:ok, List.to_tuple(values)}
  end

  defp decode_term(["mapset", values]) when is_list(values) do
    with {:ok, values} <- decode_list(values), do: {:ok, MapSet.new(values)}
  end

  defp decode_term(["delegation", value]) when is_map(value), do: decode_delegation(value)
  defp decode_term(["map", pairs]) when is_list(pairs), do: decode_map(pairs)
  defp decode_term(_), do: {:error, :malformed_term}

  defp decode_list(values), do: reduce_decode(values, [])

  defp reduce_decode([], acc), do: {:ok, Enum.reverse(acc)}

  defp reduce_decode([value | rest], acc) do
    with {:ok, value} <- decode_term(value), do: reduce_decode(rest, [value | acc])
  end

  defp decode_map(pairs) do
    Enum.reduce_while(pairs, {:ok, %{}}, fn
      [k, v], {:ok, acc} ->
        with {:ok, k} <- decode_term(k), {:ok, v} <- decode_term(v) do
          {:cont, {:ok, Map.put(acc, k, v)}}
        else
          _ -> {:halt, {:error, :malformed_term}}
        end

      _other, _acc ->
        {:halt, {:error, :malformed_term}}
    end)
  end

  defp encode_delegation(%Delegation{} = delegation) do
    %{
      "id" => delegation.id,
      "replica" => delegation.replica,
      "issuer" => Base.encode64(delegation.issuer),
      "audience" => Base.encode64(delegation.audience),
      "parent_id" => delegation.parent_id,
      "ops" => Enum.map(delegation.ops, &Atom.to_string/1),
      "roles" => Enum.map(delegation.roles, &Atom.to_string/1),
      "live" => delegation.live,
      "sig" => Base.encode64(delegation.sig)
    }
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
         } = frame
       )
       when is_binary(id) and is_binary(replica) and is_binary(issuer_b64) and
              is_binary(audience_b64) and is_list(ops) and is_list(roles) and is_boolean(live) and
              is_binary(sig_b64) do
    with {:ok, issuer} <- Base.decode64(issuer_b64),
         {:ok, audience} <- Base.decode64(audience_b64),
         {:ok, sig} <- Base.decode64(sig_b64),
         {:ok, ops} <- existing_atoms(ops),
         {:ok, roles} <- existing_atoms(roles) do
      {:ok,
       %Delegation{
         id: id,
         replica: replica,
         issuer: issuer,
         audience: audience,
         parent_id: Map.get(frame, "parent_id"),
         ops: MapSet.new(ops),
         roles: MapSet.new(roles),
         live: live,
         sig: sig
       }}
    end
  end

  defp decode_delegation(_), do: {:error, :malformed_term}

  defp existing_atoms(values), do: reduce_atoms(values, [])

  defp reduce_atoms([], acc), do: {:ok, Enum.reverse(acc)}

  defp reduce_atoms([value | rest], acc) do
    with {:ok, atom} <- existing_atom(value), do: reduce_atoms(rest, [atom | acc])
  end

  defp existing_atom(value) when is_binary(value) do
    {:ok, String.to_existing_atom(value)}
  rescue
    ArgumentError -> {:error, :unknown_atom}
  end

  defp existing_atom(_), do: {:error, :unknown_atom}
end
