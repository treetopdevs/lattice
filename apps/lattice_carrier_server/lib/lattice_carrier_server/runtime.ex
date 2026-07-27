defmodule LatticeCarrierServer.Runtime do
  @moduledoc """
  Manifest-driven boot for the pilot carrier release.

  `prepare/1` loads the deployment manifest fail-closed and returns the child
  specifications for one isolated `LatticeCarrierServer` per manifest instance.
  Instance options (including the `Secret`-wrapped identity) are held in
  `:persistent_term`, so supervisor child specifications carry only the
  instance name — never key material.

  This runtime performs transport and durable custody of signed bytes only.
  It makes no high-availability, multiplexed-protocol, E2EE, server-push, or
  semantic-authority claim.
  """

  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Health, Holder, Manifest}

  @deployment_key {__MODULE__, :deployment}
  @instance_names_key {__MODULE__, :instance_names}

  @spec prepare(nil | Path.t()) :: {:ok, [Supervisor.child_spec()]} | {:error, term()}
  def prepare(nil) do
    clear_stale_instances([])
    :persistent_term.erase(@deployment_key)
    {:ok, []}
  end

  def prepare(manifest_path) when is_binary(manifest_path) do
    case Manifest.load(manifest_path) do
      {:ok, manifest} ->
        with :ok <- preflight_instances(manifest.instances) do
          :ok = Health.reset_storage_cache(Enum.map(manifest.instances, & &1.log_file))
          clear_stale_instances(manifest.instances)

          Enum.each(manifest.instances, fn instance ->
            :persistent_term.put(instance_key(instance.name), instance)
            :persistent_term.erase(route_started_key(instance.name))
          end)

          :persistent_term.put(@deployment_key, %{
            health: manifest.health,
            instances:
              Enum.map(manifest.instances, fn instance ->
                %{
                  name: instance.name,
                  realm: instance.realm,
                  identity_file: instance.identity_file,
                  pub: instance.pub,
                  log_file: instance.log_file
                }
              end)
          })

          {:ok,
           Enum.map(manifest.instances, &instance_child_spec/1) ++
             health_children(manifest.health)}
        end

      {:error, _reason} = error ->
        clear()
        error
    end
  end

  @doc "Public (non-secret) view of the prepared deployment, or nil."
  @spec deployment() :: %{health: keyword() | nil, instances: [map()]} | nil
  def deployment, do: :persistent_term.get(@deployment_key, nil)

  @doc false
  @spec start_instance(String.t()) :: Supervisor.on_start()
  def start_instance(name) do
    instance = :persistent_term.get(instance_key(name))

    LatticeCarrierServer.start_link(
      instance: instance.name,
      identity: instance.identity,
      trusted_peers: instance.trusted_peers,
      relay_realms: instance.relay_realms,
      state_reporter: instance.state_reporter,
      source: {:path, instance.log_file},
      listener: instance.listener
    )
  end

  @doc false
  @spec route_started?(String.t()) :: boolean()
  def route_started?(name), do: :persistent_term.get(route_started_key(name), false)

  @doc false
  @spec mark_route_started(String.t()) :: :ok
  def mark_route_started(name) do
    :persistent_term.put(route_started_key(name), true)
    :ok
  end

  @doc false
  @spec clear() :: :ok
  def clear do
    :persistent_term.get(@instance_names_key, MapSet.new())
    |> Enum.each(fn name ->
      :persistent_term.erase(instance_key(name))
      :persistent_term.erase(route_started_key(name))
    end)

    :persistent_term.erase(@instance_names_key)
    :persistent_term.erase(@deployment_key)
    :ok
  end

  defp instance_child_spec(instance) do
    %{
      id: {LatticeCarrierServer, instance.name},
      start: {__MODULE__.RouteOwner, :start_link, [instance.name]},
      restart: :permanent,
      type: :worker
    }
  end

  # The health listener starts after every instance, so readiness can only
  # be probed once the instances it reports on exist.
  defp health_children(nil), do: []
  defp health_children(health), do: [Health.child_spec(health)]

  defp instance_key(name), do: {__MODULE__, {:instance, name}}
  defp route_started_key(name), do: {__MODULE__, {:route_started, name}}

  defp clear_stale_instances(instances) do
    current_names = MapSet.new(instances, & &1.name)
    previous_names = :persistent_term.get(@instance_names_key, MapSet.new())

    previous_names
    |> MapSet.difference(current_names)
    |> Enum.each(fn name ->
      :persistent_term.erase(instance_key(name))
      :persistent_term.erase(route_started_key(name))
    end)

    :persistent_term.put(@instance_names_key, current_names)
    :ok
  end

  defp preflight_instances(instances) do
    Enum.reduce_while(instances, :ok, fn instance, :ok ->
      case preflight_instance(instance) do
        :ok -> {:cont, :ok}
        {:error, _reason} = error -> {:halt, error}
      end
    end)
  end

  defp preflight_instance(instance) do
    case Holder.restore_path(instance.log_file) do
      {:ok, %Log{}} ->
        case Durability.rehearse_target(Durability.Posix, instance.log_file) do
          :ok -> :ok
          {:error, _reason} -> {:error, {:durability_unsupported, instance.ref}}
        end

      {:error, _reason} ->
        {:error, {:source_restore_failed, instance.ref}}
    end
  end
end

defmodule LatticeCarrierServer.Runtime.RouteOwner do
  @moduledoc false

  use GenServer

  alias LatticeCarrierServer.Runtime

  @initial_backoff_ms 100
  @max_backoff_ms 5_000

  @spec start_link(String.t()) :: GenServer.on_start()
  def start_link(name), do: GenServer.start_link(__MODULE__, name)

  @impl GenServer
  def init(name) do
    Process.flag(:trap_exit, true)

    case Runtime.start_instance(name) do
      {:ok, route} ->
        :ok = Runtime.mark_route_started(name)
        {:ok, %{name: name, route: route, backoff_ms: @initial_backoff_ms}}

      {:error, reason} ->
        if Runtime.route_started?(name) do
          state = %{name: name, route: nil, backoff_ms: @initial_backoff_ms}
          {:ok, schedule_restart(state)}
        else
          {:stop, reason}
        end
    end
  end

  @impl GenServer
  def handle_info(:start_route, state) do
    case Runtime.start_instance(state.name) do
      {:ok, route} ->
        :ok = Runtime.mark_route_started(state.name)
        {:noreply, %{state | route: route, backoff_ms: @initial_backoff_ms}}

      {:error, _reason} ->
        {:noreply, schedule_restart(state)}
    end
  end

  def handle_info({:EXIT, route, _reason}, %{route: route} = state) do
    {:noreply, state |> Map.put(:route, nil) |> schedule_restart()}
  end

  def handle_info({:EXIT, _other, _reason}, state), do: {:noreply, state}

  defp schedule_restart(state) do
    Process.send_after(self(), :start_route, state.backoff_ms)
    %{state | backoff_ms: min(state.backoff_ms * 2, @max_backoff_ms)}
  end
end
