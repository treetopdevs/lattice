defmodule Lattice2.WitnessedBeaconTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Sim}
  alias Township.Matter

  @realms ["clerk", "resident", "w0", "w1", "w2", "w3", "outsider"]

  defp town do
    sim = Sim.new(Matter, "replica:matter:witnessed-beacons", @realms, seed: "beacon")

    {sim, _} =
      Sim.create_replica(sim, "clerk",
        policies: %{
          __beacon__: %{
            mode: :witnessed,
            version: 1,
            witnesses: ["w0", "w1", "w2", "w3"],
            threshold: 2,
            max_epoch_step: 10
          }
        }
      )

    sim
  end

  test "a witnessed epoch lapses a lease in both command analysis and the public live check" do
    sim = town()
    {sim, lease} = Sim.grant(sim, "clerk", "resident", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)
    {sim, early} = Sim.command(sim, "resident", :post, ["early"], cap: lease.id)
    sim = Sim.sync_all(sim)
    {sim, beacon} = Sim.beacon(sim, "w0", 4, witnesses: ["w0", "w1"])
    sim = Sim.sync_all(sim)
    {sim, late} = Sim.command(sim, "resident", :post, ["late"], cap: lease.id)
    sim = Sim.sync_all(sim)

    assert Sim.quarantined(sim, "resident", beacon.id) == false
    assert Sim.quarantined(sim, "resident", early.id) == false
    assert {true, :lease_expired} = Sim.quarantined(sim, "resident", late.id)
    assert Authority.expired?(Sim.log(sim, "resident"), lease.id)
    assert "early" in Sim.state(sim, "resident").posts
    refute "late" in Sim.state(sim, "resident").posts
  end
end
