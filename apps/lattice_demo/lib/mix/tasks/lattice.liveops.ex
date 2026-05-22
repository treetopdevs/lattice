defmodule Mix.Tasks.Lattice.Liveops do
  @moduledoc """
  Starts the browser-facing Lattice LiveOps demo server.
  """

  use Mix.Task

  @shortdoc "Start the Lattice LiveOps browser demo server"

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    port =
      args
      |> List.first()
      |> case do
        nil -> 4042
        value -> String.to_integer(value)
      end

    Lattice.reset!()
    LatticeServer.DemoHub.reset()

    {:ok, _pid} =
      LatticeServer.start_http(
        port: port,
        auto_story?: false,
        static_dir: Path.expand("examples/liveops_demo", File.cwd!())
      )

    IO.puts("Lattice LiveOps demo listening on http://localhost:#{port}")

    IO.puts(
      "Open with ?role=producer, ?role=graphics_operator, ?role=remote_camera, or ?role=observer."
    )

    Process.sleep(:infinity)
  end
end
