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
    with {:ok, bundle} <- classify(retained),
         {:ok, space} <- unique_history(bundle.reference.replica, manifest.instances),
         :ok <- verify_child(bundle.child),
         :ok <- verify_reference(bundle, space),
         :ok <- verify_candidate_manifest(bundle, manifest, space),
         do: :ok
  catch
    # Total, not only exceptions: a throw or exit escaping into the staging
    # lock owner's callback would leave it without a refusal.
    _kind, _reason -> {:error, :invalid_staged_signed_artifact}
  end

  # One attempt carries exactly one child, one signed Space reference and one
  # candidate manifest. Any other shape is refused before any log is read.
  defp classify(retained) when is_list(retained) do
    case Enum.group_by(retained, & &1.kind) do
      %{log: [child], reference: [reference], manifest: [manifest]} = kinds
      when map_size(kinds) == 3 ->
        {:ok, %{child: child, reference: reference, manifest: manifest}}

      _ ->
        {:error, :invalid_staged_signed_artifact}
    end
  end

  defp classify(_), do: {:error, :invalid_staged_signed_artifact}

  # The referenced Space must have exactly one active history. Two instances
  # serving the same replica make roster and replay selection arbitrary.
  defp unique_history(replica, instances) do
    histories =
      Enum.reduce_while(instances, [], fn instance, matches ->
        case Log.restore_verified(instance.log_file) do
          # An unreadable sibling could otherwise make an ambiguous manifest
          # look unique, so it refuses instead of being skipped.
          {:ok, %{log: %{replica: ^replica} = log}} -> {:cont, [log | matches]}
          {:ok, _other_replica} -> {:cont, matches}
          _ -> {:halt, :unreadable}
        end
      end)

    case histories do
      [log] -> {:ok, log}
      _ -> {:error, :invalid_candidate_manifest}
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
    length(artifacts) in 1..128 and Enum.all?(artifacts, &artifact_valid?/1) and
      Enum.reduce(artifacts, 0, &(byte_size(&1.bytes) + &2)) <= @max_artifact and
      Enum.count(artifacts, &(&1.kind == :manifest)) == 1 and
      Enum.count(artifacts, &(&1.kind == :reference)) == 1 and
      Enum.count(artifacts, &(&1.kind == :log)) == 1
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

  defp verify_reference(%{reference: reference, child: child}, space) do
    with {:ok, frame} <- Jason.decode(reference.bytes),
         {:ok, op} <- Wire.decode_op(frame),
         true <- Op.valid?(op) and op.id == reference.op_id and op.replica == reference.replica,
         true <- op.kind == :command,
         {:create_thread, [child_replica, title]} <- op.body,
         true <- is_binary(title) and child_replica == child.replica,
         # An op already present in the active history is published, not pending.
         false <- Map.has_key?(space.ops, op.id),
         {:ok, union} <- Log.accept(space, op),
         false <- Map.has_key?(Authority.analyze(Treehouse.Space, union).reasons, op.id) do
      :ok
    else
      _ -> {:error, :invalid_staged_signed_artifact}
    end
  end

  defp verify_child(artifact) do
    r = artifact.review

    with {:ok, %{log: log, sha256: digest}} <- Log.restore_verified(artifact.path),
         true <- digest == artifact.digest and log.replica == artifact.replica,
         %Op{kind: :authority, body: {:genesis, _, root}, author: author} <-
           log.ops[artifact.op_id],
         # The reviewed profile pin is the candidate's only policy source; a
         # root genesis policy would not be covered by the reviewed digest.
         true <- root == %{},
         true <-
           is_binary(Authority.replica_commitment(log.replica)) and Authority.root(log) == author,
         {:ok, selected} <- Authority.continuation_profile(log),
         true <-
           selected.profile_genesis == r["profile_genesis"] and
             selected.profile_id == r["profile_id"],
         true <-
           selected.profile.product == :treehouse and selected.profile.kind == :thread and
             selected.profile.role == :moderator,
         %Op{kind: :authority, body: {:genesis, _, pinned}} <- log.ops[r["profile_genesis"]],
         true <- reviewed_beacon_policy?(pinned, selected.profile),
         analysis = Authority.analyze(Treehouse.Thread, log),
         true <- analysis.reasons == %{},
         %Op{kind: :command, body: {:create_thread, [_]}} <- log.ops[r["creation"]],
         # The reviewed inventory is exact: every honored active grant the child
         # log actually carries was reviewed, and nothing else was claimed.
         reviewed = reviewed_grants(r),
         true <- reviewed == honored_grants(log, analysis),
         # Grants are not the only authority shape. A transfer or succession
         # also introduces an active delegation, so authority is whitelisted:
         # the pinned genesis, the reviewed profile pin and the reviewed grant
         # introductions are the only authority operations a candidate carries.
         true <- authority_closed?(log, artifact, reviewed) do
      :ok
    else
      _ -> {:error, :invalid_staged_signed_artifact}
    end
  end

  # `profile_id` digests only the continuation profile, but any root-authored
  # genesis policy map also sources the epoch-beacon policy. Beacon witnesses
  # and threshold are therefore bound to the reviewed profile's own.
  defp reviewed_beacon_policy?(policies, profile) do
    # The reviewed profile's witnesses are normalized (sorted); the pinned
    # policy carries whatever order was signed, and the runtime sorts too.
    is_map(policies) and Enum.sort(Map.keys(policies)) == [:__beacon__, :__continuation__] and
      match?(%{mode: :witnessed}, policies.__beacon__) and
      Enum.sort(policies.__beacon__.witnesses) == profile.witnesses and
      policies.__beacon__.threshold == profile.threshold
  end

  defp reviewed_grants(review) do
    MapSet.new(review["grants"], &{&1["introduction"], &1["delegation"], &1["recipient"]})
  end

  defp authority_closed?(log, artifact, reviewed) do
    allowed =
      MapSet.new([artifact.op_id, artifact.review["profile_genesis"]])
      |> MapSet.union(MapSet.new(reviewed, &elem(&1, 0)))

    Enum.all?(log.ops, fn
      {op_id, %Op{kind: :authority}} -> MapSet.member?(allowed, op_id)
      _ -> true
    end)
  end

  defp honored_grants(log, analysis) do
    for {op_id, %Op{kind: :authority, body: {:grant, d}}} <- log.ops,
        not Map.has_key?(analysis.reasons, op_id),
        Authority.delegation_active?(log, d.id),
        not Authority.revoked?(log, d.id),
        into: MapSet.new(),
        do: {op_id, d.id, Base.encode64(d.audience)}
  end

  defp verify_candidate_manifest(%{manifest: manifest, child: child}, active, space) do
    roster = Enum.sort(Enum.uniq(Enum.to_list(Lattice.state(Treehouse.Space, space).members)))

    with {:ok, candidate} <- Manifest.load(manifest.path),
         true <- candidate.health == active.health,
         {:ok, admitted} <- admitted_instance(candidate.instances, active.instances),
         true <- admitted.log_file == child.path,
         {:ok, %{log: child_log}} <- Log.restore_verified(child.path),
         true <- bootstrap_peers_exact?(admitted, roster, child_log),
         # Relay ingress is a separate reviewed decision, never a side effect
         # of admitting a candidate child.
         true <- admitted.relay_realms == [],
         true <- Enum.sort(Enum.map(child.review["grants"], & &1["recipient"])) == roster do
      :ok
    else
      _ -> {:error, :invalid_candidate_manifest}
    end
  end

  # The candidate adds exactly one instance and reproduces every existing
  # instance configuration verbatim; only the positional ref and the opaque
  # identity wrapper are excluded from that equality.
  defp admitted_instance(candidate, active) do
    proposed = Enum.map(candidate, &comparable/1)
    existing = Enum.map(active, &comparable/1)
    # One unmatched proposal out of exactly one extra instance means every
    # existing configuration was matched, each consumed at most once.
    with [only] <- proposed -- existing,
         true <- length(proposed) == length(existing) + 1 do
      {:ok, Enum.find(candidate, &(comparable(&1) == only))}
    else
      _ -> {:error, :invalid_candidate_manifest}
    end
  end

  defp comparable(instance), do: Map.drop(instance, [:ref, :identity])

  # Bootstrap transport peers are exactly the current Space members plus the
  # independently rooted child; neither an omission nor an extra is accepted.
  defp bootstrap_peers_exact?(instance, roster, child_log) do
    peers =
      for {_realm, pub} <- instance.trusted_peers, into: MapSet.new(), do: Base.encode64(pub)

    MapSet.equal?(peers, MapSet.new([Base.encode64(Authority.root(child_log)) | roster]))
  end
end
