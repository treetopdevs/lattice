defmodule LatticeCarrierServer.Operator.Journal do
  @moduledoc """
  Local candidate journal, never an activated manifest or catalog authority.

  Mutations acquire and own a Linux OS lock for the entire transaction. The
  compare is cooperative CAS among those operator processes, not a lock against
  an unrelated writer. Generation/catalog-head values are reviewed intent only.
  An ambiguous file or failed sync is retained for explicit reconciliation.
  """
  import Bitwise
  alias Jason.OrderedObject
  alias LatticeCarrierServer.Operator.Lock
  @fields ~w(version phase attempt generation catalog_head manifest_digest artifacts)
  @artifact_fields ~w(kind op_id path replica review sha256)
  @review_fields ~w(creation grants profile_genesis profile_id)
  @grant_fields ~w(delegation introduction recipient)
  @max_bytes 1_048_576

  # System.cmd/3 raises on a nonzero exit and ErlangError when `id` cannot run
  # at all; both must become a closed refusal rather than escaping this guard.
  @spec secure_root(Path.t()) :: :ok | {:error, term()}
  def secure_root(root) do
    case System.cmd("id", ["-u"], stderr_to_stdout: true) do
      {uid, 0} ->
        case Integer.parse(String.trim(uid)) do
          {value, ""} -> secure_directory(Path.expand(root), value)
          _ -> {:error, :unsafe_operator_directory}
        end

      _ ->
        {:error, :unsafe_operator_directory}
    end
  rescue
    ErlangError -> {:error, :unsafe_operator_directory}
  end

  defp secure_directory(path, uid) do
    case File.lstat(path) do
      {:ok, %{type: :directory, uid: owner, mode: mode}}
      when owner in [0, uid] and band(mode, 0o022) == 0 ->
        if Path.dirname(path) == path, do: :ok, else: secure_directory(Path.dirname(path), uid)

      _ ->
        {:error, :unsafe_operator_directory}
    end
  end

  @spec read(Path.t()) :: {:ok, binary() | nil} | {:error, term()}
  def read(root) do
    with :ok <- secure_root(root) do
      case File.lstat(path(root)) do
        {:error, :enoent} ->
          {:ok, nil}

        {:ok, %{type: :regular, mode: mode, links: 1, size: size}}
        when band(mode, 0o077) == 0 and size <= @max_bytes ->
          with {:ok, raw} <- File.read(path(root)),
               {:ok, record} <- decode(raw),
               true <- artifacts_contained?(record, root) do
            {:ok, raw}
          else
            _ -> {:error, :corrupt_operator_journal}
          end

        _ ->
          {:error, :corrupt_operator_journal}
      end
    end
  end

  @spec decode(binary()) :: {:ok, map()} | {:error, term()}
  def decode(raw) when is_binary(raw) and byte_size(raw) <= @max_bytes do
    with {:ok, record} <- Jason.decode(raw),
         true <- valid?(record),
         true <- Jason.encode!(canonical(record)) == raw do
      {:ok, record}
    else
      _ -> {:error, :corrupt_operator_journal}
    end
  end

  def decode(_), do: {:error, :corrupt_operator_journal}

  @spec compare_and_set(Path.t(), binary() | nil, map()) :: :ok | {:error, term()}
  def compare_and_set(root, expected, next) do
    if valid?(next) and artifacts_contained?(next, root) do
      Lock.commit(root, expected, encode(next))
    else
      {:error, :corrupt_operator_journal}
    end
  end

  # `Lock.stage/6`'s own commit step must serialize a completed record through
  # this exact canonical order too — any independent `Jason.encode!/1` there
  # would (re)introduce the incidental-key-order fragility `canonical/1`
  # exists to close, since `decode/1` verifies against this same output.
  @spec encode(map()) :: binary()
  def encode(record), do: Jason.encode!(canonical(record))

  # Jason does not guarantee ordinary map key order (it is at the mercy of
  # `:maps.to_list/1`), so a future Elixir/Jason change could otherwise flip
  # the byte-for-byte comparison this journal relies on for `decode/1` and
  # `compare_and_set/3`. Every object this journal writes or re-verifies is
  # therefore rebuilt with an explicit, fixed field order before encoding.
  defp canonical(record) do
    OrderedObject.new(Enum.map(@fields, &{&1, canonical_field(&1, record[&1])}))
  end

  defp canonical_field("artifacts", artifacts), do: Enum.map(artifacts, &canonical_artifact/1)
  defp canonical_field(_key, value), do: value

  defp canonical_artifact(a) do
    OrderedObject.new(Enum.map(@artifact_fields, &{&1, canonical_artifact_field(&1, a[&1])}))
  end

  defp canonical_artifact_field("review", review), do: canonical_review(review)
  defp canonical_artifact_field(_key, value), do: value

  defp canonical_review(nil), do: nil

  defp canonical_review(review) do
    OrderedObject.new(Enum.map(@review_fields, &{&1, canonical_review_field(&1, review[&1])}))
  end

  defp canonical_review_field("grants", grants), do: Enum.map(grants, &canonical_grant/1)
  defp canonical_review_field(_key, value), do: value

  defp canonical_grant(g), do: OrderedObject.new(Enum.map(@grant_fields, &{&1, g[&1]}))

  # An artifact path is trusted content once it is in the journal: `Staging`
  # joins every attempt path under the operator root, and nothing else should
  # ever be able to persist a record naming a path elsewhere. Reject anything
  # that is not already a normalized (no `..`/`.` segments), strictly
  # root-contained path, both when writing and when re-trusting a stored one.
  defp artifacts_contained?(record, root) do
    base = Path.expand(root)

    Enum.all?(record["artifacts"], fn artifact ->
      path = artifact["path"]

      is_binary(path) and Path.expand(path) == path and String.starts_with?(path, base <> "/")
    end)
  end

  defp valid?(r) when is_map(r) do
    Enum.sort(Map.keys(r)) == Enum.sort(@fields) and r["version"] === 1 and
      r["phase"] == "carrier_pending" and nonce?(r["attempt"]) and
      is_integer(r["generation"]) and r["generation"] >= 0 and
      r["generation"] < 9_007_199_254_740_991 and
      (r["catalog_head"] == nil or op_id?(r["catalog_head"])) and
      digest?(r["manifest_digest"]) and is_list(r["artifacts"]) and
      length(r["artifacts"]) in 1..128 and Enum.all?(r["artifacts"], &artifact?/1) and
      length(Enum.uniq_by(r["artifacts"], & &1["path"])) == length(r["artifacts"])
  end

  defp valid?(_), do: false

  defp artifact?(a) when is_map(a) do
    Enum.sort(Map.keys(a)) == @artifact_fields and is_binary(a["path"]) and
      Path.type(a["path"]) == :absolute and digest?(a["sha256"]) and
      a["kind"] in ["log", "reference", "manifest"] and
      ((a["kind"] == "manifest" and a["replica"] == nil and a["op_id"] == nil and
          a["review"] == nil) or
         (a["kind"] != "manifest" and is_binary(a["replica"]) and op_id?(a["op_id"]) and
            review?(a)))
  end

  defp artifact?(_), do: false

  defp review?(%{"kind" => "reference", "review" => nil}), do: true

  defp review?(%{"kind" => "log", "review" => r}) when is_map(r) do
    Enum.sort(Map.keys(r)) == ~w(creation grants profile_genesis profile_id) and
      Enum.all?(~w(creation profile_genesis profile_id), &op_id?(r[&1])) and
      is_list(r["grants"]) and length(r["grants"]) <= 128 and
      Enum.all?(r["grants"], fn g ->
        is_map(g) and Enum.sort(Map.keys(g)) == ~w(delegation introduction recipient) and
          is_binary(g["recipient"]) and op_id?(g["delegation"]) and op_id?(g["introduction"])
      end)
  end

  defp review?(_), do: false

  @spec nonce?(term()) :: boolean()
  def nonce?(value), do: op_id?(value)

  @spec op_id?(term()) :: boolean()
  def op_id?(value) when is_binary(value) do
    case Base.url_decode64(value, padding: false) do
      {:ok, bytes} -> byte_size(bytes) == 32 and Base.url_encode64(bytes, padding: false) == value
      _ -> false
    end
  end

  def op_id?(_), do: false

  @spec digest?(term()) :: boolean()
  def digest?(value), do: is_binary(value) and Regex.match?(~r/\A[0-9a-f]{64}\z/, value)
  @spec digest(binary()) :: binary()
  def digest(bytes), do: :crypto.hash(:sha256, bytes) |> Base.encode16(case: :lower)
  @spec path(Path.t()) :: Path.t()
  def path(root), do: Path.join(Path.expand(root), "operator-journal.json")
end
