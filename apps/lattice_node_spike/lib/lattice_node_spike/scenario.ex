defmodule LatticeNodeSpike.Scenario do
  @moduledoc """
  The deterministic convergence scenario both OS processes derive independently.

  Everything is seeded (`Lattice.Identity.from_seed/2`) and Ed25519 signing is
  deterministic, so the *shared prefix* (genesis, grant, initial joins) built by
  each OS process is byte-identical — no key or op exchange is needed to
  establish the Replica on both nodes. Divergence (`diverge/2`) is what each
  side appends while the socket is closed; the union of both sides' ops is the
  op set the `Lattice.Sim` oracle (`oracle_sim/0`) replays over the simulated
  `Lattice.Net` with an explicit partition + heal.
  """

  alias Lattice.Demo.Thread
  alias Lattice.{Log, Sim}

  @replica "replica:thread:carrier-spike"
  @seed "carrier-spike"
  @realms ["node_a", "node_b"]

  @spec replica_module() :: module()
  def replica_module, do: Thread

  @spec replica() :: String.t()
  def replica, do: @replica

  @doc """
  Shared deterministic prefix: node_a creates the Thread, grants node_b, both
  join, fully synced. Identical (op-for-op, byte-for-byte) on every node that
  computes it.
  """
  @spec base_sim() :: Sim.t()
  def base_sim do
    sim = Sim.new(Thread, @replica, @realms, seed: @seed)

    {sim, _genesis} =
      Sim.create_replica(sim, "node_a",
        policies: %{moderator: %{successor: "node_b", dormant_ticks: 3}}
      )

    {sim, _grant} = Sim.grant(sim, "node_a", "node_b", ops: [:post, :set_title, :join, :leave])
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "node_a", :join, ["node_a"])
    {sim, _} = Sim.command(sim, "node_b", :join, ["node_b"])
    Sim.sync_all(sim)
  end

  @doc """
  Commands `realm` authors while disconnected. node_a (the moderator) locks the
  thread offline-authoritatively; node_b's lock attempt is unauthorized and must
  be quarantined *identically* on both sides after heal.
  """
  @spec diverge(Sim.t(), String.t()) :: Sim.t()
  def diverge(%Sim{} = sim, "node_a") do
    {sim, _} = Sim.command(sim, "node_a", :post, ["node_a: deploy window is 17:00"])
    {sim, _} = Sim.command(sim, "node_a", :set_title, ["Carrier spike (node_a edit)"])
    {sim, _} = Sim.command(sim, "node_a", :lock, [])
    sim
  end

  def diverge(%Sim{} = sim, "node_b") do
    {sim, _} = Sim.command(sim, "node_b", :post, ["node_b: ack, watching dashboards"])
    {sim, _} = Sim.command(sim, "node_b", :set_title, ["Carrier spike (node_b edit)"])
    # node_b holds no :lock capability — authored, synced, then quarantined at
    # reduction on every replica (authority soundness across the carrier).
    {sim, _} = Sim.command(sim, "node_b", :lock, [])
    sim
  end

  @doc """
  In-process oracle: the same divergence replayed through `Lattice.Sim` over the
  simulated `Lattice.Net`, with an explicit partition + heal + full sync.
  """
  @spec oracle_sim() :: Sim.t()
  def oracle_sim do
    base_sim()
    |> Sim.partition("node_a", "node_b")
    |> diverge("node_a")
    |> diverge("node_b")
    |> Sim.heal("node_a", "node_b")
    |> Sim.sync_all()
  end

  @doc "Deterministic bytes of the reduced state — the byte-identity oracle."
  @spec state_bytes(Log.t()) :: binary()
  def state_bytes(%Log{} = log) do
    Thread
    |> Lattice.state(log)
    |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])
  end
end
