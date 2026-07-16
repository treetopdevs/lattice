defmodule Township.ElectionBoard do
  @moduledoc """
  Dedicated capability-gated bulletin-board replica for Township elections.

  Commands append immutable protocol evidence to the Lattice log. This module
  intentionally declares no materialized state: phase, close, and result are
  derived later by the pure `Township.Election` projector, never trusted as LWW
  fields or whichever concurrent op sorts first.
  """

  use Lattice.Replica

  command(:configure_election, [:election_id, :config_ref],
    do: no_state([election_id, config_ref])
  )

  command(:publish_setup, [:election_id, :setup_ref], do: no_state([election_id, setup_ref]))
  command(:publish_roster, [:election_id, :roster_ref], do: no_state([election_id, roster_ref]))

  command(
    :open_election,
    [:election_id, :setup_digest, :roster_digest, :open_certificate],
    do: no_state([election_id, setup_digest, roster_digest, open_certificate])
  )

  command(:submit_ballot, [:election_id, :ballot_ref], do: no_state([election_id, ballot_ref]))

  command(:publish_box_seal, [:election_id, :seal_ref], do: no_state([election_id, seal_ref]))

  command(:propose_close, [:election_id, :manifest_ref],
    do: no_state([election_id, manifest_ref])
  )

  command(:attest_close, [:election_id, :manifest_digest, :signature],
    do: no_state([election_id, manifest_digest, signature])
  )

  command(:certify_close, [:election_id, :close_certificate],
    do: no_state([election_id, close_certificate])
  )

  command(
    :publish_protocol_artifact,
    [:election_id, :close_digest, :phase, :round, :trustee_id, :artifact_ref],
    do: no_state([election_id, close_digest, phase, round, trustee_id, artifact_ref])
  )

  command(:publish_tally, [:election_id, :close_digest, :result, :transcript_ref],
    do: no_state([election_id, close_digest, result, transcript_ref])
  )

  command(:abort_election, [:election_id, :reason, :abort_certificate],
    do: no_state([election_id, reason, abort_certificate])
  )

  @spec no_state([term()]) :: []
  defp no_state(_arguments), do: []
end
