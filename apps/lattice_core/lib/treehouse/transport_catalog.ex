defmodule Treehouse.TransportCatalog do
  @moduledoc "Closed Treehouse transport-catalog bytes and signatures; not semantic authority."

  alias Lattice.{Canonical, Identity}
  alias Lattice.Authority.ContinuationCertificate
  alias Lattice.Carrier.{Uint64, Wire}

  @catalog_fields ~w(version product space bootstrap binding revision previous entries)a
  @entry_fields ~w(product replica kind schema root genesis creation reference route service_id service_key)a
  @rotation_fields ~w(version product space bootstrap parent prior_catalog generation new_catalog_key nonce inventory_digest cutoffs)a
  @bootstrap_fields ~w(version product space space_root profile_genesis profile_id replacement_rule catalog_key service_id service_key origin nonce)a
  @replacement_fields ~w(version product space bootstrap profile_genesis profile_id parents prior_catalogs generation nonce new_catalog_key new_service_id new_service_key new_origin inventory_digest cutoffs author cap holder_epoch deps epoch epoch_basis)a
  @replacement_purposes [:catalog, :service]
  @max_artifact_bytes 131_072

  @spec normalize_bootstrap(term()) :: {:ok, map()} | {:error, :malformed_catalog}
  def normalize_bootstrap(value) do
    if fields?(value, @bootstrap_fields) and value.version == 1 and value.product == :treehouse and
         text?(value.space) and bytes?(value.space_root, 32) and id?(value.profile_genesis) and
         id?(value.profile_id) and value.replacement_rule == :bounded_space_admin_v1 and
         bytes?(value.catalog_key, 32) and bytes?(value.service_key, 32) and
         value.catalog_key != value.service_key and id?(value.service_id) and id?(value.nonce) and
         origin?(value.origin), do: {:ok, value}, else: {:error, :malformed_catalog}
  end

  @spec verify_rotation(term(), binary()) :: :ok | {:error, atom()}
  def verify_rotation(envelope, trusted_key) do
    with true <- fields?(envelope, [:rotation, :old_signature, :new_signature]),
         true <-
           bytes?(envelope.old_signature, 64) and bytes?(envelope.new_signature, 64) and
             bytes?(trusted_key, 32),
         {:ok, rotation} <- normalize_rotation(envelope.rotation) do
      if trusted_key != rotation.new_catalog_key and
           Identity.verify(trusted_key, rotation_bytes(rotation), envelope.old_signature) and
           Identity.verify(
             rotation.new_catalog_key,
             rotation_possession_bytes(rotation),
             envelope.new_signature
           ),
         do: :ok,
         else: {:error, :invalid_rotation_signature}
    else
      _ -> {:error, :malformed_catalog}
    end
  end

  @spec normalize_rotation(term()) :: {:ok, map()} | {:error, :malformed_catalog}
  def normalize_rotation(value) do
    if fields?(value, @rotation_fields) and value.version == 1 and value.product == :treehouse and
         text?(value.space) and id?(value.bootstrap) and id?(value.parent) and
         id?(value.prior_catalog) and
         integer?(value.generation) and value.generation > 0 and bytes?(value.new_catalog_key, 32) and
         id?(value.nonce) and id?(value.inventory_digest) and cutoffs?(value.cutoffs),
       do: {:ok, value},
       else: {:error, :malformed_catalog}
  end

  @spec rotation_bytes(term()) :: binary()
  def rotation_bytes(value),
    do:
      Canonical.term([
        "lattice-treehouse-catalog-rotation-v1",
        require_value(normalize_rotation(value))
      ])

  @spec rotation_possession_bytes(term()) :: binary()
  def rotation_possession_bytes(value),
    do:
      Canonical.term([
        "lattice-treehouse-transport-possession-v1",
        :catalog,
        require_value(normalize_rotation(value))
      ])

  @spec rotation_id(term()) :: String.t()
  def rotation_id(envelope) do
    if fields?(envelope, [:rotation, :old_signature, :new_signature]) and
         bytes?(envelope.old_signature, 64) and bytes?(envelope.new_signature, 64) do
      require_value(normalize_rotation(envelope.rotation))
      digest(Canonical.term(["lattice-treehouse-catalog-rotation-v1", envelope]))
    else
      raise ArgumentError, "malformed catalog rotation"
    end
  end

  @doc """
  Closed `replace_catalog_v1` claim shape (lifecycle §3). Structural only: the generation
  relation, profile, lease, epoch and declared graph are the resolver's (plan 316 stage B).
  """
  @spec normalize_replacement_claim(term()) :: {:ok, map()} | {:error, :malformed_catalog}
  def normalize_replacement_claim(value) do
    if fields?(value, @replacement_fields) and replacement_scope?(value) and
         replacement_graph?(value) and replacement_binding?(value) and
         replacement_op_binding?(value),
       do: {:ok, value},
       else: {:error, :malformed_catalog}
  end

  defp replacement_scope?(value),
    do:
      value.version === 1 and value.product == :treehouse and text?(value.space) and
        id?(value.bootstrap) and id?(value.profile_genesis) and id?(value.profile_id)

  defp replacement_graph?(value),
    do:
      ids?(value.parents, 16) and prior_catalogs?(value.prior_catalogs, value.parents) and
        integer?(value.generation) and value.generation > 0 and id?(value.nonce)

  defp replacement_binding?(value),
    do:
      bytes?(value.new_catalog_key, 32) and bytes?(value.new_service_key, 32) and
        value.new_catalog_key != value.new_service_key and id?(value.new_service_id) and
        origin?(value.new_origin) and id?(value.inventory_digest) and cutoffs?(value.cutoffs)

  defp replacement_op_binding?(value),
    do:
      bytes?(value.author, 32) and id?(value.cap) and id?(value.holder_epoch) and
        ids?(value.deps, 64) and integer?(value.epoch) and ids?(value.epoch_basis, 64)

  @doc "Pre-hash and debug bytes for vectors only; not a signing domain."
  @spec replacement_claim_bytes(term()) :: binary()
  def replacement_claim_bytes(value),
    do:
      Canonical.term([
        "lattice-treehouse-catalog-replacement-claim-v1",
        require_value(normalize_replacement_claim(value))
      ])

  @spec replacement_possession_bytes(:catalog | :service, term()) :: binary()
  def replacement_possession_bytes(purpose, value) when purpose in @replacement_purposes,
    do:
      Canonical.term([
        "lattice-treehouse-transport-possession-v1",
        purpose,
        require_value(normalize_replacement_claim(value))
      ])

  def replacement_possession_bytes(_purpose, _value),
    do: raise(ArgumentError, "malformed possession purpose")

  @doc "Both new-key possession signatures; proves key control, not authority or custody."
  @spec verify_replacement_possession(term(), term(), term()) ::
          :ok | {:error, :malformed_catalog | :invalid_possession}
  def verify_replacement_possession(claim, catalog_signature, service_signature) do
    with {:ok, claim} <- normalize_replacement_claim(claim),
         true <- bytes?(catalog_signature, 64) and bytes?(service_signature, 64) do
      if Identity.verify(
           claim.new_catalog_key,
           replacement_possession_bytes(:catalog, claim),
           catalog_signature
         ) and
           Identity.verify(
             claim.new_service_key,
             replacement_possession_bytes(:service, claim),
             service_signature
           ),
         do: :ok,
         else: {:error, :invalid_possession}
    else
      _ -> {:error, :malformed_catalog}
    end
  end

  @spec verify_catalog_json(binary(), binary()) :: :ok | {:error, atom()}
  def verify_catalog_json(bytes, trusted_key) do
    with {:ok, envelope} <- decode_catalog_json(bytes), do: verify_catalog(envelope, trusted_key)
  end

  @spec decode_catalog_json(binary()) :: {:ok, map()} | {:error, atom()}
  def decode_catalog_json(bytes) do
    with {:ok, envelope} <- decode_artifact(bytes),
         true <- fields?(envelope, [:catalog, :signature]) and bytes?(envelope.signature, 64),
         {:ok, _} <- normalize_catalog(envelope.catalog) do
      {:ok, envelope}
    else
      {:error, :control_history_limit} = error -> error
      _ -> {:error, :malformed_catalog}
    end
  end

  @spec normalize_catalog(term()) :: {:ok, map()} | {:error, :malformed_catalog}
  def normalize_catalog(value) do
    if fields?(value, @catalog_fields) and value.version == 1 and value.product == :treehouse and
         text?(value.space) and id?(value.bootstrap) and id?(value.binding) and
         integer?(value.revision) and previous?(value.revision, value.previous) and
         entries?(value.entries) and catalog_consistent?(value),
       do: {:ok, value},
       else: {:error, :malformed_catalog}
  end

  @spec verify_catalog(term(), binary()) :: :ok | {:error, atom()}
  def verify_catalog(%{catalog: catalog, signature: signature} = envelope, trusted_key) do
    with true <- map_size(envelope) == 2 and bytes?(signature, 64) and bytes?(trusted_key, 32),
         {:ok, catalog} <- normalize_catalog(catalog) do
      bytes = catalog_bytes(catalog)

      if Identity.verify(trusted_key, bytes, signature),
        do: :ok,
        else: {:error, :invalid_catalog_signature}
    else
      _ -> {:error, :malformed_catalog}
    end
  end

  def verify_catalog(_envelope, _trusted_key), do: {:error, :malformed_catalog}

  @spec catalog_bytes(term()) :: binary()
  def catalog_bytes(value),
    do:
      Canonical.term([
        "lattice-treehouse-transport-catalog-v1",
        require_value(normalize_catalog(value))
      ])

  @spec catalog_id(term()) :: String.t()
  def catalog_id(value), do: digest(catalog_bytes(value))

  @spec inventory_bytes(term()) :: binary()
  def inventory_bytes(entries) do
    if entries?(entries),
      do: Canonical.term(["lattice-treehouse-route-inventory-v1", entries]),
      else: raise(ArgumentError, "malformed catalog inventory")
  end

  @spec inventory_id(term()) :: String.t()
  def inventory_id(entries), do: digest(inventory_bytes(entries))

  @spec service_realm(term()) :: String.t()
  def service_realm(service_id) do
    if id?(service_id),
      do: "treehouse-service:" <> service_id,
      else: raise(ArgumentError, "malformed catalog service ID")
  end

  defp decode_artifact(bytes) when is_binary(bytes) and byte_size(bytes) > @max_artifact_bytes,
    do: {:error, :control_history_limit}

  defp decode_artifact(bytes) when is_binary(bytes) do
    with {:ok, raw} <- Treehouse.CatalogJSON.decode(bytes),
         true <- closed_raw_maps?(raw, 64),
         {:ok, value} <- Wire.decode_value(raw) do
      {:ok, value}
    else
      _ -> {:error, :malformed_catalog}
    end
  end

  defp decode_artifact(_), do: {:error, :malformed_catalog}

  defp closed_raw_maps?(["map", pairs], depth) when is_list(pairs) and depth > 0 do
    keys = for [["atom", key], _] <- pairs, is_binary(key), do: key

    length(keys) == length(pairs) and length(Enum.uniq(keys)) == length(keys) and
      Enum.all?(pairs, fn [_, value] -> closed_raw_maps?(value, depth - 1) end)
  end

  defp closed_raw_maps?(["list", values], depth) when is_list(values) and depth > 0,
    do: Enum.all?(values, &closed_raw_maps?(&1, depth - 1))

  defp closed_raw_maps?(["bin", encoded], _) when is_binary(encoded) do
    case Base.decode64(encoded) do
      {:ok, bytes} -> Base.encode64(bytes) == encoded
      _ -> false
    end
  end

  defp closed_raw_maps?(["int", value], _) when is_integer(value), do: integer?(value)

  defp closed_raw_maps?(["int", value], _) when is_binary(value),
    do: match?({:ok, _}, Uint64.parse_text(value))

  defp closed_raw_maps?(["atom", value], _) when is_binary(value), do: true
  defp closed_raw_maps?(["nil"], _), do: true
  defp closed_raw_maps?(_, _), do: false

  defp entries?(values) when is_list(values) and length(values) in 1..13 do
    Enum.all?(values, &entry?/1) and Enum.count(values, &(&1.kind == :space)) == 1 and
      ordered_unique?(Enum.map(values, & &1.replica)) and
      length(Enum.uniq_by(values, & &1.route)) == length(values) and
      length(Enum.uniq_by(values, &{&1.service_id, &1.service_key})) == 1
  end

  defp entries?(_), do: false

  defp catalog_consistent?(catalog) do
    space = Enum.find(catalog.entries, &(&1.kind == :space))
    space.replica == catalog.space and space.reference == catalog.bootstrap
  end

  defp entry?(value) do
    fields?(value, @entry_fields) and value.product == :treehouse and text?(value.replica) and
      {value.kind, value.schema} in [
        {:space, :treehouse_space_v1},
        {:thread, :treehouse_thread_v1}
      ] and bytes?(value.root, 32) and id?(value.genesis) and id?(value.creation) and
      id?(value.reference) and route?(value.route) and id?(value.service_id) and
      bytes?(value.service_key, 32)
  end

  defp previous?(0, nil), do: true
  defp previous?(revision, previous) when revision > 0, do: id?(previous)
  defp previous?(_, _), do: false

  defp cutoffs?(values) when is_list(values) and length(values) in 1..13,
    do: Enum.all?(values, &cutoff?/1) and ordered_unique?(Enum.map(values, & &1.replica))

  defp cutoffs?(_), do: false

  defp cutoff?(value),
    do:
      fields?(value, [:replica, :frontier, :log_digest]) and text?(value.replica) and
        id?(value.log_digest) and is_list(value.frontier) and Enum.all?(value.frontier, &id?/1) and
        ordered_unique?(value.frontier)

  defp ids?(values, max) when is_list(values),
    do: length(values) in 1..max and Enum.all?(values, &id?/1) and ordered_unique?(values)

  defp ids?(_, _), do: false

  # Sorted by {binding, catalog}; Erlang term order puts `nil` before any binary.
  defp prior_catalogs?(values, parents) when is_list(values) and length(values) in 1..32 do
    Enum.all?(values, &prior_catalog?/1) and
      ordered_unique?(Enum.map(values, &{&1.binding, &1.catalog})) and
      Enum.uniq(Enum.map(values, & &1.binding)) == parents and
      values
      |> Enum.group_by(& &1.binding, & &1.catalog)
      |> Enum.all?(fn {_, catalogs} -> nil not in catalogs or catalogs == [nil] end)
  end

  defp prior_catalogs?(_, _), do: false

  defp prior_catalog?(value),
    do:
      fields?(value, [:binding, :catalog]) and id?(value.binding) and
        (is_nil(value.catalog) or id?(value.catalog))

  defp require_value({:ok, value}), do: value
  defp require_value(_), do: raise(ArgumentError, "malformed catalog value")
  defp digest(value), do: :crypto.hash(:sha256, value) |> Base.url_encode64(padding: false)

  defp fields?(value, keys), do: is_map(value) and Enum.sort(Map.keys(value)) == Enum.sort(keys)
  defp text?(value), do: is_binary(value) and byte_size(value) > 0 and String.valid?(value)
  defp bytes?(value, count), do: is_binary(value) and byte_size(value) == count
  defp id?(value), do: ContinuationCertificate.id?(value)
  defp integer?(value), do: is_integer(value) and value >= 0 and value <= 9_007_199_254_740_991
  defp ordered_unique?(values), do: values == Enum.sort(Enum.uniq(values))
  defp route?("/r/" <> nonce), do: id?(nonce)
  defp route?(_), do: false

  defp origin?(value) when is_binary(value) do
    case Regex.run(~r/^wss:\/\/([a-z0-9.-]+)(?::([1-9][0-9]*))?$/, value) do
      [^value, host] ->
        dns_host?(host)

      [^value, host, port] ->
        dns_host?(host) and port != "443" and byte_size(port) <= 5 and
          String.to_integer(port) <= 65_535

      _ ->
        false
    end
  end

  defp origin?(_), do: false

  # WHATWG treats an ASCII numeric final label (including 0x forms) as an
  # attempted IPv4 address. Such literals/aliases are outside this DNS profile.
  defp dns_host?(host) do
    labels = String.split(host, ".")

    byte_size(host) <= 253 and
      Enum.all?(
        labels,
        &(byte_size(&1) in 1..63 and Regex.match?(~r/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, &1))
      ) and
      not Regex.match?(~r/^(?:[0-9]+|0x[0-9a-f]*)$/, List.last(labels))
  end
end
