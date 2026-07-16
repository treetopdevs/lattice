defmodule LatticeCarrierServer.Application do
  @moduledoc false

  use Application

  @impl Application
  def start(_type, _args) do
    children =
      [
        {Registry, keys: :unique, name: LatticeCarrierServer.Registry}
      ] ++ configured_server()

    Supervisor.start_link(children,
      strategy: :rest_for_one,
      name: LatticeCarrierServer.ApplicationSupervisor
    )
  end

  defp configured_server do
    case Application.get_env(:lattice_carrier_server, :server_options) do
      nil -> []
      opts when is_list(opts) -> [{LatticeCarrierServer, opts}]
    end
  end
end
