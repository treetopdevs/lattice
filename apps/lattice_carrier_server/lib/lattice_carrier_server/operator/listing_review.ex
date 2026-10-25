defmodule LatticeCarrierServer.Operator.ListingReview do
  @moduledoc """
  Bounded pure judgment of an exact holder snapshot's proposed listing candidate.

  The context contains only already-verified public catalog, ceremony, artifacts
  and child histories. No filesystem access, signing or cross-holder call occurs
  in this worker. Its token cannot survive a change to the holder snapshot.
  """
  alias LatticeCarrierServer.Holder
  alias LatticeCarrierServer.Operator.{ReferenceMode, Staging}
  alias LatticeCarrierServer.Operator.CatalogCeremony.Binding
  alias Treehouse.CatalogEntries
  @timeout 10_000

  @spec run(map(), map()) :: {:ok, map()} | {:error, atom()}
  def run(context, snapshot) do
    caller = self()
    ref = make_ref()

    {pid, monitor} =
      spawn_monitor(fn ->
        worker = self()
        spawn(fn -> watch_owner(caller, worker) end)
        send(caller, {ref, candidate(context, snapshot)})
      end)

    receive do
      {^ref, result} ->
        Process.demonitor(monitor, [:flush])
        result

      {:DOWN, ^monitor, :process, ^pid, _} ->
        {:error, :listing_review_failed}
    after
      @timeout ->
        Process.exit(pid, :kill)
        Process.demonitor(monitor, [:flush])
        {:error, :listing_review_timeout}
    end
  end

  defp watch_owner(owner, worker) do
    owner_monitor = Process.monitor(owner)
    worker_monitor = Process.monitor(worker)

    receive do
      {:DOWN, ^owner_monitor, :process, ^owner, _} -> Process.exit(worker, :kill)
      {:DOWN, ^worker_monitor, :process, ^worker, _} -> :ok
    end
  end

  defp candidate(context, snapshot) do
    with :ok <- initial_present(context, snapshot.log),
         :ok <- same(Staging.roster(snapshot.log) == context.roster, :roster_drift_since_catalog),
         {:ok, proposed} <- Holder.prepare_courier(snapshot, context.op),
         :ok <- Binding.profile_unchanged(proposed.log, context.binding.record),
         {:ok, id} <- Binding.honored_bootstrap(proposed.log, context.binding.record),
         :ok <- same(id == context.binding.bootstrap_id, :service_binding_mismatch),
         bundle = %{reference: context.reference, child: context.child},
         {:ok, observed} <- ReferenceMode.observe_listing(bundle, proposed.log, context.child_log),
         :ok <- same(observed == proposed.log, :reference_not_honored),
         histories = Map.put(context.histories, proposed.log.replica, proposed.log),
         :ok <- current_entry(context.catalog, context.child.replica, histories),
         {:ok, _} <- CatalogEntries.observe(context.catalog, histories) do
      {:ok, proposed}
    else
      false ->
        {:error, :roster_drift_since_catalog}

      {:error, reason} when reason in [:trust_pending, :invalid_catalog_transition] ->
        {:error, :catalog_carried_entry_lapsed}

      {:error, reason} when is_atom(reason) ->
        {:error, reason}

      _ ->
        {:error, :reference_not_honored}
    end
  rescue
    _ -> {:error, :listing_review_failed}
  catch
    _, _ -> {:error, :listing_review_failed}
  end

  defp same(true, _reason), do: :ok
  defp same(_, reason), do: {:error, reason}

  defp initial_present(context, log) do
    if ReferenceMode.initial?(context.reference.review) and log.ops[context.op.id] != context.op,
      do: {:error, :reference_not_honored},
      else: :ok
  end

  defp current_entry(catalog, child_replica, histories) do
    current = %{
      catalog
      | entries: Enum.filter(catalog.entries, &(&1.kind == :space or &1.replica == child_replica))
    }

    case CatalogEntries.observe(current, histories) do
      {:ok, _} -> :ok
      _ -> {:error, :reference_not_honored}
    end
  end
end
