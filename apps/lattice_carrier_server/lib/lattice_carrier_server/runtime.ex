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

  alias LatticeCarrierServer.Manifest

  @deployment_key {__MODULE__, :deployment}

  @spec prepare(nil | Path.t()) :: {:ok, [Supervisor.child_spec()]} | {:error, term()}
  def prepare(nil), do: {:ok, []}

  def prepare(manifest_path) when is_binary(manifest_path) do
    case Manifest.load(manifest_path) do
      {:ok, manifest} ->
        Enum.each(manifest.instances, fn instance ->
          :persistent_term.put(instance_key(instance.name), instance)
        end)

        :persistent_term.put(@deployment_key, %{
          health: manifest.health,
          instances:
            Enum.map(manifest.instances, fn instance ->
              %{name: instance.name, pub: instance.pub, log_file: instance.log_file}
            end)
        })

        {:ok, Enum.map(manifest.instances, &instance_child_spec/1)}

      {:error, _reason} = error ->
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

  defp instance_child_spec(instance) do
    %{
      id: {LatticeCarrierServer, instance.name},
      start: {__MODULE__, :start_instance, [instance.name]},
      type: :supervisor
    }
  end

  defp instance_key(name), do: {__MODULE__, {:instance, name}}
end
