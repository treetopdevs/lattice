defmodule Lattice.Canonical.Atom do
  @moduledoc """
  Atom-name value for safe cross-process decoding of canonical terms.

  `Lattice.Canonical` encodes this value exactly as an atom with the same name.
  It lets an untrusted decoder preserve producer-defined atom semantics without
  creating atoms in the verifier VM.
  """

  @enforce_keys [:name]
  defstruct [:name]

  @type t :: %__MODULE__{name: String.t()}

  @spec new(String.t()) :: {:ok, t()} | {:error, :invalid_atom_name}
  def new(name) when is_binary(name), do: {:ok, %__MODULE__{name: name}}
  def new(_name), do: {:error, :invalid_atom_name}
end

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
  @delegation_v3_tag "lattice-delegation-v3"
  @uint64_max 18_446_744_073_709_551_615
  @atom_tag 60_000
  @tuple_tag 60_001
  @mapset_tag 60_002
  @delegation_term_tag 60_003

  @spec suite() :: String.t()
  def suite, do: @suite

  @spec max_integer() :: non_neg_integer()
  def max_integer, do: @uint64_max

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
    delegation_bytes(
      d.replica,
      d.issuer,
      d.audience,
      d.parent_id,
      d.ops,
      d.roles,
      d.live,
      Map.get(d, :expires_epoch)
    )
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
      sort_names(ops),
      sort_names(roles),
      live
    ])
  end

  @doc """
  Delegation bytes with an optional lease (plan 149). A `nil` lease delegates to
  the 7-arity v2 arm, so every unleased delegation keeps its existing bytes,
  id, and signature verbatim; a set `expires_epoch` emits the
  `lattice-delegation-v3` tag with the epoch as the final element.
  """
  @spec delegation_bytes(
          String.t(),
          Lattice.Identity.pubkey(),
          Lattice.Identity.pubkey(),
          String.t() | nil,
          Enumerable.t(),
          Enumerable.t(),
          boolean(),
          non_neg_integer() | nil
        ) :: binary()
  def delegation_bytes(replica, issuer, audience, parent_id, ops, roles, live, nil) do
    delegation_bytes(replica, issuer, audience, parent_id, ops, roles, live)
  end

  def delegation_bytes(replica, issuer, audience, parent_id, ops, roles, live, expires_epoch)
      when is_integer(expires_epoch) and expires_epoch >= 0 do
    term([
      @delegation_v3_tag,
      replica,
      issuer,
      audience,
      parent_id,
      sort_names(ops),
      sort_names(roles),
      live,
      expires_epoch
    ])
  end

  @spec term(term()) :: binary()
  def term(value), do: encode(value)

  @doc "The name an atom or `Lattice.Canonical.Atom` encodes as."
  @spec atom_name(atom() | Lattice.Canonical.Atom.t()) :: String.t()
  def atom_name(atom) when is_atom(atom), do: Atom.to_string(atom)
  def atom_name(%Lattice.Canonical.Atom{name: name}) when is_binary(name), do: name

  # Delegation ops and roles keep Erlang term order, except that a `Lattice.Canonical.Atom`
  # ranks as the atom it names, so a VM lacking that atom produces the same bytes (row 190).
  # Atoms compare by name in term order, so the key changes nothing for atom-only sets.
  defp sort_names(names), do: Enum.sort_by(names, &term_order_key/1)

  defp term_order_key(value) when is_number(value), do: {0, value}
  defp term_order_key(value) when is_atom(value), do: {1, Atom.to_string(value)}
  defp term_order_key(%Lattice.Canonical.Atom{name: name}) when is_binary(name), do: {1, name}
  defp term_order_key(value), do: {2, value}

  @spec signable?(term()) :: boolean()
  def signable?(value) do
    _bytes = encode(value)
    true
  rescue
    ArgumentError -> false
  end

  defp encode(nil), do: <<0xF6>>
  defp encode(false), do: <<0xF4>>
  defp encode(true), do: <<0xF5>>

  defp encode(int) when is_integer(int) and int >= 0 and int <= @uint64_max,
    do: major(0, int)

  defp encode(int) when is_integer(int),
    do: raise(ArgumentError, "unsupported canonical integer: #{inspect(int)}")

  defp encode(bin) when is_binary(bin), do: major(2, byte_size(bin)) <> bin
  defp encode(atom) when is_atom(atom), do: encode_tagged(@atom_tag, Atom.to_string(atom))

  defp encode(list) when is_list(list) do
    list |> Enum.map(&encode/1) |> encode_array_bytes()
  end

  defp encode(tuple) when is_tuple(tuple) do
    tuple |> Tuple.to_list() |> then(&encode_tagged(@tuple_tag, &1))
  end

  defp encode(%MapSet{} = set) do
    elements =
      set
      |> MapSet.to_list()
      |> Enum.map(&encode/1)
      |> Enum.sort()

    if Enum.uniq(elements) != elements do
      raise ArgumentError, "duplicate canonical mapset element"
    end

    major(6, @mapset_tag) <> encode_array_bytes(elements)
  end

  defp encode(%{__struct__: Lattice.Authority.Delegation} = delegation)
       when not is_map_key(delegation, :expires_epoch) do
    encode_tagged(@delegation_term_tag, delegation_term_fields(delegation))
  end

  defp encode(%Lattice.Authority.Delegation{expires_epoch: nil} = delegation) do
    encode_tagged(@delegation_term_tag, delegation_term_fields(delegation))
  end

  defp encode(%Lattice.Authority.Delegation{expires_epoch: expires_epoch} = delegation)
       when is_integer(expires_epoch) and expires_epoch >= 0 do
    encode_tagged(
      @delegation_term_tag,
      delegation_term_fields(delegation) ++ [expires_epoch]
    )
  end

  defp encode(%Lattice.Authority.Delegation{expires_epoch: expires_epoch}) do
    raise ArgumentError,
          "delegation expires_epoch must be a non-negative integer or nil, got: #{inspect(expires_epoch)}"
  end

  defp encode(%Lattice.Canonical.Atom{name: name}) when is_binary(name),
    do: encode_tagged(@atom_tag, name)

  defp encode(%{__struct__: _} = other) do
    raise ArgumentError, "unsupported canonical term: #{inspect(other)}"
  end

  defp encode(map) when is_map(map) do
    pairs =
      map
      |> Enum.map(fn {k, v} -> {encode(k), encode(v)} end)
      |> Enum.sort_by(fn {k, _v} -> k end)

    keys = Enum.map(pairs, fn {key, _value} -> key end)

    if Enum.uniq(keys) != keys do
      raise ArgumentError, "duplicate canonical map key"
    end

    major(5, length(pairs)) <> IO.iodata_to_binary(Enum.map(pairs, fn {k, v} -> k <> v end))
  end

  defp encode(other) do
    raise ArgumentError, "unsupported canonical term: #{inspect(other)}"
  end

  defp encode_tagged(tag, value), do: major(6, tag) <> encode(value)

  defp delegation_term_fields(delegation) do
    [
      delegation.id,
      delegation.replica,
      delegation.issuer,
      delegation.audience,
      delegation.parent_id,
      sort_names(delegation.ops),
      sort_names(delegation.roles),
      delegation.live,
      delegation.sig
    ]
  end

  defp encode_array_bytes(elements) do
    major(4, length(elements)) <> IO.iodata_to_binary(elements)
  end

  defp major(major, n) when n < 24, do: <<major::3, n::5>>
  defp major(major, n) when n < 256, do: <<major::3, 24::5, n>>
  defp major(major, n) when n < 65_536, do: <<major::3, 25::5, n::16>>
  defp major(major, n) when n < 4_294_967_296, do: <<major::3, 26::5, n::32>>
  defp major(major, n) when n <= @uint64_max, do: <<major::3, 27::5, n::64>>
end
