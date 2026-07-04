defmodule Lattice2.LifecycleTest do
  @moduledoc """
  Phase D gate: durable messaging + materialization lifecycle.

  Behaviors 11 (durable send, exactly-once on next materialization, causal order),
  12 (promise across dormancy, resolved from the log), 13 (lifecycle monitors +
  tombstone as a permanent, replica-wide op), 14 (realm death and resurrection from
  a disk dump).
  """
  use ExUnit.Case, async: false

  alias Lattice.{Registry, Sim}
  alias Lattice.Demo.Thread

  @replica "replica:thread:life"

  setup do
    Lattice.reset!()
    on_exit(fn -> Lattice.reset!() end)
    :ok
  end

  # Build a base log with genesis + two authored posts, hosted on both realms.
  defp hosted do
    sim = Sim.new(Thread, @replica, ["server", "tab"], seed: "life")
    {sim, _g} = Sim.create_replica(sim, "server")
    {sim, _} = Sim.command(sim, "server", :post, ["hello"])
    {sim, _} = Sim.command(sim, "server", :post, ["world"])
    sim = Sim.sync_all(sim)

    base = Sim.log(sim, "server")
    :ok = Registry.host(Sim.identity(sim, "server"), Thread, @replica, base)
    :ok = Registry.host(Sim.identity(sim, "tab"), Thread, @replica, base)
    sim
  end

  test "behavior 11: a durable message to a dormant replica is delivered once, on next materialization" do
    _sim = hosted()
    :ok = Registry.monitor("server", @replica, self())

    # server is dormant; tab durably sends two messages.
    :ok = Registry.deliver("tab", "server", @replica, {:ping, 1})
    :ok = Registry.deliver("tab", "server", @replica, {:ping, 2})

    {:ok, _state} = Registry.materialize("server", @replica)

    assert_receive {:lattice_message, {"server", @replica}, {:ping, 1}}
    assert_receive {:lattice_message, {"server", @replica}, {:ping, 2}}

    # Dormant then live again: no re-delivery (exactly once across materializations).
    :ok = Registry.go_dormant("server", @replica)
    {:ok, _} = Registry.materialize("server", @replica)
    refute_receive {:lattice_message, {"server", @replica}, {:ping, _}}, 50
  end

  test "behavior 12: a promise resolves from the log after the target materializes, even across caller dormancy" do
    _sim = hosted()

    # tab calls server while server is dormant.
    {:ok, promise} = Registry.call("tab", "server", @replica, {:get, :messages})
    assert Registry.await("tab", @replica, promise) == :pending

    # server materializes and answers; the answer is an inbox op in its log.
    {:ok, _} = Registry.materialize("server", @replica)
    :ok = Registry.sync("server", "tab", @replica)

    # The caller may cycle through dormancy; resolution is read from the log.
    {:ok, _} = Registry.materialize("tab", @replica)
    :ok = Registry.go_dormant("tab", @replica)

    assert {:ok, messages} = Registry.await("tab", @replica, promise)
    assert messages == ["hello", "world"]
  end

  test "behavior 13: monitors observe live/dormant/live and a terminal tombstone that blocks rematerialization everywhere" do
    _sim = hosted()
    :ok = Registry.monitor("server", @replica, self())

    {:ok, _} = Registry.materialize("server", @replica)
    assert_receive {:lattice_lifecycle, {"server", @replica}, :live}

    :ok = Registry.go_dormant("server", @replica)
    assert_receive {:lattice_lifecycle, {"server", @replica}, :dormant}

    {:ok, _} = Registry.materialize("server", @replica)
    assert_receive {:lattice_lifecycle, {"server", @replica}, :live}

    :ok = Registry.tombstone("server", @replica)
    assert_receive {:lattice_lifecycle, {"server", @replica}, :tombstoned}

    # Permanent locally...
    assert {:error, :tombstoned} = Registry.materialize("server", @replica)

    # ...and everywhere: the tombstone op syncs to tab, which also cannot materialize.
    :ok = Registry.sync("server", "tab", @replica)
    assert {:error, :tombstoned} = Registry.materialize("tab", @replica)
  end

  test "behavior 14: realm death and resurrection — restore the log from disk, rematerialize, state + pending promise intact" do
    sim = hosted()
    # A promise is outstanding (request authored, not yet answered) before death.
    {:ok, promise} = Registry.call("tab", "server", @replica, {:get, :title})
    :ok = Registry.sync("tab", "server", @replica)

    {:ok, _} = Registry.materialize("server", @replica)

    dump =
      Path.join(System.tmp_dir!(), "lattice_server_#{System.unique_integer([:positive])}.dump")

    on_exit(fn -> File.rm(dump) end)
    :ok = Registry.dump("server", @replica, dump)

    # Kill the realm: drop everything from the runtime.
    :ok = Registry.reset()

    # Resurrect from disk and rematerialize.
    :ok = Registry.restore(Sim.identity(sim, "server"), Thread, @replica, dump)
    {:ok, state} = Registry.materialize("server", @replica)

    # State survived.
    assert state.messages == ["hello", "world"]

    # The pending promise resolves after rematerialization (the request op was in
    # the dumped log; rematerializing answered it). Re-host tab and sync to read it.
    :ok = Registry.host(Sim.identity(sim, "tab"), Thread, @replica, Lattice.Log.new(Sim.replica(sim)))
    :ok = Registry.sync("server", "tab", @replica)
    assert {:ok, _title} = Registry.await("tab", @replica, promise)
  end
end
