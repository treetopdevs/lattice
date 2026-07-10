defmodule LatticeNodeSpike.TownshipRootOriginationScenario do
  @moduledoc """
  Empty Township carrier scenario for release-app root origination probes.

  The regular Township scenario starts from a deterministic clerk-created matter.
  This scenario starts with empty logs at the runtime-provided, root-bound replica
  id so an installed app can author the first legitimate genesis itself.
  """

  alias Lattice.{Identity, Log, Sim}
  alias Township.Matter

  @seed "township-g1"
  @realms ["clerk", "founder"]

  @spec replica_module() :: module()
  def replica_module, do: Matter

  @spec realms() :: [String.t()]
  def realms, do: @realms

  @spec base_sim(String.t()) :: Sim.t()
  def base_sim(replica) when is_binary(replica) do
    realms = Map.new(@realms, fn id -> {id, Identity.from_seed(id, "#{@seed}:#{id}")} end)
    logs = Map.new(@realms, fn id -> {id, Log.new(replica)} end)
    caps = Map.new(@realms, fn id -> {id, []} end)

    %Sim{module: Matter, replica: replica, realms: realms, logs: logs, caps: caps}
  end

  @spec diverge(Sim.t(), String.t()) :: Sim.t()
  def diverge(%Sim{} = sim, _realm), do: sim

  @spec session_identity(String.t()) :: Identity.t()
  def session_identity(realm), do: Identity.from_seed(realm, @seed)

  @spec state_bytes(Log.t()) :: binary()
  def state_bytes(%Log{} = log) do
    Matter
    |> Lattice.state(log)
    |> :erlang.term_to_binary([:deterministic, {:minor_version, 2}])
  end
end
