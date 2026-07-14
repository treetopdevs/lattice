defmodule Township.Election.VerifiedElection do
  @moduledoc """
  Opaque input accepted by a future pinned election protocol.

  The research foundation deliberately exposes no constructor. A later profile
  may create this value only after verifying the Matter link, setup certificate,
  election public key, choice domain, and roster commitment. Merely possessing
  an `Election.Spec` is not a verified election context.
  """

  alias Township.Election.{Link, ProfileRef}

  @enforce_keys [
    :link,
    :election_id,
    :profile,
    :choice_domain,
    :election_public_key,
    :setup_certificate,
    :roster_commitment
  ]
  defstruct @enforce_keys

  @opaque t :: %__MODULE__{
            link: Link.t(),
            election_id: String.t(),
            profile: ProfileRef.t(),
            choice_domain: [term()],
            election_public_key: binary(),
            setup_certificate: term(),
            roster_commitment: binary()
          }
end
