defmodule LatticeCarrierServer.Operator.CatalogCeremony.Report do
  @moduledoc false
  # The verification report: a re-check of every public artifact, and the
  # custody names the operator records. It is an operator ceremony record, not
  # a catalogued or listed phase.

  alias LatticeCarrierServer.Operator.CatalogCeremony.{Backup, Binding, Signer, Store}

  @format "lattice-catalog-ceremony-report-v1"
  @claim "This is an operator ceremony record of catalog signer custody and, when present, " <>
           "a verified Space bootstrap binding; it is not catalog publication and not a " <>
           "catalogued or listed phase."

  @spec build(keyword(), :real | :dry_run) :: {:ok, map()} | {:error, atom()}
  def build(opts, mode) do
    with {:ok, dir} <- Store.ceremony(opts, mode),
         {:ok, pub, signer} <- Signer.load(dir, mode),
         :ok <- Store.undisposable([pub], mode),
         {:ok, backup} <- Store.read(dir, "backup.json"),
         :ok <-
           if(Backup.record_shape?(backup), do: :ok, else: {:error, :ceremony_artifact_malformed}),
         {:ok, restore} <- restored(dir, mode),
         :ok <- consistent(pub, backup, restore, signer),
         {:ok, custody} <- custody(opts),
         {:ok, binding} <- binding(dir, pub) do
      document = %{
        "format" => @format,
        "mode" => Atom.to_string(mode),
        "signer" => Map.take(Store.public_info(pub), ["public_key_base64", "fingerprint_sha256"]),
        "backup" => %{
          "sha256" => backup["sha256"],
          "format" => Backup.format(),
          "kdf_iterations" => backup["kdf_iterations"]
        },
        "restore" => Map.take(restore, ["verified_at", "separate_host"]),
        "custody" => custody,
        "binding" => binding,
        "generated_at" => Store.now(),
        "claim" => @claim
      }

      with {:ok, bytes} <- Store.write(dir, "verification-report.json", document) do
        {:ok, %{path: Path.join(dir, "verification-report.json"), sha256: Store.sha256(bytes)}}
      end
    end
  end

  # Separateness is hostname-based and attested by the named people; a real
  # ceremony needs a restore on another host. A dry run records it as it is.
  defp restored(dir, mode) do
    with {:ok, restore} <- Store.read(dir, "restore.json"),
         true <- Backup.proof_shape?(restore) do
      case {restore, mode} do
        {%{"ok" => true, "separate_host" => true}, _} -> {:ok, restore}
        {%{"ok" => true}, :dry_run} -> {:ok, restore}
        {%{"ok" => true}, :real} -> {:error, :restore_not_separate_host}
        _ -> {:error, :restore_not_verified}
      end
    else
      {:error, :ceremony_artifact_missing} -> {:error, :restore_not_verified}
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  defp consistent(pub, backup, restore, signer) do
    encoded = Base.encode64(pub)

    if restore["generation_host"] == signer["host"] and backup["public_key_base64"] == encoded and
         restore["public_key_base64"] == encoded and
         backup["sha256"] == restore["backup_sha256"] and
         backup["backup_format"] == Backup.format() and
         backup["kdf_iterations"] == Backup.iterations(),
       do: :ok,
       else: {:error, :ceremony_inconsistent}
  end

  defp custody(opts) do
    with {:ok, custodian} <- name(opts[:custodian]),
         {:ok, holder} <- name(opts[:passphrase_holder]),
         {:ok, owner} <- name(opts[:rotation_owner]),
         :ok <- split(custodian, holder) do
      {:ok, %{"custodian" => custodian, "passphrase_holder" => holder, "rotation_owner" => owner}}
    end
  end

  defp name(text) when is_binary(text) do
    trimmed = String.trim(text)

    if String.valid?(trimmed) and trimmed != "" and String.length(trimmed) <= 80 and
         not String.match?(trimmed, ~r/[[:cntrl:]]/u),
       do: {:ok, trimmed},
       else: {:error, :malformed_custody_name}
  end

  defp name(_), do: {:error, :malformed_custody_name}

  defp split(custodian, holder) do
    if String.downcase(custodian) == String.downcase(holder),
      do: {:error, :custody_not_split},
      else: :ok
  end

  defp binding(dir, pub) do
    if Store.exists?(dir, "binding-payload.json") and not Store.exists?(dir, "binding-review.txt"),
      do: {:error, :ceremony_artifact_missing},
      else: binding_state(dir, pub)
  end

  defp binding_state(dir, pub) do
    case {Binding.load_payload(dir, pub), Store.read(dir, "binding.json")} do
      {{:ok, _payload, record, sha}, {:ok, %{} = found}} ->
        if Binding.record_shape?(found, record, sha),
          do:
            {:ok,
             %{
               "status" => "verified",
               "bootstrap_id" => found["bootstrap_id"],
               "record_sha256" => sha,
               "space" => record.space
             }},
          else: {:error, :ceremony_inconsistent}

      {{:ok, _payload, _record, sha}, {:error, :ceremony_artifact_missing}} ->
        {:ok, pending(sha)}

      {{:error, :ceremony_artifact_missing}, {:error, :ceremony_artifact_missing}} ->
        {:ok, pending(nil)}

      _ ->
        {:error, :ceremony_inconsistent}
    end
  end

  defp pending(sha),
    do: %{"status" => "pending_root_signature", "payload_sha256" => sha, "blocker" => "row 232"}
end
