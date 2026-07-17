defmodule Mix.Tasks.Township.Bench.G13 do
  @shortdoc "Run the G13 coercion-resistance cost harness (reference-algorithm simulation)"
  @moduledoc """
  G13 measurement harness.

      mix township.bench.g13
      mix township.bench.g13 --variant chide_quadratic
      mix township.bench.g13 --scales 100,1000,10000 --json

  Prices the candidate construction's DOMINANT cost against its reference algorithms
  in single-process simulation, per §13 step 5 of the ZK findings doc. Runs before any
  role runner exists; emits the metric set gate 13 mandates. Makes no claim, flips no
  SecurityProfile value, touches neither Township.Matter nor Lattice.Attestation.
  """
  use Mix.Task

  alias TownshipBench.Reporter

  @impl Mix.Task
  def run(argv) do
    {opts, _, _} =
      OptionParser.parse(argv,
        strict: [variant: :string, scales: :string, json: :boolean]
      )

    variant =
      case opts[:variant] do
        "chide_quadratic" -> :chide_quadratic
        _ -> :chide_encrypted_sort
      end

    scales =
      case opts[:scales] do
        nil -> [100, 1_000, 10_000]
        s -> s |> String.split(",") |> Enum.map(&String.to_integer/1)
      end

    report = Reporter.run(scales, variant)
    IO.puts(Reporter.human(report))
    if opts[:json], do: Reporter.write_json(report)
  end
end
