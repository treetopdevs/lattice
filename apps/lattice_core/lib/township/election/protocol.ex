defmodule Township.Election.Protocol do
  @moduledoc """
  Construction-independent contract for a future pinned election profile.

  This behavior is intentionally a type boundary only. The repository does not
  ship an implementation, voter dispatch function, credential type, or entropy
  source while the construction and operational security gates remain open.
  """

  alias Township.Election.VerifiedElection

  @type voter_error :: term()
  @type role_error :: term()
  @type requirement :: term()
  @type effect :: term()

  @callback prepare_ballot(
              VerifiedElection.t(),
              credential_secret :: term(),
              choice :: term(),
              entropy :: term()
            ) ::
              {:ok, ballot_envelope :: term(), check_token :: term()}
              | {:error, voter_error()}

  @callback make_decoy(
              VerifiedElection.t(),
              credential_secret :: term(),
              entropy :: term()
            ) ::
              {:ok, decoy_credential :: term()} | {:error, voter_error()}

  @callback advance(role_state :: term(), verified_view :: term(), role_input :: term()) ::
              {:ok, role_state :: term(), [effect()]}
              | {:wait, [requirement()]}
              | {:error, role_error()}

  @callback verify(
              VerifiedElection.t(),
              board_snapshot :: term(),
              resolved_artifacts :: %{optional(String.t()) => binary()}
            ) :: term()

  @callback claims(profile :: term()) :: [term()]
end
