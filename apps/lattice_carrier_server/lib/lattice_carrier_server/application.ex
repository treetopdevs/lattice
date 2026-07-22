defmodule LatticeCarrierServer.Application do
  @moduledoc false

  use Application

  alias LatticeCarrierServer.Runtime

  @impl Application
  def start(_type, _args) do
    manifest_path = Application.get_env(:lattice_carrier_server, :manifest)

    # Fail closed: a missing or corrupt manifest, identity file, or log
    # refuses application startup rather than starting a partial deployment
    # or minting a fresh community.
    case Runtime.prepare(manifest_path) do
      {:ok, manifest_children} ->
        children =
          [
            {Registry, keys: :unique, name: LatticeCarrierServer.Registry}
          ] ++ configured_server() ++ manifest_children

        Supervisor.start_link(children,
          strategy: :rest_for_one,
          name: LatticeCarrierServer.ApplicationSupervisor
        )

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp configured_server do
    case Application.get_env(:lattice_carrier_server, :server_options) do
      nil -> []
      opts when is_list(opts) -> [{LatticeCarrierServer, opts}]
    end
  end
end
