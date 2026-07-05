# Lattice 2.0 — visual demo (plan 012): render a merged Replica op-log as a
# causal DAG with authority verdicts overlaid.
#
#   mix run scripts/lattice2_visual_demo.exs   (from apps/lattice_core, or umbrella root)
#   elixir scripts/lattice2_visual_demo.exs    (after `mix compile`/`mix test`)
#
# The scenario is deliberately the spiciest beat of scripts/lattice2_demo.exs:
# partition → concurrent writes → heal/merge, then a *stale-holder* fork — the
# old moderator locks the thread on a branch that never saw the succession that
# superseded it. The diagram shows that lock quarantined while everything else
# is honored. Everything is deterministic (fixed seed, logical ticks).

# --- bootstrap code paths so the script runs under plain `elixir` too ---
unless Code.ensure_loaded?(Lattice.Sim) do
  root = Path.expand("..", __DIR__)

  Path.wildcard(Path.join(root, "_build/*/lib/*/ebin"))
  |> Enum.each(&Code.append_path/1)

  {:ok, _} = Application.ensure_all_started(:crypto)
end

alias Lattice.{Sim, Sync}
alias Lattice.Demo.Thread
alias Lattice.Graph.ReplicaSnapshot

defmodule V do
  def h(title), do: IO.puts("\n\e[1m\e[36m== #{title} ==\e[0m")
  def say(msg), do: IO.puts("  #{msg}")
end

IO.puts("\e[1mLattice 2.0 — a Replica op-log, drawn\e[0m")

replica = "replica:thread:visual"

# ---------------------------------------------------------------------------
V.h("1. Build the scenario: partition → merge → stale-holder fork")

sim = Sim.new(Thread, replica, ["server", "tab"], seed: "visual-demo")

{sim, _genesis} =
  Sim.create_replica(sim, "server",
    policies: %{moderator: %{successor: "tab", dormant_ticks: 3}}
  )

{sim, _grant} = Sim.grant(sim, "server", "tab", ops: [:post, :set_title, :join, :leave])
sim = Sim.sync_all(sim)
{sim, _} = Sim.command(sim, "server", :join, ["server"])
{sim, _} = Sim.command(sim, "tab", :join, ["tab"])
sim = Sim.sync_all(sim)

# Partition: both realms write concurrently, then heal — the convergent merge.
sim = Sim.partition(sim, "server", "tab")
{sim, _} = Sim.command(sim, "server", :post, ["server: deploy window is 17:00"])
{sim, _} = Sim.command(sim, "tab", :post, ["tab: ack, watching dashboards"])
sim = sim |> Sim.heal("server", "tab") |> Sim.sync_all()
V.say("partitioned posts merged convergently on both realms.")

# Holder liveness at tick 5, then a FORK: on one branch the holder (server)
# locks; on the other, tab succeeds to :moderator at tick 9 (> 5 + 3 dormancy).
{sim, _} = Sim.heartbeat(sim, "server", :moderator, 5)
sim = Sim.sync_all(sim)
{stale_branch, stale_lock} = Sim.command(sim, "server", :lock, [])
{sim, _} = Sim.succeed(sim, "tab", :moderator, at_tick: 9)
sim = Sim.sync_all(sim)

{merged, _, _} = Sync.reconcile(Sim.log(sim, "server"), Sim.log(stale_branch, "server"))
V.say("merged log: #{Lattice.Log.size(merged)} ops; frontier #{length(Lattice.Log.frontier(merged))} heads.")

# ---------------------------------------------------------------------------
V.h("2. Snapshot the merged log")

graph = ReplicaSnapshot.build(Thread, merged)
stale_node = Enum.find(graph.nodes, &(&1.id == stale_lock.id))

unless stale_node.status == "quarantined" do
  raise "expected the stale-holder lock to be quarantined, got: #{inspect(stale_node)}"
end

V.say("nodes=#{length(graph.nodes)} edges=#{length(graph.edges)}")
V.say("stale lock #{String.slice(stale_lock.id, 0, 10)}… is QUARANTINED: #{stale_node.reason}")
V.say("holders legend: #{inspect(graph.holders)}")

# ---------------------------------------------------------------------------
V.h("3. Mermaid (paste into any Mermaid renderer / Markdown)")

mermaid = ReplicaSnapshot.export(graph, :mermaid)
IO.puts(mermaid)

# ---------------------------------------------------------------------------
V.h("4. Artifacts (Mermaid + DOT + JSON)")

artifacts_dir = Path.expand("../artifacts/lattice2_visual", __DIR__)
File.mkdir_p!(artifacts_dir)

for {ext, format} <- [{"mmd", :mermaid}, {"dot", :dot}, {"json", :json}] do
  path = Path.join(artifacts_dir, "replica_dag.#{ext}")
  File.write!(path, ReplicaSnapshot.export(graph, format) <> "\n")
  V.say("wrote #{Path.relative_to(path, Path.expand("..", __DIR__))}")
end

IO.puts("\n\e[1m\e[32mVisual demo complete — the quarantined op is the red dashed node.\e[0m")
