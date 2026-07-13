defmodule LatticeNodeSpike.TownshipOnboardingScenario do
  @moduledoc """
  Sim-anchored carrier state immediately before the resident's W1 post.

  The packaged onboarding proof needs the shared Township prefix, resident cap,
  and prior resident summary without the separate carrier partition storyline.
  Socket closes therefore leave this scenario unchanged while the app authors
  and pushes the next Sim-exported post.
  """

  alias Lattice.Sim
  alias LatticeNodeSpike.TownshipScenario

  @spec replica_module() :: module()
  defdelegate replica_module(), to: TownshipScenario

  @spec base_sim() :: Sim.t()
  def base_sim, do: base_sim(TownshipScenario.realms())

  @spec base_sim([String.t()]) :: Sim.t()
  def base_sim(realms) when is_list(realms) do
    sim = TownshipScenario.base_sim(realms)
    {sim, _summary} = Sim.command(sim, "resident", :set_summary, ["Needs traffic study"])
    Sim.sync_all(sim)
  end

  @spec diverge(Sim.t(), String.t()) :: Sim.t()
  def diverge(%Sim{} = sim, _realm), do: sim

  @spec session_identity(String.t()) :: Lattice.Identity.t()
  defdelegate session_identity(realm), to: TownshipScenario

  @spec state_bytes(Lattice.Log.t()) :: binary()
  defdelegate state_bytes(log), to: TownshipScenario
end
