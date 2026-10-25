defmodule Mix.Tasks.Treehouse.CatalogEvidence do
  @moduledoc "Export a listed operator snapshot as public catalog evidence without starting a relay."
  use Mix.Task
  alias LatticeCarrierServer.Operator.CatalogEvidence
  @shortdoc "Export public listed catalog evidence"

  @impl Mix.Task
  def run(argv) do
    Mix.Task.run("app.config")

    case execute(argv) do
      {:ok, path} -> Mix.shell().info(path)
      {:error, reason} -> Mix.raise(Atom.to_string(reason))
    end
  end

  @spec execute([String.t()]) :: {:ok, Path.t()} | {:error, atom()}
  def execute(argv) do
    {options, rest, invalid} =
      OptionParser.parse(argv,
        strict: [
          root: [:string, :keep],
          ceremony: [:string, :keep],
          manifest: [:string, :keep],
          out: [:string, :keep]
        ]
      )

    if rest == [] and invalid == [] and
         Enum.sort(Keyword.keys(options)) == [:ceremony, :manifest, :out, :root] do
      CatalogEvidence.export(
        options[:root],
        options[:ceremony],
        options[:manifest],
        options[:out]
      )
    else
      {:error, :invalid_evidence_options}
    end
  rescue
    _ -> {:error, :invalid_evidence_options}
  end
end
