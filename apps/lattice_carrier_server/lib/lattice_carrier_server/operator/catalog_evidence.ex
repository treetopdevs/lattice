defmodule LatticeCarrierServer.Operator.CatalogEvidence do
  @moduledoc """
  Export a checked listed host snapshot as public evidence, never installed trust.

  The explicit manifest is the exact archived candidate named by the listed receipt.
  Its normalized path and bytes must match; this is not the active configuration
  filename. All logs and catalogs are re-read before publishing.
  No application is started, no signature
  is made and no private identity or ceremony bytes are copied to the output.
  A page whose root first-install PreviewState would exceed the 1 MiB workflow
  store is refused as `:preview_storage_limit` before any output is written.
  """
  alias Lattice.Log
  alias LatticeCarrierServer.{Durability, Manifest}
  alias LatticeCarrierServer.Operator.{CatalogBinding, CatalogStore, Journal}
  alias LatticeCarrierServer.Operator.CatalogEvidence.{Packet, Workflow}
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Atoms, Paths}
  @max_source 64 * 1024 * 1024
  @test_hooks_enabled Mix.env() == :test

  @spec export(Path.t(), Path.t(), Path.t(), Path.t()) :: {:ok, Path.t()} | {:error, atom()}
  def export(root, ceremony, manifest_path, output) do
    Atoms.load()
    manifest_path = Path.expand(manifest_path)
    output = Path.expand(output)

    with {:ok, raw} <- Journal.read(root),
         {:ok, %{"phase" => "listed"} = record} <- Journal.decode(raw),
         {:ok, digest} <- listed_manifest_digest(record, manifest_path),
         {:ok, manifest} <- load_manifest(manifest_path),
         :ok <-
           same(
             Base.encode16(manifest.sha256, case: :lower) == digest,
             :release_manifest_mismatch
           ),
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
         :ok <- Workflow.fit(space, histories),
         :ok <- output_location(output, root, ceremony, manifest_path, manifest.instances),
         :ok <- before_publish(),
         {:ok, ^raw} <- Journal.read(root),
         {:ok, current} <- load_manifest(manifest_path),
         true <-
           current.sha256 == manifest.sha256 and
             public_instances(current) == public_instances(manifest),
         {:ok, ^store} <- CatalogStore.committed_documents(root, binding.record.catalog_key),
         :ok <- unchanged(captures),
         :ok <- output_location(output, root, ceremony, manifest_path, manifest.instances),
         :ok <-
           write_new(output, bytes, fn ->
             output_location(output, root, ceremony, manifest_path, manifest.instances)
           end) do
      {:ok, output}
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

  defp listed_manifest_digest(record, manifest_path) do
    case Enum.filter(record["artifacts"], &(&1["kind"] == "manifest")) do
      [%{"path" => expected_path, "sha256" => digest}] ->
        if Path.expand(expected_path) == manifest_path,
          do: {:ok, digest},
          else: {:error, :release_manifest_mismatch}

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
      ([root, ceremony, manifest] ++
         Enum.flat_map(instances, &[&1.log_file, &1.identity_file]))
      |> Enum.map(&Paths.real/1)

    resolved = Paths.real(output)
    blocked = Enum.any?(protected, &(resolved == &1 or String.starts_with?(resolved, &1 <> "/")))

    with false <- blocked,
         :ok <- Journal.secure_root(Path.dirname(output)),
         {:ok, %{type: :directory}} <- File.lstat(Path.dirname(output)),
         do: :ok,
         else: (_ -> {:error, :unsafe_export_location})
  end

  defp write_new(path, bytes, location_check) do
    with :ok <- location_check.(),
         :ok <- writer_hook(nil, path, :before_create) do
      # The calling process retains the raw descriptor through cleanup; an
      # independent IO server cannot release its inode behind these checks.
      case File.open(path, [:write, :binary, :exclusive, :raw]) do
        {:ok, file} ->
          write_opened(file, path, bytes, location_check)

        {:error, :eexist} ->
          {:error, :evidence_output_exists}

        _ ->
          {:error, :evidence_export_failed}
      end
    else
      {:error, :unsafe_export_location} = refusal -> refusal
      _ -> {:error, :evidence_export_failed}
    end
  end

  defp write_opened(file, path, bytes, location_check) do
    case :file.read_file_info(file) do
      {:ok, info} ->
        write_verified(file, path, bytes, File.Stat.from_record(info), location_check)

      _ ->
        File.close(file)
        {:error, :evidence_export_failed}
    end
  rescue
    _ ->
      File.close(file)
      {:error, :evidence_export_failed}
  catch
    _, _ ->
      File.close(file)
      {:error, :evidence_export_failed}
  end

  defp write_verified(file, path, bytes, created, location_check) do
    size = byte_size(bytes)

    result =
      try do
        with :ok <- location_check.(),
             :ok <- output_bound(file, path, created, false, 0),
             :ok <- File.chmod(path, 0o600),
             :ok <- writer_hook(file, path, :before_write),
             :ok <- location_check.(),
             :ok <- output_bound(file, path, created, true, 0),
             :ok <- :file.write(file, bytes),
             :ok <- :file.sync(file),
             :ok <- writer_hook(file, path, :after_sync),
             :ok <- location_check.(),
             :ok <- output_bound(file, path, created, true, size),
             do: :ok
      rescue
        _ -> :error
      catch
        _, _ -> :error
      end

    # Resolve failures while the descriptor still pins the created inode. A
    # later close/acknowledgement failure preserves the uncertain public file.
    if result != :ok, do: remove_created_file(file, path, created)
    closed = File.close(file)

    with :ok <- result,
         :ok <- closed,
         :ok <- writer_hook(file, path, :after_close),
         :ok <- location_check.(),
         :ok <- output_path_bound(path, created, size),
         do: :ok,
         else: (
           {:error, :unsafe_export_location} = refusal -> refusal
           _ -> {:error, :evidence_export_failed}
         )
  end

  defp output_bound(file, path, created, private?, size) do
    with {:ok, info} <- :file.read_file_info(file),
         {:ok, stat} <- File.lstat(path),
         true <- output_matches?(File.Stat.from_record(info), created, private?, size),
         true <- output_matches?(stat, created, private?, size),
         do: :ok,
         else: (_ -> :error)
  end

  defp output_path_bound(path, created, size) do
    case File.lstat(path) do
      {:ok, stat} -> if output_matches?(stat, created, true, size), do: :ok, else: :error
      _ -> :error
    end
  end

  defp output_matches?(stat, created, private?, size) do
    stat.type == :regular and stat.links == 1 and stat.uid == created.uid and stat.size == size and
      file_node(stat) == file_node(created) and
      (not private? or Bitwise.band(stat.mode, 0o7777) == 0o600)
  end

  defp remove_created_file(file, path, created) do
    with {:ok, info} <- :file.read_file_info(file),
         true <- file_node(File.Stat.from_record(info)) == file_node(created),
         {:ok, stat} <- File.lstat(path),
         true <- file_node(stat) == file_node(created),
         do: File.rm(path),
         else: (_ -> :ok)
  rescue
    _ -> :ok
  catch
    _, _ -> :ok
  end

  defp writer_hook(file, path, phase) do
    if @test_hooks_enabled do
      case Application.get_env(:lattice_carrier_server, :catalog_evidence_writer_hook) do
        hook when is_function(hook, 3) -> hook.(file, path, phase)
        hook when is_function(hook, 2) and phase == :before_write -> hook.(file, path)
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
