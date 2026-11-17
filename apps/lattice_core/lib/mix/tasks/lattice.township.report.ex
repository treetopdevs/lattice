defmodule Mix.Tasks.Lattice.Township.Report do
  @moduledoc """
  Write a self-contained HTML auditor report for a Township audit bundle.

      mix lattice.township.report --dir artifacts/township [--out PATH]

  The default output is `<dir>.report.html` beside the bundle directory. An `--out`
  inside the bundle directory is refused, since it would corrupt the bundle's exact
  verifiable file set. The file is always written; a bundle that fails verification
  gets a NOT VERIFIED report and a non-zero exit.
  """

  use Mix.Task

  alias Township.AuditReport

  @shortdoc "Write an HTML auditor report for a Township audit bundle"

  @impl Mix.Task
  def run(argv) do
    {opts, rest, invalid} = OptionParser.parse(argv, strict: [dir: :string, out: :string])

    dir = opts[:dir]
    out = opts[:out]

    if is_binary(dir) and dir != "" and rest == [] and invalid == [] do
      report(dir, if(out in [nil, ""], do: default_out(dir), else: out))
    else
      Mix.raise("usage: mix lattice.township.report --dir PATH [--out PATH]")
    end
  end

  defp default_out(dir) do
    dir = Path.expand(dir)
    Path.join(Path.dirname(dir), Path.basename(dir) <> ".report.html")
  end

  defp report(dir, out) do
    dir = Path.expand(dir)
    out = Path.expand(out)

    if out == dir or String.starts_with?(out, dir <> "/") do
      Mix.raise("refusing --out inside the bundle directory: #{out}")
    end

    Mix.Task.run("app.start")
    File.mkdir_p!(Path.dirname(out))

    case AuditReport.render(dir) do
      {:ok, html, :verified} ->
        File.write!(out, html)
        Mix.shell().info("Township audit report written: #{out} (VERIFIED)")

      {:failed, html, errors} ->
        File.write!(out, html)

        Mix.raise(
          "Township audit bundle verification failed (report written to #{out}):\n- " <>
            Enum.join(errors, "\n- ")
        )
    end
  end
end
