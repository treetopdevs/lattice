defmodule LatticeCarrierServer.Operator.CatalogCeremony.SignCatalog do
  @moduledoc """
  Independent custodian review and bounded catalog signing.

  All package and ledger verification precedes private-key access. Returned
  signatures have a durable immutable ledger entry and head acknowledgment.
  """
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Secret
  alias LatticeCarrierServer.Operator.{CatalogSigningPackage, PublicHistory}
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Paths, Signer, SigningLedger}
  alias Treehouse.TransportCatalog

  @spec review(binary(), Path.t()) :: {:ok, map()} | {:error, atom()}
  def review(bytes, ceremony), do: CatalogSigningPackage.review(bytes, ceremony)

  @spec status(binary(), Path.t()) :: {:ok, map()} | {:error, atom()}
  def status(bytes, ceremony) do
    with {:ok, package} <- review(bytes, ceremony),
         do: SigningLedger.status(ceremony, package.binding)
  end

  @spec sign(binary(), Path.t(), Path.t(), String.t()) :: {:ok, binary()} | {:error, atom()}
  def sign(bytes, ceremony, signer_path, confirmed_digest) do
    with {:ok, package} <- review(bytes, ceremony),
         true <- confirmed_digest == package.digest,
         :ok <- capacity(package.catalog) do
      SigningLedger.transact(ceremony, package.binding, "open", fn state ->
        choose(package, state, ceremony, signer_path)
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

  defp capacity(catalog) do
    if catalog.revision < SigningLedger.max_envelopes(),
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

      SigningLedger.extends?(package.catalog, state.committed) ->
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
