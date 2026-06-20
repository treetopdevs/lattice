defmodule Lattice2.SuccessionTimeTravelTest do
  @moduledoc """
  Phase E gates: succession (behavior 15) and time travel (behavior 17).
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Sync, Sim}
  alias Lattice.Demo.Thread

  @replica "replica:thread:succ"

  defp pub(sim, realm), do: Sim.identity(sim, realm).pub

  defp base do
    sim = Sim.new(Thread, @replica, ["server", "tab"], seed: "succ")

    Sim.create_replica(sim, "server",
      policies: %{moderator: %{successor: "tab", dormant_ticks: 3}}
    )
    |> elem(0)
    |> Sim.sync_all()
  end

  test "behavior 15: succession fires after dormancy; returning holder's stale lock is quarantined" do
    sim = base()

    # server is active at tick 1, then goes dormant.
    {sim, _} = Sim.heartbeat(sim, "server", :moderator, 1)
    sim = Sim.sync_all(sim)

    # Fork: a lagging server, never seeing the succession, issues a stale lock.
    {stale_branch, stale_lock} = Sim.command(sim, "server", :lock, [])

    # Clock advanced to 4 (>= 1 + 3): tab legitimately succeeds.
    {sim, _} = Sim.succeed(sim, "tab", :moderator, at_tick: 4)
    sim = Sim.sync_all(sim)

    assert Sim.holder(sim, "server", :moderator) == pub(sim, "tab")
    assert Sim.holder(sim, "tab", :moderator) == pub(sim, "tab")

    # tab can now lock as the new holder.
    {sim, tab_lock} = Sim.command(sim, "tab", :lock, [])
    refute Sim.quarantined(sim, "tab", tab_lock.id)
    assert Sim.state(sim, "tab").locked? == true

    # Merge the stale branch: every realm quarantines the returning holder's lock.
    {merged, _, _} = Sync.reconcile(Sim.log(sim, "server"), Sim.log(stale_branch, "server"))
    analysis = Authority.analyze(Thread, merged)
    assert Map.get(analysis.reasons, stale_lock.id) == :stale_holder
    assert Authority.holder(Thread, merged, :moderator) == pub(sim, "tab")
  end

  test "behavior 15: a premature succession (before the dormancy threshold) is quarantined" do
    sim = base()
    {sim, _} = Sim.heartbeat(sim, "server", :moderator, 2)
    sim = Sim.sync_all(sim)

    # tab tries to succeed at tick 3, but last activity was tick 2 and threshold is 3
    # (needs tick >= 5).
    {sim, premature} = Sim.succeed(sim, "tab", :moderator, at_tick: 3)

    assert {true, :premature_succession} = Sim.quarantined(sim, "tab", premature.id)
    # Authority did not move: server still holds.
    assert Sim.holder(sim, "tab", :moderator) == pub(sim, "server")
  end

  test "behavior 17: state_at reproduces historical state as of a causal frontier" do
    sim = base()
    {sim, _grant} = Sim.grant(sim, "server", "tab", ops: [:post, :set_title])
    sim = Sim.sync_all(sim)

    {sim, _} = Sim.command(sim, "server", :set_title, ["v1"])
    {sim, a} = Sim.command(sim, "server", :post, ["first"])

    # Snapshot the frontier here (as of the first post).
    snapshot_frontier = Log.frontier(Sim.log(sim, "server"))

    {sim, _} = Sim.command(sim, "server", :set_title, ["v2"])
    {sim, _} = Sim.command(sim, "server", :post, ["second"])

    log = Sim.log(sim, "server")
    current = Sim.state(sim, "server")
    historical = Lattice.state_at(Thread, log, snapshot_frontier)

    assert current.title == "v2"
    assert current.messages == ["first", "second"]

    assert historical.title == "v1"
    assert historical.messages == ["first"]
    assert a.id in (log |> Log.ops() |> Map.keys())

    # Verified against a recorded reduction: reducing just the slice's ops directly.
    recorded =
      Lattice.Reduce.reduce(
        Thread,
        Log.from_ops(
          @replica,
          Map.take(
            Log.ops(log),
            MapSet.to_list(Lattice.Dag.reachable(Log.ops(log), snapshot_frontier))
          )
        )
      )

    assert historical.messages == recorded.messages
  end
end
