defmodule LatticeCore.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      Lattice.Audit,
      Lattice.CapStore,
      Lattice.Topology,
      {DynamicSupervisor, name: Lattice.TabWorkerSupervisor, strategy: :one_for_one}
    ]

    opts = [strategy: :one_for_one, name: LatticeCore.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
