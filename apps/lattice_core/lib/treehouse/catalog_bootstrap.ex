defmodule Treehouse.CatalogBootstrap do
  @moduledoc """
  Read-only observation of every authenticated, honored Space catalog bootstrap.

  This does not choose a trusted record, resolve competing bootstraps, or persist
  a pin. The caller must retain the complete history and apply the catalog trust
  contract separately. Rejected-signature evidence remains in the source log.
  """

  alias Lattice.{Authority, Log, Op}
  alias Treehouse.{Space, TransportCatalog}

  @spec observe(term()) :: {:ok, map()} | {:error, :invalid_verified_history}
  def observe(log) do
    with :ok <- Log.verify_authenticity(log) do
      analysis = Authority.analyze(Space, log)

      bootstraps =
        for %Op{kind: :command, body: {:catalog_bootstrap_v1, [record]}, id: id} <-
              Log.topo_ops(log),
            not MapSet.member?(analysis.quarantine, id) do
          {:ok, normalized} = TransportCatalog.normalize_bootstrap(record)
          %{id: id, record: normalized}
        end

      {:ok, %{bootstraps: bootstraps, verified_frontier: Log.frontier(log)}}
    else
      _ -> {:error, :invalid_verified_history}
    end
  rescue
    _ -> {:error, :invalid_verified_history}
  end
end
