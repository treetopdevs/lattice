defmodule Lattice2.ReplicaSnapshotTest do
  @moduledoc """
  Plan 012 gate: the v2 Replica DAG snapshot is a faithful, deterministic view
  of a `Lattice.Log` — node/edge counts match the op/deps counts exactly, the
  authority quarantine overlay flags the right op, and every render format
  (local Mermaid; `Lattice.Graph.Export` for DOT/JSON) carries the same graph.
  """
  use ExUnit.Case, async: true

  alias Lattice.Demo.Thread
  alias Lattice.Graph.ReplicaSnapshot
  alias Lattice.{Log, Sim}

  @replica "replica:thread:snapshot"

  # Known small log: genesis + grant + two honored posts + one forged lock that
  # authority-quarantines (:no_capability), fully synced onto one log.
  defp scenario do
    sim = Sim.new(Thread, @replica, ["server", "tab"], seed: "snapshot")
    {sim, _genesis} = Sim.create_replica(sim, "server")
    {sim, _grant} = Sim.grant(sim, "server", "tab", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "server", :post, ["from server"])
    {sim, _} = Sim.command(sim, "tab", :post, ["from tab"])
    {sim, bad_lock} = Sim.command(sim, "tab", :lock, [], cap: :none)
    sim = Sim.sync_all(sim)
    {Sim.log(sim, "server"), bad_lock}
  end

  test "node count matches op count and edge count matches total in-log deps" do
    {log, _bad_lock} = scenario()
    ops = Log.ops(log)
    graph = ReplicaSnapshot.build(Thread, log)

    assert length(graph.nodes) == map_size(ops)
    assert MapSet.new(graph.nodes, & &1.id) == Log.op_ids(log)

    total_deps = ops |> Map.values() |> Enum.map(&length(&1.deps)) |> Enum.sum()
    assert length(graph.edges) == total_deps

    # Every edge is dependency -> dependent: `from` appears in `to`'s deps.
    assert Enum.all?(graph.edges, fn edge ->
             edge.from in Map.fetch!(ops, edge.to).deps
           end)
  end

  test "the quarantined op is flagged with its reason; all others are honored" do
    {log, bad_lock} = scenario()
    graph = ReplicaSnapshot.build(Thread, log)

    bad_node = Enum.find(graph.nodes, &(&1.id == bad_lock.id))
    assert bad_node.status == "quarantined"
    assert bad_node.reason == "no_capability"
    assert bad_node.label =~ "QUARANTINED(no_capability)"

    for node <- graph.nodes, node.id != bad_lock.id do
      assert node.status == "honored"
      assert node.reason == nil
    end
  end

  test "mermaid render styles the quarantined node distinctly" do
    {log, bad_lock} = scenario()
    graph = ReplicaSnapshot.build(Thread, log)
    mermaid = ReplicaSnapshot.export(graph, :mermaid)

    assert String.starts_with?(mermaid, "graph TD")
    assert mermaid =~ "classDef quarantined"
    assert mermaid =~ "classDef honored"

    sanitized = "n_" <> String.replace(bad_lock.id, ~r/[^a-zA-Z0-9_]/, "_")
    quarantined_line = mermaid |> String.split("\n") |> Enum.find(&(&1 =~ sanitized))
    assert quarantined_line =~ ":::quarantined"

    # One edge line per dep, in the dep -> dependent direction.
    edge_lines = mermaid |> String.split("\n") |> Enum.filter(&(&1 =~ " --> "))
    assert length(edge_lines) == length(graph.edges)
  end

  test "dot and json renders delegate to Graph.Export and carry the same graph" do
    {log, _bad_lock} = scenario()
    graph = ReplicaSnapshot.build(Thread, log)

    dot = ReplicaSnapshot.export(graph, :dot)
    assert String.starts_with?(dot, "digraph lattice {")

    json = Jason.decode!(ReplicaSnapshot.export(graph, :json))
    assert length(json["nodes"]) == length(graph.nodes)
    assert length(json["edges"]) == length(graph.edges)
    assert json["replica"] == @replica
  end

  test "build is deterministic: same log, byte-identical renders" do
    {log, _bad_lock} = scenario()
    g1 = ReplicaSnapshot.build(Thread, log)
    g2 = ReplicaSnapshot.build(Thread, log)

    assert g1 == g2
    assert ReplicaSnapshot.export(g1, :mermaid) == ReplicaSnapshot.export(g2, :mermaid)
    assert ReplicaSnapshot.export(g1, :json) == ReplicaSnapshot.export(g2, :json)
  end
end
