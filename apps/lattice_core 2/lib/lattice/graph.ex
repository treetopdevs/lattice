defmodule Lattice.Graph do
  @moduledoc """
  Facade for the process graph as a trust graph.
  """

  def snapshot, do: Lattice.Graph.Snapshot.build()
  def policy, do: Lattice.Graph.Policy.check_current()
  def export(format \\ :json), do: Lattice.Graph.Export.export(snapshot(), format)
end
