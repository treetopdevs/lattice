defmodule LatticeNodeSpike.Application do
  @moduledoc false

  use Application

  @impl Application
  def start(_type, _args) do
    :ok = LatticeNodeSpike.CarrierTelemetry.attach_default_logger()
    Supervisor.start_link([], strategy: :one_for_one, name: LatticeNodeSpike.Supervisor)
  end
end
