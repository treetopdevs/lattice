defmodule LatticeCarrierServer.Durability.Posix do
  @moduledoc """
  Default durability implementation for the supported Linux pilot host.

  `sync_file/1` fsyncs through the raw file API and `rename/2` is the atomic
  same-filesystem rename. Erlang's file API cannot open a directory, so
  `sync_directory/1` shells out: on Linux, coreutils `sync -- <dir>` opens
  the directory and fsyncs it; on macOS, the argument-less `/bin/sync`
  global flush is a development-only approximation (macOS also does not get
  `F_FULLFSYNC` here) — macOS is not a supported pilot platform. Any other
  platform reports itself unsupported so startup rehearsal refuses.
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
      {:unix, :darwin} -> run_sync([])
      other -> {:error, {:unsupported_platform, other}}
    end
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
