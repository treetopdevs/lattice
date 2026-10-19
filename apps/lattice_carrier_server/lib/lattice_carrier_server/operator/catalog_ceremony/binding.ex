defmodule LatticeCarrierServer.Operator.CatalogCeremony.Binding do
  @moduledoc false
  # The catalog bootstrap record the Space root must author, and the check
  # that an already-signed Space log carries exactly that record. Nothing here
  # signs: the record is bytes for the root's own device to review and sign.

  alias Lattice.{Authority, Canonical, Log}
  alias Lattice.Authority.ContinuationCertificate
  alias LatticeCarrierServer.Operator.CatalogCeremony.{Atoms, Signer, SpaceExport, Store}
  alias Treehouse.{CatalogBootstrap, TransportCatalog}

  @payload_format "lattice-catalog-bootstrap-payload-v1"
  @binding_format "lattice-catalog-binding-record-v1"
  @base64_fields ~w(space_root catalog_key service_key)
  @atom_fields ~w(product replacement_rule)
  @fields ~w(version product space space_root profile_genesis profile_id replacement_rule
             catalog_key service_id service_key origin nonce)
  @keys Map.new(@fields, &{&1, String.to_atom(&1)})
  @atoms %{"treehouse" => :treehouse, "bounded_space_admin_v1" => :bounded_space_admin_v1}

  @spec payload(keyword(), :real | :dry_run) :: {:ok, map()} | {:error, atom()}
  def payload(opts, mode) do
    with {:ok, dir} <- Store.ceremony(opts, mode),
         {:ok, catalog_key, _} <- Signer.load(dir, mode),
         {:ok, service_key} <- service_key(opts[:service_public_key]),
         {:ok, log} <- space_log(opts[:space_log]),
         {:ok, profile} <- bounded(log),
         :ok <- distinct([catalog_key, service_key, profile.root]),
         :ok <- Store.undisposable([catalog_key, service_key, profile.root], mode),
         {:ok, service_id} <- identifier(opts[:service_id]),
         record = record(log, profile, catalog_key, service_key, service_id, opts[:origin]),
         {:ok, ^record} <- normalized(record) do
      write(dir, record, opts[:before_review])
    end
  end

  @spec verify(keyword(), :real | :dry_run) :: {:ok, map()} | {:error, atom()}
  def verify(opts, mode) do
    with {:ok, dir} <- Store.ceremony(opts, mode),
         {:ok, catalog_key, _} <- Signer.load(dir, mode),
         {:ok, _payload, record, sha} <- load_payload(dir, catalog_key),
         :ok <-
           Store.undisposable(
             [record.catalog_key, record.space_root, record.service_key],
             mode
           ),
         {:ok, log} <- space_log(opts[:space_log]),
         :ok <- profile_unchanged(log, record),
         {:ok, id} <- honored(log, record) do
      binding = %{
        "format" => @binding_format,
        "bootstrap_id" => id,
        "record_sha256" => sha,
        "space" => record.space,
        "verified_at" => Store.now()
      }

      with {:ok, _} <- Store.write(dir, "binding.json", binding), do: {:ok, binding}
    end
  end

  @doc """
  Whether a `binding.json` map is the complete record `verify/2` writes for this
  payload record: exact keys, format, an id, the payload hash, the payload's
  Space and a valid timestamp.
  """
  @spec record_shape?(map(), map(), String.t()) :: boolean()
  def record_shape?(found, record, sha) do
    Enum.sort(Map.keys(found)) ==
      Enum.sort(~w(format bootstrap_id record_sha256 space verified_at)) and
      found["format"] == @binding_format and ContinuationCertificate.id?(found["bootstrap_id"]) and
      found["record_sha256"] == sha and found["space"] == record.space and
      Store.timestamp?(found["verified_at"])
  end

  @doc "Read and re-check the payload artifact; returns the record rebuilt from its JSON."
  @spec load_payload(Path.t(), binary()) :: {:ok, map(), map(), String.t()} | {:error, atom()}
  def load_payload(dir, catalog_key) do
    with {:ok, payload} <- Store.read(dir, "binding-payload.json"),
         :ok <- review_present(dir),
         true <- payload["format"] == @payload_format,
         {:ok, record} <- from_json(payload["record"]),
         canonical = Canonical.term(record),
         true <- payload["canonical_base64"] == Base.encode64(canonical),
         true <- payload["sha256"] == Store.sha256(canonical),
         {:ok, ^record} <- normalized(record) do
      if record.catalog_key == catalog_key,
        do: {:ok, payload, record, payload["sha256"]},
        else: {:error, :ceremony_inconsistent}
    else
      {:error, :ceremony_artifact_missing} = refusal -> refusal
      _ -> {:error, :ceremony_artifact_malformed}
    end
  end

  defp review_present(dir) do
    if Store.exists?(dir, "binding-review.txt"),
      do: :ok,
      else: {:error, :ceremony_artifact_missing}
  end

  @doc "The JSON-friendly record: binaries as standard base64, atoms as strings."
  @spec to_json(map()) :: map()
  def to_json(record) do
    Map.new(record, fn {key, value} ->
      name = Atom.to_string(key)

      cond do
        name in @base64_fields -> {name, Base.encode64(value)}
        name in @atom_fields -> {name, Atom.to_string(value)}
        true -> {name, value}
      end
    end)
  end

  @doc "Strict inverse of `to_json/1`; unknown fields or atom names are refused."
  @spec from_json(term()) :: {:ok, map()} | {:error, :malformed_binding}
  def from_json(%{} = json) do
    if Enum.sort(Map.keys(json)) == Enum.sort(@fields) do
      Enum.reduce_while(json, {:ok, %{}}, fn {name, value}, {:ok, acc} ->
        case field(name, value) do
          {:ok, decoded} -> {:cont, {:ok, Map.put(acc, Map.fetch!(@keys, name), decoded)}}
          :error -> {:halt, {:error, :malformed_binding}}
        end
      end)
    else
      {:error, :malformed_binding}
    end
  end

  def from_json(_), do: {:error, :malformed_binding}

  defp field(name, value) when name in @base64_fields do
    case Store.decode_key(value) do
      {:ok, key} -> {:ok, key}
      _ -> :error
    end
  end

  defp field(name, value) when name in @atom_fields do
    case Map.fetch(@atoms, value) do
      {:ok, atom} -> {:ok, atom}
      :error -> :error
    end
  end

  defp field(_name, value), do: {:ok, value}

  defp service_key(text) do
    case Store.decode_key(text) do
      {:ok, key} -> {:ok, key}
      _ -> {:error, :malformed_binding}
    end
  end

  # The Space history is either a `Lattice.Log.dump` or the app's frames export
  # (D-31, a JSON object). Dispatch is by the first non-whitespace byte; both
  # readers verify as strictly as each other and share one refusal.
  defp space_log(path) when is_binary(path) and path != "" do
    Atoms.load()
    path = Path.expand(path)

    case exported?(path) do
      true -> export_log(path)
      false -> dump_log(path)
    end
  end

  defp space_log(_), do: {:error, :space_log_required}

  defp export_log(path) do
    case SpaceExport.load(path) do
      {:ok, log} -> {:ok, log}
      _ -> {:error, :invalid_space_log}
    end
  end

  defp dump_log(path) do
    case Log.restore_verified(path) do
      {:ok, %{log: log}} -> {:ok, log}
      _ -> {:error, :invalid_space_log}
    end
  end

  defp exported?(path) do
    case File.open(path, [:read, :binary], &IO.binread(&1, 64)) do
      {:ok, head} when is_binary(head) -> String.trim_leading(head) |> String.starts_with?("{")
      _ -> false
    end
  end

  # Only a bounded-continuation Space with a selected R04 pin can carry the
  # bootstrap; a legacy-family Space cannot (row 232).
  defp bounded(log) do
    case Authority.continuation_profile(log) do
      {:ok, %{profile: %{kind: :space}} = profile} -> {:ok, profile}
      _ -> {:error, :space_not_bounded_profile}
    end
  end

  # The reviewed record named the Space's pin at payload time; the supplied log
  # must still carry exactly that pin (a later pin changes the profile).
  defp profile_unchanged(log, record) do
    case Authority.continuation_profile(log) do
      {:ok, %{profile: %{kind: :space}} = profile}
      when log.replica == record.space and profile.root == record.space_root and
             profile.profile_genesis == record.profile_genesis and
             profile.profile_id == record.profile_id ->
        :ok

      _ ->
        {:error, :binding_profile_changed}
    end
  end

  defp distinct(keys),
    do: if(length(Enum.uniq(keys)) == length(keys), do: :ok, else: {:error, :binding_key_reuse})

  defp identifier(nil), do: {:ok, fresh()}

  defp identifier(value) do
    if ContinuationCertificate.id?(value),
      do: {:ok, value},
      else: {:error, :malformed_binding}
  end

  defp fresh, do: :crypto.strong_rand_bytes(32) |> Base.url_encode64(padding: false)

  defp record(log, profile, catalog_key, service_key, service_id, origin) do
    %{
      version: 1,
      product: :treehouse,
      space: log.replica,
      space_root: profile.root,
      profile_genesis: profile.profile_genesis,
      profile_id: profile.profile_id,
      replacement_rule: :bounded_space_admin_v1,
      catalog_key: catalog_key,
      service_id: service_id,
      service_key: service_key,
      origin: origin,
      nonce: fresh()
    }
  end

  defp normalized(record) do
    case TransportCatalog.normalize_bootstrap(record) do
      {:ok, normal} -> {:ok, normal}
      _ -> {:error, :malformed_binding}
    end
  end

  defp write(dir, record, hook) do
    canonical = Canonical.term(record)
    sha = Store.sha256(canonical)

    payload = %{
      "format" => @payload_format,
      "record" => to_json(record),
      "record_encoding" => %{
        "base64_fields" => @base64_fields,
        "atom_fields" => @atom_fields,
        "note" =>
          "Binary fields are standard base64 of 32 raw bytes; atom fields are the atom name. " <>
            "canonical_base64 is Lattice.Canonical.term/1 of the record with atoms and raw binaries."
      },
      "canonical_base64" => Base.encode64(canonical),
      "sha256" => sha
    }

    with {:ok, written} <- Store.write(dir, "binding-payload.json", payload) do
      # A payload with no review sheet is an orphan: remove only the bytes written here.
      with :ok <- before_review(hook, dir),
           {:ok, _} <- Store.write_text(dir, "binding-review.txt", review(record, sha)) do
        {:ok, payload}
      else
        _ ->
          remove_if_unchanged(Path.join(dir, "binding-payload.json"), written)
          {:error, :ceremony_write_failed}
      end
    end
  end

  # A test seam only: the command line has no way to set it.
  defp before_review(fun, dir) when is_function(fun, 1), do: fun.(dir)
  defp before_review(_, _dir), do: :ok

  defp remove_if_unchanged(path, bytes) do
    if File.read(path) == {:ok, bytes}, do: File.rm(path)
    :ok
  end

  defp review(record, sha) do
    lines =
      for name <- @fields do
        value = Map.fetch!(record, Map.fetch!(@keys, name))
        "#{String.pad_trailing(name, 18)} #{display(name, value)}"
      end

    Enum.join(
      [
        "Catalog bootstrap review sheet (lattice-catalog-bootstrap-payload-v1)",
        "The Space root authors this exact record as {:catalog_bootstrap_v1, [record]}.",
        "Check every line against the intended catalog signer, service and origin.",
        "" | lines
      ] ++ ["", "canonical sha256    #{sha}", ""],
      "\n"
    )
  end

  defp display(name, value) when name in @base64_fields, do: Base.encode64(value)
  defp display(_name, value), do: to_string(value)

  # One distinct honored record, equal to the payload, authored by the root.
  defp honored(log, record) do
    with {:ok, %{bootstraps: found}} <- CatalogBootstrap.observe(log) do
      authored = Enum.filter(found, &authored_by_root?(log, &1))

      case Enum.uniq_by(authored, & &1.record) do
        [] -> {:error, :binding_not_found}
        [%{record: ^record, id: id}] -> {:ok, id}
        [_one] -> {:error, :binding_not_found}
        _many -> {:error, :binding_fork}
      end
    else
      _ -> {:error, :invalid_space_log}
    end
  end

  defp authored_by_root?(log, %{id: id, record: record}) do
    match?({:ok, %{author: author}} when author == record.space_root, Log.fetch(log, id))
  end
end
