defmodule LatticeCarrierServer.Operator.CatalogCeremony.Signer do
  @moduledoc false
  # Generating, importing and re-reading the catalog signer seed. The seed is
  # held only inside `Secret`; this module signs nothing.

  alias LatticeCarrierServer.{Manifest, Secret}
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Paths, Store}

  @realm "lattice-catalog-signer"
  @format "lattice-catalog-signer-public-v1"
  @keys ~w(format mode public_key_base64 public_key_hex fingerprint_sha256 created_at host)

  @spec generate(keyword(), :real | :dry_run) :: {:ok, map()} | {:error, atom()}
  def generate(opts, mode) do
    with {:ok, dir} <- Store.ceremony(opts, mode, create: true),
         {:ok, path} <- Paths.signer(opts[:signer], dir, mode),
         :ok <- record_absent(dir),
         seed = fresh_seed(opts, mode),
         pub = public(seed),
         :ok <- Store.undisposable([pub], mode),
         {:ok, inode} <- write_seed(path, seed),
         :ok <- hook(opts, path) do
      # A seed with no public record is an orphan: remove only the file made here.
      case record(dir, pub, mode, false) do
        {:ok, _} = ok ->
          ok

        {:error, _} ->
          Paths.remove_created(path, inode)
          {:error, :ceremony_write_failed}
      end
    end
  end

  # A test seam only: the command line has no way to set it.
  defp hook(opts, path) do
    case opts[:after_seed] do
      fun when is_function(fun, 1) -> fun.(path)
      _ -> :ok
    end
  end

  # Only a dry run may name its seed (a public label's hash); real mode is random.
  defp fresh_seed(opts, mode) do
    if mode == :dry_run and opts[:seed],
      do: opts[:seed],
      else: Secret.wrap(:crypto.strong_rand_bytes(32))
  end

  @spec import_seed(keyword(), :real | :dry_run) :: {:ok, map()} | {:error, atom()}
  def import_seed(opts, mode) do
    with {:ok, dir} <- Store.ceremony(opts, mode, create: true),
         {:ok, path} <- Paths.signer(opts[:signer], dir, mode),
         :ok <- record_absent(dir),
         {:ok, _seed, pub} <- read_seed(path),
         :ok <- Store.undisposable([pub], mode) do
      record(dir, pub, mode, true)
    end
  end

  @doc "Read a seed file under the manifest policy; returns the seed and its public key."
  @spec read_seed(Path.t()) :: {:ok, Secret.t(), binary()} | {:error, :signer_unreadable}
  def read_seed(path) do
    with {:ok, secret, pub} <- Manifest.read_identity_file(path, @realm),
         %{priv: <<_::binary-size(32)>> = seed} <- Secret.unwrap(secret),
         true <- public(Secret.wrap(seed)) == pub do
      {:ok, Secret.wrap(seed), pub}
    else
      _ -> {:error, :signer_unreadable}
    end
  end

  @doc "The Ed25519 public key a wrapped 32-byte seed derives."
  @spec public(Secret.t()) :: binary()
  def public(secret) do
    {pub, _priv} = :crypto.generate_key(:eddsa, :ed25519, Secret.unwrap(secret))
    pub
  end

  @doc "Write a seed in the identity-file format (lowercase hex plus newline), exclusively, mode 0600."
  @spec write_seed(Path.t(), Secret.t()) :: {:ok, non_neg_integer()} | {:error, atom()}
  def write_seed(path, secret) do
    Paths.create_private(
      path,
      fn -> Base.encode16(Secret.unwrap(secret), case: :lower) <> "\n" end,
      :signer_exists,
      :signer_unwritable
    )
  end

  @doc "The public signer record of a ceremony: its key, and whether it is real."
  @spec load(Path.t(), :real | :dry_run) :: {:ok, binary(), map()} | {:error, atom()}
  def load(dir, mode) do
    with {:ok, record} <- Store.read(dir, "signer.json"),
         {:ok, pub} <- Store.decode_key(record["public_key_base64"]),
         true <- shape?(record, pub, mode),
         :ok <- Store.undisposable([pub], mode) do
      {:ok, pub, record}
    else
      {:error, :malformed_key} -> {:error, :ceremony_artifact_malformed}
      {:error, _} = refusal -> refusal
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  # The complete record: exact keys, consistent key encodings, a timestamp and
  # a plausible generation host (separateness is judged against it).
  defp shape?(record, pub, mode) do
    keys = Enum.sort(Map.keys(record))

    keys in [Enum.sort(@keys), Enum.sort(["imported" | @keys])] and
      record["format"] == @format and record["mode"] == mode_text(mode) and
      record["public_key_hex"] == Base.encode16(pub, case: :lower) and
      record["fingerprint_sha256"] == Store.sha256(pub) and
      Map.get(record, "imported", true) == true and
      Store.timestamp?(record["created_at"]) and Store.host_text?(record["host"])
  end

  defp record_absent(dir),
    do: if(Store.exists?(dir, "signer.json"), do: {:error, :signer_record_exists}, else: :ok)

  defp record(dir, pub, mode, imported?) do
    base =
      Map.merge(Store.public_info(pub), %{
        "format" => @format,
        "mode" => mode_text(mode),
        "created_at" => Store.now(),
        "host" => Store.host()
      })

    public = if imported?, do: Map.put(base, "imported", true), else: base

    with {:ok, _} <- Store.write(dir, "signer.json", public), do: {:ok, public}
  end

  defp mode_text(:real), do: "real"
  defp mode_text(:dry_run), do: "dry_run"
end
