defmodule Lattice.Canonical do
  @moduledoc """
  Deterministic canonical bytes for signed Lattice values.

  This is a deliberately small CBOR-shaped subset for the Lattice term domain:
  nil, booleans, non-negative integers, binaries, atoms, lists, tuples, maps,
  and MapSets. Maps sort by their fully encoded key bytes. Local BEAM terms such
  as pid/ref/fun, floats, ports, and negative integers are rejected before
  signing.
  """

  @suite "lattice-cbor-v1"
  @op_tag "lattice-op-v2"
  @delegation_tag "lattice-delegation-v2"

  @spec suite() :: String.t()
  def suite, do: @suite

  @spec op_payload(Lattice.Op.t()) :: binary()
  def op_payload(%Lattice.Op{} = op) do
    op_bytes(op.replica, op.author, Lattice.Op.normalize_deps(op.deps), op.kind, op.body, op.cap)
  end

  @spec op_bytes(
          String.t(),
          Lattice.Identity.pubkey(),
          [Lattice.Op.id()],
          Lattice.Op.kind(),
          term(),
          term()
        ) ::
          binary()
  def op_bytes(replica, author, deps, kind, body, cap) do
    term([@op_tag, replica, author, deps, kind, body, cap])
  end

  @spec delegation_payload(Lattice.Authority.Delegation.t()) :: binary()
  def delegation_payload(%Lattice.Authority.Delegation{} = d) do
    delegation_bytes(d.replica, d.issuer, d.audience, d.parent_id, d.ops, d.roles, d.live)
  end

  @spec delegation_bytes(
          String.t(),
          Lattice.Identity.pubkey(),
          Lattice.Identity.pubkey(),
          String.t() | nil,
          Enumerable.t(),
          Enumerable.t(),
          boolean()
        ) :: binary()
  def delegation_bytes(replica, issuer, audience, parent_id, ops, roles, live) do
    term([
      @delegation_tag,
      replica,
      issuer,
      audience,
      parent_id,
      Enum.sort(ops),
      Enum.sort(roles),
      live
    ])
  end

  @spec term(term()) :: binary()
  def term(value), do: encode(value)

  defp encode(nil), do: <<0xF6>>
  defp encode(false), do: <<0xF4>>
  defp encode(true), do: <<0xF5>>
  defp encode(int) when is_integer(int) and int >= 0, do: major(0, int)
  defp encode(bin) when is_binary(bin), do: major(2, byte_size(bin)) <> bin
  defp encode(atom) when is_atom(atom), do: encode_tagged("atom", Atom.to_string(atom))

  defp encode(list) when is_list(list) do
    major(4, length(list)) <> IO.iodata_to_binary(Enum.map(list, &encode/1))
  end

  defp encode(tuple) when is_tuple(tuple) do
    tuple |> Tuple.to_list() |> then(&encode_tagged("tuple", &1))
  end

  defp encode(%MapSet{} = set), do: set |> MapSet.to_list() |> Enum.sort() |> encode()

  defp encode(%Lattice.Authority.Delegation{} = delegation) do
    encode_tagged("delegation", [
      delegation.id,
      delegation.replica,
      delegation.issuer,
      delegation.audience,
      delegation.parent_id,
      Enum.sort(delegation.ops),
      Enum.sort(delegation.roles),
      delegation.live,
      delegation.sig
    ])
  end

  defp encode(%{__struct__: _} = other) do
    raise ArgumentError, "unsupported canonical term: #{inspect(other)}"
  end

  defp encode(map) when is_map(map) do
    pairs =
      map
      |> Enum.map(fn {k, v} -> {encode(k), encode(v)} end)
      |> Enum.sort_by(fn {k, _v} -> k end)

    major(5, length(pairs)) <> IO.iodata_to_binary(Enum.map(pairs, fn {k, v} -> k <> v end))
  end

  defp encode(other) do
    raise ArgumentError, "unsupported canonical term: #{inspect(other)}"
  end

  defp encode_tagged(tag, value), do: encode([tag, value])

  defp major(major, n) when n < 24, do: <<major::3, n::5>>
  defp major(major, n) when n < 256, do: <<major::3, 24::5, n>>
  defp major(major, n) when n < 65_536, do: <<major::3, 25::5, n::16>>
  defp major(major, n) when n < 4_294_967_296, do: <<major::3, 26::5, n::32>>
  defp major(major, n), do: <<major::3, 27::5, n::64>>
end
