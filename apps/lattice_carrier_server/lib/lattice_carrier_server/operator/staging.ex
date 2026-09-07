defmodule LatticeCarrierServer.Operator.Staging do
  @moduledoc """
  Immutable operator candidate staging; no service or publication effects.

  Run only beneath the whole-command Linux operator lock. Existing logs are
  captured and compared, never rewritten. Signature checks prove supplied bytes,
  not current semantic authority, roster completeness, or authenticated readiness.
  Review/generation/catalog-head metadata remains operator intent. The only
  durable phase emitted is carrier_pending.
  """
  alias Lattice.{Authority, Log, Op}
  alias Lattice.Carrier.Wire
  alias LatticeCarrierServer.{Durability, Manifest}
  alias LatticeCarrierServer.Operator.Journal
  @max_artifact 32 * 1024 * 1024

  @spec artifact_path(Path.t(), binary(), binary()) :: Path.t()
  def artifact_path(root, attempt, digest) do
    Path.join([Path.expand(root), "attempt-" <> Journal.digest(attempt), digest])
  end

  @spec prepare(Path.t(), binary() | nil, map(), [map()], keyword()) ::
          {:ok, map()} | {:error, term()}
  def prepare(root, expected, request, artifacts, opts \\ []) do
    durability = Keyword.get(opts, :durability, Durability.Posix)

    with :ok <- Journal.secure_root(root),
         true <- request_valid?(request) and artifacts_valid?(artifacts),
         {:ok, current} <- Journal.read(root),
         true <- current == expected,
         {:ok, manifest} <- Manifest.load(request.active_manifest),
         {:ok, active_bytes} <- File.read(request.active_manifest),
         true <- Journal.digest(active_bytes) == request.manifest_digest,
         {:ok, existing} <- capture_logs(manifest.instances),
         :ok <- retain_directory(root, request.attempt, durability),
         {:ok, retained} <- retain_artifacts(root, request.attempt, artifacts, durability),
         :ok <- exact_inventory(root, request.attempt, retained),
         :ok <- verify_artifacts(retained, manifest.instances),
         :ok <- verify_candidate_manifest(retained, manifest),
         {:ok, after_logs} <- capture_logs(manifest.instances),
         true <- existing == after_logs,
         {:ok, final_manifest} <- File.read(request.active_manifest),
         true <- final_manifest == active_bytes,
         record = %{
           "version" => 1,
           "phase" => "carrier_pending",
           "attempt" => request.attempt,
           "generation" => request.generation,
           "catalog_head" => request.catalog_head,
           "manifest_digest" => request.manifest_digest,
           "artifacts" =>
             Enum.map(
               retained,
               &%{
                 "path" => &1.path,
                 "sha256" => &1.digest,
                 "kind" => Atom.to_string(&1.kind),
                 "replica" => &1.replica,
                 "op_id" => &1.op_id
               }
             )
         },
         :ok <- Journal.compare_and_set(root, expected, record, durability) do
      {:ok, record}
    else
      false -> {:error, :stale_or_invalid_operator_intent}
      {:error, _} = error -> error
    end
  end

  defp request_valid?(r) when is_map(r) do
    Enum.sort(Map.keys(r)) ==
      Enum.sort([:active_manifest, :attempt, :generation, :catalog_head, :manifest_digest]) and
      is_binary(r.active_manifest) and Path.type(r.active_manifest) == :absolute and
      Journal.nonce?(r.attempt) and Journal.digest?(r.manifest_digest) and
      (r.catalog_head == nil or Journal.op_id?(r.catalog_head)) and
      is_integer(r.generation) and r.generation >= 0 and r.generation < 9_007_199_254_740_991
  end

  defp request_valid?(_), do: false

  defp artifacts_valid?(artifacts) when is_list(artifacts) do
    length(artifacts) in 1..128 and
      Enum.all?(artifacts, fn a ->
        is_map(a) and Enum.sort(Map.keys(a)) == [:bytes, :kind, :op_id, :replica] and
          a.kind in [:log, :reference, :manifest] and is_binary(a.bytes) and
          byte_size(a.bytes) in 1..@max_artifact and
          ((a.kind == :manifest and a.replica == nil and a.op_id == nil) or
             (is_binary(a.replica) and Journal.op_id?(a.op_id)))
      end) and Enum.count(artifacts, &(&1.kind == :manifest)) == 1 and
      Enum.count(artifacts, &(&1.kind == :reference)) == 1 and
      Enum.any?(artifacts, &(&1.kind == :log)) and
      Enum.uniq_by(artifacts, &Journal.digest(&1.bytes)) == artifacts
  end

  defp artifacts_valid?(_), do: false

  defp capture_logs(instances) do
    Enum.reduce_while(instances, {:ok, %{}}, fn instance, {:ok, captures} ->
      case Log.restore_verified(instance.log_file) do
        {:ok, %{sha256: digest}} -> {:cont, {:ok, Map.put(captures, instance.log_file, digest)}}
        _ -> {:halt, {:error, :invalid_existing_log}}
      end
    end)
  end

  defp retain_directory(root, attempt, durability) do
    directory = Path.join(Path.expand(root), "attempt-" <> Journal.digest(attempt))

    case File.mkdir(directory) do
      :ok ->
        with :ok <- File.chmod(directory, 0o700),
             :ok <- durability.sync_directory(Path.expand(root)),
             do: :ok

      {:error, :eexist} ->
        Journal.secure_root(directory)

      {:error, _} = error ->
        error
    end
  end

  defp retain_artifacts(root, attempt, artifacts, durability) do
    Enum.reduce_while(artifacts, {:ok, []}, fn artifact, {:ok, retained} ->
      digest = Journal.digest(artifact.bytes)
      path = artifact_path(root, attempt, digest)

      case retain(path, artifact.bytes, durability) do
        :ok -> {:cont, {:ok, retained ++ [Map.merge(artifact, %{path: path, digest: digest})]}}
        {:error, _} = error -> {:halt, error}
      end
    end)
  end

  defp retain(path, bytes, durability) do
    case File.open(path, [:write, :binary, :exclusive]) do
      {:ok, file} ->
        result =
          with :ok <- File.chmod(path, 0o600),
               :ok <- IO.binwrite(file, bytes),
               :ok <- :file.sync(file),
               do: :ok

        _ = File.close(file)
        with :ok <- result, do: durability.sync_directory(Path.dirname(path))

      {:error, :eexist} ->
        with {:ok, %{type: :regular, links: 1}} <- File.lstat(path),
             {:ok, ^bytes} <- File.read(path),
             :ok <- durability.sync_file(path),
             :ok <- durability.sync_directory(Path.dirname(path)) do
          :ok
        else
          _ -> {:error, :immutable_artifact_conflict}
        end

      {:error, _} = error ->
        error
    end
  end

  defp exact_inventory(root, attempt, retained) do
    with {:ok, names} <-
           File.ls(Path.join(Path.expand(root), "attempt-" <> Journal.digest(attempt))),
         true <- Enum.sort(names) == Enum.sort(Enum.map(retained, & &1.digest)) do
      :ok
    else
      _ -> {:error, :ambiguous_staging_inventory}
    end
  end

  defp verify_artifacts(artifacts, instances) do
    Enum.reduce_while(artifacts, :ok, fn artifact, :ok ->
      result =
        case artifact.kind do
          :manifest ->
            :ok

          :log ->
            with {:ok, %{log: log, sha256: digest}} <- Log.restore_verified(artifact.path),
                 true <- digest == artifact.digest and log.replica == artifact.replica,
                 %Op{kind: :authority, body: {:genesis, _, _}, author: author} <-
                   Map.get(log.ops, artifact.op_id),
                 true <-
                   is_binary(Authority.replica_commitment(log.replica)) and
                     Authority.root(log) == author,
                 do: :ok

          :reference ->
            with {:ok, frame} <- Jason.decode(artifact.bytes),
                 {:ok, op} <- Wire.decode_op(frame),
                 true <-
                   Op.valid?(op) and op.id == artifact.op_id and op.replica == artifact.replica,
                 true <- op.kind == :command,
                 {:create_thread, [child_replica, title]} <- op.body,
                 true <-
                   is_binary(title) and
                     Enum.any?(artifacts, &(&1.kind == :log and &1.replica == child_replica)),
                 :ok <- replay_reference(op, instances),
                 do: :ok
        end

      if result == :ok, do: {:cont, :ok}, else: {:halt, {:error, :invalid_staged_signed_artifact}}
    end)
  end

  defp replay_reference(op, instances) do
    Enum.reduce_while(instances, {:error, :missing_space_history}, fn instance, refusal ->
      case Log.restore_verified(instance.log_file) do
        {:ok, %{log: %{replica: replica} = log}} when replica == op.replica ->
          union = Log.append!(log, op)

          if Map.has_key?(Authority.analyze(Treehouse.Space, union).reasons, op.id),
            do: {:halt, {:error, :reference_refused}},
            else: {:halt, :ok}

        _ ->
          {:cont, refusal}
      end
    end)
  end

  defp verify_candidate_manifest(artifacts, active) do
    manifest = Enum.find(artifacts, &(&1.kind == :manifest))

    allowed =
      (Enum.map(active.instances, & &1.log_file) ++
         Enum.filter(artifacts, &(&1.kind == :log)))
      |> Enum.map(fn
        path when is_binary(path) -> path
        artifact -> artifact.path
      end)

    with {:ok, candidate} <- Manifest.load(manifest.path),
         true <- Enum.all?(candidate.instances, &(&1.log_file in allowed)),
         true <-
           Enum.all?(active.instances, fn old ->
             Enum.any?(
               candidate.instances,
               &(&1.name == old.name and &1.log_file == old.log_file)
             )
           end) do
      :ok
    else
      _ -> {:error, :invalid_candidate_manifest}
    end
  end
end
