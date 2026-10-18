defmodule LatticeCarrierServer.Operator.CatalogCeremony.Paths do
  @moduledoc false
  # Path policy for every file that can hold a seed or a backup of one. The
  # parent directory of a secret must be private to the operator, so the
  # window between exclusive creation and the chmod exposes nothing.

  import Bitwise

  @type role :: :signer | :backup

  # A signer path (a generated seed, a restored seed, or the seed to import).
  @spec signer(term(), Path.t(), :real | :dry_run) :: {:ok, Path.t()} | {:error, atom()}
  def signer(path, ceremony, mode) do
    with {:ok, expanded} <- explicit(path, :signer_path_required),
         :ok <- leaf(expanded, :signer_symlink),
         :ok <- private_directory(Path.dirname(expanded)),
         :ok <- outside_git(expanded, :signer_in_git_checkout, mode),
         :ok <- no_overlap(expanded, ceremony, mode) do
      {:ok, expanded}
    end
  end

  # A backup path. It is ciphertext, so its directory may be removable media
  # with foreign ownership; it only must exist, differ from the signer's
  # directory tree, and stay out of any git work tree.
  @spec backup(term(), Path.t(), :real | :dry_run) :: {:ok, Path.t()} | {:error, atom()}
  def backup(path, signer_path, mode) do
    with {:ok, expanded} <- explicit(path, :backup_path_required),
         :ok <- leaf(expanded, :backup_symlink),
         :ok <- plain_directory(Path.dirname(expanded)),
         :ok <- outside_git(expanded, :backup_in_git_checkout, mode),
         :ok <- apart(expanded, signer_path) do
      {:ok, expanded}
    end
  end

  # An existing backup being read: a regular file, never a link.
  @spec backup_input(term()) :: {:ok, Path.t()} | {:error, atom()}
  def backup_input(path) do
    with {:ok, expanded} <- explicit(path, :backup_path_required) do
      case File.lstat(expanded) do
        {:ok, %File.Stat{type: :regular}} -> {:ok, expanded}
        _ -> {:error, :backup_unreadable}
      end
    end
  end

  @doc """
  Create `path` exclusively (it must not exist), set mode 0600 before any byte
  is written, then write what `content` returns. A failure removes the file.
  """
  @spec create_private(Path.t(), (-> binary()), atom(), atom()) :: :ok | {:error, atom()}
  def create_private(path, content, exists, failure) do
    case File.open(path, [:write, :exclusive, :binary]) do
      {:ok, io} ->
        result =
          try do
            with :ok <- File.chmod(path, 0o600), do: IO.binwrite(io, content.())
          after
            File.close(io)
          end

        if result == :ok do
          :ok
        else
          File.rm(path)
          {:error, failure}
        end

      {:error, :eexist} ->
        {:error, exists}

      _ ->
        {:error, failure}
    end
  end

  @spec uid() :: non_neg_integer() | nil
  def uid do
    case System.cmd("id", ["-u"], stderr_to_stdout: true) do
      {out, 0} ->
        case Integer.parse(String.trim(out)) do
          {uid, ""} -> uid
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp explicit(path, _reason) when is_binary(path) and path != "", do: {:ok, Path.expand(path)}
  defp explicit(_path, reason), do: {:error, reason}

  defp leaf(path, symlink_reason) do
    case File.lstat(path) do
      {:ok, %File.Stat{type: :symlink}} -> {:error, symlink_reason}
      _ -> :ok
    end
  end

  defp private_directory(dir) do
    with {:ok, %File.Stat{type: :directory, mode: mode, uid: owner}} <- File.lstat(dir),
         true <- (mode &&& 0o077) == 0,
         true <- owner == uid() do
      :ok
    else
      _ -> {:error, :unsafe_signer_directory}
    end
  end

  defp plain_directory(dir) do
    case File.lstat(dir) do
      {:ok, %File.Stat{type: :directory}} -> :ok
      _ -> {:error, :backup_directory_unavailable}
    end
  end

  defp outside_git(_path, _reason, :dry_run), do: :ok

  defp outside_git(path, reason, :real) do
    if path
       |> real_dir()
       |> Path.dirname()
       |> ancestors()
       |> Enum.any?(&File.exists?(Path.join(&1, ".git"))),
       do: {:error, reason},
       else: :ok
  end

  defp no_overlap(_path, _ceremony, :dry_run), do: :ok

  defp no_overlap(path, ceremony, :real) do
    secret = real_dir(path)
    parent = secret |> Path.dirname()
    public = real(ceremony)

    if within?(secret, public) or within?(public, parent),
      do: {:error, :signer_ceremony_overlap},
      else: :ok
  end

  defp apart(backup_path, signer_path) do
    if within?(real_dir(backup_path), real(Path.dirname(signer_path))),
      do: {:error, :backup_beside_signer},
      else: :ok
  end

  defp real_dir(path), do: Path.join(real(Path.dirname(path)), Path.basename(path))

  defp ancestors("/"), do: ["/"]
  defp ancestors(dir), do: [dir | ancestors(Path.dirname(dir))]

  # `inner` equals `outer` or lies beneath it.
  defp within?(inner, outer), do: inner == outer or String.starts_with?(inner, outer <> "/")

  @doc "Resolve every symlink in the existing prefix of `path`."
  @spec real(Path.t(), non_neg_integer()) :: Path.t()
  def real(path, depth \\ 0)
  def real(_path, depth) when depth > 40, do: throw(:symlink_loop)

  def real(path, depth) do
    [root | rest] = path |> Path.expand() |> Path.split()

    Enum.reduce(rest, root, fn part, acc ->
      candidate = Path.join(acc, part)

      case File.read_link(candidate) do
        {:ok, target} -> real(Path.expand(target, acc), depth + 1)
        _ -> candidate
      end
    end)
  end
end
