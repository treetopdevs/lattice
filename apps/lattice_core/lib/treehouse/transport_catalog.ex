defmodule Treehouse.TransportCatalog do
  @moduledoc "Closed Treehouse transport-catalog bytes and signatures; not semantic authority."

  alias Lattice.{Canonical, Identity}
  alias Lattice.Authority.ContinuationCertificate

  @catalog_fields ~w(version product space bootstrap binding revision previous entries)a
  @entry_fields ~w(product replica kind schema root genesis creation reference route service_id service_key)a

  @spec normalize_catalog(term()) :: {:ok, map()} | {:error, :malformed_catalog}
  def normalize_catalog(value) do
    if fields?(value, @catalog_fields) and value.version == 1 and value.product == :treehouse and
         text?(value.space) and id?(value.bootstrap) and id?(value.binding) and
         integer?(value.revision) and previous?(value.revision, value.previous) and
         entries?(value.entries),
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

  defp entries?(values) when is_list(values) and length(values) in 1..13 do
    Enum.all?(values, &entry?/1) and Enum.count(values, &(&1.kind == :space)) == 1 and
      ordered_unique?(Enum.map(values, & &1.replica)) and
      length(Enum.uniq_by(values, & &1.route)) == length(values)
  end

  defp entries?(_), do: false

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

  defp fields?(value, keys), do: is_map(value) and Enum.sort(Map.keys(value)) == Enum.sort(keys)
  defp text?(value), do: is_binary(value) and byte_size(value) > 0 and String.valid?(value)
  defp bytes?(value, count), do: is_binary(value) and byte_size(value) == count
  defp id?(value), do: ContinuationCertificate.id?(value)
  defp integer?(value), do: is_integer(value) and value >= 0 and value <= 9_007_199_254_740_991
  defp ordered_unique?(values), do: values == Enum.sort(Enum.uniq(values))
  defp route?("/r/" <> nonce), do: id?(nonce)
  defp route?(_), do: false
end
