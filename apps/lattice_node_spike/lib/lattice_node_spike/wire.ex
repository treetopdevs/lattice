defmodule LatticeNodeSpike.Wire do
  @moduledoc false

  alias Lattice.Carrier.Wire

  defdelegate encode(op), to: Wire, as: :encode_op
  defdelegate decode(encoded), to: Wire, as: :decode_op
  defdelegate decode_all(encoded), to: Wire, as: :decode_ops
end
