defmodule Township.Election.Replay do
  @moduledoc """
  One partial replay of an election foundation.

  A successful replay carries the projection and the verified board detail.
  The projection stays in setup. `Township.Election.replay/3` reports failure
  as `{:error, reason}` and does not build this struct.
  """

  alias Lattice.Log
  alias Township.Election.{Link, Projection, Spec}

  @enforce_keys [
    :projection,
    :spec,
    :link,
    :safe_log,
    :commands,
    :artifact_records,
    :requirements,
    :findings,
    :rejected
  ]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          projection: Projection.t(),
          spec: Spec.t(),
          link: Link.t(),
          safe_log: Log.t(),
          commands: [{term(), atom(), list()}],
          artifact_records: [map()],
          requirements: [term()],
          findings: [map()],
          rejected: [map()]
        }
end
