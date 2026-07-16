defmodule Township.Election.CloseEvidence do
  @moduledoc """
  Verified unanimous-close evidence under an explicitly asserted open proposal.

  This value is not global election finality and never advances the public
  foundation projection beyond `:setup`.
  """

  @enforce_keys [
    :election_id,
    :open_certificate_id,
    :manifest_digest,
    :ballot_wrapper_ids,
    :ballot_digests,
    :seal_digests,
    :certificate_op_ids,
    :prerequisite,
    :rejected
  ]
  defstruct @enforce_keys

  @type t :: %__MODULE__{
          election_id: String.t(),
          open_certificate_id: String.t(),
          manifest_digest: String.t(),
          ballot_wrapper_ids: [String.t()],
          ballot_digests: [String.t()],
          seal_digests: [String.t()],
          certificate_op_ids: [String.t()],
          prerequisite: :administrative_open_asserted,
          rejected: [map()]
        }
end
