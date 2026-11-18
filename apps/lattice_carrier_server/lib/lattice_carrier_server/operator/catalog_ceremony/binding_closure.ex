defmodule LatticeCarrierServer.Operator.CatalogCeremony.BindingClosure do
  @moduledoc """
  Row 360 (plan 316 PR 3 residual, D-459): the custodian refuses to sign under a
  closed binding.

  Closure is the PR 4a resolver's judgment, never a raw read of Space frames:
  `Treehouse.CatalogBindingGraph.resolve/1` runs over the package's authenticated
  Space history, its Thread histories, the custodian ledger's own signed envelopes
  below the package's revision (plus the stored copy of the package's own catalog)
  and any rotations and catalogs the caller retains (D-916: a replay is judged on the
  evidence its first signing had, since an older package carries no histories for a
  newer revision's entries). The ledger's copies are authoritative (D-915): a retained
  catalog whose id the ledger holds at any revision never reaches the resolver, and
  two conflicting retained copies of one id are unresolved. The ledger's binding id in
  `CatalogBindingGraph.closed/1` (D-275, which includes an ancestor of a cited
  rotation) or in `closed_out/1` is `:catalog_binding_closed`; every resolver error,
  every malformed input, any raw-evidence replacement and any retained catalog or
  rotation the resolver refuses (D-917: forged evidence could otherwise hide closure) is
  `:catalog_binding_unresolved`. Both refuse.

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
    with {:ok, input, kept} <- input(package, ledger_chain, retained),
         {:ok, graph} <- CatalogBindingGraph.resolve(input) do
      id = Binding.binding_id(package.binding)

      cond do
        id in CatalogBindingGraph.closed(graph) or
            Map.has_key?(CatalogBindingGraph.closed_out(graph), id) ->
          {:error, :catalog_binding_closed}

        hidden?(graph, kept) ->
          {:error, :catalog_binding_unresolved}

        true ->
          :ok
      end
    else
      _ -> {:error, :catalog_binding_unresolved}
    end
  rescue
    _ -> {:error, :catalog_binding_unresolved}
  catch
    _, _ -> {:error, :catalog_binding_unresolved}
  end

  # D-917: evidence the resolver rejects can hide closure. A replacement citing an
  # intrinsically invalid prior is raw evidence with no closing effect (OD-17), so a forged
  # retained copy of a catalog or rotation the ledger does not hold (ids exclude signatures)
  # would turn a closed binding into an open one. Any retained catalog or rotation the
  # resolver refuses, and any raw-evidence replacement refuted for its evidence rather than
  # for its authority (an ineligible author never closes anything), refuse as unresolved.
  defp hidden?(graph, kept) do
    refusals = Map.fetch!(graph, :refusals)

    Enum.any?(kept, &Map.has_key?(refusals, &1)) or
      Enum.any?(Map.fetch!(graph, :raw_evidence), fn {_, why} ->
        why != :catalog_authority_refused
      end)
  end

  defp input(package, chain, retained) do
    binding = package.binding

    with %Log{} = space <- space(package),
         {:ok, record} <- Binding.bootstrap_record(space, binding.bootstrap_id),
         true <- bootstrap_matches?(binding, record),
         {:ok, catalogs, kept} <- catalogs(package, chain, Keyword.get(retained, :catalogs, [])),
         {:ok, rotations} <-
           unique(Keyword.get(retained, :rotations, []), &TransportCatalog.rotation_id/1) do
      {:ok,
       %{
         bootstrap: %{id: binding.bootstrap_id, record: record},
         space: space,
         histories: Map.delete(package.histories, space.replica),
         rotations: rotations,
         catalogs: catalogs,
         proven_cutoffs: [],
         accepted: nil
       }, kept ++ Map.keys(rotations)}
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

  # D-915: the ledger's verified envelopes are authoritative. Catalog ids exclude the
  # signature, so a retained copy under a ledger id (at any revision, including the ones
  # D-916 leaves out) is dropped rather than allowed to shadow or stand in for it.
  # D-916: only ledger revisions below the package's, plus the stored package catalog
  # itself, are evidence. That is what the first signing of this revision saw; a newer
  # revision's entries have no histories in an older package and would pend. Leaving one
  # out never opens a closed binding: a citation of an unheld catalog pends (refuses).
  defp catalogs(package, chain, retained) do
    signed =
      Enum.map(chain, fn %{bytes: bytes} ->
        {:ok, envelope} = TransportCatalog.decode_catalog_json(bytes)
        envelope
      end)

    ledger = MapSet.new(signed, &TransportCatalog.catalog_id(&1.catalog))
    revision = package.catalog.revision

    evidence =
      Enum.filter(signed, &(&1.catalog.revision < revision or &1.catalog == package.catalog))

    with {:ok, kept} <- unique(retained, &TransportCatalog.catalog_id(&1.catalog)) do
      kept = Map.reject(kept, fn {id, _} -> MapSet.member?(ledger, id) end)

      {:ok, Map.merge(kept, Map.new(evidence, &{TransportCatalog.catalog_id(&1.catalog), &1})),
       Map.keys(kept)}
    end
  end

  # Retained artifacts keyed by id; byte-identical duplicates collapse, while two different
  # envelopes under one id are ambiguous evidence and refuse as unresolved.
  defp unique(artifacts, id_of) do
    Enum.reduce_while(artifacts, {:ok, %{}}, fn artifact, {:ok, acc} ->
      id = id_of.(artifact)

      case acc do
        %{^id => ^artifact} -> {:cont, {:ok, acc}}
        %{^id => _} -> {:halt, :error}
        _ -> {:cont, {:ok, Map.put(acc, id, artifact)}}
      end
    end)
  end
end
