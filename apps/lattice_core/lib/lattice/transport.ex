defmodule Lattice.Transport do
  @moduledoc """
  Transport behaviour for tab realms.

  Transports are not authority boundaries by themselves. They only carry safe
  envelopes to and from a tab. All tab-originated work must still pass through
  `Lattice.Gateway`.
  """

  @callback deliver_call(pid(), map(), timeout()) :: {:ok, term()} | {:error, term()}
  @callback deliver_cast(pid(), map()) :: :ok | {:error, term()}
end
