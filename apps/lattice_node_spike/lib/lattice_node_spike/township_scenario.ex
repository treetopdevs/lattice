defmodule LatticeNodeSpike.TownshipScenario do
  @moduledoc """
  Deterministic Township G1 scenario for the real-carrier harness.

  The existing node-spike carrier stack is already generic below `Peer`, so the
  Township path should parameterize the peer on a scenario module instead of
  copying the WebSocket server. This module keeps the civic-specific prefix,
  divergence, and Sim oracle in one place while leaving `Township.Matter`,
  `Lattice.Attestation`, and the carrier untouched.
  """

  alias Lattice.{Identity, Log, Sim}
  alias Township.Matter

  @replica "replica:matter:township-g1"
  @seed "township-g1"
  @realms ["clerk", "resident"]

  @spec replica_module() :: module()
  def replica_module, do: Matter

  @spec realms() :: [String.t()]
  def realms, do: @realms

  @spec replica() :: String.t()
  def replica, do: Sim.replica(base_sim())

  @doc """
  Shared deterministic prefix for both physical BEAM processes.

  The clerk creates the civic matter, grants the resident ordinary civic
  commands, and admits both identities. Each OS process can derive this prefix
  independently from seeded identities.
  """
  @spec base_sim() :: Sim.t()
  def base_sim do
    sim = Sim.new(Matter, @replica, @realms, seed: @seed)

    {sim, _genesis} =
      Sim.create_replica(sim, "clerk",
        policies: %{clerk: %{successor: "resident", dormant_ticks: 3}}
      )

    {sim, _grant} =
      Sim.grant(sim, "clerk", "resident", ops: [:admit, :post, :set_summary, :set_title])

    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "clerk", :admit, ["clerk"])
    {sim, _} = Sim.command(sim, "clerk", :admit, ["resident"])
    Sim.sync_all(sim)
  end

  @doc "Commands `realm` authors while physically partitioned."
  @spec diverge(Sim.t(), String.t()) :: Sim.t()
  def diverge(%Sim{} = sim, "clerk") do
    {sim, _} = Sim.command(sim, "clerk", :set_summary, ["Leaning approve (clerk edit)"])
    {sim, _} = Sim.command(sim, "clerk", :post, ["clerk: hearing Tuesday 6pm"])
    {sim, _} = Sim.command(sim, "clerk", :close_matter, [])

    {sim, _} =
      Sim.transfer(sim, "clerk", "resident", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    {sim, _} = Sim.command(sim, "clerk", :reopen_matter, [])
    sim
  end

  def diverge(%Sim{} = sim, "resident") do
    {sim, _} = Sim.command(sim, "resident", :set_summary, ["Needs traffic study"])
    {sim, _} = Sim.command(sim, "resident", :post, ["resident: posted while offline"])
    sim
  end

  @doc """
  In-process oracle for the physical carrier run: partition, diverge, heal, sync.
  """
  @spec oracle_sim() :: Sim.t()
  def oracle_sim do
    base_sim()
    |> Sim.partition("clerk", "resident")
    |> diverge("clerk")
    |> diverge("resident")
    |> Sim.heal("clerk", "resident")
    |> Sim.sync_all()
  end

  @doc "Seeded session identity for the given scenario realm."
  @spec session_identity(String.t()) :: Identity.t()
  def session_identity(realm), do: Identity.from_seed(realm, @seed)

  @doc "Deterministic bytes of the Township materialized state."
  @spec state_bytes(Log.t()) :: binary()
  def state_bytes(%Log{} = log) do
    Matter
    |> Lattice.state(log)
    |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])
  end
end
