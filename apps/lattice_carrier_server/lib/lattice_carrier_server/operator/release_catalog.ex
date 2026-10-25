defmodule LatticeCarrierServer.Operator.ReleaseCatalog do
  @moduledoc """
  Rebuild, independently sign, and durably record one ready release's catalog.

  Preparation returns only public transfer evidence. Commit repeats the live
  review and binds the returned envelope to that exact candidate and history
  snapshot before asking the existing Linux mutation owner to record it.
  """
  alias Lattice.{Authority, Op}
  alias Lattice.Carrier.Wire

  alias LatticeCarrierServer.Operator.{
    CatalogSigningPackage,
    CatalogStore,
    Journal,
    Lock,
    PublicHistory,
    ReferenceMode,
    ReleaseReadiness
  }

  alias LatticeCarrierServer.Operator.CatalogCeremony.{SigningCommands, SigningLedger, Store}
  alias Treehouse.TransportCatalog

  @spec prepare(Path.t(), binary(), Path.t(), Path.t(), Path.t()) ::
          {:ok, map()} | {:error, atom()}
  def prepare(root, expected, ceremony, probe, status_path) do
    with {:ok, review} <- ReleaseReadiness.review(root, expected, probe, ceremony, "ready"),
         {:ok, store, envelopes} <- store(root, review.binding.record.catalog_key),
         true <- store.head == review.record["catalog_head"],
         {:ok, candidate} <- candidate(review, envelopes, store.head),
         {:ok, status_bytes} <- read(status_path, 67_108_864),
         {:ok, status} <- SigningLedger.verify_status(status_bytes, review.binding),
         :ok <- custodian_current(status, store.head, candidate.catalog),
         :ok <- pending_current(store, envelopes, candidate.catalog),
         {:ok, package} <- CatalogSigningPackage.review(candidate.package, ceremony) do
      {:ok, Map.put(candidate, :sheet, SigningCommands.sheet(package))}
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :stale_catalog_head}
    end
  rescue
    _ -> {:error, :catalog_publication_refused}
  catch
    _, _ -> {:error, :catalog_publication_refused}
  end

  @spec commit(Path.t(), binary(), Path.t(), Path.t(), Path.t(), Path.t()) ::
          {:ok, map()} | {:error, atom()}
  def commit(root, expected, ceremony, probe, package_path, envelope_path) do
    with {:ok, package_bytes} <- read(package_path, 67_108_864),
         {:ok, package} <- CatalogSigningPackage.review(package_bytes, ceremony),
         {:ok, envelope_bytes} <- read(envelope_path, 131_072),
         {:ok, %{catalog: catalog} = envelope} <-
           TransportCatalog.decode_catalog_json(envelope_bytes),
         true <- PublicHistory.canonical(Wire.encode_value(envelope)) == envelope_bytes,
         true <- catalog == package.catalog,
         :ok <- TransportCatalog.verify_catalog(envelope, package.binding.record.catalog_key),
         {:ok, actual} when is_binary(actual) <- Journal.read(root),
         {:ok, record} <- Journal.decode(actual),
         phase when phase in ["ready", "catalogued"] <- record["phase"],
         {:ok, review} <- ReleaseReadiness.review(root, actual, probe, ceremony, phase),
         true <- review.binding == package.binding,
         {:ok, expected_record} <- Journal.decode(expected),
         true <- expected_record["phase"] == "ready",
         :ok <- expected_current(root, expected, actual, record, catalog, envelope_bytes),
         {:ok, store, envelopes} <- store(root, review.binding.record.catalog_key),
         {:ok, rebuilt} <- candidate(review, envelopes, expected_record["catalog_head"]),
         true <- rebuilt.catalog == catalog,
         :ok <- extends_snapshot(package.histories, review.current.pairs),
         :ok <- pending_current(store, envelopes, catalog),
         {:ok, _} <- CatalogSigningPackage.review(rebuilt.package, ceremony),
         {:ok, next} <- publish(root, expected, review, catalog, envelope_bytes) do
      {:ok, next}
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :catalog_publication_refused}
    end
  rescue
    _ -> {:error, :catalog_publication_refused}
  catch
    _, _ -> {:error, :catalog_publication_refused}
  end

  defp expected_current(root, expected, actual, record, catalog, bytes) do
    cond do
      actual == expected and record["phase"] == "ready" ->
        :ok

      record["phase"] == "catalogued" ->
        catalogs = Enum.filter(record["artifacts"], &(&1["kind"] == "catalog"))

        base =
          record
          |> Map.put("phase", "ready")
          |> Map.put("catalog_head", catalog.previous)
          |> Map.put("artifacts", Enum.reject(record["artifacts"], &(&1["kind"] == "catalog")))

        if Journal.encode(base) == expected and catalogs == [artifact(root, catalog, bytes)],
          do: :ok,
          else: {:error, :stale_operator_intent}

      true ->
        {:error, :stale_operator_intent}
    end
  end

  defp publish(
         _root,
         _expected,
         %{record: %{"phase" => "catalogued"} = record},
         _catalog,
         _bytes
       ),
       do: {:ok, record}

  defp publish(root, expected, review, catalog, bytes) do
    next =
      review.record
      |> Map.put("phase", "catalogued")
      |> Map.put("catalog_head", TransportCatalog.catalog_id(catalog))
      |> Map.update!("artifacts", &(&1 ++ [artifact(root, catalog, bytes)]))

    with :ok <-
           Lock.catalogued(
             root,
             expected,
             %{path: review.deployment.manifest_path, sha256: review.digest},
             Journal.encode(next),
             review.deployment.incarnation,
             bytes
           ),
         do: {:ok, next}
  end

  defp artifact(root, catalog, bytes) do
    sha = Journal.digest(bytes)

    %{
      "kind" => "catalog",
      "op_id" => TransportCatalog.catalog_id(catalog),
      "path" => CatalogStore.file_path(root, sha),
      "replica" => catalog.space,
      "review" => nil,
      "sha256" => sha
    }
  end

  defp candidate(review, envelopes, head) do
    [reference] = Enum.filter(review.record["artifacts"], &(&1["kind"] == "reference"))
    [child_artifact] = Enum.filter(review.record["artifacts"], &(&1["kind"] == "log"))

    pairs =
      Map.new(review.current.pairs, fn {instance, log} -> {log.replica, {instance, log}} end)

    with true <- map_size(pairs) == length(review.current.pairs),
         {space_instance, space} <- Map.fetch!(pairs, reference["replica"]),
         {child_instance, child} <- Map.fetch!(pairs, child_artifact["replica"]),
         {:ok, reference_bytes} <- read(reference["path"], 64_000),
         true <- Journal.digest(reference_bytes) == reference["sha256"],
         {:ok, raw_reference} <- Jason.decode(reference_bytes),
         {:ok, reference_op} <- Wire.decode_op(raw_reference),
         true <-
           Wire.encode_op(reference_op) == raw_reference and reference_op.id == reference["op_id"],
         {:ok, prior} <- prior(envelopes, head),
         old_entries = if(prior, do: prior.catalog.entries, else: []),
         :ok <- carried_references_present(old_entries, space),
         {:ok, initial} <- initial_entries(prior, space_instance, space, review.binding),
         new =
           entry(
             child_instance,
             child,
             :thread,
             child_artifact["op_id"],
             child_artifact["review"]["creation"],
             reference_op.id,
             review.binding
           ),
         entries = Enum.sort_by(old_entries ++ initial ++ [new], & &1.replica),
         :ok <- capacity(entries),
         :ok <- routes_current(entries, pairs, envelopes),
         catalog = %{
           version: 1,
           product: :treehouse,
           space: space.replica,
           bootstrap: review.binding.bootstrap_id,
           binding: review.binding.bootstrap_id,
           revision: if(prior, do: prior.catalog.revision + 1, else: 0),
           previous: head,
           entries: entries
         },
         {:ok, _} <- TransportCatalog.normalize_catalog(catalog),
         mode =
           if(ReferenceMode.initial?(reference["review"]),
             do: "initial_existing",
             else: "pending"
           ),
         histories =
           Map.new(entries, fn entry ->
             {entry.replica, elem(Map.fetch!(pairs, entry.replica), 1)}
           end),
         {:ok, package} <- CatalogSigningPackage.encode(catalog, histories, reference_op, mode) do
      {:ok, %{catalog: catalog, package: package}}
    else
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :catalog_invalid}
    end
  end

  defp carried_references_present(entries, space) do
    if Enum.all?(entries, &(&1.kind != :thread or Map.has_key?(space.ops, &1.reference))),
      do: :ok,
      else: {:error, :catalog_reference_pending}
  end

  defp capacity(entries) do
    if length(entries) <= 13, do: :ok, else: {:error, :catalog_capacity}
  end

  defp prior(_envelopes, nil), do: {:ok, nil}

  defp prior(envelopes, id) do
    case Map.fetch(envelopes, id) do
      {:ok, envelope} -> {:ok, envelope}
      :error -> {:error, :stale_catalog_head}
    end
  end

  defp initial_entries(prior, _instance, _space, _binding) when not is_nil(prior), do: {:ok, []}

  defp initial_entries(nil, instance, space, binding) do
    reasons = Authority.analyze(Treehouse.Space, space).reasons
    root = Authority.root(space)
    ops = Enum.reject(Map.values(space.ops), &Map.has_key?(reasons, &1.id))

    with [%Op{id: genesis}] <-
           Enum.filter(ops, &(&1.kind == :authority and &1.deps == [] and &1.author == root)),
         [%Op{id: creation}] <-
           Enum.filter(ops, &match?(%Op{kind: :command, body: {:create_space, [_]}}, &1)) do
      {:ok, [entry(instance, space, :space, genesis, creation, binding.bootstrap_id, binding)]}
    else
      _ -> {:error, :catalog_invalid}
    end
  end

  defp entry(instance, log, kind, genesis, creation, reference, binding),
    do: %{
      product: :treehouse,
      replica: log.replica,
      kind: kind,
      schema: if(kind == :space, do: :treehouse_space_v1, else: :treehouse_thread_v1),
      root: Authority.root(log),
      genesis: genesis,
      creation: creation,
      reference: reference,
      route: instance.route,
      service_id: binding.record.service_id,
      service_key: binding.record.service_key
    }

  defp routes_current(entries, pairs, envelopes) do
    stored = for {_id, envelope} <- envelopes, entry <- envelope.catalog.entries, do: entry

    valid =
      Enum.all?(entries, fn entry ->
        {instance, _log} = Map.fetch!(pairs, entry.replica)

        instance.route == entry.route and
          Enum.all?(stored, fn old ->
            (old.replica != entry.replica or old.route == entry.route) and
              (old.route != entry.route or old.replica == entry.replica)
          end)
      end)

    if valid, do: :ok, else: {:error, :catalog_route_reused}
  end

  defp custodian_current(status, head, catalog) do
    latest = List.last(status.chain)

    cond do
      latest == nil and head == nil -> :ok
      latest != nil and latest.id in [head, TransportCatalog.catalog_id(catalog)] -> :ok
      true -> {:error, :catalog_signature_pending}
    end
  end

  defp pending_current(%{pending: nil}, _envelopes, _catalog), do: :ok

  defp pending_current(store, envelopes, catalog) do
    if Map.fetch!(envelopes, store.pending.id).catalog == catalog,
      do: :ok,
      else: {:error, :catalog_fork}
  end

  defp extends_snapshot(histories, pairs) do
    current = Map.new(pairs, fn {_instance, log} -> {log.replica, log} end)

    if Enum.all?(histories, fn {replica, log} ->
         case current[replica] do
           nil -> false
           latest -> Enum.all?(log.ops, fn {id, op} -> latest.ops[id] == op end)
         end
       end), do: :ok, else: {:error, :catalog_history_replaced}
  end

  defp store(root, key) do
    with {:ok, info} <- CatalogStore.verify(root, key) do
      Enum.reduce_while(info.envelopes, {:ok, %{}}, fn {id, meta}, {:ok, envelopes} ->
        with {:ok, envelope} <- CatalogStore.load_envelope(root, meta.sha256, key) do
          {:cont, {:ok, Map.put(envelopes, id, envelope)}}
        else
          _ -> {:halt, {:error, :catalog_store_corrupt}}
        end
      end)
      |> case do
        {:ok, envelopes} -> {:ok, info, envelopes}
        refusal -> refusal
      end
    end
  end

  defp read(path, cap) when is_binary(path),
    do: Store.read_text(Path.dirname(Path.expand(path)), Path.basename(path), cap)

  defp read(_, _), do: {:error, :catalog_artifact_missing}
end
