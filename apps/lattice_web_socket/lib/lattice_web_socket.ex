defmodule LatticeWebSocket do
  @moduledoc """
  Reusable WebSocket transport client and real `Lattice.Carrier` adapter.

  The app owns `Lattice.Transport.WebSocket.Client`, its JSON envelope codec,
  and `Lattice.Carrier.WebSocket`. The carrier namespace is shared deliberately:
  its transport-independent behaviour and helpers remain in `lattice_core`,
  while this app owns the WebSocket implementation.
  """
end
