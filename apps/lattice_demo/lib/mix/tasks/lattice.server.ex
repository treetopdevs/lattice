defmodule Mix.Tasks.Lattice.Server do
  @moduledoc """
  Starts the browser-facing Lattice WebSocket demo server.
  """

  use Mix.Task

  @shortdoc "Start the Lattice browser demo server"

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    port =
      args
      |> List.first()
      |> case do
        nil -> 4040
        value -> String.to_integer(value)
      end

    Lattice.reset!()
    LatticeServer.DemoHub.reset()

    {:ok, _pid} =
      LatticeServer.start_http(
        port: port,
        grant_targets: %{
          "echo" => Lattice.Demo.EchoServer,
          {"echo", :ops} => ["call", "cast"]
        }
      )

    IO.puts("Lattice browser demo listening on http://localhost:#{port}")
    Process.sleep(:infinity)
  end
end
