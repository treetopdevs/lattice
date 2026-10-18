defmodule LatticeCarrierServer.Operator.CatalogCeremony.Backup do
  @moduledoc false
  # The encrypted signer backup and its restore proof.
  #
  # File: one JSON object. Header fields (everything except `ciphertext_base64`
  # and `tag_base64`) are the AES-256-GCM additional data, encoded as compact
  # JSON with keys sorted at every level. Key = PBKDF2-HMAC-SHA256 of the
  # passphrase bytes, the 16-byte salt, 600000 iterations, 32 bytes. Plaintext
  # is the raw 32-byte Ed25519 seed. Anything else is `malformed_backup`.

  alias LatticeCarrierServer.Operator.CatalogCeremony.{Passphrase, Paths, Signer, Store}
  alias LatticeCarrierServer.Secret

  @format "lattice-catalog-signer-backup-v1"
  @record_format "lattice-catalog-backup-record-v1"
  @iterations 600_000
  @kdf "pbkdf2-hmac-sha256"
  @cipher "aes-256-gcm"
  @header_keys ~w(cipher format kdf public_key_base64)
  @file_keys @header_keys ++ ~w(ciphertext_base64 tag_base64)

  @spec format() :: String.t()
  def format, do: @format

  @spec iterations() :: pos_integer()
  def iterations, do: @iterations

  @spec create(keyword(), :real | :dry_run) :: {:ok, map()} | {:error, atom()}
  def create(opts, mode) do
    with {:ok, dir} <- Store.ceremony(opts, mode),
         {:ok, pub, _record} <- Signer.load(dir, mode),
         :ok <- Store.undisposable([pub], mode),
         {:ok, signer_path} <- Paths.signer(opts[:signer], dir, mode),
         {:ok, backup_path} <- Paths.backup(opts[:out], signer_path, mode),
         {:ok, seed} <- signer_seed(signer_path, pub),
         {:ok, passphrase} <- Passphrase.confirmed(opts),
         bytes = encode(seed, pub, passphrase),
         {:ok, inode} <- write(backup_path, bytes),
         :ok <- hook(opts, backup_path),
         :ok <- self_check(backup_path, inode, passphrase, pub) do
      # A backup with no public record is an orphan: remove only the file made here.
      case record(dir, bytes, pub, opts) do
        {:ok, _} = ok ->
          ok

        {:error, _} ->
          Paths.remove_created(backup_path, inode)
          {:error, :ceremony_write_failed}
      end
    end
  end

  @spec verify(keyword(), :real | :dry_run) :: {:ok, map()} | {:error, atom()}
  def verify(opts, mode) do
    with {:ok, dir} <- Store.ceremony(opts, mode),
         {:ok, pub, signer} <- Signer.load(dir, mode),
         :ok <- Store.undisposable([pub], mode),
         {:ok, recorded} <- Store.read(dir, "backup.json"),
         {:ok, backup_path} <- Paths.backup_input(opts[:backup], mode),
         {:ok, restore_path} <- restore_target(opts, dir, mode),
         {:ok, bytes} <- read(backup_path),
         :ok <- digest(bytes, recorded),
         {:ok, passphrase} <- Passphrase.single(opts),
         {:ok, seed, derived} <- decrypt(bytes, passphrase),
         :ok <- if(derived == pub, do: :ok, else: {:error, :backup_key_mismatch}),
         :ok <- restore(restore_path, seed, pub) do
      proof(dir, bytes, pub, signer, restore_path != nil)
    end
  end

  @doc "Decrypt a backup file's bytes; the seed stays wrapped."
  @spec decrypt(binary(), Secret.t()) :: {:ok, Secret.t(), binary()} | {:error, atom()}
  def decrypt(bytes, passphrase) do
    with {:ok, parsed} <- parse(bytes),
         plain when is_binary(plain) <- open(parsed, derive(passphrase, parsed.salt)),
         <<_::binary-size(32)>> <- plain,
         seed = Secret.wrap(plain),
         pub = Signer.public(seed),
         true <- pub == parsed.pub do
      {:ok, seed, pub}
    else
      {:error, :malformed_backup} = refusal -> refusal
      _ -> {:error, :backup_decrypt_failed}
    end
  end

  @doc "The exact AAD bytes for a header map (string keys): compact JSON, keys sorted at every level."
  @spec aad(map()) :: binary()
  def aad(header), do: header |> sorted() |> Jason.encode!()

  defp sorted(%{} = map) when not is_struct(map) do
    map
    |> Enum.sort_by(&elem(&1, 0))
    |> Enum.map(fn {key, value} -> {key, sorted(value)} end)
    |> Jason.OrderedObject.new()
  end

  defp sorted(value), do: value

  defp open(parsed, key) do
    :crypto.crypto_one_time_aead(
      :aes_256_gcm,
      key,
      parsed.nonce,
      parsed.ciphertext,
      parsed.aad,
      parsed.tag,
      false
    )
  end

  defp encode(seed, pub, passphrase) do
    salt = :crypto.strong_rand_bytes(16)
    nonce = :crypto.strong_rand_bytes(12)
    header = header(pub, salt, nonce)

    {ciphertext, tag} =
      :crypto.crypto_one_time_aead(
        :aes_256_gcm,
        derive(passphrase, salt),
        nonce,
        Secret.unwrap(seed),
        aad(header),
        16,
        true
      )

    header
    |> Map.merge(%{
      "ciphertext_base64" => Base.encode64(ciphertext),
      "tag_base64" => Base.encode64(tag)
    })
    |> Jason.encode!(pretty: true)
    |> Kernel.<>("\n")
  end

  defp header(pub, salt, nonce) do
    %{
      "format" => @format,
      "public_key_base64" => Base.encode64(pub),
      "kdf" => %{
        "name" => @kdf,
        "iterations" => @iterations,
        "salt_base64" => Base.encode64(salt)
      },
      "cipher" => %{"name" => @cipher, "nonce_base64" => Base.encode64(nonce)}
    }
  end

  defp derive(passphrase, salt),
    do: :crypto.pbkdf2_hmac(:sha256, Secret.unwrap(passphrase), salt, @iterations, 32)

  defp parse(bytes) do
    with {:ok, %{} = file} <- Jason.decode(bytes),
         true <- Enum.sort(Map.keys(file)) == Enum.sort(@file_keys),
         true <- file["format"] == @format,
         {:ok, salt, nonce} <- params(file["kdf"], file["cipher"]),
         {:ok, <<_::binary-size(32)>> = ciphertext} <- decode(file["ciphertext_base64"]),
         {:ok, <<_::binary-size(16)>> = tag} <- decode(file["tag_base64"]),
         {:ok, pub} <- Store.decode_key(file["public_key_base64"]) do
      aad = file |> Map.take(@header_keys) |> aad()
      {:ok, %{salt: salt, nonce: nonce, ciphertext: ciphertext, tag: tag, pub: pub, aad: aad}}
    else
      _ -> {:error, :malformed_backup}
    end
  end

  defp params(
         %{"name" => @kdf, "iterations" => @iterations, "salt_base64" => salt64} = kdf,
         %{"name" => @cipher, "nonce_base64" => nonce64} = cipher
       )
       when map_size(kdf) == 3 and map_size(cipher) == 2 do
    with {:ok, <<_::binary-size(16)>> = salt} <- decode(salt64),
         {:ok, <<_::binary-size(12)>> = nonce} <- decode(nonce64) do
      {:ok, salt, nonce}
    else
      _ -> :error
    end
  end

  defp params(_kdf, _cipher), do: :error

  defp decode(text) when is_binary(text), do: Base.decode64(text)
  defp decode(_), do: :error

  defp signer_seed(path, pub) do
    case Signer.read_seed(path) do
      {:ok, seed, ^pub} -> {:ok, seed}
      {:ok, _seed, _other} -> {:error, :signer_key_mismatch}
      {:error, _} = refusal -> refusal
    end
  end

  # A test seam only: the command line has no way to set it.
  defp hook(opts, path) do
    case opts[:after_write] do
      fun when is_function(fun, 1) -> fun.(path)
      _ -> :ok
    end
  end

  # A test seam only: the command line has no way to set it.
  defp record_hook(opts, dir) do
    case opts[:before_record] do
      fun when is_function(fun, 1) -> fun.(dir)
      _ -> :ok
    end
  end

  defp write(path, bytes) do
    Paths.create_private(path, fn -> bytes end, :backup_exists, :backup_unwritable)
  end

  # The file is read back and decrypted before the ceremony trusts it.
  defp self_check(path, inode, passphrase, pub) do
    with {:ok, bytes} <- File.read(path),
         {:ok, _seed, ^pub} <- decrypt(bytes, passphrase) do
      :ok
    else
      _ ->
        Paths.remove_created(path, inode)
        {:error, :backup_self_check_failed}
    end
  end

  defp record(dir, bytes, pub, opts) do
    record = %{
      "format" => @record_format,
      "backup_format" => @format,
      "kdf_iterations" => @iterations,
      "sha256" => Store.sha256(bytes),
      "bytes" => byte_size(bytes),
      "created_at" => Store.now(),
      "public_key_base64" => Base.encode64(pub)
    }

    with :ok <- record_hook(opts, dir),
         {:ok, _} <- Store.write(dir, "backup.json", record),
         do: {:ok, record}
  end

  defp read(path) do
    case File.read(path) do
      {:ok, bytes} -> {:ok, bytes}
      _ -> {:error, :backup_unreadable}
    end
  end

  defp digest(bytes, recorded) do
    if Store.sha256(bytes) == recorded["sha256"],
      do: :ok,
      else: {:error, :backup_digest_mismatch}
  end

  defp restore_target(opts, dir, mode) do
    case opts[:restore_to] do
      nil -> {:ok, nil}
      path -> Paths.signer(path, dir, mode)
    end
  end

  # A restored seed is proven by reading it back through the identity-file
  # policy and re-deriving its public key.
  defp restore(nil, _seed, _pub), do: :ok

  defp restore(path, seed, pub) do
    with {:ok, _inode} <- Signer.write_seed(path, seed),
         {:ok, _restored, ^pub} <- Signer.read_seed(path) do
      :ok
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :restore_check_failed}
    end
  end

  defp proof(dir, bytes, pub, signer, restored?) do
    host = Store.host()

    proof = %{
      "ok" => true,
      "backup_sha256" => Store.sha256(bytes),
      "public_key_base64" => Base.encode64(pub),
      "verified_at" => Store.now(),
      "host" => host,
      "generation_host" => signer["host"],
      "separate_host" => host != signer["host"],
      "seed_restored" => restored?
    }

    with {:ok, _} <- Store.write(dir, "restore.json", proof), do: {:ok, proof}
  end
end
