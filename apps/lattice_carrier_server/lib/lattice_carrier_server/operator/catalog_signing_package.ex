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
  alias LatticeCarrierServer.Operator.CatalogCeremony.Atoms
  alias Treehouse.{CatalogEntries, TransportCatalog}

  @format "treehouse-catalog-signing-v1"
  @max_bytes 64 * 1024 * 1024
  @max_history_bytes 16 * 1024 * 1024
  @max_metadata_bytes 131_072
  @keys ~w(catalog digest format histories reference)

  @spec encode(map(), %{String.t() => Log.t()}, map(), String.t()) ::
          {:ok, binary()} | {:error, atom()}
  def encode(catalog, histories, reference, mode) do
    doc = %{
      "format" => @format,
      "catalog" => Wire.encode_value(catalog),
      "digest" => digest(catalog),
      "reference" => %{"mode" => mode, "frame" => Wire.encode_op(reference)},
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
         {:ok, _} <- CatalogEntries.observe(catalog, observed),
         true <- catalog.binding == catalog.bootstrap,
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
         {:ok, binding} <-
           CatalogBinding.load_log(ceremony_dir, package.histories[package.catalog.space]),
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

  defp reference(_, _, _), do: :error
end
