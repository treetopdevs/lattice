defmodule LatticeNodeSpike.TownshipScenario do
  @moduledoc """
  Deterministic Township G1 scenario for the real WebSocket carrier.

  Both OS processes derive the same shared Township prefix locally. The socket
  close is the physical partition: each side appends its offline W0-W2 actions,
  then `Lattice.Carrier.sync/3` heals the logs. `oracle_sim/0` replays the same
  op set through `Lattice.Sim` so the carrier run has a byte-identical baseline.
  """

  alias Lattice.{Identity, Log, Sim}
  alias Township.Matter

  @replica "replica:matter:township-carrier-g1"
  @seed "township-carrier"
  @realms ["clerk", "resident"]

  @spec replica_module() :: module()
  def replica_module, do: Matter

  @spec replica() :: String.t()
  def replica, do: Sim.replica(base_sim())

  @spec session_identity(String.t()) :: Identity.t()
  def session_identity(realm), do: Identity.from_seed(realm, @seed)

  @doc """
  Shared deterministic Township prefix.

  Clerk creates the matter, delegates resident's civic participation caps, admits
  both visible members, and sets the public title. Every process can derive this
  locally with identical op ids before any carrier transfer occurs.
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
    {sim, _} = Sim.command(sim, "clerk", :set_title, ["Zoning variance #24"])

    Sim.sync_all(sim)
  end

  @doc "Offline W0-W2 actions authored while the socket is closed."
  @spec diverge(Sim.t(), String.t()) :: Sim.t()
  def diverge(%Sim{} = sim, "clerk") do
    {sim, _} = Sim.command(sim, "clerk", :post, ["clerk: hearing remains Tuesday 6pm"])
    {sim, _} = Sim.command(sim, "clerk", :set_summary, ["Leaning approve (clerk carrier edit)"])
    {sim, _} = Sim.command(sim, "clerk", :close_matter, [])

    {sim, _} =
      Sim.transfer(sim, "clerk", "resident", :clerk,
        at_tick: 1,
        ops: [:close_matter, :reopen_matter]
      )

    {sim, _} = Sim.command(sim, "clerk", :reopen_matter, [])
    sim
  end

  # Resident's post and summary edit should survive the heal. The intruder admit
  # cites no capability, so it must be semantically quarantined as `:no_capability`.
  def diverge(%Sim{} = sim, "resident") do
    {sim, _} = Sim.command(sim, "resident", :post, ["resident: traffic study requested"])

    {sim, _} =
      Sim.command(sim, "resident", :set_summary, ["Needs traffic study (resident carrier edit)"])

    {sim, _} = Sim.command(sim, "resident", :admit, ["intruder"], cap: :none)
    sim
  end

  @doc "The in-process oracle for the same op set transferred over the carrier."
  @spec oracle_sim() :: Sim.t()
  def oracle_sim do
    base_sim()
    |> Sim.partition("clerk", "resident")
    |> diverge("clerk")
    |> diverge("resident")
    |> Sim.heal("clerk", "resident")
    |> Sim.sync_all()
  end

  @doc "Deterministic bytes of the reduced Township state."
  @spec state_bytes(Log.t()) :: binary()
  def state_bytes(%Log{} = log) do
    Matter
    |> Lattice.state(log)
    |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])
  end
end
