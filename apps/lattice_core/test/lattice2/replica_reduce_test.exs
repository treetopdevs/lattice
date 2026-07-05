defmodule Lattice2.ReplicaReduceTest do
  @moduledoc """
  Phase B gate: Replica DSL + CRDTs + deterministic reduction.

  Behavior 1 (convergence to identical reduced state, equal to the no-partition
  result), behavior 2 (delivery-order independence — byte-identical state), and
  behavior 18 (same-path equivalence: fully-live run vs partition+sync run produce
  identical logs and state).
  """
  use ExUnit.Case, async: true

  alias Lattice.{Log, Op, Reduce, Sim, Sync}
  alias Lattice.Demo.Thread

  @replica "replica:thread:demo"

  defp genesis do
    creator = Lattice.Identity.from_seed("server", "seed:genesis")
    {:ok, body} = Thread.command_body(:set_title, ["welcome"])
    Op.new(creator, @replica, [], :command, body)
  end

  test "behavior 1: partitioned realms converge to identical reduced state" do
    sim = Sim.new(Thread, @replica, ["server", "tab"], seed: "b1")
    {sim, _genesis} = Sim.create_replica(sim, "server")
    {sim, _grant} = Sim.grant(sim, "server", "tab", ops: [:post, :set_title, :join, :leave])
    # Everyone has genesis + the tab grant before the split.
    sim = Sim.sync_all(sim)

    sim = Sim.partition(sim, "server", "tab")

    {sim, _} = Sim.command(sim, "server", :post, ["from server"])
    {sim, _} = Sim.command(sim, "server", :set_title, ["Server Title"])
    {sim, _} = Sim.command(sim, "tab", :post, ["from tab"])
    {sim, _} = Sim.command(sim, "tab", :join, ["tab"])

    # Diverged while partitioned.
    refute Sim.state(sim, "server") == Sim.state(sim, "tab")

    sim = sim |> Sim.heal("server", "tab") |> Sim.sync_all()

    server_state = Sim.state(sim, "server")
    tab_state = Sim.state(sim, "tab")

    assert server_state == tab_state
    assert server_state.title == "Server Title"
    assert "from server" in server_state.messages
    assert "from tab" in server_state.messages
    assert "tab" in server_state.participants

    # Equal to the no-partition result: reducing the merged op set in any order is
    # path-independent.
    merged = Map.values(Log.ops(Sim.log(sim, "server")))
    {fresh, _} = Sync.deliver(Log.new(Sim.replica(sim)), Enum.reverse(merged))
    quarantine = Lattice.Authority.quarantine(Thread, fresh)
    assert Reduce.reduce(Thread, fresh, quarantine: quarantine) == server_state
  end

  test "behavior 2: same op set, many delivery orders => byte-identical state" do
    # Fixed causal DAG of ops (deps are pinned, so ids are stable across runs).
    a = Lattice.Identity.from_seed("a", "seed:a")
    b = Lattice.Identity.from_seed("b", "seed:b")
    g = genesis()

    o1 = cmd(a, [g.id], :post, ["a1"])
    o2 = cmd(b, [g.id], :post, ["b1"])
    o3 = cmd(a, [o1.id, o2.id], :set_title, ["merged"])
    o4 = cmd(b, [o2.id], :join, ["b"])
    o5 = cmd(a, [o3.id], :post, ["a2"])
    ops = [g, o1, o2, o3, o4, o5]

    reductions =
      for _ <- 1..40 do
        {log, report} = Sync.deliver(Log.new(@replica), Enum.shuffle(ops))
        assert report.pending == []
        state = Reduce.reduce(Thread, log)
        :erlang.term_to_binary(state, [:deterministic])
      end

    assert reductions |> Enum.uniq() |> length() == 1
  end

  test "behavior 18: fully-live run and partition+sync run produce identical logs and state" do
    # The SAME ops (fixed deps) applied two ways.
    a = Lattice.Identity.from_seed("a", "seed:a")
    b = Lattice.Identity.from_seed("b", "seed:b")
    g = genesis()
    o1 = cmd(a, [g.id], :post, ["a1"])
    o2 = cmd(b, [g.id], :post, ["b1"])
    o3 = cmd(a, [o1.id], :set_title, ["t"])
    o4 = cmd(b, [o2.id], :join, ["b"])
    ops = [g, o1, o2, o3, o4]

    # Live: one log, all ops.
    {live, _} = Sync.deliver(Log.new(@replica), ops)

    # Partitioned: each author on its own log, then reconcile.
    la = Enum.reduce([g, o1, o3], Log.new(@replica), &Log.append!(&2, &1))
    lb = Enum.reduce([g, o2, o4], Log.new(@replica), &Log.append!(&2, &1))
    {la, lb, _} = Sync.reconcile(la, lb)

    assert Log.op_ids(live) == Log.op_ids(la)
    assert Log.op_ids(la) == Log.op_ids(lb)
    assert Reduce.reduce(Thread, live) == Reduce.reduce(Thread, la)
    assert Reduce.reduce(Thread, la) == Reduce.reduce(Thread, lb)
  end

  test "causal_list keeps causal order and breaks concurrent ties deterministically" do
    a = Lattice.Identity.from_seed("a", "seed:a")
    b = Lattice.Identity.from_seed("b", "seed:b")
    g = genesis()
    # a1 -> a2 causal chain; b1 concurrent with both.
    a1 = cmd(a, [g.id], :post, ["a1"])
    a2 = cmd(a, [a1.id], :post, ["a2"])
    b1 = cmd(b, [g.id], :post, ["b1"])

    {log, _} = Sync.deliver(Log.new(@replica), Enum.shuffle([g, a1, a2, b1]))
    msgs = Reduce.reduce(Thread, log).messages

    # Causal order preserved: a1 strictly before a2.
    assert index(msgs, "a1") < index(msgs, "a2")
    assert "b1" in msgs
  end

  test "or_set add-wins: concurrent add survives a remove that didn't observe it" do
    a = Lattice.Identity.from_seed("a", "seed:a")
    b = Lattice.Identity.from_seed("b", "seed:b")
    g = genesis()
    # a joins x, then a removes x (observed). b concurrently joins x (not observed by a's remove).
    a_join = cmd(a, [g.id], :join, ["x"])
    a_leave = cmd(a, [a_join.id], :leave, ["x"])
    b_join = cmd(b, [g.id], :join, ["x"])

    {log, _} = Sync.deliver(Log.new(@replica), Enum.shuffle([g, a_join, a_leave, b_join]))
    assert "x" in Reduce.reduce(Thread, log).participants
  end

  defp cmd(identity, deps, command, args) do
    {:ok, body} = Thread.command_body(command, args)
    Op.new(identity, @replica, deps, :command, body)
  end

  defp index(list, value), do: Enum.find_index(list, &(&1 == value))
end
