defmodule LatticeCarrierServer.Operator.ReleaseReadiness do
  @moduledoc """
  Local readiness confirmation for one activated, restarted release (plan 223,
  operator decision D1: route activation is local-only).

  After a full restart under an operator-root controlled boot, the operator
  calls `confirm/3`. It proves, in order and without writing anything: the boot
  is guarded and carries an incarnation marker; the journal is `activated` over
  the manifest this deployment loaded; every route is ready; the Space roster
  still matches what staging reviewed; and the admitted child route answers an
  authenticated frontier and pull over its real loopback listener. Only then
  does it ask the Python mutation owner, the only writer, to record `ready`.
  The owner is never invoked on a refusal.

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
  alias Lattice.Carrier.WebSocket
  alias Lattice.{Authority, Log}
  alias LatticeCarrierServer.Operator.{Journal, Lock, Staging}
  alias LatticeCarrierServer.{Durability, Health, Holder, Listener, Manifest, ProbeRealm}
  alias LatticeCarrierServer.{Runtime, Secret}

  @spec confirm(Path.t(), binary() | nil, Path.t()) :: {:ok, map()} | {:error, term()}
  def confirm(root, expected, probe_identity_file) do
    with {:ok, deployment} <- Runtime.deployment() |> guarded(root),
         {:ok, record} <- activated(root, expected),
         digest = Base.encode16(deployment.manifest_digest, case: :lower),
         :ok <- same(digest == manifest_artifact(record)["sha256"], :release_manifest_mismatch),
         :ok <- same(Health.ready?(), :route_not_ready),
         {:ok, admitted} <- roster_current(record, deployment),
         :ok <- pulled(admitted, probe_identity_file),
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

  defp manifest_artifact(record),
    do: Enum.find(record["artifacts"], %{}, &(&1["kind"] == "manifest"))

  # Row 217's roster re-review against the Space log this restart now serves.
  # The holder persists before it acknowledges, so the file is the served
  # history; a file that cannot be read is a route that is not ready.
  defp roster_current(record, deployment) do
    [reference] = Enum.filter(record["artifacts"], &(&1["kind"] == "reference"))
    [child] = Enum.filter(record["artifacts"], &(&1["kind"] == "log"))
    pub = Base.decode64!(record["service"]["pub"])

    with {:ok, served} <- served_logs(deployment.instances),
         {:ok, child_log} <- staged_child(child),
         [admitted] <- Enum.filter(Runtime.instance_views(), &(&1.pub == pub)) do
      case Enum.filter(served, &(&1.replica == reference["replica"])) do
        [space] ->
          roster = Staging.roster(space)
          grants = Enum.sort(Enum.map(child["review"]["grants"], & &1["recipient"]))

          # The authority roots are kept so the probe key can be refused if it
          # reuses either one; members and the child root are trusted peers,
          # which `ProbeRealm.register/2` already refuses.
          roots = [Authority.root(space), Authority.root(child_log)]

          if grants == roster and Staging.bootstrap_peers_exact?(admitted, roster, child_log),
            do: {:ok, Map.merge(admitted, %{replica: child["replica"], roots: roots})},
            else: {:error, :roster_drift_since_activation}

        _ ->
          {:error, :roster_drift_since_activation}
      end
    else
      {:error, _} = refusal -> refusal
      _ -> {:error, :roster_drift_since_activation}
    end
  end

  defp served_logs(instances) do
    Enum.reduce_while(instances, {:ok, []}, fn instance, {:ok, logs} ->
      case Durability.with_target_lock(
             instance.log_file,
             fn -> Log.restore_verified(instance.log_file) end,
             retries: 5
           ) do
        {:ok, %{log: log}} -> {:cont, {:ok, logs ++ [log]}}
        _ -> {:halt, {:error, :route_not_ready}}
      end
    end)
  end

  defp staged_child(child) do
    replica = child["replica"]

    case Log.restore_verified(child["path"]) do
      {:ok, %{log: %{replica: ^replica} = log}} -> {:ok, log}
      _ -> {:error, :invalid_staged_signed_artifact}
    end
  end

  # The key is read before anything is registered; the grant exists only
  # between `register/2` and the `after` block, and the connection never
  # outlives this call.
  defp pulled(admitted, probe_identity_file) do
    with {:ok, secret, pub} <- probe_key(probe_identity_file),
         :ok <- same(pub not in admitted.roots, :readiness_probe_key_reused),
         {:ok, grant} <- ProbeRealm.register(admitted.name, pub) do
      try do
        read_route(admitted, secret)
      after
        ProbeRealm.revoke(admitted.name, grant)
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
  defp read_route(admitted, secret) do
    holder = Holder.via(admitted.name)
    {ip, port} = :ranch.get_addr(Listener.ref(admitted.name))

    connection =
      WebSocket.connect(
        hostname: ip |> :inet.ntoa() |> to_string(),
        port: port,
        identity: Secret.unwrap(secret),
        realm: ProbeRealm.realm(),
        peer_realm: admitted.realm,
        peer_pubkey: admitted.pub,
        replica: admitted.replica
      )

    case connection do
      {:ok, conn} ->
        try do
          compare(conn, holder)
        after
          WebSocket.close(conn)
        end

      _ ->
        {:error, :readiness_pull_failed}
    end
  end

  defp compare(conn, holder) do
    before = MapSet.new(Holder.op_ids(holder))

    with {:ok, frontier, conn} <- WebSocket.advertise(conn, nil),
         later = MapSet.new(Holder.op_ids(holder)),
         true <- MapSet.subset?(before, frontier) and MapSet.subset?(frontier, later),
         # Pull from nothing so every served op is encoded and sent: the
         # served ids must cover the frontier and stay within the holder's.
         {:ok, ops, _conn} <- WebSocket.pull(conn, MapSet.new()),
         final = MapSet.new(Holder.op_ids(holder)),
         served = MapSet.new(ops, & &1.id),
         true <- MapSet.subset?(frontier, served) and MapSet.subset?(served, final) do
      :ok
    else
      _ -> {:error, :readiness_pull_failed}
    end
  end

  defp same(true, _reason), do: :ok
  defp same(_, reason), do: {:error, reason}
end
