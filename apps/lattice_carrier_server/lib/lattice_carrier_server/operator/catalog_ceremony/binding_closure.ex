defmodule LatticeCarrierServer.Operator.CatalogCeremony.BindingClosure do
  @moduledoc """
  Row 360 (plan 316 PR 3 residual, D-459): the custodian refuses to sign under a
  closed binding.

  Closure is the PR 4a resolver's judgment, never a raw read of Space frames:
  `Treehouse.CatalogBindingGraph.resolve/1` runs over the package's authenticated
  Space history, its Thread histories, the custodian ledger's own signed envelopes
  and any rotations and catalogs the caller retains. The ledger's binding id in
  `CatalogBindingGraph.closed/1` (D-275, which includes an ancestor of a cited
  rotation) or in `closed_out/1` is `:catalog_binding_closed`; every resolver error
  and every malformed input is `:catalog_binding_unresolved`. Both refuse.

  Non-claims: closure is judged only over the Space history the package carries
  (no freshness guarantee; the custodian keeps no Space state of its own), and this
  is not retained-client acceptance, a route switch or 4c wiring.
  """

  alias Lattice.Log
  alias LatticeCarrierServer.Operator.CatalogCeremony.Binding
  alias Treehouse.{CatalogBindingGraph, TransportCatalog}

  @spec check(map(), [map()], keyword()) ::
          :ok | {:error, :catalog_binding_closed | :catalog_binding_unresolved}
  def check(package, ledger_chain, retained \\ []) do
    with {:ok, input} <- input(package, ledger_chain, retained),
         {:ok, graph} <- CatalogBindingGraph.resolve(input) do
      id = Binding.binding_id(package.binding)

      if id in CatalogBindingGraph.closed(graph) or
           Map.has_key?(CatalogBindingGraph.closed_out(graph), id),
         do: {:error, :catalog_binding_closed},
         else: :ok
    else
      _ -> {:error, :catalog_binding_unresolved}
    end
  rescue
    _ -> {:error, :catalog_binding_unresolved}
  catch
    _, _ -> {:error, :catalog_binding_unresolved}
  end

  defp input(package, chain, retained) do
    binding = package.binding

    with %Log{} = space <- space(package),
         {:ok, record} <- Binding.bootstrap_record(space, binding.bootstrap_id),
         true <- bootstrap_matches?(binding, record),
         {:ok, catalogs} <- catalogs(chain, Keyword.get(retained, :catalogs, [])) do
      {:ok,
       %{
         bootstrap: %{id: binding.bootstrap_id, record: record},
         space: space,
         histories: Map.delete(package.histories, space.replica),
         rotations:
           Map.new(
             Keyword.get(retained, :rotations, []),
             &{TransportCatalog.rotation_id(&1), &1}
           ),
         catalogs: catalogs,
         proven_cutoffs: [],
         accepted: nil
       }}
    else
      _ -> :error
    end
  end

  # D-910: the Space the package's entries were judged against at decode. For a
  # `pending` package that is the raw Space plus the one staged, Core-honored reference
  # op (`ReferenceMode.observe`); otherwise it equals the raw Space. A stored pending
  # catalog names that reference, so the raw Space would make its replay pend.
  defp space(%{catalog: %{space: replica}} = package) do
    case Map.get(package, :observed) do
      %{^replica => %Log{replica: ^replica} = log} -> log
      _ -> package.histories[replica]
    end
  end

  # A bootstrap binding's record must be exactly the Space's; with any other record the
  # resolver's honored-bootstrap check fails and the closed set would be silently empty.
  defp bootstrap_matches?(binding, record),
    do: Binding.binding_id(binding) != binding.bootstrap_id or record == binding.record

  defp catalogs(chain, retained) do
    signed =
      Enum.map(chain, fn %{bytes: bytes} ->
        {:ok, envelope} = TransportCatalog.decode_catalog_json(bytes)
        envelope
      end)

    {:ok, Map.new(signed ++ retained, &{TransportCatalog.catalog_id(&1.catalog), &1})}
  end
end
