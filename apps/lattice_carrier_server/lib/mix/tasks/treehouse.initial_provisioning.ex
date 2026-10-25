defmodule Mix.Tasks.Treehouse.InitialProvisioning do
  @shortdoc "Verify an ordinary Treehouse public bundle and prepare new offline operator files"
  @moduledoc """
  Linux-only initial provisioning import, without starting or modifying a relay.

      mix treehouse.initial_provisioning --bundle FILE --ceremony DIR \\
        --output NEW_DIR --operator-root PRIVATE_DIR --identity-file SERVICE_SEED_FILE \\
        --space-port PORT --thread-port PORT

  The operator root and service identity must already exist. Output is a new
  private directory; an exact completed retry is read-only. Conflicts and partial
  imports are preserved and refused. Listener ports must be explicit and nonzero.
  Public host/proxy mapping remains a separate deployment step. Stdout reports public output paths and the attempt id, never seed or bundle contents.
  """
  use Mix.Task
  alias LatticeCarrierServer.Operator.{InitialBundle, InitialProvisioning}

  @impl Mix.Task
  def run(argv) do
    {opts, rest, invalid} =
      OptionParser.parse(argv,
        strict: [
          bundle: :string,
          ceremony: :string,
          output: :string,
          operator_root: :string,
          identity_file: :string,
          space_port: :integer,
          thread_port: :integer
        ]
      )

    required = [
      :bundle,
      :ceremony,
      :output,
      :operator_root,
      :identity_file,
      :space_port,
      :thread_port
    ]

    unless rest == [] and invalid == [] and Enum.all?(required, &Keyword.has_key?(opts, &1)) and
             length(Keyword.keys(opts)) == length(Enum.uniq(Keyword.keys(opts))) do
      Mix.raise("refused: invalid_initial_provisioning_options")
    end

    Mix.Task.run("compile")
    Mix.Task.run("app.config")
    {:ok, _} = Application.ensure_all_started(:crypto)

    case InitialProvisioning.prepare(opts) do
      {:ok, result} ->
        Mix.shell().info(
          InitialBundle.canonical(%{
            "index" => result.index,
            "inputs_bundle" => Path.join(Path.dirname(result.index), "bundle.json"),
            "active_manifest" => result.active_manifest,
            "attempt" => result.request.attempt,
            "claim" => "verified_offline_import"
          })
        )

      {:error, reason} ->
        Mix.raise("refused: #{reason}")
    end
  end
end
