defmodule LatticeCarrierServer.Operator.CatalogEvidence do
  @moduledoc """
  Export a checked listed host snapshot as public evidence, never installed trust.

  The explicit manifest must match the immutable listed artifact. All logs and
  catalogs are re-read before publishing. No application is started, no signature
  is made and no private identity or ceremony bytes are copied to the output.
  """
  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Manifest}
  alias LatticeCarrierServer.Operator.{CatalogBinding, CatalogStore, Journal}
  alias LatticeCarrierServer.Operator.CatalogEvidence.Packet
  alias LatticeCarrierServer.Operator.CatalogCeremony.Atoms
  @max_source 64 * 1024 * 1024
  @test_hooks_enabled Mix.env() == :test

  @spec export(Path.t(), Path.t(), Path.t(), Path.t()) :: {:ok, Path.t()} | {:error, atom()}
  def export(root, ceremony, manifest_path, output) do
    Atoms.load()

    with {:ok, raw} <- Journal.read(root),
         {:ok, %{"phase" => "listed"} = record} <- Journal.decode(raw),
         {:ok, manifest} <- load_manifest(manifest_path),
         :ok <- manifest_bound(manifest, record),
         {:ok, histories, captures} <- histories(manifest.instances),
         [reference] <- Enum.filter(record["artifacts"], &(&1["kind"] == "reference")),
         %Log{} = space <- histories[reference["replica"]],
         {:ok, binding} <- CatalogBinding.load_log(ceremony, space),
         {:ok, store} <- CatalogStore.committed_documents(root, binding.record.catalog_key),
         true <- store.head == record["catalog_head"],
         :ok <-
           head_routes(
             List.last(store.documents).envelope.catalog,
             manifest.instances,
             histories,
             captures,
             binding
           ),
         {:ok, bytes} <-
           Packet.encode(space, Enum.map(store.documents, & &1.bytes), histories, store.head),
         :ok <- output_location(output, root, ceremony, manifest_path, manifest.instances),
         :ok <- before_publish(),
         {:ok, ^raw} <- Journal.read(root),
         {:ok, current} <- load_manifest(manifest_path),
         true <-
           current.sha256 == manifest.sha256 and
             public_instances(current) == public_instances(manifest),
         {:ok, ^store} <- CatalogStore.committed_documents(root, binding.record.catalog_key),
         :ok <- unchanged(captures),
         :ok <- write_new(output, bytes) do
      {:ok, Path.expand(output)}
    else
      {:ok, %{"phase" => _}} -> {:error, :catalog_not_listed}
      {:error, reason} when is_atom(reason) -> {:error, reason}
      _ -> {:error, :evidence_source_changed}
    end
  rescue
    _ -> {:error, :evidence_export_failed}
  catch
    _, _ -> {:error, :evidence_export_failed}
  end

  defp load_manifest(path) do
    case Manifest.load(path) do
      {:ok, manifest} -> {:ok, manifest}
      _ -> {:error, :release_manifest_mismatch}
    end
  end

  defp manifest_bound(manifest, record) do
    case Enum.filter(record["artifacts"], &(&1["kind"] == "manifest")) do
      [%{"sha256" => digest}] ->
        same(Base.encode16(manifest.sha256, case: :lower) == digest, :release_manifest_mismatch)

      _ ->
        {:error, :release_manifest_mismatch}
    end
  end

  defp histories(instances) do
    Enum.reduce_while(instances, {:ok, %{}, [], 0}, fn instance, {:ok, logs, captures, size} ->
      case read_log(instance.log_file, @max_source - size) do
        {:ok, log, capture} ->
          if Map.has_key?(logs, log.replica) do
            {:halt, {:error, :invalid_verified_history}}
          else
            {:cont,
             {:ok, Map.put(logs, log.replica, log), [capture | captures], size + capture.size}}
          end

        refusal ->
          {:halt, refusal}
      end
    end)
    |> case do
      {:ok, logs, captures, _} -> {:ok, logs, captures}
      refusal -> refusal
    end
  end

  defp read_log(path, remaining) do
    Durability.with_target_lock(
      path,
      fn ->
        with {:ok, %{type: :regular, size: size} = stat} <- File.lstat(path),
             true <- size <= remaining,
             {:ok, bytes} <- limited(path, remaining),
             accounted = source_size(bytes),
             true <- accounted <= remaining,
             {:ok, %{log: log}} <- Log.restore_verified_bytes(bytes),
             {:ok, after_stat} <- File.lstat(path),
             true <- stable(stat) == stable(after_stat) do
          {:ok, log,
           %{
             path: path,
             replica: log.replica,
             stat: stable(stat),
             size: accounted,
             digest: Journal.digest(bytes)
           }}
        else
          false -> {:error, :evidence_page_too_large}
          _ -> {:error, :invalid_verified_history}
        end
      end,
      retries: 5
    )
  end

  # Compressed ETF declares its expanded byte size. Charge that before the
  # existing safe decoder, so compression cannot bypass the source budget.
  defp source_size(<<131, 80, expanded::unsigned-big-32, _::binary>> = bytes),
    do: max(byte_size(bytes), expanded + 1)

  defp source_size(bytes), do: byte_size(bytes)

  defp limited(path, maximum) when maximum >= 0 do
    with {:ok, file} <- File.open(path, [:read, :binary, :raw]) do
      try do
        case :file.read(file, maximum + 1) do
          {:ok, bytes} when byte_size(bytes) <= maximum -> {:ok, bytes}
          _ -> {:error, :evidence_page_too_large}
        end
      after
        File.close(file)
      end
    end
  end

  defp limited(_, _), do: {:error, :evidence_page_too_large}

  defp head_routes(catalog, instances, logs, captures, binding) do
    by_path = Map.new(captures, &{&1.path, &1.replica})
    actual = Map.new(instances, &{Map.fetch!(by_path, &1.log_file), &1})

    valid =
      catalog.bootstrap == binding.bootstrap_id and catalog.binding == binding.bootstrap_id and
        catalog.space == binding.record.space and
        Enum.sort(Map.keys(logs)) == Enum.sort(Enum.map(catalog.entries, & &1.replica)) and
        Enum.all?(catalog.entries, fn entry ->
          case actual[entry.replica] do
            nil ->
              false

            instance ->
              instance.route == entry.route and instance.pub == entry.service_key and
                entry.service_id == binding.record.service_id and
                entry.service_key == binding.record.service_key and
                instance.realm == binding.realm
          end
        end)

    same(valid, :service_binding_mismatch)
  end

  defp public_instances(manifest),
    do:
      Enum.map(
        manifest.instances,
        &Map.take(&1, [
          :name,
          :pub,
          :realm,
          :route,
          :log_file,
          :identity_file,
          :trusted_peers,
          :relay_realms
        ])
      )

  defp stable(stat),
    do:
      Map.take(stat, [
        :type,
        :size,
        :mtime,
        :ctime,
        :mode,
        :links,
        :uid,
        :gid,
        :major_device,
        :minor_device,
        :inode
      ])

  defp file_node(stat), do: Map.take(stat, [:major_device, :minor_device, :inode])

  defp unchanged(captures) do
    Enum.reduce_while(captures, :ok, fn capture, :ok ->
      case read_log(capture.path, @max_source) do
        {:ok, _log, ^capture} -> {:cont, :ok}
        _ -> {:halt, {:error, :evidence_source_changed}}
      end
    end)
  end

  defp output_location(output, root, ceremony, manifest, instances) do
    output = Path.expand(output)

    protected =
      [Path.expand(root), Path.expand(ceremony), Path.expand(manifest)] ++
        Enum.flat_map(instances, &[Path.expand(&1.log_file), Path.expand(&1.identity_file)])

    blocked = Enum.any?(protected, &(output == &1 or String.starts_with?(output, &1 <> "/")))

    with false <- blocked,
         :ok <- Journal.secure_root(Path.dirname(output)),
         {:ok, %{type: :directory}} <- File.lstat(Path.dirname(output)),
         do: :ok,
         else: (_ -> {:error, :unsafe_export_location})
  end

  defp write_new(path, bytes) do
    case File.open(path, [:write, :binary, :exclusive]) do
      {:ok, file} ->
        created =
          case :file.read_file_info(file) do
            {:ok, info} -> File.Stat.from_record(info) |> file_node()
            _ -> nil
          end

        result =
          try do
            with true <- created != nil,
                 :ok <- before_write(file, path),
                 :ok <- IO.binwrite(file, bytes),
                 :ok <- :file.sync(file),
                 do: :ok
          rescue
            _ -> :error
          catch
            _, _ -> :error
          end

        closed = File.close(file)

        if result == :ok and closed == :ok do
          :ok
        else
          remove_created_file(path, created)
          {:error, :evidence_export_failed}
        end

      {:error, :eexist} ->
        {:error, :evidence_output_exists}

      _ ->
        {:error, :evidence_export_failed}
    end
  end

  defp remove_created_file(path, created) do
    case File.lstat(path) do
      {:ok, stat} -> if file_node(stat) == created, do: File.rm(path)
      _ -> :ok
    end
  end

  defp before_write(file, path) do
    if @test_hooks_enabled do
      case Application.get_env(:lattice_carrier_server, :catalog_evidence_writer_hook) do
        hook when is_function(hook, 2) -> hook.(file, path)
        _ -> :ok
      end
    else
      :ok
    end
  end

  defp before_publish do
    if @test_hooks_enabled do
      case Application.get_env(:lattice_carrier_server, :catalog_evidence_hook) do
        hook when is_function(hook, 0) -> hook.()
        _ -> :ok
      end
    else
      :ok
    end
  end

  defp same(true, _), do: :ok
  defp same(_, reason), do: {:error, reason}
end
