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

  @doc """
  Prove the write -> fsync -> rename -> directory-fsync sequence in
  `directory`, cleaning up all rehearsal residue.
  """
  @spec rehearse(module(), Path.t()) :: :ok | {:error, term()}
  def rehearse(impl, directory) do
    unique = System.unique_integer([:monotonic, :positive])
    temp_path = Path.join(directory, "#{@rehearsal_prefix}.tmp.#{unique}")
    target_path = Path.join(directory, "#{@rehearsal_prefix}.#{unique}")

    try do
      with :ok <- write_probe(temp_path),
           :ok <- impl.sync_file(temp_path),
           :ok <- impl.rename(temp_path, target_path),
           :ok <- impl.sync_directory(directory) do
        :ok
      end
    after
      _ = File.rm(temp_path)
      _ = File.rm(target_path)
    end
  end

  defp write_probe(path) do
    case File.write(path, "lattice-durability-rehearsal") do
      :ok -> :ok
      {:error, reason} -> {:error, {:probe_write_failed, reason}}
    end
  end
end
