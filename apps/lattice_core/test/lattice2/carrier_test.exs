defmodule Lattice.CarrierTest do
  use ExUnit.Case, async: true

  alias Lattice.{Carrier, Identity, Log, Net, Op, Sim, Sync}
  alias Lattice.Carrier.SimNet
  alias Lattice.Demo.Thread
  alias Lattice.Sync.Shape

  @replica "replica:thread:carrier-test"

  # Two realms diverged behind a partition — the standard convergence fixture.
  defp diverged_sim do
    sim = Sim.new(Thread, @replica, ["a", "b"], seed: "carrier-test")
    {sim, _} = Sim.create_replica(sim, "a")
    {sim, _} = Sim.grant(sim, "a", "b", ops: [:post, :set_title, :join])
    sim = Sim.sync_all(sim)
    sim = Sim.partition(sim, "a", "b")
    {sim, _} = Sim.command(sim, "a", :post, ["a: offline"])
    {sim, _} = Sim.command(sim, "a", :set_title, ["a title"])
    {sim, _} = Sim.command(sim, "b", :post, ["b: offline"])
    {sim, _} = Sim.command(sim, "b", :set_title, ["b title"])
    sim
  end

  test "Carrier.sync over SimNet reproduces Sync.reconcile exactly" do
    sim = diverged_sim()
    log_a = Sim.log(sim, "a")
    log_b = Sim.log(sim, "b")

    # Oracle: the pure reconciliation the whole suite pins.
    {oracle_a, oracle_b, _report} = Sync.reconcile(log_a, log_b)

    conn = SimNet.connect(Net.new(), "a", "b", log_b)
    assert {:ok, log_a2, stats, conn} = Carrier.sync(SimNet, conn, log_a)
    log_b2 = SimNet.peer_log(conn)

    assert stats.sent == 2
    assert stats.received == 2
    assert Log.op_ids(log_a2) == Log.op_ids(oracle_a)
    assert Log.op_ids(log_b2) == Log.op_ids(oracle_b)

    assert :erlang.term_to_binary(Lattice.state(Thread, log_a2), [:deterministic]) ==
             :erlang.term_to_binary(Lattice.state(Thread, oracle_a), [:deterministic])
  end

  test "a second Carrier.sync transfers nothing (idempotent)" do
    sim = diverged_sim()
    conn = SimNet.connect(Net.new(), "a", "b", Sim.log(sim, "b"))

    {:ok, log_a, _stats, conn} = Carrier.sync(SimNet, conn, Sim.log(sim, "a"))
    assert {:ok, ^log_a, stats, _conn} = Carrier.sync(SimNet, conn, log_a)
    assert stats.sent == 0
    assert stats.received == 0
    assert stats.pushed.accepted == []
    assert stats.pulled.accepted == []
  end

  test "Carrier.sync can restrict transfer with a dependency-closed shape" do
    identity = Identity.from_seed("a", "carrier-shape")
    replica = "replica:carrier-shape"
    post = Op.new(identity, replica, [], :command, {:post, ["visible"]})
    title = Op.new(identity, replica, [], :command, {:set_title, ["hidden"]})
    log_a = replica |> Log.new() |> Log.append!(post) |> Log.append!(title)
    log_b = Log.new(replica)
    conn = SimNet.connect(Net.new(), "a", "b", log_b)

    assert {:ok, _log_a, stats, conn} =
             Carrier.sync(SimNet, conn, log_a, shape: Shape.commands([:post]))

    peer_ids = Log.op_ids(SimNet.peer_log(conn))
    assert stats.sent == 1
    assert MapSet.member?(peer_ids, post.id)
    refute MapSet.member?(peer_ids, title.id)
  end

  test "every callback is gated by the simulated partition" do
    sim = diverged_sim()
    log_a = Sim.log(sim, "a")
    net = Net.new() |> Net.partition("a", "b")
    conn = SimNet.connect(net, "a", "b", Sim.log(sim, "b"))

    assert {:error, :partitioned} = Carrier.sync(SimNet, conn, log_a)
    assert {:error, :partitioned} = SimNet.pull(conn, Log.op_ids(log_a))
    assert {:error, :partitioned} = SimNet.push(conn, [])
    assert {:error, :partitioned} = SimNet.live(conn, {:typing, "a"})

    # Heal, and the same connection value syncs to convergence.
    conn = %{conn | net: Net.heal(net, "a", "b")}
    assert {:ok, log_a2, _stats, conn} = Carrier.sync(SimNet, conn, log_a)
    assert Log.op_ids(log_a2) == Log.op_ids(SimNet.peer_log(conn))
  end

  test "live delivery never touches the peer log" do
    sim = diverged_sim()
    log_b = Sim.log(sim, "b")
    conn = SimNet.connect(Net.new(), "a", "b", log_b)

    assert {:ok, conn} = SimNet.live(conn, {:typing, "a"})
    assert SimNet.peer_log(conn) == log_b
  end
end
