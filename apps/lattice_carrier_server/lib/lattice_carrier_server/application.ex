defmodule LatticeCarrierServer.Application do
  @moduledoc false

  use Application

  alias LatticeCarrierServer.{Health, Runtime}

  @impl Application
  def start(_type, _args) do
    manifest_path = Application.get_env(:lattice_carrier_server, :manifest)

    gate_children =
      if is_binary(manifest_path),
        do: [{LatticeCarrierServer.Operator.ReleaseGate, latch: :atomics.new(1, [])}],
        else: []

    children =
      [{Health.StorageCache, []}, {Registry, keys: :unique, name: LatticeCarrierServer.Registry}] ++
        gate_children ++
        [{LatticeCarrierServer.RuntimeSupervisor, {manifest_path, configured_server()}}]

    case Supervisor.start_link(children,
           strategy: :rest_for_one,
           name: LatticeCarrierServer.ApplicationSupervisor
         ) do
      {:ok, _pid} = started ->
        started

      {:error, _reason} = error ->
        Runtime.clear()
        error
    end
  end

  @impl Application
  def stop(_state), do: Runtime.clear()

  defp configured_server do
    case Application.get_env(:lattice_carrier_server, :server_options) do
      nil -> []
      opts when is_list(opts) -> [{LatticeCarrierServer, opts}]
    end
  end
end

defmodule LatticeCarrierServer.RuntimeSupervisor do
  @moduledoc false

  use Supervisor

  @spec start_link([Supervisor.child_spec() | {module(), term()}]) :: Supervisor.on_start()
  def start_link(children), do: Supervisor.start_link(__MODULE__, children, name: __MODULE__)

  @impl Supervisor
  def init({manifest_path, configured}) do
    owner = if is_binary(manifest_path), do: LatticeCarrierServer.Operator.ReleaseGate.owner()

    case LatticeCarrierServer.Runtime.prepare_owned(manifest_path, owner, configured != []) do
      {:ok, children} -> Supervisor.init(configured ++ children, strategy: :one_for_one)
      {:error, reason} -> raise "carrier release preflight refused: #{inspect(reason)}"
    end
  end

  def init(children), do: Supervisor.init(children, strategy: :one_for_one)
end
