defmodule Township.Election.SecurityProfile do
  @moduledoc """
  Versioned, reviewable security manifest for the election foundation.

  `research/0` is deliberately an unselected profile: it records the complete
  claim vocabulary while making every property an explicit non-claim. It cannot
  become stronger through a boolean feature flag.
  """

  alias Lattice.Canonical
  alias Township.Election.SecurityProfile.Claim

  @claim_set_domain "township-election-claim-set-v1"
  @profile_id "township-election-research-unselected-v1"

  @scopes %{
    board_integrity: "authorized immutable board publication",
    convergence: "deterministic projection from a complete artifact set",
    universal_verifiability: "public verification of the final result transcript",
    eligibility: "encrypted credential eligibility and duplicate handling",
    ballot_privacy: "choice confidentiality beyond the ideal tally leakage",
    receipt_freeness: "inability to prove a vote to a coercer",
    credential_surrender_resistance: "safety after credential surrender",
    forced_choice_resistance: "safety under a demanded choice",
    forced_abstention_resistance: "safety under participation surveillance",
    closure_safety: "uniqueness and completeness of the certified ballot manifest",
    censorship_resistance: "resistance to selective ballot denial",
    availability: "ability to complete setup, close, and tally"
  }

  @enforce_keys [
    :profile_id,
    :construction,
    :implementation_status,
    :theorem_reference,
    :ideal_leakage,
    :claims
  ]
  defstruct @enforce_keys

  @type construction :: %{
          status: :unselected,
          paper: nil,
          version: nil,
          parameters_digest: nil
        }

  @type t :: %__MODULE__{
          profile_id: String.t(),
          construction: construction(),
          implementation_status: :research | :experimental | :independently_reviewed,
          theorem_reference: String.t() | nil,
          ideal_leakage: [atom()],
          claims: %{required(atom()) => Claim.t()}
        }

  @spec research() :: t()
  def research do
    claims =
      Map.new(@scopes, fn {name, scope} ->
        {name,
         %Claim{
           status: :not_claimed,
           assumptions: [],
           scope: scope,
           exclusions: [
             "no pinned cryptographic construction",
             "no completed operational composition review"
           ],
           evidence: []
         }}
      end)

    %__MODULE__{
      profile_id: @profile_id,
      construction: %{
        status: :unselected,
        paper: nil,
        version: nil,
        parameters_digest: nil
      },
      implementation_status: :research,
      theorem_reference: nil,
      ideal_leakage: [:final_result, :ballot_count, :removed_count],
      claims: claims
    }
  end

  @doc "ID of the module-owned reviewed research manifest."
  @spec claim_set_id() :: String.t()
  def claim_set_id do
    [@claim_set_domain, to_canonical_term(research())]
    |> Canonical.term()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.url_encode64(padding: false)
  end

  @spec to_canonical_term(t()) :: map()
  def to_canonical_term(%__MODULE__{} = profile) do
    %{
      "profile_id" => profile.profile_id,
      "construction" => %{
        "status" => profile.construction.status,
        "paper" => profile.construction.paper,
        "version" => profile.construction.version,
        "parameters_digest" => profile.construction.parameters_digest
      },
      "implementation_status" => profile.implementation_status,
      "theorem_reference" => profile.theorem_reference,
      "ideal_leakage" => profile.ideal_leakage,
      "claims" =>
        Map.new(profile.claims, fn {name, claim} ->
          {Atom.to_string(name), Claim.to_canonical_term(claim)}
        end)
    }
  end
end
