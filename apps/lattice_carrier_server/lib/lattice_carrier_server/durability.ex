defmodule LatticeCarrierServer.Durability do
  @moduledoc """
  Persist-before-acknowledge durability contract (plan 158).

  A path-backed relay is acknowledged only after the complete sequence:
  write the temporary file, `fsync` the file, atomically rename it over the
  served log, then `fsync` the containing directory. `rehearse_target/2`
  proves that exact replacement sequence at startup; a platform or filesystem
  that cannot prove it is unsupported for the pilot and refuses to serve.

  Target locks coordinate tasks only inside this BEAM node. They do not guard
  two OS processes or separate nodes pointed at the same custody path; pilot
  deployment must retain single-process ownership of each log directory.
  """

  @callback sync_file(Path.t()) :: :ok | {:error, term()}
  @callback rename(Path.t(), Path.t()) :: :ok | {:error, term()}
  @callback sync_directory(Path.t()) :: :ok | {:error, term()}

  @doc false
  @spec with_target_lock(Path.t(), (-> result), keyword()) :: result | {:error, term()}
        when result: term()
  def with_target_lock(path, fun, opts \\ [])
      when is_binary(path) and is_function(fun, 0) and is_list(opts) do
    lock = {{__MODULE__, :target, Path.expand(path)}, self()}
    retries = Keyword.get(opts, :retries, :infinity)
    wrapped_fun = fn -> {:target_lock_result, fun.()} end

    case :global.trans(lock, wrapped_fun, [node()], retries) do
      :aborted -> {:error, {__MODULE__, :target_lock_aborted}}
      {:target_lock_result, result} -> result
    end
  end

  @doc """
  Prove the configured target's real persistence sequence without replacing it.

  Two private sibling files stand in for the live target. The rehearsal reads
  and writes the target's current byte size, exercises the same secure
  allocation used by relay persistence, renames over an existing sibling, and
  syncs the containing directory. The configured target is read but never
  opened for writing or renamed. Startup separately rehearses replacement of
  each relay-enabled target itself; this isolated recurring check cannot
  detect a target-specific immutable-file attribute added after boot.
  """
  @spec rehearse_target_isolated(module(), Path.t()) :: :ok | {:error, term()}
  def rehearse_target_isolated(impl, path) do
    with {:ok, bytes} <- File.read(path),
         {:ok, %File.Stat{type: :regular, mode: mode}} <- File.stat(path),
         {:ok, temp_path} <- secure_temp(path) do
      try do
        with {:ok, target_path} <- secure_temp(path) do
          try do
            with :ok <- File.write(temp_path, bytes),
                 :ok <- File.chmod(temp_path, Bitwise.band(mode, 0o777)),
                 :ok <- impl.sync_file(temp_path),
                 :ok <- impl.rename(temp_path, target_path),
                 :ok <- impl.sync_directory(Path.dirname(path)) do
              :ok
            end
          after
            _ = File.rm(target_path)
          end
        end
      after
        _ = File.rm(temp_path)
      end
    else
      {:ok, %File.Stat{}} -> {:error, :invalid_rehearsal_target}
      {:error, _reason} = error -> error
    end
  end

  @doc """
  Prove the real configured log can be replaced through the same durable
  sequence used by relay persistence. The replacement contains identical
  bytes and preserves the log's permission bits.
  """
  @spec rehearse_target(module(), Path.t()) :: :ok | {:error, term()}
  def rehearse_target(impl, path) do
    with {:ok, bytes} <- File.read(path),
         {:ok, %File.Stat{type: :regular, mode: mode}} <- File.stat(path),
         {:ok, temp_path} <- secure_temp(path) do
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

  @doc false
  @spec cleanup_orphaned_temps(Path.t()) :: :ok | {:error, term()}
  def cleanup_orphaned_temps(path) when is_binary(path) do
    directory = Path.dirname(path)
    prefix = Path.basename(path) <> ".tmp."

    with {:ok, entries} <- File.ls(directory) do
      entries
      |> Enum.filter(&String.starts_with?(&1, prefix))
      |> Enum.sort()
      |> Enum.reduce_while(:ok, fn entry, :ok ->
        orphan_path = Path.join(directory, entry)

        case File.rm(orphan_path) do
          :ok -> {:cont, :ok}
          {:error, :enoent} -> {:cont, :ok}
          {:error, reason} -> {:halt, {:error, {:orphan_cleanup_failed, orphan_path, reason}}}
        end
      end)
    end
  end

  @doc false
  @spec bounded_cleanup_orphaned_temps(Path.t(), pos_integer()) :: :ok | {:error, term()}
  def bounded_cleanup_orphaned_temps(path, timeout_ms \\ 250)
      when is_binary(path) and is_integer(timeout_ms) and timeout_ms > 0 do
    deadline = System.monotonic_time(:millisecond) + timeout_ms

    task =
      Task.async(fn ->
        try do
          cleanup_with_short_lock_retry(path, deadline)
        catch
          kind, reason -> {:error, {:orphan_cleanup_exception, kind, reason}}
        end
      end)

    case Task.yield(task, timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> result
      _timeout_or_exit -> {:error, :orphan_cleanup_timeout}
    end
  end

  defp cleanup_with_short_lock_retry(path, deadline) do
    result =
      with_target_lock(
        path,
        fn ->
          with :ok <- cleanup_orphaned_temps(path) do
            # A killed task can leave its `mktemp` subprocess just enough
            # time to create a sibling after the first sweep. This short,
            # lock-protected second sweep is best-effort crash cleanup.
            Process.sleep(10)
            cleanup_orphaned_temps(path)
          end
        end,
        retries: 0
      )

    case result do
      {:error, {__MODULE__, :target_lock_aborted}} ->
        retry_cleanup_before_deadline(path, deadline)

      other ->
        other
    end
  end

  defp retry_cleanup_before_deadline(path, deadline) do
    remaining_ms = deadline - System.monotonic_time(:millisecond)

    if remaining_ms > 10 do
      Process.sleep(min(5, remaining_ms - 10))
      cleanup_with_short_lock_retry(path, deadline)
    else
      {:error, :orphan_cleanup_timeout}
    end
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
end
