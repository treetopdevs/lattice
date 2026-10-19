defmodule Treehouse.BoundedSpaceVectors do
  @moduledoc """
  Deterministic parity vector for bounded Space creation, the root continuation pin and the
  catalog bootstrap. Every key derives from a public label, so none is a real key.
  """

  alias Lattice.{Canonical, Identity, Log}
  alias Lattice.Authority.ContinuationCertificate
  alias Lattice.Carrier.Wire
  alias Treehouse.Space

  @label "lattice-bounded-space-vector-v1"
  @names ~w(root nominee w1 w2 w3 catalog service)
  @path "clients/lattice-client/test/vectors/treehouse/bounded_space_binding_v1.json"

  @spec relative_path() :: String.t()
  def relative_path, do: @path

  @spec vector() :: map()
  def vector do
    ids = Map.new(@names, &{&1, identity(&1)})
    root = ids["root"]
    witnesses = Enum.sort(for n <- ~w(w1 w2 w3), do: ids[n].pub)
    nonce_replica = "replica:treehouse:space:" <> id("space-nonce")
    name = "Canopy"

    params = %{
      nominee: ids["nominee"].pub,
      witnesses: witnesses,
      threshold: 2,
      max_lease_epochs: 7
    }

    {:ok, %{replica: replica, pending: [genesis, creation]}} =
      Space.prepare_bounded_creation(root, nonce_replica, name)

    log = Enum.reduce([genesis, creation], Log.new(replica), &Log.append!(&2, &1))
    {:ok, pin} = Space.prepare_continuation_pin(root, log, params)
    log = Log.append!(log, pin)

    {:ok, profile_id} =
      ContinuationCertificate.profile_id(%{
        mode: :bounded_continuation,
        version: 1,
        product: :treehouse,
        kind: :space,
        role: :admin,
        nominee: ids["nominee"].pub,
        witnesses: witnesses,
        threshold: 2,
        max_lease_epochs: 7
      })

    record = %{
      version: 1,
      product: :treehouse,
      space: replica,
      space_root: root.pub,
      profile_genesis: pin.id,
      profile_id: profile_id,
      replacement_rule: :bounded_space_admin_v1,
      catalog_key: ids["catalog"].pub,
      service_id: id("service"),
      service_key: ids["service"].pub,
      origin: "wss://bounded-vector-relay.invalid",
      nonce: id("bootstrap-nonce")
    }

    {:ok, bootstrap} = Space.author_catalog_bootstrap(root, log, record)
    canonical = Canonical.term(record)

    %{
      format: "lattice-bounded-space-binding-vector-v1",
      seeds: Map.new(@names, &{&1, Base.encode16(seed(&1), case: :lower)}),
      nonce_replica: nonce_replica,
      name: name,
      profile: %{threshold: 2, max_lease_epochs: 7},
      replica: replica,
      record: LatticeRecordJson.to_json(record),
      canonical_base64: Base.encode64(canonical),
      canonical_sha256: Base.encode16(:crypto.hash(:sha256, canonical), case: :lower),
      profile_id: profile_id,
      ops:
        for(
          {label, op} <- [
            genesis: genesis,
            create_space: creation,
            pin: pin,
            bootstrap: bootstrap
          ]
        ) do
          %{label: label, id: op.id, frame: Wire.encode_op(op)}
        end
    }
  end

  @spec encoded() :: binary()
  def encoded, do: Jason.encode!(sorted(vector()), pretty: true) <> "\n"

  # Atom-keyed map order depends on the VM's atom table, so every object is emitted key-sorted.
  defp sorted(%{} = map) do
    map
    |> Enum.map(fn {k, v} -> {to_string(k), sorted(v)} end)
    |> Enum.sort()
    |> Jason.OrderedObject.new()
  end

  defp sorted(list) when is_list(list), do: Enum.map(list, &sorted/1)
  defp sorted(other), do: other

  @spec write!(String.t()) :: :ok
  def write!(path), do: File.write!(path, encoded())

  defp seed(name), do: :crypto.hash(:sha256, @label <> ":" <> name)

  defp identity(name) do
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519, seed(name))
    %Identity{realm_id: name, pub: pub, priv: priv}
  end

  defp id(label),
    do: :crypto.hash(:sha256, @label <> "-" <> label) |> Base.url_encode64(padding: false)
end

defmodule LatticeRecordJson do
  @moduledoc false
  @base64 ~w(space_root catalog_key service_key)a
  @atoms ~w(product replacement_rule)a

  def to_json(record) do
    Map.new(record, fn {key, value} ->
      cond do
        key in @base64 -> {Atom.to_string(key), Base.encode64(value)}
        key in @atoms -> {Atom.to_string(key), Atom.to_string(value)}
        true -> {Atom.to_string(key), value}
      end
    end)
  end
end
