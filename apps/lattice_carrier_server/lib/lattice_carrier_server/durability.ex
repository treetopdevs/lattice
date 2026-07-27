defmodule LatticeCarrierServer.Durability do
  @moduledoc """
  Persist-before-acknowledge durability contract (plan 158).

  A path-backed relay is acknowledged only after the complete sequence:
  write the temporary file, `fsync` the file, atomically rename it over the
  served log, then `fsync` the containing directory. `rehearse/2` proves the
  full sequence executes in a durable directory; a platform or filesystem
  that cannot prove the sequence is unsupported for the pilot and refuses at
  startup instead of serving.
  """

  @callback sync_file(Path.t()) :: :ok | {:error, term()}
  @callback rename(Path.t(), Path.t()) :: :ok | {:error, term()}
  @callback sync_directory(Path.t()) :: :ok | {:error, term()}

  @rehearsal_prefix ".lattice-durability-rehearsal"

  @doc false
  @spec with_target_lock(Path.t(), (-> result)) :: result | {:error, term()} when result: term()
  def with_target_lock(path, fun) when is_binary(path) and is_function(fun, 0) do
    lock = {{__MODULE__, :target, Path.expand(path)}, self()}

    case :global.trans(lock, fun, [node()]) do
      {:aborted, reason} -> {:error, {:target_lock_failed, reason}}
      result -> result
    end
  end

  @doc """
  Prove the write -> fsync -> rename -> directory-fsync sequence in
  `directory`, cleaning up all rehearsal residue.
  """
  @spec rehearse(module(), Path.t()) :: :ok | {:error, term()}
  def rehearse(impl, directory), do: rehearse(impl, directory, [])

  @doc false
  @spec rehearse(module(), Path.t(), keyword()) :: :ok | {:error, term()}
  def rehearse(impl, directory, opts) do
    unique = Keyword.get(opts, :unique, fn -> System.unique_integer([:monotonic, :positive]) end)

    case allocate_namespace(directory, unique, 16) do
      {:ok, namespace} ->
        temp_path = Path.join(namespace, "probe.tmp")
        target_path = Path.join(namespace, "probe")

        try do
          with :ok <- write_probe(temp_path),
               :ok <- impl.sync_file(temp_path),
               :ok <- impl.rename(temp_path, target_path),
               :ok <- impl.sync_directory(namespace),
               :ok <- impl.sync_directory(directory) do
            :ok
          end
        after
          _ = File.rm_rf(namespace)
        end

      {:error, _reason} = error ->
        error
    end
  end

  @doc """
  Prove the real configured log can be replaced through the same durable
  sequence used by relay persistence. The replacement contains identical
  bytes and preserves the log's permission bits.
  """
  @spec rehearse_target(module(), Path.t(), keyword()) :: :ok | {:error, term()}
  def rehearse_target(impl, path, opts \\ []) do
    unique = Keyword.get(opts, :unique, fn -> System.unique_integer([:monotonic, :positive]) end)
    allocated = Keyword.get(opts, :allocated, fn _path -> :ok end)

    with {:ok, bytes} <- File.read(path),
         {:ok, %File.Stat{type: :regular, mode: mode}} <- File.stat(path),
         {:ok, temp_path} <- allocate_target(path, unique, bytes, mode, 16) do
      allocated.(temp_path)

      try do
        with :ok <- impl.sync_file(temp_path),
             :ok <- impl.rename(temp_path, path),
             :ok <- impl.sync_directory(Path.dirname(path)) do
          :ok
        end
      after
        _ = File.rm(temp_path)
      end
    else
      {:ok, %File.Stat{}} -> {:error, :invalid_rehearsal_target}
      {:error, _reason} = error -> error
    end
  end

  defp allocate_target(_path, _unique, _bytes, _mode, 0),
    do: {:error, :rehearsal_target_unavailable}

  defp allocate_target(path, unique, bytes, mode, attempts) do
    temp_path = "#{path}.tmp.rehearsal-#{unique.()}"

    case File.open(temp_path, [:write, :binary, :exclusive]) do
      {:ok, io_device} ->
        result =
          try do
            with :ok <- IO.binwrite(io_device, bytes),
                 :ok <- File.chmod(temp_path, Bitwise.band(mode, 0o777)) do
              :ok
            end
          after
            _ = File.close(io_device)
          end

        case result do
          :ok ->
            {:ok, temp_path}

          {:error, reason} ->
            _ = File.rm(temp_path)
            {:error, {:rehearsal_target_write_failed, reason}}
        end

      {:error, :eexist} ->
        allocate_target(path, unique, bytes, mode, attempts - 1)

      {:error, reason} ->
        {:error, {:rehearsal_target_write_failed, reason}}
    end
  end

  defp allocate_namespace(_directory, _unique, 0),
    do: {:error, :rehearsal_namespace_unavailable}

  defp allocate_namespace(directory, unique, attempts) do
    namespace = Path.join(directory, "#{@rehearsal_prefix}.#{unique.()}")

    case File.mkdir(namespace) do
      :ok ->
        case File.chmod(namespace, 0o700) do
          :ok ->
            {:ok, namespace}

          {:error, reason} ->
            _ = File.rmdir(namespace)
            {:error, {:rehearsal_namespace_permissions, reason}}
        end

      {:error, :eexist} ->
        allocate_namespace(directory, unique, attempts - 1)

      {:error, reason} ->
        {:error, {:rehearsal_namespace_failed, reason}}
    end
  end

  defp write_probe(path) do
    case File.write(path, "lattice-durability-rehearsal") do
      :ok -> :ok
      {:error, reason} -> {:error, {:probe_write_failed, reason}}
    end
  end
end
