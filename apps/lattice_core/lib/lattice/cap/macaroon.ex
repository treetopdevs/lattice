defmodule Lattice.Cap.Macaroon do
  @moduledoc """
  Macaroon-style presentation for Lattice capabilities.

  The runtime authority remains server-side in `Lattice.CapStore`; this module
  gives demos and graph exports a concrete caveat-bearing, attenuable token
  shape without pretending to be a production macaroon implementation.
  """

  alias Lattice.Cap

  def mint(%Cap{} = cap) do
    %{
      id: cap.id,
      root_id: cap.root_id,
      parent_id: cap.parent_id,
      owner_tab_id: cap.owner_tab_id,
      caveats: Enum.map(cap.caveats, &Lattice.Cap.Caveat.external/1),
      provenance: cap.provenance,
      signature: signature(cap)
    }
  end

  def verify(%Cap{} = cap, %{signature: signature}), do: signature == signature(cap)
  def verify(%Cap{} = cap, %{"signature" => signature}), do: signature == signature(cap)

  def signature(%Cap{} = cap) do
    :crypto.hash(
      :sha256,
      :erlang.term_to_binary({cap.id, cap.root_id, cap.caveats, cap.provenance})
    )
    |> Base.url_encode64(padding: false)
  end
end
