defmodule LatticeCarrierServer.Operator.CatalogBinding do
  @moduledoc """
  Read-only ingress for a finished catalog ceremony (plan 224, Design 1).

  `load/2` takes the public ceremony directory copied to the carrier host and the
  served Space log path, re-derives everything from the signed log and the public
  artifacts, and returns the one honored bootstrap. Nothing is trusted from
  `verification-report.json`: it is only cross-checked. The `attested` values
  (custody names, separate-host flag, backup digest, and the root-signed origin)
  are carried as unverified operator text; the origin's deployment is R21a. Every
  failure is an atom.
  """

  alias Lattice.Log
  alias LatticeCarrierServer.Durability
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Atoms, Binding, Signer, Store}
  alias Treehouse.TransportCatalog

  @review_cap 16 * 1024
  # Report.@format is private and report.ex is outside this change.
  @report_format "lattice-catalog-ceremony-report-v1"
  @report_keys ~w(format mode signer backup restore custody binding generated_at claim)

  @spec load(term(), term()) ::
          {:ok, %{bootstrap_id: String.t(), record: map(), realm: String.t(), attested: map()}}
          | {:error, atom()}
  def load(ceremony_dir, space_log_path) do
    ingest(ceremony_dir, space_log_path)
  rescue
    _ -> {:error, :ceremony_artifact_malformed}
  catch
    _, _ -> {:error, :ceremony_artifact_malformed}
  end

  defp ingest(ceremony_dir, space_log_path) do
    with {:ok, dir} <- Store.ceremony([ceremony: ceremony_dir], :real),
         {:ok, signer_key, _signer} <- Signer.load(dir, :real),
         {:ok, _payload, record, sha} <- Binding.load_payload(dir, signer_key),
         :ok <- review(dir, record, sha),
         {:ok, binding} <- binding(dir, record, sha),
         {:ok, report} <- report(dir),
         :ok <-
           Store.undisposable([record.catalog_key, record.service_key, record.space_root], :real),
         {:ok, log} <- served(space_log_path),
         :ok <- Binding.profile_unchanged(log, record),
         {:ok, id} <- honored(log, record),
         :ok <- same(binding["bootstrap_id"], id),
         :ok <- same(record.catalog_key, signer_key),
         :ok <- distinct(record),
         :ok <- cross_check(report, record, signer_key, id, sha) do
      {:ok,
       %{
         bootstrap_id: id,
         record: record,
         realm: TransportCatalog.service_realm(record.service_id),
         attested: %{
           custody: report["custody"],
           separate_host: report["restore"]["separate_host"],
           backup_sha256: report["backup"]["sha256"],
           origin: record.origin
         }
       }}
    end
  end

  defp review(dir, record, sha) do
    with {:ok, text} <- Store.read_text(dir, "binding-review.txt", @review_cap),
         true <- Binding.review_matches?(text, record, sha) do
      :ok
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  defp binding(dir, record, sha) do
    with {:ok, found} <- Store.read(dir, "binding.json", Binding.binding_keys()),
         true <- Binding.record_shape?(found, record, sha) do
      {:ok, found}
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  defp report(dir) do
    with {:ok, report} <- Store.read(dir, "verification-report.json", @report_keys),
         true <- report_shape?(report) do
      {:ok, report}
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  defp report_shape?(r) do
    r["format"] == @report_format and is_binary(r["mode"]) and is_binary(r["claim"]) and
      Store.timestamp?(r["generated_at"]) and
      keyed?(r["signer"], %{"public_key_base64" => :string, "fingerprint_sha256" => :string}) and
      keyed?(r["backup"], %{
        "sha256" => :sha256,
        "format" => :format,
        "kdf_iterations" => :integer
      }) and
      keyed?(r["restore"], %{"verified_at" => :timestamp, "separate_host" => :boolean}) and
      keyed?(r["custody"], %{
        "custodian" => :name,
        "passphrase_holder" => :name,
        "rotation_owner" => :name
      }) and
      keyed?(r["binding"], %{
        "status" => :string,
        "bootstrap_id" => :string,
        "record_sha256" => :string,
        "space" => :string
      })
  end

  # A closed key set whose values have the named types.
  defp keyed?(%{} = map, spec) do
    Enum.sort(Map.keys(map)) == Enum.sort(Map.keys(spec)) and
      Enum.all?(spec, fn {key, type} -> typed?(Map.fetch!(map, key), type) end)
  end

  defp keyed?(_, _), do: false

  defp typed?(value, :string), do: is_binary(value)
  # Same rule as Report's private custody name check, without trimming.
  defp typed?(value, :name) when is_binary(value) do
    String.valid?(value) and String.trim(value) == value and value != "" and
      String.length(value) <= 80 and not String.match?(value, ~r/[[:cntrl:]]/u)
  end

  defp typed?(value, :sha256), do: Store.sha256_text?(value)
  defp typed?(value, :timestamp), do: Store.timestamp?(value)
  defp typed?(value, :format), do: is_binary(value) and byte_size(value) <= 128
  defp typed?(_value, :name), do: false
  defp typed?(value, :boolean), do: is_boolean(value)
  defp typed?(value, :integer), do: is_integer(value)

  # Read under the target lock; never `Holder.restore_path/1`, which deletes temp files.
  defp served(path) when is_binary(path) and path != "" do
    Atoms.load()
    path = Path.expand(path)

    read = fn ->
      try do
        Log.restore_verified(path)
      rescue
        _ -> {:error, :invalid_log}
      end
    end

    case Durability.with_target_lock(path, read, retries: 5) do
      {:ok, %{log: log}} -> {:ok, log}
      {:error, {Durability, :target_lock_aborted}} -> {:error, :space_log_busy}
      _ -> {:error, :invalid_space_log}
    end
  end

  defp served(_), do: {:error, :space_log_required}

  defp honored(log, record) do
    case Binding.honored_bootstrap(log, record) do
      {:ok, _} = ok -> ok
      {:error, :binding_not_found} -> {:error, :binding_not_in_served_log}
      {:error, _} = refusal -> refusal
    end
  end

  defp same(left, right),
    do: if(left == right, do: :ok, else: {:error, :ceremony_inconsistent})

  defp distinct(record) do
    keys = [record.catalog_key, record.service_key, record.space_root]
    if length(Enum.uniq(keys)) == 3, do: :ok, else: {:error, :binding_key_reuse}
  end

  # Cross-check only: every value is compared with one re-derived above.
  defp cross_check(report, record, signer_key, id, sha) do
    if report["mode"] == "real" and report["binding"]["status"] == "verified" and
         report["signer"]["public_key_base64"] == Base.encode64(signer_key) and
         report["signer"]["fingerprint_sha256"] == Store.sha256(signer_key) and
         report["binding"]["bootstrap_id"] == id and report["binding"]["record_sha256"] == sha and
         report["binding"]["space"] == record.space,
       do: :ok,
       else: {:error, :catalog_report_mismatch}
  end
end
