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
  alias Lattice.Authority.BeaconCertificate
  alias Lattice.Log
  alias Lattice.Op
  alias LatticeCarrierServer.{Durability, Manifest}
  alias LatticeCarrierServer.Operator.{CatalogBinding, CatalogStore, Journal, Lock, ReferenceMode}
  alias Treehouse.TransportCatalog
  @max_artifact 32 * 1024 * 1024
  # Adopted founder-lifecycle witness maximum step
  # (docs/research/treehouse_founder_lifecycle.md).
  @reviewed_max_epoch_step 1
  @bound_refusals [:service_binding_mismatch, :relay_realms_unreviewed, :catalog_route_changed]

  @spec artifact_path(Path.t(), binary(), binary()) :: Path.t()
  def artifact_path(root, attempt, digest),
    do: Path.join([Path.expand(root), "attempt-" <> Journal.digest(attempt), digest])

  @doc """
  Stage a candidate under the finished catalog ceremony in `ceremony_dir`
  (plan 224 PR 2): the binding is read from the ceremony and the Space instance's
  served log, never from the manifest.
  """
  @spec prepare(Path.t(), binary() | nil, map(), [map()], Path.t()) ::
          {:ok, map()} | {:error, term()}
  def prepare(root, expected, request, artifacts, ceremony_dir) do
    with true <- :os.type() == {:unix, :linux},
         :ok <- Journal.secure_root(root),
         true <- request_valid?(request) and artifacts_valid?(artifacts),
         {:ok, ^expected} <- Journal.read(root),
         {:ok, catalogued} <- catalog_head_current(root, request.catalog_head),
         # The parsed manifest must describe the exact bytes just digested, not
         # whatever an unrelated writer left on disk moments later. `bytes` is
         # read once, checked, and then reconfirmed unchanged around the
         # separate `Manifest.load/1` read so the two views cannot diverge.
         {:ok, bytes} <- File.read(request.active_manifest),
         true <- Journal.digest(bytes) == request.manifest_digest,
         {:ok, manifest} <- Manifest.load(request.active_manifest),
         {:ok, ^bytes} <- File.read(request.active_manifest),
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
        with {:ok, binding} <- bind_ceremony(manifest.instances, artifacts, ceremony_dir),
             :ok <- initial_catalog_current(root, retained, binding),
             {:ok, service} <- inspect_staged(retained, manifest, binding, catalogued) do
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
               ),
             "service" => service
           }}
        end
      end)
    else
      false -> {:error, :unsupported_or_stale_operator_intent}
      {:ok, _} -> {:error, :stale_operator_intent}
      {:error, _} = error -> error
    end
  end

  # A stage always starts from the catalog head the store has committed, with no
  # pending envelope past it (plan 224 Design 3). Returns the committed routes.
  defp catalog_head_current(root, head) do
    case CatalogStore.verify(root, nil) do
      {:ok, %{head: ^head, pending: nil} = store} -> committed_routes(root, store)
      {:ok, _} -> {:error, :stale_catalog_head}
      {:error, _} = error -> error
    end
  end

  # Every envelope at or below the verified head, read back at its digest name
  # and required to still hold the verified bytes.
  defp committed_routes(_root, %{head_revision: nil}), do: {:ok, %{}}

  defp committed_routes(root, %{envelopes: envelopes, head_revision: head_revision}) do
    envelopes
    |> Enum.filter(fn {_id, e} -> e.revision <= head_revision end)
    |> Enum.reduce_while({:ok, []}, fn {_id, e}, {:ok, acc} ->
      with {:ok, bytes} <- File.read(CatalogStore.file_path(root, e.sha256)),
           true <- Journal.digest(bytes) == e.sha256,
           {:ok, %{catalog: catalog}} <- TransportCatalog.decode_catalog_json(bytes) do
        {:cont, {:ok, [catalog | acc]}}
      else
        _ -> {:halt, {:error, :catalog_store_corrupt}}
      end
    end)
    |> case do
      {:ok, catalogs} -> catalog_routes(catalogs)
      {:error, _} = error -> error
    end
  end

  @doc false
  # replica => route over every entry of the committed catalogs. Entry routes
  # are immutable, so a replica catalogued under two routes is a corrupt store.
  @spec catalog_routes([map()]) :: {:ok, %{String.t() => String.t()}} | {:error, atom()}
  def catalog_routes(catalogs) do
    pairs =
      for catalog <- catalogs,
          entry <- catalog.entries,
          uniq: true,
          do: {entry.replica, entry.route}

    routes = Map.new(pairs)

    if map_size(routes) == length(pairs),
      do: {:ok, routes},
      else: {:error, :catalog_store_corrupt}
  end

  @doc false
  # A Treehouse instance whose replica is catalogued keeps the catalogued route.
  @spec catalog_routes_kept([map()], (map() -> String.t() | nil), map()) ::
          :ok | {:error, :catalog_route_changed}
  def catalog_routes_kept(instances, replica_of, routes) do
    ok? =
      Enum.all?(instances, fn instance ->
        replica = replica_of.(instance)

        not treehouse?(replica) or
          Map.get(routes, replica, instance.route) == instance.route
      end)

    if ok?, do: :ok, else: {:error, :catalog_route_changed}
  end

  # The Space the reference names is the instance that serves its replica; the
  # ceremony binding is read against that instance's log file.
  defp bind_ceremony(instances, artifacts, ceremony_dir) do
    case Enum.filter(artifacts, &(&1.kind == :reference)) do
      [%{replica: replica}] ->
        with {:ok, path} <- space_log_path(instances, replica),
             do: load_binding(ceremony_dir, path)

      _ ->
        {:error, :invalid_staged_signed_artifact}
    end
  end

  @doc false
  # The log file of the one instance (of anything with a `:log_file`) whose
  # verified history is `replica`; none or several is ambiguous.
  @spec space_log_path([map()], String.t()) :: {:ok, Path.t()} | {:error, atom()}
  def space_log_path(instances, replica) do
    found =
      Enum.filter(instances, fn instance ->
        read = fn -> Log.restore_verified(instance.log_file) end

        match?(
          {:ok, %{log: %{replica: ^replica}}},
          Durability.with_target_lock(instance.log_file, read, retries: 5)
        )
      end)

    case found do
      [%{log_file: path}] -> {:ok, path}
      _ -> {:error, :service_binding_mismatch}
    end
  end

  @doc false
  # `CatalogBinding.load/2` with the Space log's lock retried briefly; every
  # other refusal passes through as the ceremony ingress named it.
  @spec load_binding(Path.t(), Path.t()) :: {:ok, map()} | {:error, atom()}
  def load_binding(ceremony_dir, space_log_path),
    do: load_binding(ceremony_dir, space_log_path, 5)

  defp load_binding(ceremony_dir, space_log_path, retries) do
    case CatalogBinding.load(ceremony_dir, space_log_path) do
      {:error, :space_log_busy} when retries > 0 ->
        Process.sleep(50)
        load_binding(ceremony_dir, space_log_path, retries - 1)

      other ->
        other
    end
  end

  @doc false
  # `catalogued` is the committed replica => route map (`catalog_routes/1`).
  @spec inspect_staged([map()], Manifest.t(), map(), map()) :: {:ok, map()} | {:error, term()}
  def inspect_staged(retained, manifest, binding, catalogued \\ %{}) do
    with {:ok, bundle} <- classify(retained),
         {:ok, pairs} <- active_logs(manifest.instances),
         active = Enum.map(pairs, &elem(&1, 1)),
         {:ok, space} <- unique_history(bundle.reference.replica, active),
         :ok <- unserved(bundle.child.replica, active),
         {:ok, child_log} <- verify_child(bundle.child),
         :ok <- initial_active_history(bundle.reference.review, active),
         {:ok, _observed} <- ReferenceMode.observe(bundle, space, child_log),
         context = %{
           pairs: pairs,
           space: space,
           child_log: child_log,
           binding: binding,
           catalogued: catalogued
         },
         {:ok, admitted} <- verify_candidate_manifest(bundle, manifest, context),
         do: bind_service(admitted)
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
  defp unique_history(replica, active) do
    case Enum.filter(active, &(&1.replica == replica)) do
      [log] -> {:ok, log}
      _ -> {:error, :invalid_candidate_manifest}
    end
  end

  # The candidate child must not already be served: a second log file for the
  # same replica would be a potentially divergent carrier history.
  defp unserved(replica, active) do
    if Enum.any?(active, &(&1.replica == replica)),
      do: {:error, :invalid_candidate_manifest},
      else: :ok
  end

  # Every active log is read once per inspection and shared by every check;
  # each is paired with the instance serving it.
  defp active_logs(instances) do
    Enum.reduce_while(instances, {:ok, []}, fn instance, {:ok, pairs} ->
      case Log.restore_verified(instance.log_file) do
        {:ok, %{log: log}} -> {:cont, {:ok, [{instance, log} | pairs]}}
        # An unreadable sibling could otherwise make an ambiguous manifest
        # look unique, so it refuses instead of being skipped.
        _ -> {:halt, {:error, :invalid_candidate_manifest}}
      end
    end)
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
    do: is_binary(a.replica) and Journal.op_id?(a.op_id) and ReferenceMode.valid_review?(a.review)

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

  defp initial_active_history(review, active) do
    if ReferenceMode.initial?(review) and length(active) != 1,
      do: {:error, :invalid_candidate_manifest},
      else: :ok
  end

  # Runs inside the Python owner's stage lock, with the ceremony's catalog key.
  # A nil request head or an empty route map cannot prove first publication.
  defp initial_catalog_current(root, artifacts, binding) do
    if Enum.any?(artifacts, &(&1.kind == :reference and ReferenceMode.initial?(&1.review))) do
      case CatalogStore.verify(root, binding.record.catalog_key) do
        {:ok, %{head: nil, pending: nil, envelopes: envelopes}} when map_size(envelopes) == 0 ->
          :ok

        {:ok, _} ->
          {:error, :initial_catalog_not_empty}

        {:error, _} = error ->
          error
      end
    else
      :ok
    end
  end

  defp verify_child(artifact) do
    with {:ok, %{log: log, sha256: digest}} <- Log.restore_verified(artifact.path),
         true <- digest == artifact.digest and log.replica == artifact.replica,
         :ok <- verify_child_log(log, artifact),
         do: {:ok, log}
  end

  @doc "Verify the same closed child authority and beacon contract before import or staging."
  @spec verify_child_log(Log.t(), map()) :: :ok | {:error, atom()}
  def verify_child_log(log, artifact) do
    r = artifact.review

    with :ok <- Log.verify_authenticity(log),
         true <- log.replica == artifact.replica,
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
         true <- authority_closed?(log, artifact, reviewed),
         # A root-authored tombstone ends the replica's lifecycle. Authority
         # analysis only quarantines an *unauthorized* tombstone, so a valid
         # one would otherwise sail through every check above; it is refused
         # here explicitly rather than folded into the closed inventory.
         false <- Authority.tombstoned?(log) do
      :ok
    else
      _ -> {:error, :invalid_staged_signed_artifact}
    end
  rescue
    _ -> {:error, :invalid_staged_signed_artifact}
  end

  # `profile_id` digests only the continuation profile, but any root-authored
  # genesis policy map also sources the epoch-beacon policy. The whole policy,
  # as the authority judge normalizes it (witnesses sorted), must equal the
  # reviewed profile's witnesses and threshold with the adopted step bound.
  defp reviewed_beacon_policy?(policies, profile) do
    is_map(policies) and Enum.sort(Map.keys(policies)) == [:__beacon__, :__continuation__] and
      BeaconCertificate.normalize_policy(policies.__beacon__) ==
        {:ok,
         %{
           mode: :witnessed,
           version: 1,
           witnesses: profile.witnesses,
           threshold: profile.threshold,
           max_epoch_step: @reviewed_max_epoch_step
         }}
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

  defp verify_candidate_manifest(%{manifest: manifest, child: child}, active, context) do
    %{space: space, child_log: child_log, binding: binding, pairs: pairs} = context
    roster = roster(space)

    with {:ok, candidate} <- load_candidate(manifest.path),
         true <- candidate.health == active.health,
         {:ok, admitted} <- admitted_instance(candidate.instances, pairs, child),
         true <- admitted.log_file == child.path,
         # The child's bootstrap moderator authority must be independently
         # generated, never the active Space root or the admitted carrier
         # service key — either reuse would hand Space or operator
         # infrastructure the child's authority, and using the carrier's own
         # transport key this way would cross the carrier server's
         # no-semantic-authority boundary.
         true <- Authority.root(child_log) not in [Authority.root(space), admitted.pub],
         # Inversely, the carrier service key must be no participant's: holding
         # the Space root's or a member's seed would give the carrier custody of
         # that participant's authority.
         true <-
           Base.encode64(admitted.pub) not in [Base.encode64(Authority.root(space)) | roster],
         # verify_child already requires the bounded Treehouse Thread family;
         # this keeps the admitted child inside check_bound explicitly.
         true <- treehouse?(child.replica),
         bound = bound_context(pairs, child, context),
         :ok <- check_bound(candidate.instances, bound, binding),
         :ok <- catalog_routes_kept(candidate.instances, bound.replica_of, context.catalogued),
         true <- bootstrap_peers_exact?(admitted, roster, child_log),
         true <- Enum.sort(Enum.map(child.review["grants"], & &1["recipient"])) == roster do
      {:ok, admitted}
    else
      {:error, reason} when reason in @bound_refusals -> {:error, reason}
      _ -> {:error, :invalid_candidate_manifest}
    end
  end

  defp load_candidate(path) do
    case Manifest.load(path) do
      {:ok, candidate} -> {:ok, candidate}
      _ -> :refused
    end
  end

  # The bound-instance rule's view of the candidate: every active log by its
  # file, plus the staged child's file, with each replica's authority root.
  defp bound_context(pairs, child, %{space: space, child_log: child_log} = context) do
    replicas =
      Map.new([
        {child.path, child.replica} | Enum.map(pairs, fn {i, l} -> {i.log_file, l.replica} end)
      ])

    roots =
      Map.new([
        {child.replica, Authority.root(child_log)}
        | Enum.map(pairs, fn {_, l} -> {l.replica, Authority.root(l)} end)
      ])

    %{
      space_replica: space.replica,
      replica_of: &Map.get(replicas, &1.log_file),
      roots: roots,
      roster: roster(context.space),
      peer_error: :invalid_candidate_manifest
    }
  end

  @doc false
  # The bound-instance rule (plan 224 Design 2, OD-1/OD-5) over every Treehouse
  # instance. `context`:
  #   :space_replica - the Space the ceremony binds
  #   :replica_of    - fn instance -> served replica | nil
  #   :roots         - %{replica => authority root pub | nil}
  #   :roster        - sorted base64 member keys (`roster/1`)
  #   :peer_error    - the atom for a trusted_peers set that is not {root} + roster,
  #                    one realm per key
  # Returns :ok or {:error, :service_binding_mismatch | context.peer_error |
  # :relay_realms_unreviewed}, in that order of precedence. An instance with no
  # known replica, or a Treehouse instance with no authority root, is a
  # mismatch, and so are two instances serving one replica; a non-Treehouse log
  # may have no root and is then not inventoried.
  @spec check_bound([map()], map(), map()) :: :ok | {:error, atom()}
  def check_bound(instances, context, binding) do
    treehouse = Enum.filter(instances, &treehouse?(context.replica_of.(&1)))
    key = binding.record.service_key
    roster_keys = context.roster

    root_keys =
      for root <- Map.values(context.roots), is_binary(root), do: Base.encode64(root)

    with :ok <- replicas_known(instances, context),
         :ok <- replicas_unique(instances, context),
         :ok <- rooted(treehouse, context),
         :ok <- space_present(treehouse, context),
         :ok <- same_bound(treehouse, binding.realm, key),
         :ok <- distinct_key(treehouse, key, roster_keys ++ root_keys),
         :ok <- peers_exact(treehouse, context),
         do: relays_reviewed(treehouse)
  end

  defp treehouse?("replica:treehouse:" <> _), do: true
  defp treehouse?(_), do: false

  defp replicas_known(instances, context) do
    if Enum.all?(instances, &is_binary(context.replica_of.(&1))),
      do: :ok,
      else: {:error, :service_binding_mismatch}
  end

  # `roots` is keyed by replica, so two instances serving one replica would
  # collapse to one root and drop the other from the key-reuse inventory. Each
  # instance serves one log, so differing roots for one replica need two
  # instances serving it: refusing that covers both cases.
  defp replicas_unique(instances, context) do
    replicas = Enum.map(instances, context.replica_of)

    if length(Enum.uniq(replicas)) == length(replicas),
      do: :ok,
      else: {:error, :service_binding_mismatch}
  end

  defp rooted(treehouse, context) do
    if Enum.all?(treehouse, &is_binary(Map.get(context.roots, context.replica_of.(&1)))),
      do: :ok,
      else: {:error, :service_binding_mismatch}
  end

  defp space_present(treehouse, context) do
    if Enum.any?(treehouse, &(context.replica_of.(&1) == context.space_replica)),
      do: :ok,
      else: {:error, :service_binding_mismatch}
  end

  defp same_bound(treehouse, realm, key) do
    routes = Enum.map(treehouse, & &1.route)

    ok? =
      Enum.all?(treehouse, &(&1.realm == realm and &1.pub == key and is_binary(&1.route))) and
        length(Enum.uniq(routes)) == length(routes) and
        length(Enum.uniq(Enum.map(treehouse, & &1.identity_file))) == 1 and
        not Enum.any?(treehouse, &Map.has_key?(&1.trusted_peers, realm))

    if ok?, do: :ok, else: {:error, :service_binding_mismatch}
  end

  defp distinct_key(treehouse, key, others) do
    peer_keys = Enum.flat_map(treehouse, &Map.values(&1.trusted_peers))

    if Base.encode64(key) in others or key in peer_keys,
      do: {:error, :service_binding_mismatch},
      else: :ok
  end

  # One realm per key: a second realm aliasing the root's or a member's key
  # would collapse in the set comparison and could then be relayed for.
  defp peers_exact(treehouse, context) do
    ok? =
      Enum.all?(treehouse, fn instance ->
        root = Map.get(context.roots, context.replica_of.(instance))
        pubs = MapSet.new(instance.trusted_peers, fn {_, pub} -> Base.encode64(pub) end)

        is_binary(root) and MapSet.size(pubs) == map_size(instance.trusted_peers) and
          pubs == MapSet.new([Base.encode64(root) | context.roster])
      end)

    if ok?, do: :ok, else: {:error, context.peer_error}
  end

  defp relays_reviewed(treehouse) do
    ok? =
      Enum.all?(treehouse, fn instance ->
        length(Enum.uniq(instance.relay_realms)) == length(instance.relay_realms) and
          MapSet.new(instance.relay_realms) == MapSet.new(Map.keys(instance.trusted_peers))
      end)

    if ok?, do: :ok, else: {:error, :relay_realms_unreviewed}
  end

  # The pending record binds the exact identity bytes whose key was reviewed:
  # the digest and the key both come from one read, so they describe the same
  # file. The mutation owner rechecks that digest before commit, and
  # activation must recheck it before use.
  defp bind_service(admitted) do
    path = admitted.identity_file

    with :ok <- Journal.identity_location(path),
         {:ok, bytes} <- File.read(path),
         {:ok, pub} <- Manifest.identity_public_key(bytes),
         true <- pub == admitted.pub do
      {:ok,
       %{
         "identity_file" => path,
         "realm" => admitted.realm,
         "pub" => Base.encode64(admitted.pub),
         "sha256" => Journal.digest(bytes)
       }}
    else
      _ -> {:error, :invalid_candidate_manifest}
    end
  end

  # The candidate adds exactly one instance (by name) and reproduces every
  # active instance. A Treehouse instance may additionally migrate to the bound
  # service values (realm, route, relay set, identity file/key, trusted peers);
  # the bound-instance rule then judges those values. Anything else, and every
  # non-Treehouse instance, must match verbatim.
  @migrating [:realm, :route, :relay_realms, :identity_file, :pub, :trusted_peers]

  defp admitted_instance(candidate, pairs, child) do
    names = Enum.map(candidate, & &1.name)
    by_name = Map.new(candidate, &{&1.name, &1})

    with true <- length(Enum.uniq(names)) == length(names),
         true <- length(candidate) == length(pairs) + 1,
         true <-
           Enum.all?(pairs, fn {instance, log} ->
             unchanged?(by_name[instance.name], instance, log)
           end),
         active_names = Enum.map(pairs, fn {instance, _} -> instance.name end),
         [new] <- Enum.reject(candidate, &(&1.name in active_names)),
         true <- new.log_file == child.path do
      {:ok, new}
    else
      _ -> {:error, :invalid_candidate_manifest}
    end
  end

  defp unchanged?(nil, _active, _log), do: false

  defp unchanged?(proposed, active, log) do
    if treehouse?(log.replica),
      do: migratable(proposed) == migratable(active),
      else: comparable(proposed) == comparable(active)
  end

  defp migratable(instance),
    do:
      instance
      |> comparable()
      |> Map.drop(@migrating)
      |> Map.update!(:listener, &Keyword.delete(&1, :route))

  defp comparable(instance), do: Map.drop(instance, [:ref, :identity])

  # The Space roster as staging reviews it, and as activation re-reviews it
  # from the sealed Space log: sorted, unique member keys.
  @doc false
  @spec roster(Log.t()) :: [binary()]
  def roster(space),
    do: Enum.sort(Enum.uniq(Enum.to_list(Lattice.state(Treehouse.Space, space).members)))

  @doc false
  # The roster re-review shared by activation and readiness. `logs` are the
  # verified logs the caller serves; the staged child is read from its retained
  # artifact. `window` is the refusal atom for drift (`:roster_drift_since_staging`
  # at activation, `:roster_drift_since_activation` at readiness). The child
  # must grant exactly the roster and `admitted` must bootstrap exactly the
  # roster plus the child root. Returns the logs the caller needs for the rest.
  @spec roster_current(map(), map(), [Log.t()], atom()) ::
          {:ok, %{space: Log.t(), child_log: Log.t(), roster: [binary()]}} | {:error, atom()}
  def roster_current(record, admitted, logs, window) do
    [reference] = Enum.filter(record["artifacts"], &(&1["kind"] == "reference"))
    [child] = Enum.filter(record["artifacts"], &(&1["kind"] == "log"))

    with {:ok, child_log} <- staged_child(child),
         [space] <- Enum.filter(logs, &(&1.replica == reference["replica"])),
         :ok <- initial_reference_current(reference, child, space, child_log),
         roster = roster(space),
         true <- Enum.sort(Enum.map(child["review"]["grants"], & &1["recipient"])) == roster,
         true <- bootstrap_peers_exact?(admitted, roster, child_log) do
      {:ok, %{space: space, child_log: child_log, roster: roster}}
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, window}
    end
  end

  # Activation and readiness must re-observe the current served history, not a
  # journal boolean. Pending-mode behavior remains the existing saga.
  defp initial_reference_current(reference, child, space, child_log) do
    if ReferenceMode.initial?(reference["review"]) do
      with {:ok, bytes} <- File.read(reference["path"]),
           true <- Journal.digest(bytes) == reference["sha256"],
           bundle = %{
             reference: %{
               bytes: bytes,
               op_id: reference["op_id"],
               replica: reference["replica"],
               review: reference["review"]
             },
             child: %{replica: child["replica"], op_id: child["op_id"], review: child["review"]}
           },
           true <- initial_child_current?(bundle.child, child_log),
           {:ok, _} <- ReferenceMode.observe(bundle, space, child_log) do
        :ok
      else
        _ -> {:error, :invalid_staged_signed_artifact}
      end
    else
      :ok
    end
  end

  defp initial_child_current?(child, log), do: verify_child_log(log, child) == :ok

  defp staged_child(child) do
    replica = child["replica"]

    case Log.restore_verified(child["path"]) do
      {:ok, %{log: %{replica: ^replica} = log}} -> {:ok, log}
      _ -> {:error, :invalid_staged_signed_artifact}
    end
  end

  # Bootstrap transport peers are exactly the current Space members plus the
  # independently rooted child; neither an omission nor an extra is accepted.
  @doc false
  @spec bootstrap_peers_exact?(map(), [binary()], Log.t()) :: boolean()
  def bootstrap_peers_exact?(instance, roster, child_log) do
    peers =
      for {_realm, pub} <- instance.trusted_peers, into: MapSet.new(), do: Base.encode64(pub)

    MapSet.equal?(peers, MapSet.new([Base.encode64(Authority.root(child_log)) | roster]))
  end
end
