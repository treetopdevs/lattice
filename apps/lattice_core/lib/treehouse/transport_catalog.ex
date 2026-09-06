defmodule Treehouse.TransportCatalog do
  @moduledoc "Closed Treehouse transport-catalog bytes and signatures; not semantic authority."

  alias Lattice.{Canonical, Identity}

  @spec verify_catalog(term(), binary()) :: :ok | {:error, atom()}
  def verify_catalog(%{catalog: catalog, signature: signature}, trusted_key) do
    bytes = Canonical.term(["lattice-treehouse-transport-catalog-v1", catalog])

    if Identity.verify(trusted_key, bytes, signature),
      do: :ok,
      else: {:error, :invalid_catalog_signature}
  end

  def verify_catalog(_envelope, _trusted_key), do: {:error, :malformed_catalog}
end
