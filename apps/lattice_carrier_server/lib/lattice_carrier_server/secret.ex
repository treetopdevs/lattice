defmodule LatticeCarrierServer.Secret do
  @moduledoc """
  Opaque wrapper for secret terms such as the carrier service identity.

  Supervisor child specifications, crash reports, and inspected process
  arguments render this wrapper as an opaque token, so private key material
  never appears in logs or error output. The wrapped value is reachable only
  through `unwrap/1` inside the process that owns it.
  """

  @enforce_keys [:fetch]
  defstruct [:fetch]

  @opaque t :: %__MODULE__{fetch: (-> term())}

  @doc "Wrap a secret term in an opaque, redacted container."
  @spec wrap(term()) :: t()
  def wrap(value), do: %__MODULE__{fetch: fn -> value end}

  @doc "Recover the wrapped secret term."
  @spec unwrap(t()) :: term()
  def unwrap(%__MODULE__{fetch: fetch}), do: fetch.()

  defimpl Inspect do
    def inspect(_secret, _opts), do: "#LatticeCarrierServer.Secret<redacted>"
  end
end
