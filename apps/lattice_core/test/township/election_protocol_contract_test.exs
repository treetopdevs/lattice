defmodule Township.ElectionProtocolContractTest do
  use ExUnit.Case, async: true

  alias Lattice.Attestation
  alias Township.Election.{Protocol, SecurityProfile}

  @callbacks [
    advance: 3,
    claims: 1,
    make_decoy: 3,
    prepare_ballot: 4,
    verify: 3
  ]

  @claims [
    :availability,
    :ballot_privacy,
    :board_integrity,
    :censorship_resistance,
    :closure_safety,
    :convergence,
    :credential_surrender_resistance,
    :eligibility,
    :forced_abstention_resistance,
    :forced_choice_resistance,
    :receipt_freeness,
    :universal_verifiability
  ]

  test "the replacement protocol seam is exact and has no voter-facing implementation" do
    assert Protocol.behaviour_info(:callbacks) |> Enum.sort() == Enum.sort(@callbacks)
    assert {:module, Township.Election} = Code.ensure_loaded(Township.Election)

    refute function_exported?(Township.Election, :prepare_ballot, 4)
    refute function_exported?(Township.Election, :make_decoy, 3)
    refute function_exported?(Township.Election, :advance, 3)
  end

  test "the unselected research profile makes every security property an explicit non-claim" do
    profile = SecurityProfile.research()

    assert profile.profile_id == "township-election-research-unselected-v1"
    assert profile.implementation_status == :research
    assert profile.construction.status == :unselected
    assert profile.theorem_reference == nil
    assert profile.claims |> Map.keys() |> Enum.sort() == Enum.sort(@claims)

    assert Enum.all?(profile.claims, fn {_name, claim} ->
             claim.status == :not_claimed and claim.assumptions == [] and
               claim.evidence == [] and claim.scope != "" and claim.exclusions != []
           end)

    assert SecurityProfile.claim_set_id() == SecurityProfile.claim_set_id()

    assert byte_size(Base.url_decode64!(SecurityProfile.claim_set_id(), padding: false)) ==
             32

    refute function_exported?(SecurityProfile, :claim_set_id, 1)
  end

  test "the legacy W4 Stub stays the only implementation and remains honest" do
    assert Attestation.Stub.receipt_free?() == false
    assert {:module, Attestation.M4Placeholder} = Code.ensure_loaded(Attestation.M4Placeholder)
    refute function_exported?(Attestation.M4Placeholder, :receipt_free?, 0)
    refute function_exported?(Attestation.M4Placeholder, :cast_vouch, 3)
  end
end
