defmodule Mix.Tasks.Lattice.Research.Demo do
  @moduledoc """
  Runs the executable research demonstrator suite.
  """

  use Mix.Task

  @shortdoc "Run Lattice research demos"

  @impl true
  def run(_args) do
    Mix.Task.run("app.start")
    Lattice.reset!()

    demos = [
      cap_wallet: Lattice.Demo.CapWallet.run_demo(),
      agent_tools: Lattice.Demo.AgentTools.run_demo(),
      live_introspection: Lattice.Demo.LiveIntrospection.run_demo(),
      federated_workers: Lattice.Demo.FederatedWorkers.run_demo(),
      red_team: Lattice.RedTeam.Sandbox.run(),
      graph_policy: Lattice.Graph.Policy.check_current()
    ]

    IO.puts("Lattice research demonstrator")

    Enum.each(demos, fn {name, result} ->
      IO.puts("\n#{name}")
      IO.puts(inspect(result, pretty: true, limit: :infinity))
    end)
  end
end
