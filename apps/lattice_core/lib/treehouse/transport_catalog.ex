defmodule Treehouse.TransportCatalog do
  @moduledoc "Closed Treehouse transport-catalog bytes and signatures; not semantic authority."

  alias Lattice.{Canonical, Identity}
  alias Lattice.Authority.ContinuationCertificate
  alias Lattice.Carrier.Wire

  @catalog_fields ~w(version product space bootstrap binding revision previous entries)a
  @entry_fields ~w(product replica kind schema root genesis creation reference route service_id service_key)a
  @rotation_fields ~w(version product space bootstrap parent prior_catalog generation new_catalog_key nonce inventory_digest cutoffs)a
  @max_artifact_bytes 131_072

  @spec verify_rotation(term(), binary()) :: :ok | {:error, atom()}
  def verify_rotation(envelope, trusted_key) do
    with true <- fields?(envelope, [:rotation, :old_signature, :new_signature]),
         true <- bytes?(envelope.old_signature, 64) and bytes?(envelope.new_signature, 64) and bytes?(trusted_key, 32),
         {:ok, rotation} <- normalize_rotation(envelope.rotation) do
      if trusted_key != rotation.new_catalog_key and
           Identity.verify(trusted_key, rotation_bytes(rotation), envelope.old_signature) and
           Identity.verify(rotation.new_catalog_key, rotation_possession_bytes(rotation), envelope.new_signature),
        do: :ok,
        else: {:error, :invalid_rotation_signature}
    else
      _ -> {:error, :malformed_catalog}
    end
  end

  @spec normalize_rotation(term()) :: {:ok, map()} | {:error, :malformed_catalog}
  def normalize_rotation(value) do
    if fields?(value, @rotation_fields) and value.version == 1 and value.product == :treehouse and
         text?(value.space) and id?(value.bootstrap) and id?(value.parent) and id?(value.prior_catalog) and
         integer?(value.generation) and value.generation > 0 and bytes?(value.new_catalog_key, 32) and
         id?(value.nonce) and id?(value.inventory_digest) and cutoffs?(value.cutoffs),
      do: {:ok, value}, else: {:error, :malformed_catalog}
  end

  @spec rotation_bytes(term()) :: binary()
  def rotation_bytes(value),
    do: Canonical.term(["lattice-treehouse-catalog-rotation-v1", require_value(normalize_rotation(value))])

  @spec rotation_possession_bytes(term()) :: binary()
  def rotation_possession_bytes(value),
    do: Canonical.term(["lattice-treehouse-transport-possession-v1", :catalog, require_value(normalize_rotation(value))])

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
      bytes = Canonical.term(["lattice-treehouse-transport-catalog-v1", catalog])

      if Identity.verify(trusted_key, bytes, signature),
        do: :ok,
        else: {:error, :invalid_catalog_signature}
    else
      _ -> {:error, :malformed_catalog}
    end
  end

  def verify_catalog(_envelope, _trusted_key), do: {:error, :malformed_catalog}

  defp decode_artifact(bytes) when is_binary(bytes) and byte_size(bytes) > @max_artifact_bytes,
    do: {:error, :control_history_limit}

  defp decode_artifact(bytes) when is_binary(bytes) do
    with {:ok, raw} <- Jason.decode(bytes),
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
    do: Regex.match?(~r/^(0|[1-9][0-9]*)$/, value)

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
    do: fields?(value, [:replica, :frontier, :log_digest]) and text?(value.replica) and
      id?(value.log_digest) and is_list(value.frontier) and Enum.all?(value.frontier, &id?/1) and
      ordered_unique?(value.frontier)

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
end
