defmodule LatticeCarrierServer.Operator.ReleaseListing do
  @moduledoc """
  Publish the exact client-signed reference and record a dated local listed receipt.

  Review runs before a snapshot CAS delivery and again over the served histories.
  The Linux owner alone writes the journal; an existing exact initial reference
  is observed without rewriting the Space. No signing key is read here.
  """
  alias Lattice.{Log, Op}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Holder

  alias LatticeCarrierServer.Operator.{
    CatalogStore,
    Journal,
    ListingReview,
    Lock,
    ReleaseReadiness
  }

  alias LatticeCarrierServer.Operator.CatalogCeremony.Store
  alias Treehouse.{CatalogEntries, TransportCatalog}

  @owner_refusals %{
    "operator_busy" => :operator_busy,
    "stale_operator_intent" => :stale_operator_intent,
    "stale_operator_incarnation" => :stale_operator_incarnation,
    "operator_history_full" => :operator_history_full,
    "immutable_artifact_conflict" => :immutable_artifact_conflict
  }

  @spec publish(Path.t(), binary(), Path.t(), Path.t()) :: {:ok, map()} | {:error, atom()}
  def publish(root, expected, ceremony, probe) do
    with {:ok, actual, record} <- current(root, expected),
         {:ok, before} <- ReleaseReadiness.review(root, actual, probe, ceremony, record["phase"]),
         {:ok, context} <- context(root, before),
         holder = Holder.via(context.space_instance.name),
         :ok <- Holder.prove_durability(holder),
         {:ok, snapshot} <- Holder.courier_snapshot(holder),
         :ok <- snapshot_bound(snapshot, before),
         {:ok, proposed} <- ListingReview.run(context, snapshot),
         :ok <- before_courier(context.op.id),
         {:ok, _receipt} <- Holder.courier(holder, context.op, proposed.token),
         {:ok, after_review} <-
           ReleaseReadiness.review(root, actual, probe, ceremony, record["phase"]),
         true <- after_review.binding == before.binding,
         {:ok, after_context} <- context(root, after_review),
         true <- after_context.catalog == context.catalog and after_context.op == context.op,
         {:ok, histories} <- served_histories(after_context, after_review),
         true <- histories[context.catalog.space].ops[context.op.id] == context.op,
         {:ok, _} <- CatalogEntries.observe(context.catalog, histories),
         {:ok, listed} <- receipt(root, expected, after_review) do
      {:ok, listed}
    else
      {:error, {:operator_refused, reason}} when is_binary(reason) ->
        {:error, Map.get(@owner_refusals, reason, :listing_refused)}

      {:error, reason} when is_atom(reason) ->
        {:error, reason}

      _ ->
        {:error, :listing_refused}
    end
  rescue
    _ -> {:error, :listing_refused}
  catch
    _, _ -> {:error, :listing_refused}
  end

  # Test seam at the snapshot-CAS boundary; receives public reference id only.
  defp before_courier(id) do
    case Application.get_env(:lattice_carrier_server, :listing_courier_hook) do
      hook when is_function(hook, 1) -> hook.(id)
      _ -> :ok
    end

    :ok
  end

  defp current(root, expected) do
    with {:ok, %{"phase" => "catalogued"} = prior} <- Journal.decode(expected),
         true <- Journal.encode(prior) == expected,
         {:ok, actual} when is_binary(actual) <- Journal.read(root),
         {:ok, record} <- Journal.decode(actual),
         true <-
           (actual == expected and record == prior) or
             (record["phase"] == "listed" and record == Map.put(prior, "phase", "listed") and
                actual == Journal.encode(record)) do
      {:ok, actual, record}
    else
      _ -> {:error, :stale_operator_intent}
    end
  end

  defp context(root, review) do
    [artifact] = Enum.filter(review.record["artifacts"], &(&1["kind"] == "catalog"))
    [reference] = Enum.filter(review.record["artifacts"], &(&1["kind"] == "reference"))
    [child] = Enum.filter(review.record["artifacts"], &(&1["kind"] == "log"))

    pairs =
      Map.new(review.current.pairs, fn {instance, log} -> {log.replica, {instance, log}} end)

    with {:ok, store} <- CatalogStore.verify(root, review.binding.record.catalog_key),
         true <- store.head == review.record["catalog_head"] and store.pending == nil,
         true <- artifact["path"] == CatalogStore.file_path(root, artifact["sha256"]),
         {:ok, %{catalog: catalog}} <-
           CatalogStore.load_envelope(root, artifact["sha256"], review.binding.record.catalog_key),
         true <-
           TransportCatalog.catalog_id(catalog) == artifact["op_id"] and
             artifact["op_id"] == store.head,
         true <-
           catalog.space == artifact["replica"] and catalog.space == review.binding.record.space,
         true <-
           catalog.bootstrap == review.binding.bootstrap_id and
             catalog.binding == catalog.bootstrap,
         true <- map_size(pairs) == length(review.current.pairs),
         :ok <- routes(catalog, pairs),
         {:ok, bytes} <- read(reference["path"], 64_000),
         true <- Journal.digest(bytes) == reference["sha256"],
         {:ok, frame} <- Jason.decode(bytes),
         {:ok, op} <- Wire.decode_op(frame),
         true <- Wire.encode_op(op) == frame and Op.valid?(op),
         true <-
           op.id == reference["op_id"] and op.replica == reference["replica"] and
             op.replica == catalog.space,
         :command <- op.kind,
         {:create_thread, [child_replica, _title]} <- op.body,
         true <- child_replica == child["replica"],
         [entry] <-
           Enum.filter(catalog.entries, &(&1.replica == child_replica and &1.kind == :thread)),
         true <-
           entry.reference == op.id and entry.genesis == child["op_id"] and
             entry.creation == child["review"]["creation"] do
      histories =
        Map.new(catalog.entries, fn entry ->
          {entry.replica, elem(Map.fetch!(pairs, entry.replica), 1)}
        end)

      {:ok,
       %{
         catalog: catalog,
         histories: histories,
         op: op,
         roster: review.current.roster,
         binding: review.binding,
         space_instance: elem(Map.fetch!(pairs, catalog.space), 0),
         reference: %{
           bytes: bytes,
           op_id: op.id,
           replica: op.replica,
           review: reference["review"]
         },
         child: %{replica: child_replica, op_id: child["op_id"], review: child["review"]},
         child_log: Map.fetch!(histories, child_replica)
       }}
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :catalog_reference_mismatch}
    end
  end

  defp routes(catalog, pairs) do
    if Enum.all?(catalog.entries, fn entry ->
         case pairs[entry.replica] do
           {instance, _log} -> instance.route == entry.route
           _ -> false
         end
       end), do: :ok, else: {:error, :catalog_route_mismatch}
  end

  defp snapshot_bound(snapshot, review) do
    if snapshot.token.owner == review.deployment.owner,
      do: :ok,
      else: {:error, :release_boot_unguarded}
  end

  defp served_histories(context, review) do
    pairs =
      Map.new(review.current.pairs, fn {instance, log} -> {log.replica, {instance, log}} end)

    Enum.reduce_while(context.catalog.entries, {:ok, %{}}, fn entry, {:ok, histories} ->
      {instance, disk} = Map.fetch!(pairs, entry.replica)

      with {:ok, snapshot} <- Holder.served_snapshot(Holder.via(instance.name)),
           :ok <- snapshot_bound(snapshot, review),
           true <- snapshot.log == disk,
           :ok <- Log.verify_authenticity(snapshot.log) do
        {:cont, {:ok, Map.put(histories, entry.replica, snapshot.log)}}
      else
        _ -> {:halt, {:error, :served_history_changed}}
      end
    end)
  end

  defp receipt(root, _expected, %{record: %{"phase" => "listed"} = record}) do
    with {:ok, raw} <- Journal.read(root), true <- raw == Journal.encode(record) do
      {:ok, record}
    else
      _ -> {:error, :stale_operator_intent}
    end
  end

  defp receipt(root, expected, review) do
    record = Map.put(review.record, "phase", "listed")

    with :ok <-
           Lock.listed(
             root,
             expected,
             %{path: review.deployment.manifest_path, sha256: review.digest},
             Journal.encode(record),
             review.deployment.incarnation
           ),
         do: {:ok, record}
  end

  defp read(path, cap),
    do: Store.read_text(Path.dirname(Path.expand(path)), Path.basename(path), cap)
end
