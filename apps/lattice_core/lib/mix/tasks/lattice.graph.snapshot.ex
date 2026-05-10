defmodule Mix.Tasks.Lattice.Graph.Snapshot do
  @moduledoc """
  Prints a Lattice process/trust graph snapshot.

      mix lattice.graph.snapshot
      mix lattice.graph.snapshot --format dot
      mix lattice.graph.snapshot --format mermaid
  """

  use Mix.Task

  @shortdoc "Export the Lattice graph as JSON, DOT, or Mermaid"

  @impl true
  def run(args) do
    Mix.Task.run("app.start")

    {opts, _rest, _invalid} = OptionParser.parse(args, strict: [format: :string])
    format = Keyword.get(opts, :format, "json")

    Lattice.Graph.snapshot()
    |> Lattice.Graph.Export.export(format)
    |> Mix.shell().info()
  end
end
