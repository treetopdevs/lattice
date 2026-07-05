defmodule Lattice.SyncShapeTest do
  use ExUnit.Case, async: true

  alias Lattice.Demo.Thread
  alias Lattice.Log
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

  defp find_grant_op(log, delegation_id) do
    Enum.find(Log.topo_ops(log), fn
      %{kind: :authority, body: {:grant, %{id: ^delegation_id}}} -> true
      _op -> false
    end)
  end
end
