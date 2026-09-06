defmodule Treehouse.TransportCatalog do
  @moduledoc "Closed Treehouse transport-catalog bytes and signatures; not semantic authority."

  @spec verify_catalog(term(), binary()) :: :ok | {:error, atom()}
  def verify_catalog(_envelope, _trusted_key), do: {:error, :malformed_catalog}
end
