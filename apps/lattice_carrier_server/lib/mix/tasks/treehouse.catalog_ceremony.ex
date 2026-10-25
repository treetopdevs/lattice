defmodule Mix.Tasks.Treehouse.CatalogCeremony do
  @shortdoc "Catalog signer custody ceremony (key generation, backup, binding payload, report)"
  @moduledoc """
  Operator ceremony for the Treehouse catalog signer (plan 223, row 224).

      mix treehouse.catalog_ceremony generate --signer PATH --ceremony DIR
      mix treehouse.catalog_ceremony import --signer PATH --ceremony DIR
      mix treehouse.catalog_ceremony backup --signer PATH --ceremony DIR --out BACKUP
      mix treehouse.catalog_ceremony verify-backup --backup BACKUP --ceremony DIR [--restore-to PATH]
      mix treehouse.catalog_ceremony binding-payload --ceremony DIR --space-log PATH \\
        --service-public-key BASE64 --origin wss://HOST[:PORT] [--service-id ID]
      mix treehouse.catalog_ceremony verify-binding --ceremony DIR --space-log PATH
      mix treehouse.catalog_ceremony report --ceremony DIR --custodian NAME \\
        --passphrase-holder NAME --rotation-owner NAME
      mix treehouse.catalog_ceremony dry-run --ceremony DIR
      mix treehouse.catalog_ceremony review-catalog --ceremony DIR --package PATH
      mix treehouse.catalog_ceremony init-ledger --ceremony DIR --space-log PATH --out STATUS
      mix treehouse.catalog_ceremony catalog-status --ceremony DIR --package PATH --out STATUS
      mix treehouse.catalog_ceremony sign-catalog --ceremony DIR --package PATH --signer KEY --confirm-catalog DIGEST --out ENVELOPE

  Run from the repository root. The task never starts the carrier application
  and signs only through explicit digest-confirmed sign-catalog. Secret paths are always explicit; the backup passphrase is
  read from stdin only (twice for `backup`, once for `verify-backup`), and only
  when stdin is a pipe or file: a terminal is refused, because echo cannot be
  turned off reliably from inside the VM (the runbook pipes it in from a silent
  shell `read`). Passphrases are printable ASCII, 20 to 1024 characters. Stdout
  carries public values; a refusal prints `refused: <atom>` to stderr and exits
  nonzero. See `docs/treehouse_catalog_signer_custody.md`.
  """
  use Mix.Task

  alias LatticeCarrierServer.Operator.CatalogCeremony.{Atoms, Cli}

  @impl Mix.Task
  def run(argv) do
    Mix.Task.run("compile")
    Mix.Task.run("app.config")
    {:ok, _} = Application.ensure_all_started(:crypto)
    Atoms.load()

    case Cli.run(argv) do
      :ok -> :ok
      {:error, _reason} -> exit({:shutdown, 1})
    end
  end
end
