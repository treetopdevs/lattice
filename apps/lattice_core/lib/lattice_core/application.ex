defmodule LatticeCore.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      Lattice.Audit,
      Lattice.IFC,
      Lattice.Graph.Annotations,
      Lattice.Flagship,
      Lattice.CapStore,
      Lattice.Topology,
      {DynamicSupervisor, name: Lattice.TabWorkerSupervisor, strategy: :one_for_one},
      Lattice.LiveOps,
      # Lattice 2.0 — logical clock + Replica materialization plane
      Lattice.Clock,
      {Registry, keys: :unique, name: Lattice.Materializer.Registry},
      {DynamicSupervisor, name: Lattice.MaterializerSupervisor, strategy: :one_for_one},
      Lattice.Registry
    ]

    opts = [strategy: :one_for_one, name: LatticeCore.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
