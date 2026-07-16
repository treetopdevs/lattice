defmodule Mix.Tasks.Lattice.Township.VerifyBundle do
  @moduledoc """
  Verify a Township outsider audit bundle from its `matter.log` root.

      mix lattice.township.verify_bundle --dir artifacts/township
  """

  use Mix.Task

  alias Township.AuditBundle

  @shortdoc "Verify a Township outsider audit bundle"

  @impl Mix.Task
  def run(argv) do
    {opts, rest, invalid} = OptionParser.parse(argv, strict: [dir: :string])

    case {opts[:dir], rest, invalid} do
      {dir, [], []} when is_binary(dir) and dir != "" -> verify(dir)
      _other -> Mix.raise("usage: mix lattice.township.verify_bundle --dir PATH")
    end
  end

  defp verify(dir) do
    case AuditBundle.verify(dir) do
      :ok ->
        Mix.shell().info("Township audit bundle verified: #{Path.expand(dir)}")

      {:error, errors} ->
        Mix.raise("Township audit bundle verification failed:\n- #{Enum.join(errors, "\n- ")}")
    end
  end
end
