defmodule Township.ReportFile do
  @moduledoc """
  Writes a report file by exclusive temporary creation and rename.

  The bytes go to a new dot-file in the destination's directory, created with
  `[:write, :exclusive, :raw, :binary]`, so a link already planted at that name is
  never followed. The file is synced and closed, then renamed over the destination.
  A symlink or hard link swapped in at the destination is therefore replaced, never
  written through. The caller creates the destination directory first.
  """

  @doc """
  Atomically write `bytes` to `path`.

  `opts` accepts only `suffix:`, the temporary-name suffix (a random hex string by
  default). On failure after the temporary file is created, it is removed and the
  raw reason is returned; `{:error, :eexist}` means the temporary name was taken
  and nothing was touched.
  """
  @spec write(Path.t(), iodata(), keyword()) :: :ok | {:error, term()}
  def write(path, bytes, opts \\ []) do
    opts = Keyword.validate!(opts, suffix: nil)
    suffix = opts[:suffix] || Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
    # Fixed short stem, so a destination basename near NAME_MAX still gets a valid name.
    tmp = Path.join(Path.dirname(path), ".report-" <> suffix <> ".tmp")

    case :file.open(tmp, [:write, :exclusive, :raw, :binary]) do
      {:ok, io} -> write_and_rename(io, tmp, path, bytes)
      {:error, _reason} = error -> error
    end
  end

  defp write_and_rename(io, tmp, path, bytes) do
    result =
      with :ok <- :file.write(io, bytes),
           :ok <- :file.sync(io) do
        :file.close(io)
      else
        error ->
          _ = :file.close(io)
          error
      end

    with :ok <- result,
         :ok <- File.rename(tmp, path) do
      :ok
    else
      {:error, _reason} = error ->
        _ = File.rm(tmp)
        error
    end
  end
end
