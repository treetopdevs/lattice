defmodule LatticeCarrierServer.Operator.CatalogCeremony.SignCatalog do
  @moduledoc """
  Independent custodian review and bounded catalog signing.

  All package and ledger verification precedes private-key access. Returned
  signatures have a durable immutable ledger entry and head acknowledgment.
  """
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Secret
  alias LatticeCarrierServer.Operator.{CatalogSigningPackage, PublicHistory}

  alias LatticeCarrierServer.Operator.CatalogCeremony.{
    Binding,
    BindingClosure,
    Paths,
    Signer,
    SigningLedger
  }

  alias Treehouse.TransportCatalog

  @spec review(binary(), Path.t()) :: {:ok, map()} | {:error, atom()}
  def review(bytes, ceremony), do: CatalogSigningPackage.review(bytes, ceremony)

  @spec status(binary(), Path.t()) :: {:ok, map()} | {:error, atom()}
  def status(bytes, ceremony) do
    with {:ok, package} <- review(bytes, ceremony),
         do: SigningLedger.status(ceremony, package.binding)
  end

  # The CLI, `sign/4` and `status/2` are bootstrap-only: no CLI path reaches a
  # replacement binding (the replacement ceremony is OD-13, row 361). `sign_reviewed/4`
  # is the shared signing step for a package whose binding a caller has already
  # reviewed; it refuses under a closed binding (row 360, `BindingClosure`).
  @spec sign(binary(), Path.t(), Path.t(), String.t()) :: {:ok, binary()} | {:error, atom()}
  def sign(bytes, ceremony, signer_path, confirmed_digest) do
    with {:ok, package} <- review(bytes, ceremony),
         do: sign_reviewed(package, ceremony, signer_path, confirmed_digest)
  rescue
    _ -> {:error, :catalog_signing_refused}
  catch
    _, _ -> {:error, :catalog_signing_refused}
  end

  @doc false
  @spec sign_reviewed(map(), Path.t(), Path.t(), String.t()) ::
          {:ok, binary()} | {:error, atom()}
  def sign_reviewed(package, ceremony, signer_path, confirmed_digest),
    do: sign_reviewed(package, ceremony, signer_path, confirmed_digest, [])

  # Row 360: inside the ledger lock and before any key access or ledger write, the
  # PR 4a resolver judges the binding over the package's histories, the ledger's own
  # signed envelopes and `opts[:retained]` (`rotations:` and `catalogs:` envelopes).
  # A closed or unresolvable binding refuses, including a replay of a stored revision.
  @doc false
  @spec sign_reviewed(map(), Path.t(), Path.t(), String.t(), keyword()) ::
          {:ok, binary()} | {:error, atom()}
  def sign_reviewed(package, ceremony, signer_path, confirmed_digest, opts) do
    with true <- confirmed_digest == package.digest,
         # The confirmation must still describe the catalog being signed, and that
         # catalog must belong to the ledger's binding, before any key access.
         true <- CatalogSigningPackage.digest(package.catalog) == package.digest,
         true <- catalog_in_scope?(package.catalog, package.binding),
         :ok <- capacity(package.catalog, package.binding) do
      retained = Keyword.get(opts, :retained, [])

      SigningLedger.transact(ceremony, package.binding, "open", fn state ->
        with :ok <- BindingClosure.check(package, state.chain, retained),
             do: choose(package, state, ceremony, signer_path)
      end)
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :catalog_confirmation_mismatch}
    end
  rescue
    _ -> {:error, :catalog_signing_refused}
  catch
    _, _ -> {:error, :catalog_signing_refused}
  end

  defp catalog_in_scope?(catalog, binding),
    do:
      catalog.binding == Binding.binding_id(binding) and
        catalog.bootstrap == binding.bootstrap_id and catalog.space == binding.record.space

  defp capacity(catalog, binding) do
    if catalog.revision < SigningLedger.max_envelopes(binding),
      do: :ok,
      else: {:error, :catalog_ledger_capacity}
  end

  defp choose(package, state, ceremony, path) do
    stored = Enum.find(state.chain, &(&1.catalog == package.catalog))

    cond do
      state.pending != nil and state.pending.catalog == package.catalog ->
        persist(package, state.pending.bytes)

      stored != nil ->
        {:ok, state.head_bytes, stored.bytes, stored.bytes}

      state.pending != nil ->
        {:error, :catalog_ledger_fork}

      SigningLedger.extends?(package.catalog, state.committed, package.binding) ->
        with {:ok, canonical} <- Paths.signer(path, Path.expand(ceremony), :real),
             {:ok, secret, pub} <- Signer.read_seed(canonical),
             true <- pub == package.binding.record.catalog_key do
          envelope = %{
            catalog: package.catalog,
            signature:
              :crypto.sign(:eddsa, :none, TransportCatalog.catalog_bytes(package.catalog), [
                Secret.unwrap(secret),
                :ed25519
              ])
          }

          :ok = TransportCatalog.verify_catalog(envelope, pub)
          persist(package, PublicHistory.canonical(Wire.encode_value(envelope)))
        else
          {:error, _} = refusal -> refusal
          _ -> {:error, :signer_key_mismatch}
        end

      true ->
        {:error, :catalog_ledger_fork}
    end
  end

  defp persist(package, envelope) do
    head =
      SigningLedger.head(
        package.binding,
        package.catalog.revision,
        TransportCatalog.catalog_id(package.catalog)
      )

    {:ok, head, envelope, envelope}
  end
end
