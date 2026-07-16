defmodule Township.Election.Link do
  @moduledoc """
  Verified binding between an immutable election spec and one honored Matter op.

  Callers must name the link op explicitly. This type deliberately has no notion
  of a current or winning election link.
  """

  @enforce_keys [:election_id, :spec_digest, :matter_replica_id, :matter_link_op_id]
  defstruct [:election_id, :spec_digest, :matter_replica_id, :matter_link_op_id]

  @type t :: %__MODULE__{
          election_id: String.t(),
          spec_digest: String.t(),
          matter_replica_id: String.t(),
          matter_link_op_id: String.t()
        }
end
