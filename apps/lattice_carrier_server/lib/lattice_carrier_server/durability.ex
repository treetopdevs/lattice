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
    allocated = Keyword.get(opts, :allocated, fn _path -> :ok end)

    with {:ok, bytes} <- File.read(path),
         {:ok, %File.Stat{type: :regular, mode: mode}} <- File.stat(path),
         {:ok, temp_path} <- secure_temp(path) do
      allocated.(temp_path)

      try do
        with :ok <- File.write(temp_path, bytes),
             :ok <- File.chmod(temp_path, Bitwise.band(mode, 0o777)),
             :ok <- impl.sync_file(temp_path),
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

  @doc false
  @spec secure_temp(Path.t()) :: {:ok, Path.t()} | {:error, term()}
  def secure_temp(path) when is_binary(path) do
    template = "#{path}.tmp.XXXXXXXX"

    with :ok <- secure_parent(path) do
      case System.cmd("mktemp", [template], stderr_to_stdout: true) do
        {output, 0} ->
          temp_path = String.trim(output)

          with true <- String.starts_with?(temp_path, path <> ".tmp."),
               {:ok, %File.Stat{type: :regular, mode: mode}} <- File.lstat(temp_path),
               true <- Bitwise.band(mode, 0o077) == 0 do
            {:ok, temp_path}
          else
            _invalid ->
              _ = File.rm(temp_path)
              {:error, :secure_temp_invalid}
          end

        {_output, status} ->
          {:error, {:secure_temp_failed, status}}
      end
    end
  rescue
    error in [ErlangError] -> {:error, {:secure_temp_unavailable, error.original}}
  end

  defp secure_parent(path) do
    with {:ok, %File.Stat{type: :directory, mode: mode, uid: uid}} <-
           File.stat(Path.dirname(path)),
         true <- Bitwise.band(mode, 0o022) == 0,
         {:ok, ^uid} <- effective_uid() do
      :ok
    else
      _invalid -> {:error, :insecure_target_directory}
    end
  end

  defp effective_uid do
    case System.cmd("id", ["-u"], stderr_to_stdout: true) do
      {output, 0} ->
        case Integer.parse(String.trim(output)) do
          {uid, ""} when uid >= 0 -> {:ok, uid}
          _invalid -> {:error, :invalid_uid}
        end

      {_output, _status} ->
        {:error, :uid_unavailable}
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
