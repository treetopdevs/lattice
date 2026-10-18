defmodule LatticeCarrierServer.Operator.CatalogCeremony.Store do
  @moduledoc false
  # Public ceremony artifacts only: pretty JSON with a trailing newline in a
  # directory that holds no secret. Every failure is an atom.

  import Bitwise

  alias LatticeCarrierServer.Operator.CatalogCeremony.{DryRun, Paths}

  @marker "DRY-RUN-NOT-REAL"

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

  @spec read(Path.t(), String.t()) :: {:ok, map()} | {:error, atom()}
  def read(dir, name) do
    with {:ok, bytes} <- File.read(Path.join(dir, name)),
         {:ok, %{} = map} <- Jason.decode(bytes) do
      {:ok, map}
    else
      {:error, :enoent} -> {:error, :ceremony_artifact_missing}
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

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
