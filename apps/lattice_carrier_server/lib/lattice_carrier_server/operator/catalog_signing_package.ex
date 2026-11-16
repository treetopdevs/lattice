defmodule LatticeCarrierServer.Operator.CatalogSigningPackage do
  @moduledoc """
  Closed public evidence transferred to the independent catalog custodian.

  Decoding authenticates all histories and observes the exact staged reference.
  Review additionally checks the custodian's own completed ceremony. Neither
  operation signs, changes a journal, or installs client trust.
  """
  alias Lattice.{Authority, Log}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.Operator.{CatalogBinding, PublicHistory, ReferenceMode}
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Atoms, Binding}
  alias Treehouse.{CatalogBootstrap, CatalogEntries, TransportCatalog}

  @format "treehouse-catalog-signing-v1"
  @max_bytes 64 * 1024 * 1024
  @max_history_bytes 16 * 1024 * 1024
  @max_metadata_bytes 131_072
  @keys ~w(catalog digest format histories reference)

  @replacement_refusals ~w(binding_profile_changed binding_not_found binding_fork invalid_space_log
                           replacement_op_missing replacement_claim_mismatch
                           replacement_not_core_honored)a

  @doc """
  Encode the closed package. `reference` is the staged Thread reference op for the
  `pending` and `initial_existing` modes. The `replacement` mode (row 361) carries no
  staged reference: pass `nil`, and `reference.frame` is `nil` on the wire.
  """
  @spec encode(map(), %{String.t() => Log.t()}, map() | nil, String.t()) ::
          {:ok, binary()} | {:error, atom()}
  def encode(catalog, histories, reference, mode) do
    doc = %{
      "format" => @format,
      "catalog" => Wire.encode_value(catalog),
      "digest" => digest(catalog),
      "reference" => %{"mode" => mode, "frame" => frame(mode, reference)},
      "histories" =>
        histories
        |> Enum.sort_by(&elem(&1, 0))
        |> Enum.map(fn {replica, log} ->
          %{"replica" => replica, "frames" => PublicHistory.frames(log)}
        end)
    }

    bytes = PublicHistory.canonical(doc)
    with {:ok, _} <- decode(bytes), do: {:ok, bytes}
  rescue
    _ -> {:error, :invalid_catalog_package}
  end

  @spec decode(term()) :: {:ok, map()} | {:error, :invalid_catalog_package}
  def decode(bytes) when is_binary(bytes) and byte_size(bytes) <= @max_bytes do
    Atoms.load()

    with true <- String.valid?(bytes),
         {:ok, doc} when is_map(doc) <- JSON.decode(bytes),
         true <- Enum.sort(Map.keys(doc)) == @keys and doc["format"] == @format,
         true <-
           byte_size(PublicHistory.canonical(Map.delete(doc, "histories"))) <= @max_metadata_bytes,
         {:ok, catalog} <- Wire.decode_value(doc["catalog"]),
         {:ok, catalog} <- TransportCatalog.normalize_catalog(catalog),
         true <- Wire.encode_value(catalog) == doc["catalog"],
         true <- digest(catalog) == doc["digest"],
         {:ok, histories} <- histories(doc["histories"], catalog),
         {:ok, observed, reference} <- reference(doc["reference"], catalog, histories),
         {:ok, observable} <- observable(catalog, doc["reference"]["mode"], observed),
         {:ok, _} <- CatalogEntries.observe(observable, observed),
         true <- doc["reference"]["mode"] == "replacement" or catalog.binding == catalog.bootstrap,
         true <- PublicHistory.canonical(doc) == bytes do
      {:ok,
       %{
         catalog: catalog,
         digest: doc["digest"],
         histories: histories,
         observed: observed,
         reference: reference,
         mode: doc["reference"]["mode"],
         bytes: bytes
       }}
    else
      _ -> {:error, :invalid_catalog_package}
    end
  rescue
    _ -> {:error, :invalid_catalog_package}
  catch
    _, _ -> {:error, :invalid_catalog_package}
  end

  def decode(_), do: {:error, :invalid_catalog_package}

  @spec review(binary(), Path.t()) :: {:ok, map()} | {:error, atom()}
  def review(bytes, ceremony_dir) do
    with {:ok, package} <- decode(bytes),
         # A replacement package is reviewed only by `review_replacement/4` (row 361).
         true <- package.mode != "replacement",
         {:ok, binding} <-
           CatalogBinding.load_log(ceremony_dir, package.histories[package.catalog.space]),
         true <- binding.record.space == package.catalog.space,
         true <- binding.bootstrap_id == package.catalog.bootstrap,
         true <- binding.bootstrap_id == package.catalog.binding do
      {:ok, Map.put(package, :binding, binding)}
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :catalog_binding_mismatch}
    end
  rescue
    _ -> {:error, :invalid_catalog_package}
  end

  @doc """
  Review a `replacement` package against a supplied parent bootstrap binding, the
  replacement claim and the replacement op id (row 361 signing path, fixtures only).

  Derivation and structural review, not trust: `op_id` and `claim` must come from the
  caller (the PR 4 resolver, which does not exist yet). The Core-honored check is a
  call to `Authority.analyze` on the package's Space snapshot; it is not resolver
  acceptance and is not monotone under later revokes. No ceremony directory is read,
  because the new signer's ceremony is not built. Returns the package with the derived
  `Binding.replacement/3` binding under `:binding`.
  """
  @spec review_replacement(binary(), map(), map(), String.t()) ::
          {:ok, map()} | {:error, atom()}
  def review_replacement(bytes, parent, claim, op_id) do
    with {:ok, package} <- decode(bytes),
         true <- package.mode == "replacement",
         {:ok, claim} <- TransportCatalog.normalize_replacement_claim(claim),
         {:ok, derived} <- Binding.replacement(parent, claim, op_id),
         catalog = package.catalog,
         true <- catalog.bootstrap == parent.bootstrap_id,
         true <- catalog.binding == op_id,
         true <- catalog.space == parent.record.space,
         {:inventory, true} <-
           {:inventory, TransportCatalog.inventory_id(catalog.entries) == claim.inventory_digest},
         true <-
           Enum.all?(
             catalog.entries,
             &(&1.service_id == derived.record.service_id and
                 &1.service_key == derived.record.service_key)
           ),
         space = package.histories[catalog.space],
         :ok <- Binding.profile_unchanged(space, parent.record),
         {:ok, bootstrap} <- Binding.honored_bootstrap(space, parent.record),
         true <- bootstrap == parent.bootstrap_id,
         :ok <- replacement_op(space, op_id, claim),
         :ok <- core_honored(space, op_id) do
      {:ok, Map.put(package, :binding, derived)}
    else
      {:error, reason} when reason in @replacement_refusals -> {:error, reason}
      {:inventory, false} -> {:error, :catalog_inventory_mismatch}
      _ -> {:error, :catalog_binding_mismatch}
    end
  rescue
    _ -> {:error, :invalid_catalog_package}
  end

  # `CatalogEntries.observe/2` judges every entry's service identity against the
  # bootstrap record, which a replacement catalog by definition does not carry. For the
  # replacement mode the entries are projected onto the bootstrap record's service for
  # that structural observation only (history, root, genesis and creation checks); the
  # replacement's own service identity is judged in `review_replacement/4`.
  defp observable(catalog, "replacement", histories) do
    with %Log{} = space <- histories[catalog.space],
         {:ok, %{bootstraps: found}} <- CatalogBootstrap.observe(space),
         %{record: record} <- Enum.find(found, &(&1.id == catalog.bootstrap)) do
      {:ok,
       %{
         catalog
         | entries:
             Enum.map(
               catalog.entries,
               &%{&1 | service_id: record.service_id, service_key: record.service_key}
             )
       }}
    else
      _ -> :error
    end
  end

  defp observable(catalog, _mode, _histories), do: {:ok, catalog}

  defp replacement_op(space, op_id, claim) do
    case Log.fetch(space, op_id) do
      {:ok, %{kind: :command, body: {:replace_catalog_v1, [carried | _]}}} ->
        case TransportCatalog.normalize_replacement_claim(carried) do
          {:ok, ^claim} -> :ok
          _ -> {:error, :replacement_claim_mismatch}
        end

      _ ->
        {:error, :replacement_op_missing}
    end
  end

  defp core_honored(space, op_id) do
    if Authority.analyze(Treehouse.Space, space).reasons[op_id] == nil,
      do: :ok,
      else: {:error, :replacement_not_core_honored}
  end

  defp frame("replacement", nil), do: nil
  defp frame(mode, reference) when mode != "replacement", do: Wire.encode_op(reference)

  @spec digest(map()) :: String.t()
  def digest(catalog),
    do:
      :crypto.hash(:sha256, TransportCatalog.catalog_bytes(catalog))
      |> Base.encode16(case: :lower)

  defp histories(docs, catalog) when is_list(docs) and length(docs) in 1..13 do
    expected = catalog.entries |> Enum.map(& &1.replica) |> Enum.sort()

    with true <- Enum.all?(docs, &is_map/1),
         true <- Enum.map(docs, & &1["replica"]) == expected do
      Enum.reduce_while(docs, {:ok, %{}}, fn doc, {:ok, logs} ->
        with true <- Enum.sort(Map.keys(doc)) == ~w(frames replica),
             true <- byte_size(PublicHistory.canonical(doc)) <= @max_history_bytes,
             {:ok, log} <- PublicHistory.decode(doc["replica"], doc["frames"], push_bytes: 64_000) do
          {:cont, {:ok, Map.put(logs, log.replica, log)}}
        else
          _ -> {:halt, :error}
        end
      end)
    else
      _ -> :error
    end
  end

  defp histories(_, _), do: :error

  defp reference(%{"mode" => mode, "frame" => frame} = doc, catalog, histories)
       when map_size(doc) == 2 and mode in ["pending", "initial_existing"] do
    with {:ok, op} <- Wire.decode_op(frame),
         true <- Wire.encode_op(op) == frame,
         [entry] <- Enum.filter(catalog.entries, &(&1.kind == :thread and &1.reference == op.id)),
         true <-
           mode != "initial_existing" or
             (catalog.revision == 0 and catalog.previous == nil and length(catalog.entries) == 2),
         space = histories[catalog.space],
         child = histories[entry.replica],
         true <- Authority.root(space) != Authority.root(child),
         bundle = %{
           child: %{replica: entry.replica, review: %{"creation" => entry.creation}},
           reference: %{
             replica: catalog.space,
             op_id: op.id,
             bytes: PublicHistory.canonical(frame),
             review: if(mode == "initial_existing", do: %{"mode" => mode}, else: nil)
           }
         },
         {:ok, observed} <- ReferenceMode.observe(bundle, space, child) do
      {:ok, Map.put(histories, catalog.space, observed), op}
    else
      _ -> :error
    end
  end

  # Replacement mode (row 361): no staged Thread reference exists, the catalog is a
  # revision-0 replacement genesis, and the carried histories are observed as given.
  defp reference(%{"mode" => "replacement", "frame" => nil} = doc, catalog, histories)
       when map_size(doc) == 2 do
    if catalog.binding != catalog.bootstrap and catalog.revision == 0 and
         catalog.previous == nil,
       do: {:ok, histories, nil},
       else: :error
  end

  defp reference(_, _, _), do: :error
end
