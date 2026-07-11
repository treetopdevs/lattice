defmodule LatticeCarrierServerTest do
  use ExUnit.Case, async: false

  alias Lattice.{Identity, Log, Op}
  alias Lattice.Carrier.{Session, Telemetry, WebSocket, Wire}
  alias Lattice.Transport.WebSocket.Client

  @replica "replica:carrier-server:test"

  test "a trusted production client pulls the configured log" do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server")
    client_identity = Identity.from_seed("instrument", "carrier-client")
    op = Op.new(author, @replica, [], :command, {:post, "served"})
    log = @replica |> Log.new() |> Log.append!(op)
    instance = {:test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{client_identity.realm_id => client_identity.pub},
       source: {:log, log},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert port = LatticeCarrierServer.port(instance)

    assert {:ok, connection} =
             WebSocket.connect(
               hostname: "127.0.0.1",
               port: port,
               identity: client_identity,
               realm: client_identity.realm_id,
               peer_realm: server_identity.realm_id,
               peer_pubkey: server_identity.pub,
               replica: @replica
             )

    assert {:ok, ids, connection} = WebSocket.advertise(connection, Log.new(@replica))
    assert ids == MapSet.new([op.id])

    assert {:ok, [pulled], connection} = WebSocket.pull(connection, MapSet.new())
    assert pulled == op
    assert :ok = WebSocket.close(connection)
  end

  test "authentication failures stay coarse while telemetry retains the reason" do
    server_identity = Identity.from_seed("town-node", "carrier-server")
    trusted_identity = Identity.from_seed("instrument", "carrier-client")
    wrong_identity = Identity.from_seed("instrument", "wrong-carrier-client")
    instance = {:test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{trusted_identity.realm_id => trusted_identity.pub},
       source: {:log, Log.new(@replica)},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    handler_id = {__MODULE__, make_ref()}
    parent = self()

    assert :ok =
             Telemetry.attach(
               handler_id,
               [:lattice, :carrier, :auth_failure],
               &__MODULE__.handle_telemetry/4,
               parent
             )

    on_exit(fn -> Telemetry.detach(handler_id) end)

    assert {:error, {:peer_error, "unauthenticated"}} =
             WebSocket.connect(
               hostname: "127.0.0.1",
               port: LatticeCarrierServer.port(instance),
               identity: wrong_identity,
               realm: wrong_identity.realm_id,
               peer_realm: server_identity.realm_id,
               peer_pubkey: server_identity.pub,
               replica: @replica
             )

    assert_receive {:telemetry, [:lattice, :carrier, :auth_failure], %{},
                    %{side: :server} = metadata}

    assert metadata.reason == :bad_signature
    assert metadata.expected_realm == trusted_identity.realm_id
    assert metadata.peer_realm == wrong_identity.realm_id
    assert metadata.side == :server
  end

  test "an oversized authenticated pull frame is closed before dispatch" do
    server_identity = Identity.from_seed("town-node", "carrier-server")
    client_identity = Identity.from_seed("instrument", "carrier-client")
    instance = {:test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{client_identity.realm_id => client_identity.pub},
       source: {:log, Log.new(@replica)},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert {:ok, connection} =
             WebSocket.connect(
               hostname: "127.0.0.1",
               port: LatticeCarrierServer.port(instance),
               identity: client_identity,
               realm: client_identity.realm_id,
               peer_realm: server_identity.realm_id,
               peer_pubkey: server_identity.pub,
               replica: @replica
             )

    oversized_have =
      1..5_000
      |> Map.new(fn index -> {"#{index}:#{String.duplicate("x", 24)}", true} end)
      |> Map.keys()
      |> MapSet.new()

    assert {:error, :closed} = WebSocket.pull(connection, oversized_have)
  end

  test "authenticated disconnect emits telemetry without changing the served log" do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server")
    client_identity = Identity.from_seed("instrument", "carrier-client")
    op = Op.new(author, @replica, [], :command, {:post, "stable"})
    log = @replica |> Log.new() |> Log.append!(op)
    instance = {:test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{client_identity.realm_id => client_identity.pub},
       source: {:log, log},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    handler_id = {__MODULE__, make_ref()}

    assert :ok =
             Telemetry.attach(
               handler_id,
               [:lattice, :carrier, :disconnect],
               &__MODULE__.handle_telemetry/4,
               self()
             )

    on_exit(fn -> Telemetry.detach(handler_id) end)
    connect_opts = connect_opts(instance, server_identity, client_identity)

    assert {:ok, connection} = WebSocket.connect(connect_opts)
    assert :ok = WebSocket.close(connection)

    assert_receive {:telemetry, [:lattice, :carrier, :disconnect], %{}, metadata}, 1_000
    assert metadata.realm == server_identity.realm_id
    assert metadata.peer_realm == client_identity.realm_id
    assert metadata.side == :server

    assert {:ok, connection} = WebSocket.connect(connect_opts)
    assert {:ok, [^op], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
  end

  test "protocol requests are refused before authentication" do
    server_identity = Identity.from_seed("town-node", "carrier-server")
    client_identity = Identity.from_seed("instrument", "carrier-client")
    instance = {:test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{client_identity.realm_id => client_identity.pub},
       source: {:log, Log.new(@replica)},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert {:ok, client} =
             Client.connect(
               hostname: "127.0.0.1",
               port: LatticeCarrierServer.port(instance),
               path: "/carrier"
             )

    assert :ok = Client.send_envelope(client, %{type: "frontier"})

    assert {:ok, %{"type" => "error", "reason" => "unauthenticated"}} =
             Client.recv_envelope(client)

    assert :ok = Client.close(client)
  end

  test "auth refusal telemetry distinguishes realm replica version and malformed challenges" do
    server_identity = Identity.from_seed("town-node", "carrier-server")
    trusted_identity = Identity.from_seed("instrument", "carrier-client")
    unknown_identity = Identity.from_seed("unknown", "unknown-client")
    instance = {:test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{trusted_identity.realm_id => trusted_identity.pub},
       source: {:log, Log.new(@replica)},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    handler_id = {__MODULE__, make_ref()}

    assert :ok =
             Telemetry.attach(
               handler_id,
               [:lattice, :carrier, :auth_failure],
               &__MODULE__.handle_telemetry/4,
               self()
             )

    on_exit(fn -> Telemetry.detach(handler_id) end)
    port = LatticeCarrierServer.port(instance)

    assert_auth_rejected(port, signed_challenge(unknown_identity), :unknown_peer)

    assert_auth_rejected(
      port,
      signed_challenge(trusted_identity, replica: "replica:wrong"),
      :wrong_replica
    )

    assert_auth_rejected(
      port,
      signed_challenge(trusted_identity, wire_version: Wire.version() + 1),
      :unsupported_wire_version
    )

    malformed =
      Session.challenge(trusted_identity.realm_id, @replica, wire_version: Wire.version())

    assert_auth_rejected(port, malformed, :malformed_session)
  end

  test "push and live requests are refused without changing the served log" do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server")
    client_identity = Identity.from_seed("instrument", "carrier-client")
    served = Op.new(author, @replica, [], :command, {:post, "served"})
    rejected = Op.new(client_identity, @replica, [served.id], :command, {:post, "rejected"})
    log = @replica |> Log.new() |> Log.append!(served)
    instance = {:test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{client_identity.realm_id => client_identity.pub},
       source: {:log, log},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert {:ok, connection} =
             WebSocket.connect(connect_opts(instance, server_identity, client_identity))

    assert {:error, {:peer_error, "read_only"}} = WebSocket.push(connection, [rejected])
    assert {:error, {:peer_error, "read_only"}} = WebSocket.live(connection, %{typing: true})
    assert {:ok, [^served], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
  end

  @tag :tmp_dir
  test "a path source restores and serves the configured log", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server")
    client_identity = Identity.from_seed("instrument", "carrier-client")
    op = Op.new(author, @replica, [], :command, {:post, "restored"})
    log = @replica |> Log.new() |> Log.append!(op)
    path = Path.join(tmp_dir, "matter.log")
    instance = {:test, System.unique_integer([:positive])}
    assert :ok = Log.dump(log, path)

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{client_identity.realm_id => client_identity.pub},
       source: {:path, path},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert {:ok, connection} =
             WebSocket.connect(connect_opts(instance, server_identity, client_identity))

    assert {:ok, [^op], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
  end

  test "invalid transport identity and trusted-peer configuration refuse startup" do
    identity = Identity.from_seed("town-node", "carrier-server")
    log = Log.new(@replica)

    assert {:error, {:invalid_config, :identity}} =
             LatticeCarrierServer.start_link(
               instance: {:invalid_identity, make_ref()},
               identity: :not_an_identity,
               trusted_peers: %{"instrument" => Identity.from_seed("instrument", "client").pub},
               source: {:log, log},
               listener: [port: 0]
             )

    assert {:error, {:invalid_config, :trusted_peers}} =
             LatticeCarrierServer.start_link(
               instance: {:invalid_trusted_peers, make_ref()},
               identity: identity,
               trusted_peers: %{"instrument" => :not_a_public_key},
               source: {:log, log},
               listener: [port: 0]
             )
  end

  @tag :tmp_dir
  test "a supervised fixed-port restart reloads the same path source", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server-restart")
    client_identity = Identity.from_seed("instrument", "carrier-client-restart")
    op = Op.new(author, @replica, [], :command, {:post, "restart-stable"})
    path = Path.join(tmp_dir, "matter.log")
    port = free_port()
    instance = {:test, System.unique_integer([:positive])}
    assert :ok = @replica |> Log.new() |> Log.append!(op) |> Log.dump(path)

    opts = [
      instance: instance,
      identity: server_identity,
      trusted_peers: %{client_identity.realm_id => client_identity.pub},
      source: {:path, path},
      listener: [ip: {127, 0, 0, 1}, port: port]
    ]

    server = start_supervised!({LatticeCarrierServer, opts})
    connect_opts = connect_opts(instance, server_identity, client_identity)

    assert {:ok, connection} = WebSocket.connect(connect_opts)
    assert {:ok, [^op], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)

    monitor = Process.monitor(server)
    Process.exit(server, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^server, :killed}, 1_000

    assert {:ok, connection} = connect_eventually(connect_opts, 2_000)
    assert LatticeCarrierServer.port(instance) == port
    assert {:ok, [^op], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
  end

  def handle_telemetry(event, measurements, metadata, receiver) do
    send(receiver, {:telemetry, event, measurements, metadata})
  end

  defp assert_auth_rejected(port, challenge, expected_reason) do
    assert {:ok, client} = Client.connect(hostname: "127.0.0.1", port: port, path: "/carrier")
    assert :ok = Client.send_envelope(client, challenge)

    assert {:ok, %{"type" => "error", "reason" => "unauthenticated"}} =
             Client.recv_envelope(client)

    assert_receive {:telemetry, [:lattice, :carrier, :auth_failure], %{}, metadata}
    assert metadata.reason == expected_reason
    assert metadata.side == :server
    assert :ok = Client.close(client)
  end

  defp signed_challenge(identity, opts \\ []) do
    replica = Keyword.get(opts, :replica, @replica)
    wire_version = Keyword.get(opts, :wire_version, Wire.version())

    identity.realm_id
    |> Session.challenge(replica, wire_version: wire_version)
    |> Session.sign_challenge(identity)
  end

  defp connect_opts(instance, server_identity, client_identity) do
    [
      hostname: "127.0.0.1",
      port: LatticeCarrierServer.port(instance),
      identity: client_identity,
      realm: client_identity.realm_id,
      peer_realm: server_identity.realm_id,
      peer_pubkey: server_identity.pub,
      replica: @replica
    ]
  end

  defp connect_eventually(opts, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    hostname = opts |> Keyword.fetch!(:hostname) |> String.to_charlist()
    port = Keyword.fetch!(opts, :port)

    with :ok <- wait_for_tcp(hostname, port, deadline) do
      WebSocket.connect(opts)
    end
  end

  defp wait_for_tcp(hostname, port, deadline) do
    case :gen_tcp.connect(hostname, port, [:binary, active: false], 100) do
      {:ok, socket} ->
        :gen_tcp.close(socket)

      {:error, reason} ->
        if System.monotonic_time(:millisecond) < deadline do
          Process.sleep(25)
          wait_for_tcp(hostname, port, deadline)
        else
          {:error, reason}
        end
    end
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, {_ip, port}} = :inet.sockname(socket)
    :ok = :gen_tcp.close(socket)
    port
  end
end
