defmodule LatticeCarrierServer.Operator.Staging do
  @moduledoc """
  Read-only authenticated preparation plus an isolated Linux mutation owner.

  The Python3 helper holds its own flock through staging, BEAM inspection, and
  durable commit/reopen. BEAM never writes or renames operator files. Current
  manifest/log digests are rechecked by that same owner before commit.
  The candidate is not activation, authenticated readiness, or publication.
  Generation/catalog-head values remain reviewed operator intent.
  """
  alias Lattice.Authority
  alias Lattice.Carrier.Wire
  alias Lattice.Log
  alias Lattice.Op
  alias LatticeCarrierServer.Manifest
  alias LatticeCarrierServer.Operator.{Journal, Lock}
  @max_artifact 32 * 1024 * 1024

  @spec artifact_path(Path.t(), binary(), binary()) :: Path.t()
  def artifact_path(root, attempt, digest),
    do: Path.join([Path.expand(root), "attempt-" <> Journal.digest(attempt), digest])

  @spec prepare(Path.t(), binary() | nil, map(), [map()]) :: {:ok, map()} | {:error, term()}
  def prepare(root, expected, request, artifacts) do
    with true <- :os.type() == {:unix, :linux},
         :ok <- Journal.secure_root(root),
         true <- request_valid?(request) and artifacts_valid?(artifacts),
         {:ok, ^expected} <- Journal.read(root),
         {:ok, manifest} <- Manifest.load(request.active_manifest),
         {:ok, bytes} <- File.read(request.active_manifest),
         true <- Journal.digest(bytes) == request.manifest_digest,
         {:ok, checks} <- capture_logs(manifest.instances) do
      checks = [%{path: request.active_manifest, sha256: request.manifest_digest} | checks]

      material =
        Enum.map(artifacts, &%{sha256: Journal.digest(&1.bytes), bytes: Base.encode64(&1.bytes)})

      retained =
        Enum.map(artifacts, fn artifact ->
          digest = Journal.digest(artifact.bytes)

          Map.merge(artifact, %{
            digest: digest,
            path: artifact_path(root, request.attempt, digest)
          })
        end)

      Lock.stage(root, expected, request.attempt, checks, material, fn ->
        with :ok <- inspect_staged(retained, manifest) do
          {:ok,
           %{
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
                   "op_id" => &1.op_id,
                   "review" => &1.review
                 }
               )
           }}
        end
      end)
    else
      false -> {:error, :unsupported_or_stale_operator_intent}
      {:ok, _} -> {:error, :stale_operator_intent}
      {:error, _} = error -> error
    end
  end

  @doc false
  @spec inspect_staged([map()], Manifest.t()) :: :ok | {:error, term()}
  def inspect_staged(retained, manifest) do
    with :ok <- verify_artifacts(retained, manifest.instances),
         :ok <- verify_candidate_manifest(retained, manifest),
         do: :ok
  rescue
    _ -> {:error, :invalid_staged_signed_artifact}
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
    length(artifacts) in 1..128 and Enum.all?(artifacts, &artifact_valid?/1) and
      Enum.reduce(artifacts, 0, &(byte_size(&1.bytes) + &2)) <= @max_artifact and
      Enum.count(artifacts, &(&1.kind == :manifest)) == 1 and
      Enum.count(artifacts, &(&1.kind == :reference)) == 1 and
      Enum.any?(artifacts, &(&1.kind == :log))
  end

  defp artifacts_valid?(_), do: false

  defp artifact_valid?(a) when is_map(a) do
    Enum.sort(Map.keys(a)) == [:bytes, :kind, :op_id, :replica, :review] and
      is_binary(a.bytes) and byte_size(a.bytes) in 1..@max_artifact and
      artifact_identity_valid?(a)
  end

  defp artifact_valid?(_), do: false

  defp artifact_identity_valid?(%{kind: :manifest} = a),
    do: a.replica == nil and a.op_id == nil and a.review == nil

  defp artifact_identity_valid?(%{kind: :reference} = a),
    do: is_binary(a.replica) and Journal.op_id?(a.op_id) and a.review == nil

  defp artifact_identity_valid?(%{kind: :log} = a),
    do: is_binary(a.replica) and Journal.op_id?(a.op_id) and review_valid?(a.review)

  defp artifact_identity_valid?(_), do: false

  defp review_valid?(r) when is_map(r) do
    Enum.sort(Map.keys(r)) == ~w(creation grants profile_genesis profile_id) and
      Enum.all?(~w(creation profile_genesis profile_id), &Journal.op_id?(r[&1])) and
      is_list(r["grants"]) and length(r["grants"]) <= 128 and
      Enum.all?(r["grants"], fn g ->
        is_map(g) and Enum.sort(Map.keys(g)) == ~w(delegation introduction recipient) and
          canonical_key?(g["recipient"]) and Journal.op_id?(g["delegation"]) and
          Journal.op_id?(g["introduction"])
      end) and Enum.uniq_by(r["grants"], & &1["recipient"]) == r["grants"]
  end

  defp review_valid?(_), do: false

  defp canonical_key?(key) when is_binary(key) do
    case Base.decode64(key) do
      {:ok, bytes} -> byte_size(bytes) == 32 and Base.encode64(bytes) == key
      _ -> false
    end
  end

  defp canonical_key?(_), do: false

  defp capture_logs(instances) do
    Enum.reduce_while(instances, {:ok, []}, fn instance, {:ok, captures} ->
      case Log.restore_verified(instance.log_file) do
        {:ok, %{sha256: digest}} ->
          {:cont, {:ok, [%{path: instance.log_file, sha256: digest} | captures]}}

        _ ->
          {:halt, {:error, :invalid_existing_log}}
      end
    end)
  end

  defp verify_artifacts(artifacts, instances) do
    Enum.reduce_while(artifacts, :ok, fn artifact, :ok ->
      result =
        case artifact.kind do
          :manifest ->
            :ok

          :log ->
            verify_child(artifact)

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

  defp verify_child(artifact) do
    r = artifact.review

    with {:ok, %{log: log, sha256: digest}} <- Log.restore_verified(artifact.path),
         true <- digest == artifact.digest and log.replica == artifact.replica,
         %Op{kind: :authority, body: {:genesis, _, _}, author: author} <- log.ops[artifact.op_id],
         true <-
           is_binary(Authority.replica_commitment(log.replica)) and Authority.root(log) == author,
         {:ok, selected} <- Authority.continuation_profile(log),
         true <-
           selected.profile_genesis == r["profile_genesis"] and
             selected.profile_id == r["profile_id"],
         true <-
           selected.profile.product == :treehouse and selected.profile.kind == :thread and
             selected.profile.role == :moderator,
         analysis = Authority.analyze(Treehouse.Thread, log),
         true <- analysis.reasons == %{},
         %Op{kind: :command, body: {:create_thread, [_]}} <- log.ops[r["creation"]],
         true <- Enum.all?(r["grants"], &valid_grant?(&1, log, analysis)) do
      :ok
    else
      _ -> {:error, :invalid_child_admission}
    end
  end

  defp valid_grant?(review, log, analysis) do
    case log.ops[review["introduction"]] do
      %Op{kind: :authority, body: {:grant, d}} ->
        Base.encode64(d.audience) == review["recipient"] and d.id == review["delegation"] and
          not Map.has_key?(analysis.reasons, review["introduction"]) and
          Authority.delegation_active?(log, d.id) and not Authority.revoked?(log, d.id)

      _ ->
        false
    end
  end

  defp replay_reference(op, instances) do
    Enum.reduce_while(instances, {:error, :missing_space_history}, fn instance, refusal ->
      case Log.restore_verified(instance.log_file) do
        {:ok, %{log: %{replica: replica} = log}} when replica == op.replica ->
          {:halt, accept_reference(log, op)}

        _ ->
          {:cont, refusal}
      end
    end)
  end

  defp accept_reference(log, op) do
    with {:ok, union} <- Log.accept(log, op),
         false <- Map.has_key?(Authority.analyze(Treehouse.Space, union).reasons, op.id) do
      :ok
    else
      _ -> {:error, :reference_refused}
    end
  end

  defp verify_candidate_manifest(artifacts, active) do
    manifest = Enum.find(artifacts, &(&1.kind == :manifest))
    children = Enum.filter(artifacts, &(&1.kind == :log))
    allowed = Enum.map(active.instances, & &1.log_file) ++ Enum.map(children, & &1.path)
    reference = Enum.find(artifacts, &(&1.kind == :reference))

    with {:ok, candidate} <- Manifest.load(manifest.path),
         true <- Enum.all?(candidate.instances, &(&1.log_file in allowed)),
         true <-
           Enum.all?(active.instances, fn old ->
             Enum.any?(
               candidate.instances,
               &(&1.name == old.name and &1.log_file == old.log_file)
             )
           end),
         {:ok, roster} <- current_roster(reference.replica, active.instances),
         true <-
           Enum.all?(children, fn child ->
             reviewed = Enum.map(child.review["grants"], & &1["recipient"]) |> Enum.sort()

             peers =
               for instance <- candidate.instances,
                   instance.log_file == child.path,
                   {_realm, pub} <- instance.trusted_peers,
                   do: Base.encode64(pub)

             {:ok, %{log: child_log}} = Log.restore_verified(child.path)
             child_root = Base.encode64(Authority.root(child_log))

             Enum.all?(roster, &(&1 in peers)) and
               Enum.all?(peers, &(&1 in roster or &1 == child_root)) and reviewed == roster
           end) do
      :ok
    else
      _ -> {:error, :invalid_candidate_manifest}
    end
  end

  defp current_roster(replica, instances) do
    Enum.reduce_while(instances, {:error, :missing_space_history}, fn instance, refusal ->
      case Log.restore_verified(instance.log_file) do
        {:ok, %{log: %{replica: ^replica} = log}} ->
          members = Lattice.state(Treehouse.Space, log).members |> Enum.to_list()
          {:halt, {:ok, Enum.sort(Enum.uniq(members))}}

        _ ->
          {:cont, refusal}
      end
    end)
  end
end
