defmodule LatticeCarrierServer.Operator.CatalogCeremony.Paths do
  @moduledoc false
  # Path policy for every file that can hold a seed or a backup of one. Paths
  # are canonicalized once and every ancestor must be unswappable by another
  # user, so the window between exclusive creation and the chmod exposes nothing.

  import Bitwise

  @type role :: :signer | :backup

  # A signer path (a generated seed, a restored seed, or the seed to import).
  @spec signer(term(), Path.t(), :real | :dry_run) :: {:ok, Path.t()} | {:error, atom()}
  def signer(path, ceremony, mode) do
    with {:ok, expanded} <- explicit(path, :signer_path_required),
         :ok <- leaf(expanded, :signer_symlink),
         {:ok, canonical} <- canonical(expanded, :unsafe_signer_directory),
         :ok <- leaf(canonical, :signer_symlink),
         :ok <- private_directory(Path.dirname(canonical)),
         :ok <- ancestors_safe(Path.dirname(canonical), :unsafe_signer_directory),
         :ok <- outside_git(canonical, :signer_in_git_checkout, mode),
         :ok <- no_overlap(canonical, ceremony, mode) do
      {:ok, canonical}
    end
  end

  # A backup path. It is ciphertext, but the tool chmods it by path after the
  # exclusive create, so its directory and every ancestor must be owned by this
  # user or root and not group/other-writable unless sticky: nobody else may be
  # able to swap the created entry. It must also differ from the signer's
  # directory tree and stay out of any git work tree.
  @spec backup(term(), Path.t(), :real | :dry_run) :: {:ok, Path.t()} | {:error, atom()}
  def backup(path, signer_path, mode) do
    with {:ok, expanded} <- explicit(path, :backup_path_required),
         :ok <- leaf(expanded, :backup_symlink),
         {:ok, canonical} <- canonical(expanded, :backup_directory_unavailable),
         :ok <- leaf(canonical, :backup_symlink),
         :ok <- plain_directory(Path.dirname(canonical)),
         :ok <-
           ancestors_safe(Path.dirname(canonical), :backup_directory_unavailable,
             include_self: true
           ),
         :ok <- outside_git(canonical, :backup_in_git_checkout, mode),
         :ok <- apart(canonical, signer_path) do
      {:ok, canonical}
    end
  end

  # Resolve every link in the parent once; all later checks and all I/O use
  # this canonical path, so a link swapped after validation is never followed
  # through an ancestor that was not itself checked.
  defp canonical(path, reason) do
    {:ok, real_dir(path)}
  catch
    :symlink_loop -> {:error, reason}
  end

  # An existing backup being read. It is ciphertext, but the copy on the
  # verifying machine follows the secret-path policy: canonicalized once, a
  # regular file owned by this user with no group/other access and a single
  # link, in a directory chain nobody else can swap, outside any git work tree.
  # The returned canonical path is the only one ever read.
  @spec backup_input(term(), :real | :dry_run) :: {:ok, Path.t()} | {:error, atom()}
  def backup_input(path, mode) do
    with {:ok, expanded} <- explicit(path, :backup_path_required),
         {:ok, canonical} <- canonical(expanded, :backup_directory_unavailable),
         :ok <-
           ancestors_safe(Path.dirname(canonical), :backup_directory_unavailable,
             include_self: true
           ),
         :ok <- private_file(canonical),
         :ok <- outside_git(canonical, :backup_in_git_checkout, mode) do
      {:ok, canonical}
    end
  end

  defp private_file(path) do
    with {:ok, %File.Stat{type: :regular, mode: mode, uid: owner, links: 1}} <- File.lstat(path),
         true <- (mode &&& 0o077) == 0,
         true <- owner == uid() do
      :ok
    else
      _ -> {:error, :backup_unreadable}
    end
  end

  @doc """
  Create `path` exclusively (raw `O_EXCL`, so a planted link is never followed),
  then bind the descriptor to the path: chmod 0600, lstat, and require the same
  inode, a regular file, mode 0600 and a single link before any byte is
  written. Returns the created inode. A failure, including a raise while
  producing `content`, removes the file.
  """
  @spec create_private(Path.t(), (-> binary()), atom(), atom()) ::
          {:ok, non_neg_integer()} | {:error, atom()}
  def create_private(path, content, exists, failure) do
    case :file.open(path, [:write, :exclusive, :raw, :binary]) do
      {:ok, fd} ->
        finish_private(fd, path, content, failure)

      {:error, :eexist} ->
        {:error, exists}

      _ ->
        {:error, failure}
    end
  end

  defp finish_private(fd, path, content, failure) do
    inode = descriptor_inode(fd)

    try do
      with true <- is_integer(inode),
           :ok <- File.chmod(path, 0o600),
           :ok <- same_file(path, inode),
           :ok <- :file.write(fd, content.()),
           :ok <- :file.sync(fd) do
        {:ok, inode}
      else
        _ ->
          remove_created(path, inode)
          {:error, failure}
      end
    rescue
      _ ->
        remove_created(path, inode)
        {:error, failure}
    catch
      _, _ ->
        remove_created(path, inode)
        {:error, failure}
    after
      :file.close(fd)
    end
  end

  defp descriptor_inode(fd) do
    case :prim_file.read_handle_info(fd) do
      {:ok, info} -> File.Stat.from_record(info).inode
      _ -> nil
    end
  end

  defp same_file(path, inode) do
    with {:ok, %File.Stat{type: :regular, inode: ^inode, links: 1, mode: mode, uid: owner}} <-
           File.lstat(path),
         true <- (mode &&& 0o7777) == 0o600,
         true <- owner == uid() do
      :ok
    else
      _ -> {:error, :not_the_created_file}
    end
  end

  @doc "Remove `path` only when it is still the file this process created (same inode)."
  @spec remove_created(Path.t(), term()) :: :ok
  def remove_created(path, inode) do
    case File.lstat(path) do
      {:ok, %File.Stat{inode: ^inode, type: :regular}} when is_integer(inode) ->
        File.rm(path)
        :ok

      _ ->
        :ok
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

  @doc """
  Every ancestor of `dir` (after resolving links), up to `/`, must be a real
  directory owned by this user or root and not group/other-writable unless it
  has the sticky bit. With `include_self: false` (the default) the directory
  itself is skipped because the caller checks it more strictly.
  """
  @spec ancestors_safe(Path.t(), atom(), keyword()) :: :ok | {:error, atom()}
  def ancestors_safe(dir, reason, opts \\ []) do
    resolved = real(dir)
    chain = ancestors(resolved)
    chain = if Keyword.get(opts, :include_self, false), do: chain, else: tl(chain)
    me = uid()

    if me != nil and Enum.all?(chain, &safe_ancestor?(&1, me)),
      do: :ok,
      else: {:error, reason}
  catch
    :symlink_loop -> {:error, reason}
  end

  defp safe_ancestor?(dir, me) do
    case File.lstat(dir) do
      {:ok, %File.Stat{type: :directory, mode: mode, uid: owner}} ->
        (owner == me or owner == 0) and
          ((mode &&& 0o022) == 0 or (mode &&& 0o1000) != 0)

      _ ->
        false
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
