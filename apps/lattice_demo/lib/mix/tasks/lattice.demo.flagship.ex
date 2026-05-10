defmodule Mix.Tasks.Lattice.Demo.Flagship do
  @moduledoc """
  Starts the flagship wallet/process graph browser demo.
  """

  use Mix.Task

  @shortdoc "Start the Lattice flagship graph inspector demo"

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    port =
      args
      |> List.first()
      |> case do
        nil -> 4041
        value -> String.to_integer(value)
      end

    Lattice.Flagship.reset()

    {:ok, _pid} =
      LatticeServer.start_http(
        port: port,
        static_dir: Path.expand("examples/flagship_demo", File.cwd!()),
        auto_story?: false,
        grant_targets: %{}
      )

    IO.puts("Lattice flagship demo listening on http://localhost:#{port}")
    IO.puts("Press Ctrl-C twice to stop.")
    Process.sleep(:infinity)
  end
end
