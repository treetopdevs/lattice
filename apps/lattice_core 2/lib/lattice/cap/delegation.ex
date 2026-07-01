defmodule Lattice.Cap.Delegation do
  @moduledoc """
  Public helper for delegating caps through monotonic attenuation.
  """

  alias Lattice.Cap.Attenuation

  defdelegate derive(parent, child_owner_tab_id, opts), to: Attenuation
end
