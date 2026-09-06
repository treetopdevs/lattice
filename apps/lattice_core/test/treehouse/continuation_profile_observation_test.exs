defmodule Treehouse.ContinuationProfileObservationTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Sim}
  alias Lattice.Authority.ContinuationCertificate
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
                  profile_id: ContinuationCertificate.profile_id(profile),
                  profile: profile,
                  verified_frontier: Log.frontier(log)
                }}
    end
  end
end
