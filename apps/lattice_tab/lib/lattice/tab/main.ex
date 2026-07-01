defmodule Lattice.Tab.Main do
  @moduledoc "AtomVM packbeam entry point. Boots the in-tab realm."
  @spec start() :: no_return()
  def start, do: Lattice.Tab.Realm.run()
end
