defmodule LatticeCarrierServer.Operator.CatalogCeremony.Store do
  @moduledoc false
  # Public ceremony artifacts only: pretty JSON with a trailing newline in a
  # directory that holds no secret. Every failure is an atom.

  import Bitwise

  alias LatticeCarrierServer.Operator.CatalogCeremony.{DryRun, Paths}

  @marker "DRY-RUN-NOT-REAL"
  @max_artifact_bytes 64 * 1024

  @spec marker() :: String.t()
  def marker, do: @marker

  # Resolves the ceremony directory. `create: true` makes a missing directory
  # (mode 0700); every other command needs an existing one. A real-mode
  # command never accepts a directory a dry run has marked.
  @spec ceremony(keyword(), :real | :dry_run, keyword()) :: {:ok, Path.t()} | {:error, atom()}
  def ceremony(opts, mode, flags \\ []) do
    with dir when is_binary(dir) and dir != "" <- opts[:ceremony],
         expanded = Path.expand(dir),
         :ok <- directory(expanded, Keyword.get(flags, :create, false)),
         :ok <- private(expanded),
         :ok <- marker_clear(expanded, mode) do
      {:ok, expanded}
    else
      nil -> {:error, :ceremony_required}
      {:error, _} = refusal -> refusal
      _ -> {:error, :ceremony_required}
    end
  end

  defp directory(path, create?) do
    case File.lstat(path) do
      {:ok, %File.Stat{type: :directory}} -> :ok
      {:ok, _} -> {:error, :ceremony_directory_invalid}
      {:error, :enoent} when create? -> make(path)
      {:error, _} -> {:error, :ceremony_directory_invalid}
    end
  end

  # An existing ceremony directory must belong to this user with no group or
  # other access, and every ancestor must be safe to traverse.
  defp private(path) do
    with {:ok, %File.Stat{type: :directory, mode: mode, uid: owner}} <- File.lstat(path),
         true <- (mode &&& 0o077) == 0 and owner == Paths.uid(),
         :ok <- Paths.ancestors_safe(path, :ceremony_directory_invalid) do
      :ok
    else
      _ -> {:error, :ceremony_directory_invalid}
    end
  end

  defp make(path) do
    with :ok <- File.mkdir_p(path),
         :ok <- File.chmod(path, 0o700) do
      :ok
    else
      _ -> {:error, :ceremony_directory_invalid}
    end
  end

  defp marker_clear(dir, :real) do
    if File.exists?(Path.join(dir, @marker)),
      do: {:error, :dry_run_ceremony_dir},
      else: :ok
  end

  defp marker_clear(_dir, :dry_run), do: :ok

  # A real ceremony never uses a key a dry run derives from a public label.
  @spec undisposable([binary()], :real | :dry_run) :: :ok | {:error, :disposable_test_key}
  def undisposable(keys, :real) do
    disposable = DryRun.public_keys()

    if Enum.any?(keys, &(&1 in disposable)),
      do: {:error, :disposable_test_key},
      else: :ok
  end

  def undisposable(_keys, :dry_run), do: :ok

  @doc "The largest ceremony artifact `read/2` and `read_text/3` accept by default."
  @spec max_artifact_bytes() :: pos_integer()
  def max_artifact_bytes, do: @max_artifact_bytes

  # Strict JSON object artifact: bounded, regular, single-link, unchanged while
  # read, no repeated key at any depth.
  @spec read(Path.t(), String.t()) :: {:ok, map()} | {:error, atom()}
  def read(dir, name), do: read_between(dir, name, fn _ -> :ok end)

  # Test seam the command line cannot reach: `between` runs after the first
  # lstat and before the open, the window a swapped artifact would use.
  @doc false
  # `between` is a test seam only: called with `:before_open` and `:after_open`.
  @spec read_between(Path.t(), String.t(), (atom() -> term())) :: {:ok, map()} | {:error, atom()}
  def read_between(dir, name, between) when is_function(between, 1) do
    with {:ok, bytes} <- read_bounded(dir, name, @max_artifact_bytes, between),
         {:ok, decoded} <- Jason.decode(bytes, objects: :ordered_objects),
         {:ok, %{} = map} <- plain(decoded) do
      {:ok, map}
    else
      {:error, :ceremony_artifact_missing} = refusal -> refusal
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  @doc "Like `read/2`, and the top-level key set must be exactly `keys`."
  @spec read(Path.t(), String.t(), [String.t()]) :: {:ok, map()} | {:error, atom()}
  def read(dir, name, keys) do
    with {:ok, map} <- read(dir, name) do
      if Enum.sort(Map.keys(map)) == Enum.sort(keys),
        do: {:ok, map},
        else: {:error, :ceremony_artifact_malformed}
    end
  end

  @spec read_text(Path.t(), String.t(), pos_integer()) :: {:ok, binary()} | {:error, atom()}
  def read_text(dir, name, cap) do
    with {:ok, bytes} <- read_bounded(dir, name, cap),
         true <- String.valid?(bytes) do
      {:ok, bytes}
    else
      {:error, :ceremony_artifact_missing} = refusal -> refusal
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  defp read_bounded(dir, name, cap, between \\ fn _ -> :ok end) do
    path = Path.join(dir, name)

    case File.lstat(path) do
      {:ok, %File.Stat{type: :regular, links: 1, size: size} = first} when size <= cap ->
        between.(:before_open)
        read_file(path, first, cap, between)

      {:error, :enoent} ->
        {:error, :ceremony_artifact_missing}

      _ ->
        {:error, :ceremony_artifact_malformed}
    end
  end

  defp read_file(path, first, cap, between) do
    # A FIFO swapped in by a same-uid writer can still block open; the 0700
    # owner-only ceremony directory is the boundary (Erlang has no
    # O_NOFOLLOW/O_NONBLOCK open).
    with {:ok, fd} <- :file.open(path, [:read, :raw, :binary]) do
      result = if opened_matches?(fd, first, cap), do: :file.read(fd, cap + 1), else: :swapped
      :file.close(fd)
      between.(:after_open)

      with {:ok, bytes} when byte_size(bytes) <= cap <- result,
           {:ok, second} <- File.lstat(path),
           true <- second.inode == first.inode and second.size == first.size do
        {:ok, bytes}
      else
        :eof -> {:ok, ""}
        _ -> {:error, :ceremony_artifact_malformed}
      end
    else
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  # The opened descriptor must be the artifact the first lstat saw.
  defp opened_matches?(fd, first, cap) do
    case :prim_file.read_handle_info(fd) do
      {:ok, record} ->
        info = File.Stat.from_record(record)

        info.type == :regular and info.links == 1 and info.inode == first.inode and
          info.major_device == first.major_device and info.size <= cap

      _ ->
        false
    end
  end

  # Ordered objects keep repeats; any repeated key refuses the whole artifact.
  defp plain(%Jason.OrderedObject{values: values}) do
    keys = Enum.map(values, &elem(&1, 0))

    if length(Enum.uniq(keys)) == length(keys) do
      Enum.reduce_while(values, {:ok, %{}}, fn {key, value}, {:ok, acc} ->
        case plain(value) do
          {:ok, converted} -> {:cont, {:ok, Map.put(acc, key, converted)}}
          :error -> {:halt, :error}
        end
      end)
    else
      :error
    end
  end

  defp plain(list) when is_list(list) do
    Enum.reduce_while(list, {:ok, []}, fn item, {:ok, acc} ->
      case plain(item) do
        {:ok, converted} -> {:cont, {:ok, [converted | acc]}}
        :error -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, reversed} -> {:ok, Enum.reverse(reversed)}
      :error -> :error
    end
  end

  defp plain(other), do: {:ok, other}

  @spec exists?(Path.t(), String.t()) :: boolean()
  def exists?(dir, name), do: File.exists?(Path.join(dir, name))

  @spec write(Path.t(), String.t(), map()) :: {:ok, binary()} | {:error, :ceremony_write_failed}
  def write(dir, name, map), do: write_text(dir, name, Jason.encode!(map, pretty: true) <> "\n")

  # `suffix` is a test seam only; callers use the random default.
  @spec write_text(Path.t(), String.t(), binary(), String.t()) ::
          {:ok, binary()} | {:error, :ceremony_write_failed}
  def write_text(dir, name, bytes, suffix \\ random_suffix()) do
    target = Path.join(dir, name)
    temporary = Path.join(dir, "." <> name <> "." <> suffix <> ".tmp")

    # Exclusive raw creation: a planted link at the temporary name is never followed.
    with {:ok, fd} <- :file.open(temporary, [:write, :exclusive, :raw, :binary]) do
      written = :file.write(fd, bytes)
      :file.close(fd)

      with :ok <- written,
           :ok <- File.rename(temporary, target) do
        {:ok, bytes}
      else
        _ -> failed(temporary)
      end
    else
      _ -> {:error, :ceremony_write_failed}
    end
  end

  defp random_suffix, do: :crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)

  defp failed(temporary) do
    File.rm(temporary)
    {:error, :ceremony_write_failed}
  end

  @spec sha256(binary()) :: String.t()
  def sha256(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)

  @spec now() :: String.t()
  def now, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()

  @spec host() :: String.t()
  def host do
    case :inet.gethostname() do
      {:ok, name} -> List.to_string(name)
      _ -> "unknown"
    end
  end

  @doc "A nonempty host name: valid text, no control characters, at most 255 bytes."
  @spec host_text?(term()) :: boolean()
  def host_text?(host) when is_binary(host) do
    String.valid?(host) and host != "" and byte_size(host) <= 255 and
      not String.match?(host, ~r/[[:cntrl:]]/u)
  end

  def host_text?(_), do: false

  @doc "A 64-character lowercase hex digest."
  @spec sha256_text?(term()) :: boolean()
  def sha256_text?(text) when is_binary(text), do: text =~ ~r/\A[0-9a-f]{64}\z/
  def sha256_text?(_), do: false

  @doc "An ISO 8601 UTC timestamp string."
  @spec timestamp?(term()) :: boolean()
  def timestamp?(text) when is_binary(text), do: match?({:ok, _, _}, DateTime.from_iso8601(text))
  def timestamp?(_), do: false

  @spec public_info(binary()) :: map()
  def public_info(pub) do
    %{
      "public_key_base64" => Base.encode64(pub),
      "public_key_hex" => Base.encode16(pub, case: :lower),
      "fingerprint_sha256" => sha256(pub)
    }
  end

  @spec decode_key(term()) :: {:ok, binary()} | {:error, :malformed_key}
  def decode_key(text) when is_binary(text) do
    case Base.decode64(text) do
      {:ok, <<_::binary-size(32)>> = key} -> {:ok, key}
      _ -> {:error, :malformed_key}
    end
  end

  def decode_key(_), do: {:error, :malformed_key}
end
