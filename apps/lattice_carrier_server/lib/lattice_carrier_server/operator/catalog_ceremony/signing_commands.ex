defmodule LatticeCarrierServer.Operator.CatalogCeremony.SigningCommands do
  @moduledoc false
  alias Lattice.Log

  alias LatticeCarrierServer.Operator.{
    CatalogBinding,
    CatalogSigningPackage,
    PublicArtifact,
    PublicHistory
  }

  alias LatticeCarrierServer.Operator.CatalogCeremony.{SignCatalog, SigningLedger, Store}
  alias Treehouse.TransportCatalog

  @spec review(keyword()) :: {:ok, map()} | {:error, atom()}
  def review(opts) do
    with {:ok, bytes} <- package(opts),
         {:ok, package} <- SignCatalog.review(bytes, opts[:ceremony]) do
      {:ok, sheet(package)}
    end
  end

  @spec init(keyword()) :: {:ok, map()} | {:error, atom()}
  def init(opts) do
    with {:ok, binding} <- CatalogBinding.load(opts[:ceremony], opts[:space_log]),
         {:ok, state} <- SigningLedger.init(opts[:ceremony], binding),
         :ok <- PublicArtifact.write(opts[:out], SigningLedger.export_status(state, binding)) do
      {:ok, %{"custodian_status" => Path.expand(opts[:out]), "binding" => binding.bootstrap_id}}
    end
  end

  @spec status(keyword()) :: {:ok, map()} | {:error, atom()}
  def status(opts) do
    with {:ok, bytes} <- package(opts),
         {:ok, package} <- SignCatalog.review(bytes, opts[:ceremony]),
         {:ok, state} <- SigningLedger.status(opts[:ceremony], package.binding),
         text = SigningLedger.export_status(state, package.binding),
         :ok <- PublicArtifact.write(opts[:out], text) do
      {:ok,
       %{"custodian_status" => Path.expand(opts[:out]), "binding" => package.binding.bootstrap_id}}
    end
  end

  @spec sign(keyword()) :: {:ok, map()} | {:error, atom()}
  def sign(opts) do
    with {:ok, bytes} <- package(opts),
         {:ok, envelope} <-
           SignCatalog.sign(bytes, opts[:ceremony], opts[:signer], opts[:confirm_catalog]),
         :ok <- PublicArtifact.write(opts[:out], envelope) do
      {:ok, %{"signed_catalog" => Path.expand(opts[:out]), "sha256" => Store.sha256(envelope)}}
    end
  end

  defp package(opts) do
    case opts[:package] do
      path when is_binary(path) and path != "" ->
        path = Path.expand(path)
        Store.read_text(Path.dirname(path), Path.basename(path), 67_108_864)

      _ ->
        {:error, :catalog_package_required}
    end
  end

  @spec sheet(map()) :: map()
  def sheet(package) do
    %{
      "binding" => package.binding.bootstrap_id,
      "catalog_id" => TransportCatalog.catalog_id(package.catalog),
      "confirm_catalog" => CatalogSigningPackage.digest(package.catalog),
      "revision" => package.catalog.revision,
      "previous" => package.catalog.previous,
      "inventory" =>
        Enum.map(package.catalog.entries, fn entry ->
          %{
            "replica" => entry.replica,
            "root" => Base.encode64(entry.root),
            "route" => entry.route,
            "reference" => entry.reference,
            "kind" => Atom.to_string(entry.kind)
          }
        end),
      "snapshots" =>
        Enum.map(Enum.sort_by(package.histories, &elem(&1, 0)), fn {replica, log} ->
          frontier = Log.frontier(log) |> Enum.sort() |> PublicHistory.canonical()

          %{
            "replica" => replica,
            "frames" => map_size(log.ops),
            "frontier_sha256" => Store.sha256(frontier)
          }
        end),
      "claim" =>
        "Dated signed-history review; full histories expose plaintext to custodian and backup readers. No route installation or live freshness receipt."
    }
  end
end
