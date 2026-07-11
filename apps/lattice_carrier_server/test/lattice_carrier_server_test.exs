defmodule LatticeCarrierServerTest do
  use ExUnit.Case, async: false

  alias Lattice.Carrier.{Session, Telemetry, WebSocket, Wire}
  alias Lattice.{Identity, Log, Op}
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

  @tag :tmp_dir
  test "an oversized relay frame closes before persistence", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server-relay")
    relay_identity = Identity.from_seed("resident", "carrier-relay-client")
    base = Op.new(author, @replica, [], :command, {:post, "base"})

    oversized =
      Op.new(
        relay_identity,
        @replica,
        [base.id],
        :command,
        {:post, String.duplicate("x", 70_000)}
      )

    path = Path.join(tmp_dir, "matter.log")
    instance = {:test, System.unique_integer([:positive])}
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{relay_identity.realm_id => relay_identity.pub},
       relay_realms: [relay_identity.realm_id],
       source: {:path, path},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    connect_opts = connect_opts(instance, server_identity, relay_identity)
    assert {:ok, connection} = WebSocket.connect(connect_opts)
    assert {:error, :closed} = WebSocket.relay(connection, oversized)

    assert {:ok, connection} = WebSocket.connect(connect_opts)
    assert {:ok, [^base], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
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

  test "relay remains read-only unless the server explicitly enables the realm" do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server")
    client_identity = Identity.from_seed("resident", "carrier-relay-client")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    relayed = Op.new(client_identity, @replica, [base.id], :command, {:post, "relayed"})
    log = @replica |> Log.new() |> Log.append!(base)
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

    assert {:error, {:peer_error, "read_only"}} = WebSocket.relay(connection, relayed)
    assert {:ok, [^base], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
  end

  @tag :tmp_dir
  test "an authorized realm relays one persisted op for a second observer", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server-relay")
    relay_identity = Identity.from_seed("resident", "carrier-relay-client")
    observer_identity = Identity.from_seed("instrument", "carrier-relay-observer")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    relayed = Op.new(relay_identity, @replica, [base.id], :command, {:post, "relayed"})
    path = Path.join(tmp_dir, "matter.log")
    instance = {:test, System.unique_integer([:positive])}
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{
         relay_identity.realm_id => relay_identity.pub,
         observer_identity.realm_id => observer_identity.pub
       },
       relay_realms: [relay_identity.realm_id],
       source: {:path, path},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert {:ok, relay_connection} =
             WebSocket.connect(connect_opts(instance, server_identity, relay_identity))

    assert {:ok, %{accepted: [relayed_id], quarantined: [], rejected: [], pending: []},
            relay_connection} = WebSocket.relay(relay_connection, relayed)

    assert relayed_id == relayed.id

    assert {:ok, observer_connection} =
             WebSocket.connect(connect_opts(instance, server_identity, observer_identity))

    observer_relay =
      Op.new(observer_identity, @replica, [relayed.id], :command, {:post, "observer write"})

    assert {:error, {:peer_error, "read_only"}} =
             WebSocket.relay(observer_connection, observer_relay)

    assert {:error, {:peer_error, "read_only"}} =
             WebSocket.push(relay_connection, [observer_relay])

    assert {:error, {:peer_error, "read_only"}} =
             WebSocket.live(relay_connection, %{typing: true})

    assert {:ok, [^base, ^relayed], observer_connection} =
             WebSocket.pull(observer_connection, MapSet.new())

    assert {:ok, persisted} = Log.restore(path)
    assert persisted |> Log.op_ids() |> Enum.sort() == [base.id, relayed.id] |> Enum.sort()
    assert :ok = WebSocket.close(observer_connection)
    assert :ok = WebSocket.close(relay_connection)
  end

  @tag :tmp_dir
  test "an authenticated malformed relay is rejected without changing the frontier", %{
    tmp_dir: tmp_dir
  } do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server-relay")
    relay_identity = Identity.from_seed("resident", "carrier-relay-client")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    path = Path.join(tmp_dir, "matter.log")
    instance = {:test, System.unique_integer([:positive])}
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{relay_identity.realm_id => relay_identity.pub},
       relay_realms: [relay_identity.realm_id],
       source: {:path, path},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    client = authenticated_client(instance, server_identity, relay_identity)
    assert :ok = Client.send_envelope(client, %{type: "relay"})

    assert {:ok, %{"type" => "error", "reason" => "malformed"}} =
             Client.recv_envelope(client)

    assert :ok = Client.send_envelope(client, %{type: "frontier"})

    assert {:ok, %{"type" => "frontier_result", "ids" => [base_id]}} =
             Client.recv_envelope(client)

    assert base_id == base.id
    assert :ok = Client.close(client)
  end

  @tag :tmp_dir
  test "relay reports quarantine rejection and pending without growing the frontier", %{
    tmp_dir: tmp_dir
  } do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server-relay")
    relay_identity = Identity.from_seed("resident", "carrier-relay-client")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    bad_signature = Op.new(relay_identity, @replica, [base.id], :command, {:post, "bad"})
    bad_signature = %{bad_signature | sig: <<0::512>>}

    wrong_replica =
      Op.new(relay_identity, "replica:wrong", [], :command, {:post, "wrong replica"})

    missing_dep =
      Op.new(relay_identity, @replica, ["missing-op"], :command, {:post, "missing dep"})

    path = Path.join(tmp_dir, "matter.log")
    instance = {:test, System.unique_integer([:positive])}
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{relay_identity.realm_id => relay_identity.pub},
       relay_realms: [relay_identity.realm_id],
       source: {:path, path},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert {:ok, connection} =
             WebSocket.connect(connect_opts(instance, server_identity, relay_identity))

    assert {:ok,
            %{accepted: [], quarantined: [{bad_id, :bad_signature}], rejected: [], pending: []},
            connection} = WebSocket.relay(connection, bad_signature)

    assert bad_id == bad_signature.id

    assert {:ok,
            %{accepted: [], quarantined: [], rejected: [{wrong_id, :wrong_replica}], pending: []},
            connection} = WebSocket.relay(connection, wrong_replica)

    assert wrong_id == wrong_replica.id

    assert {:ok, %{accepted: [], quarantined: [], rejected: [], pending: [pending_id]},
            connection} = WebSocket.relay(connection, missing_dep)

    assert pending_id == missing_dep.id
    assert {:ok, [^base], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
  end

  @tag :tmp_dir
  test "duplicate accepted and quarantined relays do not rewrite the source", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server-relay")
    relay_identity = Identity.from_seed("resident", "carrier-relay-client")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    accepted = Op.new(relay_identity, @replica, [base.id], :command, {:post, "accepted"})
    bad_signature = Op.new(relay_identity, @replica, [accepted.id], :command, {:post, "bad"})
    bad_signature = %{bad_signature | sig: <<0::512>>}
    path = Path.join(tmp_dir, "matter.log")
    instance = {:test, System.unique_integer([:positive])}
    unchanged_timestamp = 1_600_000_000
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{relay_identity.realm_id => relay_identity.pub},
       relay_realms: [relay_identity.realm_id],
       source: {:path, path},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    assert {:ok, connection} =
             WebSocket.connect(connect_opts(instance, server_identity, relay_identity))

    assert {:ok, %{accepted: [accepted_id]}, connection} =
             WebSocket.relay(connection, accepted)

    assert accepted_id == accepted.id
    assert :ok = File.touch(path, unchanged_timestamp)
    assert File.stat!(path, time: :posix).mtime == unchanged_timestamp

    assert {:ok, %{accepted: [], quarantined: [], rejected: [], pending: []}, connection} =
             WebSocket.relay(connection, accepted)

    assert File.stat!(path, time: :posix).mtime == unchanged_timestamp

    assert {:ok, %{quarantined: [{bad_id, :bad_signature}]}, connection} =
             WebSocket.relay(connection, bad_signature)

    assert bad_id == bad_signature.id
    assert :ok = File.touch(path, unchanged_timestamp)

    assert {:ok, %{quarantined: [{bad_id, :already_quarantined}]}, connection} =
             WebSocket.relay(connection, bad_signature)

    assert bad_id == bad_signature.id
    assert File.stat!(path, time: :posix).mtime == unchanged_timestamp
    assert {:ok, [^base, ^accepted], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
  end

  @tag :tmp_dir
  test "failed relay persistence keeps the old log through restart", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server-relay-failure")
    relay_identity = Identity.from_seed("resident", "carrier-relay-failure-client")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    relayed = Op.new(relay_identity, @replica, [base.id], :command, {:post, "not persisted"})
    path = Path.join(tmp_dir, "matter.log")
    port = free_port()
    instance = {:test, System.unique_integer([:positive])}
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)
    source_bytes = File.read!(path)

    opts = [
      instance: instance,
      identity: server_identity,
      trusted_peers: %{relay_identity.realm_id => relay_identity.pub},
      relay_realms: [relay_identity.realm_id],
      source: {:path, path},
      listener: [ip: {127, 0, 0, 1}, port: port]
    ]

    server = start_supervised!({LatticeCarrierServer, opts})
    connect_opts = connect_opts(instance, server_identity, relay_identity)
    assert {:ok, connection} = WebSocket.connect(connect_opts)

    handler_id = {__MODULE__, make_ref()}

    assert :ok =
             Telemetry.attach(
               handler_id,
               [:lattice, :carrier, :relay_failure],
               &__MODULE__.handle_telemetry/4,
               self()
             )

    on_exit(fn -> Telemetry.detach(handler_id) end)

    assert :ok = File.rm(path)
    assert :ok = File.mkdir(path)

    assert {:error, {:peer_error, "unavailable"}} = WebSocket.relay(connection, relayed)

    assert_receive {:telemetry, [:lattice, :carrier, :relay_failure], %{}, metadata}, 1_000
    assert match?({:persistence_failed, _reason}, metadata.reason)
    assert metadata.peer_realm == relay_identity.realm_id
    assert metadata.side == :server
    refute Map.has_key?(metadata, :path)
    refute Map.has_key?(metadata, :op)

    assert {:ok, [^base], connection} = WebSocket.pull(connection, MapSet.new())
    assert Path.wildcard("#{path}.tmp.*") == []
    assert :ok = WebSocket.close(connection)

    assert :ok = File.rmdir(path)
    assert :ok = File.write(path, source_bytes)

    monitor = Process.monitor(server)
    Process.exit(server, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^server, :killed}, 1_000

    assert {:ok, connection} = connect_eventually(connect_opts, 2_000)
    assert {:ok, [^base], connection} = WebSocket.pull(connection, MapSet.new())
    assert :ok = WebSocket.close(connection)
  end

  @tag :tmp_dir
  test "an acknowledged relay survives supervised server restart", %{tmp_dir: tmp_dir} do
    author = Identity.from_seed("author", "carrier-server-author")
    server_identity = Identity.from_seed("town-node", "carrier-server-relay-restart")
    relay_identity = Identity.from_seed("resident", "carrier-relay-restart-client")
    base = Op.new(author, @replica, [], :command, {:post, "base"})
    relayed = Op.new(relay_identity, @replica, [base.id], :command, {:post, "durable"})
    path = Path.join(tmp_dir, "matter.log")
    port = free_port()
    instance = {:test, System.unique_integer([:positive])}
    assert :ok = @replica |> Log.new() |> Log.append!(base) |> Log.dump(path)

    opts = [
      instance: instance,
      identity: server_identity,
      trusted_peers: %{relay_identity.realm_id => relay_identity.pub},
      relay_realms: [relay_identity.realm_id],
      source: {:path, path},
      listener: [ip: {127, 0, 0, 1}, port: port]
    ]

    server = start_supervised!({LatticeCarrierServer, opts})
    connect_opts = connect_opts(instance, server_identity, relay_identity)
    assert {:ok, connection} = WebSocket.connect(connect_opts)
    assert {:ok, %{accepted: [relayed_id]}, connection} = WebSocket.relay(connection, relayed)
    assert relayed_id == relayed.id
    assert :ok = WebSocket.close(connection)

    monitor = Process.monitor(server)
    Process.exit(server, :kill)
    assert_receive {:DOWN, ^monitor, :process, ^server, :killed}, 1_000

    assert {:ok, connection} = connect_eventually(connect_opts, 2_000)
    assert {:ok, [^base, ^relayed], connection} = WebSocket.pull(connection, MapSet.new())
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
    relay_identity = Identity.from_seed("resident", "carrier-relay-client")
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

    assert {:error, {:invalid_config, :relay_realms}} =
             LatticeCarrierServer.start_link(
               instance: {:relay_requires_path, make_ref()},
               identity: identity,
               trusted_peers: %{relay_identity.realm_id => relay_identity.pub},
               relay_realms: [relay_identity.realm_id],
               source: {:log, log},
               listener: [port: 0]
             )

    assert {:error, {:invalid_config, :relay_realms}} =
             LatticeCarrierServer.start_link(
               instance: {:relay_requires_trusted_realm, make_ref()},
               identity: identity,
               trusted_peers: %{"instrument" => Identity.from_seed("instrument", "client").pub},
               relay_realms: [relay_identity.realm_id],
               source: {:path, "/unused"},
               listener: [port: 0]
             )
  end

  @tag :tmp_dir
  test "missing and corrupt path sources refuse startup", %{tmp_dir: tmp_dir} do
    server_identity = Identity.from_seed("town-node", "carrier-server-invalid-source")
    client_identity = Identity.from_seed("instrument", "carrier-client-invalid-source")
    corrupt_path = Path.join(tmp_dir, "corrupt.log")
    assert :ok = File.write(corrupt_path, "not an Erlang term")

    previous_flag = Process.flag(:trap_exit, true)

    try do
      for path <- [Path.join(tmp_dir, "missing.log"), corrupt_path] do
        instance = {:invalid_source, System.unique_integer([:positive])}

        assert {:error, reason} =
                 LatticeCarrierServer.start_link(
                   instance: instance,
                   identity: server_identity,
                   trusted_peers: %{client_identity.realm_id => client_identity.pub},
                   source: {:path, path},
                   listener: [port: 0]
                 )

        assert inspect(reason) =~ "source_error"
      end
    after
      Process.flag(:trap_exit, previous_flag)
    end
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

  defp authenticated_client(instance, server_identity, client_identity) do
    assert {:ok, client} =
             Client.connect(
               hostname: "127.0.0.1",
               port: LatticeCarrierServer.port(instance),
               path: "/carrier"
             )

    challenge = signed_challenge(client_identity)
    assert :ok = Client.send_envelope(client, challenge)
    assert {:ok, %{"type" => "carrier_hello"} = response} = Client.recv_envelope(client)

    assert :ok =
             Session.verify_response(challenge, response,
               expected_realm: server_identity.realm_id,
               expected_pubkey: server_identity.pub
             )

    client
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
