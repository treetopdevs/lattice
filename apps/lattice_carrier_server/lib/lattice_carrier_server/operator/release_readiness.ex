defmodule LatticeCarrierServer.Operator.ReleaseReadiness do
  @moduledoc """
  Local readiness confirmation for one activated, restarted release (plan 223,
  operator decision D1: route activation is local-only).

  After a full restart under an operator-root controlled boot, the operator
  calls `confirm/4`. It proves, in order and without writing anything: the boot
  is guarded and carries an incarnation marker; the journal is `activated` over
  the manifest this deployment loaded; every route is ready; the Space roster
  still matches what staging reviewed; every Treehouse route answers an
  authenticated frontier and pull over its real loopback listener; and the
  ceremony binding, reloaded after those probes, is unchanged. Only then does
  it ask the Python mutation owner, the only writer, to record `ready`. The
  owner is never invoked on a refusal.

  The pull authenticates through the operator probe realm
  (`LatticeCarrierServer.ProbeRealm`): an Ed25519 key named by file, read with
  the manifest identity-file policy, kept in `Secret` until the challenge is
  signed, granted to the admitted instance for one read-only session and
  revoked afterwards. Whoever can call this already reads every log file.

  `ready` is one operator's observation on one host after one restart. It is
  not catalog publication, a client or field result, or a live health signal.
  Every raise or exit becomes an atom-only refusal, so no refusal carries key
  material.
  """
  alias Lattice.{Authority, Log}
  alias Lattice.Carrier.WebSocket
  alias LatticeCarrierServer.Operator.{Journal, Lock, Staging}

  alias LatticeCarrierServer.{
    Durability,
    Health,
    Holder,
    Listener,
    Manifest,
    ProbeRealm,
    Runtime,
    Secret
  }

  @window :roster_drift_since_activation

  @spec confirm(Path.t(), binary() | nil, Path.t(), Path.t()) :: {:ok, map()} | {:error, term()}
  def confirm(root, expected, probe_identity_file, ceremony_dir) do
    with {:ok, deployment} <- Runtime.deployment() |> guarded(root),
         {:ok, record} <- activated(root, expected),
         digest = Base.encode16(deployment.manifest_digest, case: :lower),
         :ok <- same(digest == manifest_artifact(record)["sha256"], :release_manifest_mismatch),
         :ok <- same(Health.ready?(), :route_not_ready),
         {:ok, instances} <- loaded_manifest(deployment),
         {:ok, current} <- roster_current(record, instances),
         {:ok, binding} <- bound(record, instances, ceremony_dir),
         :ok <- check_bound(instances, current, binding, reference(record)),
         :ok <- pulled(targets(current, binding), binding, probe_identity_file),
         :ok <- rebound(record, instances, ceremony_dir, binding),
         next = Map.put(record, "phase", "ready"),
         :ok <-
           Lock.ready(
             root,
             expected,
             %{path: deployment.manifest_path, sha256: digest},
             Journal.encode(next),
             deployment.incarnation
           ) do
      {:ok, next}
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :release_readiness_refused}
    end
  rescue
    _ -> {:error, :release_readiness_refused}
  catch
    :exit, _ -> {:error, :release_readiness_refused}
  end

  defp guarded(deployment, root) do
    with %{operator_root: guarded_root, incarnation: incarnation} when is_binary(incarnation) <-
           deployment,
         true <- guarded_root == Path.expand(root) do
      {:ok, deployment}
    else
      _ -> {:error, :release_boot_unguarded}
    end
  end

  defp activated(root, expected) do
    with {:ok, ^expected} when is_binary(expected) <- Journal.read(root),
         {:ok, %{"phase" => "activated"} = record} <- Journal.decode(expected) do
      {:ok, record}
    else
      _ -> {:error, :stale_operator_intent}
    end
  end

  defp reference(record), do: Enum.find(record["artifacts"], &(&1["kind"] == "reference"))

  defp manifest_artifact(record),
    do: Enum.find(record["artifacts"], %{}, &(&1["kind"] == "manifest"))

  # The release this restart serves, read from the manifest bytes the
  # deployment loaded (the deployment view carries no routes or peers).
  defp loaded_manifest(deployment) do
    case Manifest.load(deployment.manifest_path) do
      {:ok, %{sha256: sha, instances: instances}} when sha == deployment.manifest_digest ->
        {:ok, instances}

      _ ->
        {:error, :release_manifest_mismatch}
    end
  end

  # Row 217's roster re-review against the Space log this restart now serves,
  # shared with activation. The holder persists before it acknowledges, so the
  # file is the served history; a file that cannot be read is a route that is
  # not ready.
  defp roster_current(record, instances) do
    [child] = Enum.filter(record["artifacts"], &(&1["kind"] == "log"))

    with {:ok, pairs} <- served_logs(instances),
         # Service keys are shared across routes, so the admitted route is the
         # one serving the staged child log.
         [admitted] <- Enum.filter(instances, &(&1.log_file == child["path"])),
         {:ok, current} <-
           Staging.roster_current(record, admitted, Enum.map(pairs, &elem(&1, 1)), @window) do
      {:ok, Map.put(current, :pairs, pairs)}
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, @window}
    end
  end

  # The ceremony binding, read against the served instance of the staged
  # reference's Space; the journal's service record must be the bound one.
  defp bound(record, instances, ceremony_dir) do
    [reference] = Enum.filter(record["artifacts"], &(&1["kind"] == "reference"))
    service = record["service"]

    with {:ok, path} <- Staging.space_log_path(instances, reference["replica"]),
         {:ok, binding} <- Staging.load_binding(ceremony_dir, path),
         :ok <-
           same(
             service["realm"] == binding.realm and
               service["pub"] == Base.encode64(binding.record.service_key),
             :service_binding_mismatch
           ) do
      {:ok, binding}
    end
  end

  # The binding again, after every route was probed: a bootstrap that landed in
  # the served Space log meanwhile refuses (`:binding_fork` and the other
  # `CatalogBinding` atoms pass through), and a different honored bootstrap,
  # realm or key is a mismatch. `ready` is a dated observation: the window
  # between this recheck and the owner's commit is accepted, and PRs 4-5
  # reload the binding before they rely on it.
  defp rebound(record, instances, ceremony_dir, binding) do
    with {:ok, again} <- bound(record, instances, ceremony_dir) do
      same(
        again.bootstrap_id == binding.bootstrap_id and again.realm == binding.realm and
          again.record.service_key == binding.record.service_key,
        :service_binding_mismatch
      )
    end
  end

  defp check_bound(instances, current, binding, reference) do
    replicas = Map.new(current.pairs, fn {instance, log} -> {instance.log_file, log.replica} end)

    roots =
      Map.new(current.pairs, fn {_instance, log} -> {log.replica, Authority.root(log)} end)

    Staging.check_bound(
      instances,
      %{
        space_replica: reference["replica"],
        replica_of: &Map.get(replicas, &1.log_file),
        roots: roots,
        roster: current.roster,
        peer_error: @window
      },
      binding
    )
  end

  defp served_logs(instances) do
    Enum.reduce_while(instances, {:ok, []}, fn instance, {:ok, pairs} ->
      case Durability.with_target_lock(
             instance.log_file,
             fn -> Log.restore_verified(instance.log_file) end,
             retries: 5
           ) do
        {:ok, %{log: log}} -> {:cont, {:ok, pairs ++ [{instance, log}]}}
        _ -> {:halt, {:error, :route_not_ready}}
      end
    end)
  end

  # One probe target per Treehouse route: the instance, its route path, the
  # replica it serves, and the genesis op ids that pull must carry.
  defp targets(current, binding) do
    for {instance, log} <- current.pairs,
        String.starts_with?(log.replica, "replica:treehouse:") do
      %{
        name: instance.name,
        route: instance.route,
        realm: binding.realm,
        pub: binding.record.service_key,
        replica: log.replica,
        genesis: genesis_ids(log),
        root: Authority.root(log)
      }
    end
  end

  defp genesis_ids(log) do
    for {id, %{kind: :authority, body: body}} <- log.ops,
        is_tuple(body) and elem(body, 0) == :genesis,
        do: id
  end

  # Every route is probed, one grant at a time, so no grant outlives the call.
  # The probe key is refused if it reuses the service key or any route's root.
  defp pulled(targets, binding, probe_identity_file) do
    with {:ok, secret, pub} <- probe_key(probe_identity_file),
         :ok <-
           same(
             pub != binding.record.service_key and pub not in Enum.map(targets, & &1.root),
             :readiness_probe_key_reused
           ) do
      Enum.reduce_while(targets, :ok, fn target, :ok ->
        case probe(target, secret, pub) do
          :ok -> {:cont, :ok}
          {:error, _} = refusal -> {:halt, refusal}
        end
      end)
    end
  end

  @doc false
  # Test seam: probe one route, with whatever replica the target expects.
  @spec probe_route(map(), Path.t()) :: :ok | {:error, atom()}
  def probe_route(target, probe_identity_file) do
    with {:ok, secret, pub} <- probe_key(probe_identity_file),
         do: probe(target, secret, pub)
  end

  # The grant exists only between `register/2` and the `after` block, and the
  # connection never outlives this call.
  defp probe(target, secret, pub) do
    with {:ok, grant} <- ProbeRealm.register(target.name, pub) do
      try do
        read_route(target, secret)
      after
        ProbeRealm.revoke(target.name, grant)
      end
    end
  end

  defp probe_key(path) do
    case Manifest.read_identity_file(path, ProbeRealm.realm()) do
      {:ok, _secret, _pub} = ok -> ok
      _ -> {:error, :readiness_probe_key_unreadable}
    end
  end

  # A <= S <= B: members may relay while this runs, so the socket's frontier
  # must lie between the holder's ids read before and after it. The probe
  # dials the address the listener actually bound, not an assumed loopback.
  defp read_route(target, secret) do
    # Synchronous test hook, run in this process before the route is dialed:
    # it receives the route path only, never a key.
    case Application.get_env(:lattice_carrier_server, :readiness_probe_hook) do
      hook when is_function(hook, 1) -> hook.(target.route)
      _ -> :ok
    end

    holder = Holder.via(target.name)
    {ip, port} = :ranch.get_addr(Listener.ref(target.name))

    connection =
      WebSocket.connect(
        hostname: ip |> :inet.ntoa() |> to_string(),
        port: port,
        identity: Secret.unwrap(secret),
        realm: ProbeRealm.realm(),
        path: target.route,
        peer_realm: target.realm,
        peer_pubkey: target.pub,
        replica: target.replica
      )

    case connection do
      {:ok, conn} ->
        try do
          compare(conn, holder, target)
        after
          WebSocket.close(conn)
        end

      _ ->
        {:error, :readiness_pull_failed}
    end
  end

  defp compare(conn, holder, target) do
    before = MapSet.new(Holder.op_ids(holder))

    with {:ok, frontier, conn} <- WebSocket.advertise(conn, nil),
         later = MapSet.new(Holder.op_ids(holder)),
         true <- MapSet.subset?(before, frontier) and MapSet.subset?(frontier, later),
         # Pull from nothing so every served op is encoded and sent: the
         # served ids must cover the frontier and stay within the holder's.
         {:ok, ops, _conn} <- WebSocket.pull(conn, MapSet.new()),
         final = MapSet.new(Holder.op_ids(holder)),
         served = MapSet.new(ops, & &1.id),
         true <- MapSet.subset?(frontier, served) and MapSet.subset?(served, final),
         true <- Enum.all?(ops, &(&1.replica == target.replica)),
         true <- target.genesis != [] and Enum.all?(target.genesis, &MapSet.member?(served, &1)) do
      :ok
    else
      _ -> {:error, :readiness_pull_failed}
    end
  end

  defp same(true, _reason), do: :ok
  defp same(_, reason), do: {:error, reason}
end
