defmodule LatticeCarrierServer.ProbeRealmTest do
  @moduledoc """
  Plan 223 / D-22: the operator probe realm is an ephemeral, single-use,
  read-only grant. These tests boot a real two-instance manifest deployment and
  connect over loopback. The 30-second session cap is not slept through here.
  """

  use ExUnit.Case, async: false

  alias Lattice.Carrier.{Telemetry, WebSocket}
  alias Lattice.{Identity, Log, Op}
  alias Lattice.Transport.WebSocket.Client
  alias LatticeCarrierServer.{Holder, ProbeRealm, Runtime}

  @moduletag :tmp_dir
  @moduletag timeout: 120_000

  setup %{tmp_dir: tmp_dir} do
    previous = Application.get_env(:lattice_carrier_server, :manifest, :missing)

    on_exit(fn ->
      :ok = safe_stop()
      restore_manifest_config(previous)
      {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
    end)

    alpha = instance_fixture(tmp_dir, "alpha")
    beta = instance_fixture(tmp_dir, "beta")

    boot!(write_manifest(tmp_dir, %{"version" => 1, "instances" => [alpha.entry, beta.entry]}))

    %{alpha: alpha, beta: beta, probe: Identity.from_seed("operator", "probe-key")}
  end

  describe "a live grant" do
    test "reads frontier and pull and nothing else", %{alpha: alpha, probe: probe} do
      {:ok, _ref} = ProbeRealm.register(alpha.name, probe.pub)

      assert {:ok, conn} = connect_probe(alpha, probe)
      assert {:ok, ids, conn} = WebSocket.advertise(conn, Log.new(alpha.replica))
      assert ids == MapSet.new([alpha.base.id])
      assert {:ok, [pulled], conn} = WebSocket.pull(conn, MapSet.new())
      assert pulled == alpha.base
      assert :ok = WebSocket.close(conn)
    end

    test "refuses every other request as read_only without touching the holder", %{
      alpha: alpha,
      probe: probe
    } do
      {:ok, _ref} = ProbeRealm.register(alpha.name, probe.pub)
      assert {:ok, conn} = connect_probe(alpha, probe)

      op = Op.new(alpha.relay_identity, alpha.replica, [alpha.base.id], :command, {:post, "no"})
      before = holder_snapshot(alpha)
      attach_refusals()

      requests = [
        {"relay", %{type: "relay", op: Lattice.Carrier.Wire.encode_op(op)}},
        {"subscribe", %{type: "subscribe"}},
        {"unsubscribe", %{type: "unsubscribe"}},
        {"state", %{type: "state"}},
        {"carrier_challenge", %{type: "carrier_challenge", local_realm: ProbeRealm.realm()}},
        {"mystery", %{type: "mystery"}}
      ]

      for {type, request} <- requests do
        assert {:ok, %{"type" => "error", "reason" => "read_only"}} =
                 Client.request_envelope(conn.client, request)

        assert_receive {:telemetry, [:lattice, :carrier, :probe_refused], %{},
                        %{type: ^type, probe: true, side: :server} = metadata}

        refute Map.has_key?(metadata, :pubkey)
        assert holder_snapshot(alpha) == before
      end

      # Still a working probe session afterwards.
      assert {:ok, _ids, conn} = WebSocket.advertise(conn, Log.new(alpha.replica))
      assert holder_snapshot(alpha) == before
      assert :ok = WebSocket.close(conn)
    end
  end

  describe "authentication" do
    test "no grant, expired, revoked and consumed grants are unauthenticated", %{
      alpha: alpha,
      probe: probe
    } do
      assert {:error, {:peer_error, "unauthenticated"}} = connect_probe(alpha, probe)

      expire(alpha.name, probe.pub)
      assert {:error, {:peer_error, "unauthenticated"}} = connect_probe(alpha, probe)

      {:ok, ref} = ProbeRealm.register(alpha.name, probe.pub)
      assert :ok = ProbeRealm.revoke(alpha.name, ref)
      assert :ok = ProbeRealm.revoke(alpha.name, ref)
      assert {:error, {:peer_error, "unauthenticated"}} = connect_probe(alpha, probe)

      {:ok, _ref} = ProbeRealm.register(alpha.name, probe.pub)
      assert {:ok, conn} = connect_probe(alpha, probe)
      assert {:error, {:peer_error, "unauthenticated"}} = connect_probe(alpha, probe)
      assert :ok = WebSocket.close(conn)
    end

    test "a grant for one instance does not open another", %{
      alpha: alpha,
      beta: beta,
      probe: probe
    } do
      {:ok, _ref} = ProbeRealm.register(alpha.name, probe.pub)
      assert {:error, {:peer_error, "unauthenticated"}} = connect_probe(beta, probe)
      assert {:ok, conn} = connect_probe(alpha, probe)
      assert :ok = WebSocket.close(conn)
    end

    test "mismatched realm and key pairings are refused and keep the grant", %{
      alpha: alpha,
      probe: probe
    } do
      {:ok, _ref} = ProbeRealm.register(alpha.name, probe.pub)

      # The probe realm signed by a trusted peer's key.
      assert {:error, {:peer_error, "unauthenticated"}} =
               connect(alpha, alpha.observer, ProbeRealm.realm())

      # A trusted peer's realm signed by the probe key.
      assert {:error, {:peer_error, "unauthenticated"}} =
               connect(alpha, probe, alpha.observer.realm_id)

      # Wrong replica.
      assert {:error, {:peer_error, "unauthenticated"}} =
               connect(alpha, probe, ProbeRealm.realm(), replica: "replica:other")

      # None of the failures consumed the grant.
      assert {:ok, conn} = connect_probe(alpha, probe)
      assert :ok = WebSocket.close(conn)
    end

    test "a trusted peer's session is unchanged", %{alpha: alpha} do
      op = Op.new(alpha.relay_identity, alpha.replica, [alpha.base.id], :command, {:post, "yes"})

      assert {:ok, conn} = connect(alpha, alpha.relay_identity, alpha.relay_identity.realm_id)
      assert {:ok, %{accepted: [id]}, conn} = WebSocket.relay(conn, op)
      assert id == op.id
      assert {:ok, _subscription, conn} = WebSocket.subscribe(conn, self())
      assert map_size(holder_state(alpha).subscribers) == 1
      assert :ok = WebSocket.close(conn)
    end
  end

  describe "registration" do
    test "refuses a busy instance, but replaces an expired grant", %{alpha: alpha, probe: probe} do
      {:ok, _ref} = ProbeRealm.register(alpha.name, probe.pub)

      assert {:error, :readiness_probe_busy} = ProbeRealm.register(alpha.name, probe.pub)

      expire(alpha.name, probe.pub)
      assert {:ok, ref} = ProbeRealm.register(alpha.name, probe.pub)
      assert is_reference(ref)
    end

    test "revoke removes only its own grant", %{alpha: alpha, probe: probe} do
      {:ok, old} = ProbeRealm.register(alpha.name, probe.pub)
      expire(alpha.name, probe.pub)
      {:ok, _new} = ProbeRealm.register(alpha.name, probe.pub)

      assert :ok = ProbeRealm.revoke(alpha.name, old)
      assert {:ok, conn} = connect_probe(alpha, probe)
      assert :ok = WebSocket.close(conn)
    end

    test "refuses a reused key and an unknown instance", %{alpha: alpha, beta: beta, probe: probe} do
      for pub <- [
            alpha.server_identity.pub,
            beta.server_identity.pub,
            alpha.observer.pub,
            beta.relay_identity.pub
          ] do
        assert {:error, :readiness_probe_key_reused} = ProbeRealm.register(alpha.name, pub)
      end

      assert {:error, :readiness_probe_unknown_instance} =
               ProbeRealm.register("no-such-instance", probe.pub)
    end

    test "refuses when the realm collides with a trusted peer", %{tmp_dir: tmp_dir, probe: probe} do
      colliding = instance_fixture(tmp_dir, "colliding", extra_peer_realm: ProbeRealm.realm())
      boot!(write_manifest(tmp_dir, %{"version" => 1, "instances" => [colliding.entry]}))

      assert {:error, :readiness_probe_realm_collision} =
               ProbeRealm.register(colliding.name, probe.pub)
    end
  end

  defp connect_probe(fixture, probe), do: connect(fixture, probe, ProbeRealm.realm())

  defp connect(fixture, identity, realm, opts \\ []) do
    WebSocket.connect(
      hostname: "127.0.0.1",
      port: LatticeCarrierServer.port(fixture.name),
      identity: identity,
      realm: realm,
      peer_realm: fixture.server_identity.realm_id,
      peer_pubkey: fixture.server_identity.pub,
      replica: Keyword.get(opts, :replica, fixture.replica)
    )
  end

  defp attach_refusals do
    handler_id = {__MODULE__, make_ref()}

    :ok =
      Telemetry.attach(
        handler_id,
        [:lattice, :carrier, :probe_refused],
        &__MODULE__.handle_telemetry/4,
        self()
      )

    on_exit(fn -> Telemetry.detach(handler_id) end)
  end

  def handle_telemetry(event, measurements, metadata, receiver) do
    send(receiver, {:telemetry, event, measurements, metadata})
  end

  # Rewrite the instance's live grant with a lapsed deadline.
  defp expire(name, pub) do
    [{^name, ref, ^pub, _deadline}] = :ets.lookup(ProbeRealm.table(), name)
    :ets.insert(ProbeRealm.table(), {name, ref, pub, System.monotonic_time(:millisecond) - 1})
  rescue
    MatchError ->
      {:ok, ref} = ProbeRealm.register(name, pub)
      :ets.insert(ProbeRealm.table(), {name, ref, pub, System.monotonic_time(:millisecond) - 1})
  end

  defp holder_state(fixture), do: :sys.get_state(Holder.via(fixture.name))

  defp holder_snapshot(fixture) do
    state = holder_state(fixture)
    {state.log, Map.keys(state.subscribers)}
  end

  defp instance_fixture(tmp_dir, name, opts \\ []) do
    replica = "replica:probe-realm:#{name}"
    author = Identity.from_seed("author", "probe-author-#{name}")
    relay_identity = Identity.from_seed("resident", "probe-relay-#{name}")
    observer = Identity.from_seed("instrument", "probe-observer-#{name}")
    base = Op.new(author, replica, [], :command, {:post, "base #{name}"})

    dir = Path.join(tmp_dir, name)
    File.mkdir_p!(dir)
    log_path = Path.join(dir, "matter.log")
    assert :ok = replica |> Log.new() |> Log.append!(base) |> Log.dump(log_path)

    seed = :crypto.hash(:sha256, "probe-server-#{name}-#{Path.basename(tmp_dir)}")
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519, seed)
    server_identity = %Identity{realm_id: "town-node-#{name}", pub: pub, priv: priv}

    identity_path = Path.join(dir, "identity")
    File.write!(identity_path, Base.encode16(seed, case: :lower))
    File.chmod!(identity_path, 0o600)

    extra =
      case Keyword.get(opts, :extra_peer_realm) do
        nil ->
          []

        realm ->
          stranger = Identity.from_seed("stranger", "probe-stranger-#{name}")
          [%{"realm" => realm, "pubkey" => Base.encode64(stranger.pub)}]
      end

    entry = %{
      "name" => "pilot-#{name}",
      "realm" => server_identity.realm_id,
      "identity_file" => identity_path,
      "log_file" => log_path,
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "trusted_peers" =>
        [
          %{"realm" => observer.realm_id, "pubkey" => Base.encode64(observer.pub)},
          %{"realm" => relay_identity.realm_id, "pubkey" => Base.encode64(relay_identity.pub)}
        ] ++ extra,
      "relay_realms" => [relay_identity.realm_id]
    }

    %{
      name: "pilot-#{name}",
      replica: replica,
      base: base,
      relay_identity: relay_identity,
      observer: observer,
      server_identity: server_identity,
      entry: entry
    }
  end

  defp write_manifest(tmp_dir, manifest) do
    path = Path.join(tmp_dir, "manifest-#{System.unique_integer([:positive])}.json")
    File.write!(path, Jason.encode!(manifest))
    path
  end

  defp boot!(manifest_path) do
    :ok = safe_stop()
    Application.put_env(:lattice_carrier_server, :manifest, manifest_path)
    {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
    assert %{} = Runtime.deployment()
  end

  defp safe_stop do
    case Application.stop(:lattice_carrier_server) do
      :ok -> :ok
      {:error, {:not_started, :lattice_carrier_server}} -> :ok
    end
  end

  defp restore_manifest_config(:missing),
    do: Application.delete_env(:lattice_carrier_server, :manifest)

  defp restore_manifest_config(value),
    do: Application.put_env(:lattice_carrier_server, :manifest, value)
end
