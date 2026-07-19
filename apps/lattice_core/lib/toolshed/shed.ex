defmodule Toolshed.Shed do
  @moduledoc """
  One neighborhood shed — the Toolshed membership/inventory Replica (PD-003).

  The shed holds who belongs and what is listed; each listed tool is its own
  `Toolshed.Tool` Replica, referenced here by replica id. Admission is a Cap
  granted by an existing neighbor — an attenuated, TTL'd invite (a plan-149
  lease), typically handed over in person. No signup, no registry: an identity
  with no invite Cap cannot vouch itself in, and a lapsed invite stops
  admitting with a visible `:lease_expired` quarantine.

  The one authority field is the steward's bulletin: the shed steward role is
  a transferable Cap (the founder moves away, stewardship transfers in one op,
  their later stale bulletin quarantines), and the module-level `succession`
  documents the dormancy fallback exactly as `Township.Matter` does — a real
  deployment resolves the successor per-shed at grant time.
  """

  use Lattice.Replica

  state do
    field(:name, merge: :lww, default: "")
    field(:neighbors, merge: :or_set)
    field(:inventory, merge: :or_set)
    field(:bulletin, authority: :steward, default: "")
  end

  # Convergent commands — pure reducers, absolute mutations only.
  command(:set_name, [:text], do: [{:name, {:write, text}}])
  command(:vouch_in, [:neighbor], do: [{:neighbors, {:add, neighbor}}])
  command(:drop_neighbor, [:neighbor], do: [{:neighbors, {:remove, neighbor}}])
  command(:list_tool, [:tool_replica], do: [{:inventory, {:add, tool_replica}}])
  command(:delist_tool, [:tool_replica], do: [{:inventory, {:remove, tool_replica}}])

  # Steward-only, authority-guarded.
  command(:post_bulletin, [:text], do: [{:bulletin, {:write, text}}])

  succession(:steward, to: "realm:successor", after: {:dormant_ticks, 3})
end
