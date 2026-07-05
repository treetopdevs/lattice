defmodule Lattice.SyncShapeTest do
  use ExUnit.Case, async: true

  alias Lattice.Demo.Thread
  alias Lattice.Identity
  alias Lattice.Log
  alias Lattice.Op
  alias Lattice.Sim
  alias Lattice.Sync
  alias Lattice.Sync.Shape

  test "all shape preserves existing missing/2 behavior" do
    sim = Sim.new(Thread, "replica:shape", ["a", "b"], seed: "shape")
    {sim, _} = Sim.create_replica(sim, "a")
    {sim, _} = Sim.grant(sim, "a", "b", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "a", :post, ["from a"])

    assert Sync.missing(Sim.log(sim, "a"), MapSet.new()) ==
             Sync.missing(Sim.log(sim, "a"), MapSet.new(), Shape.all())
  end

  test "command shape includes selected command ops and causal dependencies" do
    sim = Sim.new(Thread, "replica:shape", ["a", "b"], seed: "shape")
    {sim, genesis} = Sim.create_replica(sim, "a")
    {sim, grant} = Sim.grant(sim, "a", "b", ops: [:post, :set_title])
    sim = Sim.sync_all(sim)
    {sim, post} = Sim.command(sim, "b", :post, ["visible"])
    {sim, title} = Sim.command(sim, "b", :set_title, ["not selected"])
    grant_op = find_grant_op(Sim.log(sim, "b"), grant.id)

    ids =
      sim
      |> Sim.log("b")
      |> Sync.missing(MapSet.new(), Shape.commands([:post]))
      |> Enum.map(& &1.id)

    assert post.id in ids
    assert genesis.id in ids
    assert grant_op.id in ids
    refute title.id in ids
  end

  test "command shapes retain tombstones so partial materialization cannot resurrect deletions" do
    identity = Identity.from_seed("a", "shape-tombstone")
    replica = "replica:shape-tombstone"
    post = Op.new(identity, replica, [], :command, {:post, ["visible"]})
    tombstone = Op.new(identity, replica, [post.id], :tombstone, {:delete, post.id})
    log = replica |> Log.new() |> Log.append!(post) |> Log.append!(tombstone)

    ids =
      log
      |> Sync.missing(MapSet.new(), Shape.commands([:post]))
      |> Enum.map(& &1.id)

    assert post.id in ids
    assert tombstone.id in ids
  end

  test "command shapes retain tombstones without pulling excluded deleted commands" do
    identity = Identity.from_seed("a", "shape-excluded-tombstone")
    replica = "replica:shape-excluded-tombstone"
    hidden = Op.new(identity, replica, [], :command, {:set_title, ["hidden"]})
    tombstone = Op.new(identity, replica, [], :tombstone, {:delete, hidden.id})
    log = replica |> Log.new() |> Log.append!(hidden) |> Log.append!(tombstone)
    shape = Shape.commands([:post])

    assert Shape.selected?(shape, tombstone)
    refute Shape.selected?(shape, hidden)

    ids =
      log
      |> Sync.missing(MapSet.new(), shape)
      |> Enum.map(& &1.id)

    assert tombstone.id in ids
    refute hidden.id in ids
  end

  defp find_grant_op(log, delegation_id) do
    Enum.find(Log.topo_ops(log), fn
      %{kind: :authority, body: {:grant, %{id: ^delegation_id}}} -> true
      _op -> false
    end)
  end
end
