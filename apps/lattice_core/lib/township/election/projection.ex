defmodule Township.Election.Projection do
  @moduledoc """
  Deterministic public result of foundation election replay.

  While the construction profile is unselected, every valid projection remains
  in `:setup`, has no close id, and cannot carry a final result.
  """

  @enforce_keys [
    :election_id,
    :phase,
    :status,
    :close_id,
    :rejected,
    :faults,
    :claim_set_id
  ]
  defstruct @enforce_keys

  @type status ::
          {:pending, [term()]}
          | {:invalid, [map()]}
          | {:forked, [map()]}
          | {:aborted, term()}
          | {:final, term()}

  @type t :: %__MODULE__{
          election_id: String.t() | nil,
          phase: :setup,
          status: status(),
          close_id: nil,
          rejected: [map()],
          faults: [map()],
          claim_set_id: String.t()
        }

  @spec to_canonical_term(t()) :: map()
  def to_canonical_term(%__MODULE__{} = projection) do
    %{
      "election_id" => projection.election_id,
      "phase" => projection.phase,
      "status" => projection.status,
      "close_id" => projection.close_id,
      "rejected" => projection.rejected,
      "faults" => projection.faults,
      "claim_set_id" => projection.claim_set_id
    }
  end
end
