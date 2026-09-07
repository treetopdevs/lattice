defmodule Treehouse.ContinuationProfileObservationTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, Log, Sim}
  alias Treehouse.ContinuationFixtures, as: F

  test "a later metadata-only root pin is observed without inventing a continuation candidate" do
    for kind <- [:space, :thread] do
      {sim, _genesis} = F.new(kind: kind)
      {sim, pin, profile} = F.pin(sim)
      log = Sim.log(sim, "founder")

      assert Authority.continuation_profile(log) ==
               {:ok,
                %{
                  replica: sim.replica,
                  root: Sim.identity(sim, "founder").pub,
                  profile_genesis: pin.id,
                  profile_id:
                    F.digest(Canonical.term(["lattice-continuation-profile-v1", profile])),
                  profile: profile,
                  verified_frontier: Log.frontier(log)
                }}
    end
  end

  test "only the latest valid root pin is selected; impostors and malformed replacements stay retained" do
    {sim, _} = F.new()

    assert {:error, :continuation_not_configured} =
             Authority.continuation_profile(Sim.log(sim, "founder"))

    {sim, impostor, _} = F.pin(sim, author: "observer")

    assert {:error, :continuation_not_configured} =
             Authority.continuation_profile(Sim.log(sim, "founder"))

    {sim, first, _} = F.pin(sim)
    {sim, second, profile} = F.pin(sim, threshold: 3)
    {sim, malformed, _} = F.pin(sim, profile: Map.put(profile, :extra, true))
    log = Sim.log(sim, "founder")
    assert {:ok, observed} = Authority.continuation_profile(log)
    assert observed.profile_genesis == second.id
    assert observed.profile == profile
    assert observed.verified_frontier == [malformed.id]

    assert Enum.all?(
             [impostor, first, second, malformed],
             &MapSet.member?(Log.op_ids(log), &1.id)
           )
  end

  test "forged or incomplete retained history never produces a trusted pin" do
    {sim, genesis} = F.new()
    {sim, pin, _} = F.pin(sim)
    log = Sim.log(sim, "founder")
    ops = Log.ops(log)
    forged = %{pin | sig: <<0::512>>}

    for bad <- [
          Log.from_ops(sim.replica, Map.delete(ops, genesis.id)),
          Log.from_ops(sim.replica, Map.put(ops, pin.id, forged)),
          %{log | referenced: MapSet.new()}
        ] do
      assert {:error, :invalid_verified_history} = Authority.continuation_profile(bad)
    end
  end

  test "legacy and unknown intended families have distinct closed refusals" do
    {legacy, _} = F.new(name: "legacy-profile-observation")

    assert {:error, :unauthorized_continuation} =
             Authority.continuation_profile(Sim.log(legacy, "founder"))

    {bounded, _} = F.new()
    log = Sim.log(bounded, "founder")

    unknown = %{
      log
      | replica: String.replace(log.replica, "bounded-continuation-v1", "bounded-continuation-v2")
    }

    assert {:error, :unsupported_authority_profile} = Authority.continuation_profile(unknown)
  end
end
