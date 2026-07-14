defmodule Township.Election.SecurityProfile.Claim do
  @moduledoc """
  One explicit security claim, including the limits that keep it honest.
  """

  @enforce_keys [:status, :assumptions, :scope, :exclusions, :evidence]
  defstruct @enforce_keys

  @type status :: :not_claimed | :conditional | :failed
  @type t :: %__MODULE__{
          status: status(),
          assumptions: [String.t()],
          scope: String.t(),
          exclusions: [String.t()],
          evidence: [String.t()]
        }

  @spec to_canonical_term(t()) :: map()
  def to_canonical_term(%__MODULE__{} = claim) do
    %{
      "status" => claim.status,
      "assumptions" => claim.assumptions,
      "scope" => claim.scope,
      "exclusions" => claim.exclusions,
      "evidence" => claim.evidence
    }
  end
end
