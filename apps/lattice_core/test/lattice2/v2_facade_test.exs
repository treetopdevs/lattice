defmodule Lattice2.V2FacadeTest do
  @moduledoc """
  Plan 011 gate: `Lattice.V2` is a pure delegation facade — every facade verb
  routes to the same result as the underlying runtime call. Modeled on
  `lifecycle_test.exs`.
  """
  use ExUnit.Case, async: false

  alias Lattice.Demo.Thread
  alias Lattice.{Registry, Sim, V2}

  @replica "replica:thread:v2facade"

  setup do
    Lattice.reset!()
    on_exit(fn -> Lattice.reset!() end)
    :ok
  end

  # Build a base log with genesis + two authored posts, hosted on both realms.
  defp hosted do
    sim = Sim.new(Thread, @replica, ["server", "tab"], seed: "v2facade")
    {sim, _g} = Sim.create_replica(sim, "server")
    {sim, _} = Sim.command(sim, "server", :post, ["hello"])
    {sim, _} = Sim.command(sim, "server", :post, ["world"])
    sim = Sim.sync_all(sim)

    base = Sim.log(sim, "server")
    :ok = Registry.host(Sim.identity(sim, "server"), Thread, @replica, base)
    :ok = Registry.host(Sim.identity(sim, "tab"), Thread, @replica, base)
    sim
  end

  test "materialize/2 routes to Registry.materialize/2 (same state, pair goes live)" do
    _sim = hosted()

    assert {:ok, state} = V2.materialize("server", @replica)
    assert state == Registry.state("server", @replica)
    assert Registry.lifecycle("server", @replica) == :live

    # Idempotent, exactly like the Registry call.
    assert {:ok, ^state} = Registry.materialize("server", @replica)
  end

  test "dormant/2 routes to Registry.go_dormant/2" do
    _sim = hosted()
    {:ok, _} = V2.materialize("server", @replica)

    assert :ok = V2.dormant("server", @replica)
    assert Registry.lifecycle("server", @replica) == :dormant
  end

  test "tombstone/2 routes to Registry.tombstone/2 (permanent, blocks rematerialization)" do
    _sim = hosted()

    assert :ok = V2.tombstone("server", @replica)
    assert Registry.lifecycle("server", @replica) == :tombstoned
    assert {:error, :tombstoned} = V2.materialize("server", @replica)
    assert {:error, :tombstoned} = Registry.materialize("server", @replica)
  end

  test "monitor/2 subscribes the caller, exactly like Registry.monitor/3 with self()" do
    _sim = hosted()

    assert :ok = V2.monitor("server", @replica)
    assert_receive {:lattice_lifecycle, {"server", @replica}, :dormant}

    {:ok, _} = V2.materialize("server", @replica)
    assert_receive {:lattice_lifecycle, {"server", @replica}, :live}
  end

  test "send/3 routes to Registry.deliver/4 (durable, delivered once on next materialization)" do
    _sim = hosted()
    :ok = V2.monitor("server", @replica)

    assert :ok = V2.send("tab", {"server", @replica}, {:ping, 1})
    {:ok, _} = V2.materialize("server", @replica)
    assert_receive {:lattice_message, {"server", @replica}, {:ping, 1}}

    # Exactly once across materializations, same as the Registry path.
    :ok = V2.dormant("server", @replica)
    {:ok, _} = V2.materialize("server", @replica)
    refute_receive {:lattice_message, {"server", @replica}, {:ping, _}}, 50
  end

  test "call/4 + await/2 route to Registry.call/4 + Registry.await/3" do
    _sim = hosted()

    assert {:ok, promise} = V2.call("tab", "server", @replica, {:get, :messages})
    assert V2.await("tab", promise) == :pending
    assert V2.await("tab", promise) == Registry.await("tab", @replica, promise)

    {:ok, _} = V2.materialize("server", @replica)
    :ok = Registry.sync("server", "tab", @replica)

    assert {:ok, messages} = V2.await("tab", promise)
    assert messages == ["hello", "world"]
    assert V2.await("tab", promise) == Registry.await("tab", @replica, promise)
  end

  test "state/2 runtime head routes to Registry.state/2" do
    _sim = hosted()
    {:ok, _} = V2.materialize("server", @replica)

    assert V2.state("server", @replica) == Registry.state("server", @replica)
    assert V2.state("server", @replica).messages == ["hello", "world"]
  end

  test "state/2 value-level head routes to Lattice.state/2" do
    _sim = hosted()
    log = Registry.log("server", @replica)

    assert V2.state(Thread, log) == Lattice.state(Thread, log)
    assert V2.state(Thread, log).messages == ["hello", "world"]
  end

  test "state_at/3 routes to Lattice.state_at/3" do
    _sim = hosted()
    log = Registry.log("server", @replica)
    frontier = Lattice.Log.frontier(log)

    assert V2.state_at(Thread, log, frontier) == Lattice.state_at(Thread, log, frontier)
    assert V2.state_at(Thread, log, frontier).messages == ["hello", "world"]
  end
end
