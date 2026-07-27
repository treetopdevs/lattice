defmodule LatticeCarrierServer.Durability.Posix do
  @moduledoc """
  Default durability implementation for the supported Linux pilot host.

  `sync_file/1` fsyncs through the raw file API and `rename/2` is the atomic
  same-filesystem rename. Erlang's file API cannot open a directory, so
  `sync_directory/1` shells out: on Linux, coreutils `sync -- <dir>` opens
  the directory and fsyncs it — this is the only path a pilot release relies
  on. macOS has no directory-fsync equivalent here (no `F_FULLFSYNC`, and
  the argument-less `/bin/sync` is a global flush, not a directory fsync),
  so by default it refuses with `{:unsupported_platform, :darwin}` rather
  than silently reporting readiness a real disaster could falsify. Any other
  platform refuses the same way.

  The macOS refusal is deliberately not distinguishable at the return-value
  level from "genuinely unsupported": it is the same durability failure a
  reader must treat identically, so a pilot release on a macOS host cannot
  quietly serve traffic. A local development escape hatch exists only via
  the explicit `:lattice_carrier_server, :allow_approximate_darwin_sync`
  application config — never a default — and even then the approximate
  global flush is not the Linux guarantee.
  """

  @behaviour LatticeCarrierServer.Durability

  @impl LatticeCarrierServer.Durability
  def sync_file(path) do
    with {:ok, io_device} <- File.open(path, [:read, :binary]) do
      try do
        :file.sync(io_device)
      after
        _ = File.close(io_device)
      end
    end
  end

  @impl LatticeCarrierServer.Durability
  def rename(temp_path, path), do: File.rename(temp_path, path)

  @impl LatticeCarrierServer.Durability
  def sync_directory(directory) do
    case :os.type() do
      {:unix, :linux} -> run_sync(["--", directory])
      {:unix, :darwin} -> darwin_sync_directory()
      other -> {:error, {:unsupported_platform, other}}
    end
  end

  defp darwin_sync_directory do
    if darwin_approximation_allowed?() do
      run_sync([])
    else
      {:error, {:unsupported_platform, :darwin}}
    end
  end

  defp darwin_approximation_allowed? do
    Application.get_env(:lattice_carrier_server, :allow_approximate_darwin_sync, false) == true
  end

  defp run_sync(args) do
    case System.cmd("sync", args, stderr_to_stdout: true) do
      {_output, 0} -> :ok
      {_output, status} -> {:error, {:directory_sync_failed, status}}
    end
  rescue
    error in [ErlangError] -> {:error, {:directory_sync_unavailable, error.original}}
  end
end
