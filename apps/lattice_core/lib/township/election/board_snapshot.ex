defmodule Township.Election.BoardSnapshot do
  @moduledoc """
  Untrusted inputs needed for one pure foundation projection.

  Callers may build this value, but `Township.Election.project/3` re-verifies the
  Matter link, board root, log structure, and authority on every call.
  """

  alias Lattice.Log

  @enforce_keys [:matter_log, :matter_link_op_id, :board_log, :max_artifact_byte_size]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          matter_log: Log.t(),
          matter_link_op_id: String.t(),
          board_log: Log.t(),
          max_artifact_byte_size: pos_integer()
        }
end
