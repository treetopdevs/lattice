defmodule LatticeCarrierServer.Operator.CatalogCeremony do
  @moduledoc """
  Operator ceremony tooling for the Treehouse catalog signer (plan 223, row 224).

  The ceremony prepares the custody inputs for a later catalogued phase; it is
  an operator record, not catalog publication, and it never signs anything in
  real mode. The commands are:

    * `generate/1` and `import_signer/1` make or adopt the catalog signer seed file.
    * `backup/1` writes a passphrase-encrypted copy; `verify_backup/1` proves
      it decrypts to the same public key without reading the signer file and
      can restore the seed to another path.
    * `binding_payload/1` derives the closed bootstrap record the Space root
      must author from a bounded-profile Space log; `verify_binding/1` checks
      an already-signed Space log carries exactly that record.
    * `report/1` re-checks the artifacts and records who holds what.
    * `dry_run/1` rehearses the whole flow with labelled disposable keys.

  Custody: no secret is read from a default location, the environment or argv.
  Seeds move only through explicit file paths whose parent directory is private
  to the operator and outside any git work tree; the passphrase comes from
  stdin. Seeds and passphrases live inside `LatticeCarrierServer.Secret`. The
  ceremony directory holds public artifacts only. Every refusal is an
  `{:error, atom}`; a raise, throw or exit becomes `{:error, :catalog_ceremony_refused}`.
  """

  alias LatticeCarrierServer.Operator.CatalogCeremony.{
    Backup,
    Binding,
    DryRun,
    Report,
    Signer
  }

  @type result :: {:ok, map()} | {:error, atom()}

  @doc "Make a new random signer seed at `:signer` and record its public key in `:ceremony`."
  @spec generate(keyword()) :: result()
  def generate(opts), do: guarded(fn -> Signer.generate(opts, :real) end)

  @doc "Adopt an existing seed file (a restored signer) at `:signer`."
  @spec import_signer(keyword()) :: result()
  def import_signer(opts), do: guarded(fn -> Signer.import_seed(opts, :real) end)

  @doc "Write the encrypted backup to `:out`; the passphrase is read twice by `:passphrase_reader` or stdin."
  @spec backup(keyword()) :: result()
  def backup(opts), do: guarded(fn -> Backup.create(opts, :real) end)

  @doc "Decrypt `:backup` (passphrase read once) without the signer file; `:restore_to` also writes the seed."
  @spec verify_backup(keyword()) :: result()
  def verify_backup(opts), do: guarded(fn -> Backup.verify(opts, :real) end)

  @doc "Write the bootstrap payload and review sheet for `:space_log`, `:service_public_key` and `:origin`."
  @spec binding_payload(keyword()) :: result()
  def binding_payload(opts), do: guarded(fn -> Binding.payload(opts, :real) end)

  @doc "Check the signed `:space_log` carries exactly the payload record, authored by the Space root."
  @spec verify_binding(keyword()) :: result()
  def verify_binding(opts), do: guarded(fn -> Binding.verify(opts, :real) end)

  @doc "Write the verification report naming `:custodian`, `:passphrase_holder` and `:rotation_owner`."
  @spec report(keyword()) :: result()
  def report(opts), do: guarded(fn -> Report.build(opts, :real) end)

  @doc "Rehearse the flow in a new or empty `:ceremony` directory with disposable keys."
  @spec dry_run(keyword()) :: result()
  def dry_run(opts), do: guarded(fn -> DryRun.run(opts) end)

  # No refusal may carry a term that could hold key material.
  defp guarded(fun) do
    case fun.() do
      {:ok, _} = ok -> ok
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :catalog_ceremony_refused}
    end
  rescue
    _ -> {:error, :catalog_ceremony_refused}
  catch
    _, _ -> {:error, :catalog_ceremony_refused}
  end
end
