defmodule LatticeCarrierServer.TownshipProjectionTest do
  use ExUnit.Case, async: false

  alias Lattice.Carrier.{Backoff, WebSocket}
  alias Lattice.{Identity, Log, Sim}
  alias Township.{AuditBundle, Matter, ReadModel}
  alias TownshipWeb.CarrierProjection

  @moduletag timeout: 120_000
  @script Path.expand("../priv/server_node.exs", __DIR__)
  @source_dir Path.expand("../../../artifacts/township", __DIR__)
  @source_path Path.join(@source_dir, "matter.log")

  test "a second-BEAM server restart moves one projection from fresh to stale to fresh" do
    {:ok, _apps} = Application.ensure_all_started(:township_web)
    assert :ok = AuditBundle.verify(@source_dir)
    {:ok, source_log} = Log.restore(@source_path)
    observer = Identity.from_seed("instrument", "stable-server-projection")
    server_identity = Identity.from_seed("town-node", "stable-carrier-server")
    fixed_port = free_port()
    server = spawn_server(fixed_port, observer)
    assert elem(server, 1) == fixed_port

    topic = "township:stable-server:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         connect_opts: connect_opts(fixed_port, observer, server_identity, source_log.replica),
         replica: source_log.replica,
         peer_realm: server_identity.realm_id,
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, fresh_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(fresh_payload) == source_log |> Log.op_ids() |> Enum.sort()

    stop_server(server)

    assert {:ok, {:stale, stale_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(stale_payload) == payload_ids(fresh_payload)
    assert stale_payload.provenance.freshness == :stale
    assert stale_payload.provenance.last_error

    restarted_server = spawn_server(fixed_port, observer)
    assert elem(restarted_server, 1) == fixed_port

    assert {:ok, {:fresh, recovered_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(recovered_payload) == payload_ids(fresh_payload)
    assert recovered_payload.provenance.freshness == :fresh
    assert recovered_payload.provenance.last_error == nil

    stop_server(restarted_server)
  end

  @tag :tmp_dir
  test "a client-signed relay survives a second-BEAM restart and matches Sim", %{
    tmp_dir: tmp_dir
  } do
    {:ok, _apps} = Application.ensure_all_started(:township_web)

    replica_name = "replica:matter:stable-relay"
    sim = Sim.new(Matter, replica_name, ["clerk", "resident"], seed: "stable-relay")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    base_log = Sim.log(sim, "clerk")
    replica = base_log.replica
    relay_identity = Sim.identity(sim, "resident")
    {sim, relayed_op} = Sim.command(sim, "resident", :post, ["resident: relayed"])
    sim = Sim.sync_all(sim)
    expected_log = Sim.log(sim, "clerk")
    source_path = Path.join(tmp_dir, "matter.log")
    assert :ok = Log.dump(base_log, source_path)

    observer = Identity.from_seed("instrument", "stable-relay-projection")
    server_identity = Identity.from_seed("town-node", "stable-carrier-server")
    fixed_port = free_port()
    server = spawn_server(fixed_port, observer, relay_identity, source_path)
    assert elem(server, 1) == fixed_port

    topic = "township:stable-relay:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         connect_opts: connect_opts(fixed_port, observer, server_identity, replica),
         replica: replica,
         peer_realm: server_identity.realm_id,
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: :manual}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, base_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(base_payload) == base_log |> Log.op_ids() |> Enum.sort()

    assert {:ok, relay_connection} =
             WebSocket.connect(connect_opts(fixed_port, relay_identity, server_identity, replica))

    assert {:ok, %{accepted: [relayed_id]}, relay_connection} =
             WebSocket.relay(relay_connection, relayed_op)

    assert relayed_id == relayed_op.id
    assert :ok = WebSocket.close(relay_connection)

    assert {:ok, {:fresh, relayed_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(relayed_payload) == expected_log |> Log.op_ids() |> Enum.sort()
    assert relayed_payload.read_model == ReadModel.observe(expected_log)
    assert relayed_payload.causal_replay == ReadModel.replay(expected_log)

    assert {:ok, audit_connection} =
             WebSocket.connect(connect_opts(fixed_port, observer, server_identity, replica))

    assert {:ok, served_ops, audit_connection} = WebSocket.pull(audit_connection, MapSet.new())
    assert Enum.map(served_ops, & &1.id) == Enum.map(Log.topo_ops(expected_log), & &1.id)
    refute server_identity.pub in Enum.map(served_ops, & &1.author)
    assert :ok = WebSocket.close(audit_connection)

    kill_server(server)

    assert {:ok, {:stale, stale_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(stale_payload) == payload_ids(relayed_payload)

    restarted_server = spawn_server(fixed_port, observer, relay_identity, source_path)
    assert elem(restarted_server, 1) == fixed_port

    assert {:ok, {:fresh, recovered_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(recovered_payload) == payload_ids(relayed_payload)
    assert recovered_payload.read_model == relayed_payload.read_model
    assert recovered_payload.causal_replay == relayed_payload.causal_replay

    stop_server(restarted_server)
  end

  @tag :tmp_dir
  test "a second-BEAM availability feed drives Sim convergence and resubscribes after restart", %{
    tmp_dir: tmp_dir
  } do
    {:ok, _apps} = Application.ensure_all_started(:township_web)

    replica_name = "replica:matter:stable-feed"
    sim = Sim.new(Matter, replica_name, ["clerk", "resident"], seed: "stable-feed")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    base_log = Sim.log(sim, "clerk")
    relay_identity = Sim.identity(sim, "resident")
    {sim, first_relayed_op} = Sim.command(sim, "resident", :post, ["resident: pushed feed"])
    sim = Sim.sync_all(sim)
    first_expected_log = Sim.log(sim, "clerk")

    {sim, second_relayed_op} =
      Sim.command(sim, "resident", :post, ["resident: pushed after restart"])

    sim = Sim.sync_all(sim)
    restarted_expected_log = Sim.log(sim, "clerk")
    source_path = Path.join(tmp_dir, "matter.log")
    assert :ok = Log.dump(base_log, source_path)

    observer = Identity.from_seed("instrument", "stable-feed-projection")
    server_identity = Identity.from_seed("town-node", "stable-carrier-server")
    fixed_port = free_port()
    server = spawn_server(fixed_port, observer, relay_identity, source_path)
    topic = "township:stable-feed:#{System.unique_integer([:positive])}"

    projection =
      start_supervised!(
        {CarrierProjection,
         feed: :server_push,
         connect_opts: connect_opts(fixed_port, observer, server_identity, base_log.replica),
         replica: base_log.replica,
         peer_realm: server_identity.realm_id,
         pubsub: TownshipWeb.PubSub,
         topic: topic,
         schedule: [
           initial_delay_ms: 60_000,
           poll_interval_ms: 60_000,
           backoff: Backoff.new(base_ms: 50, max_ms: 200, seed: "stable-feed")
         ]}
      )

    assert {:ok, :connecting} = CarrierProjection.subscribe(projection)
    assert {:ok, {:fresh, base_payload}} = CarrierProjection.refresh(projection)
    assert_receive {:township_instrument, {:fresh, ^base_payload}}
    assert payload_ids(base_payload) == base_log |> Log.op_ids() |> Enum.sort()

    assert {:ok, relay_connection} =
             WebSocket.connect(
               connect_opts(fixed_port, relay_identity, server_identity, base_log.replica)
             )

    assert {:ok, %{accepted: [relayed_id]}, relay_connection} =
             WebSocket.relay(relay_connection, first_relayed_op)

    assert relayed_id == first_relayed_op.id

    assert_receive {:township_instrument, {:fresh, pushed_payload}}, 5_000
    assert payload_ids(pushed_payload) == first_expected_log |> Log.op_ids() |> Enum.sort()
    assert pushed_payload.read_model == ReadModel.observe(first_expected_log)
    assert pushed_payload.causal_replay == ReadModel.replay(first_expected_log)
    assert pushed_payload.provenance.refresh_trigger == :server_push
    assert pushed_payload.provenance.feed_generation == Log.size(first_expected_log)
    assert :ok = WebSocket.close(relay_connection)

    kill_server(server)
    assert_receive {:township_instrument, {:stale, stale_payload}}, 5_000
    assert payload_ids(stale_payload) == payload_ids(pushed_payload)

    restarted_server = spawn_server(fixed_port, observer, relay_identity, source_path)
    assert elem(restarted_server, 1) == fixed_port

    assert_receive {:township_instrument, {:fresh, recovered_payload}}, 5_000
    assert payload_ids(recovered_payload) == payload_ids(pushed_payload)
    assert recovered_payload.read_model == pushed_payload.read_model
    assert recovered_payload.causal_replay == pushed_payload.causal_replay
    assert recovered_payload.provenance.refresh_trigger == :poll
    assert recovered_payload.provenance.feed_generation == Log.size(first_expected_log)

    assert {:ok, relay_connection} =
             WebSocket.connect(
               connect_opts(fixed_port, relay_identity, server_identity, base_log.replica)
             )

    assert {:ok, %{accepted: [second_relayed_id]}, relay_connection} =
             WebSocket.relay(relay_connection, second_relayed_op)

    assert second_relayed_id == second_relayed_op.id

    assert_receive {:township_instrument, {:fresh, restarted_push_payload}}, 5_000

    assert payload_ids(restarted_push_payload) ==
             restarted_expected_log |> Log.op_ids() |> Enum.sort()

    assert restarted_push_payload.read_model == ReadModel.observe(restarted_expected_log)
    assert restarted_push_payload.causal_replay == ReadModel.replay(restarted_expected_log)
    assert restarted_push_payload.provenance.refresh_trigger == :server_push
    assert restarted_push_payload.provenance.feed_generation == Log.size(restarted_expected_log)
    assert :ok = WebSocket.close(relay_connection)
    stop_server(restarted_server)
  end

  @tag :tmp_dir
  test "relay accepts a signed command while the observer preserves Sim authority quarantine", %{
    tmp_dir: tmp_dir
  } do
    {:ok, _apps} = Application.ensure_all_started(:township_web)

    sim =
      Sim.new(Matter, "replica:matter:relay-authority", ["clerk", "resident"],
        seed: "relay-authority"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    base_log = Sim.log(sim, "clerk")
    relay_identity = Sim.identity(sim, "resident")
    {sim, denied_op} = Sim.command(sim, "resident", :admit, ["intruder"], cap: :none)
    sim = Sim.sync_all(sim)
    expected_log = Sim.log(sim, "clerk")
    source_path = Path.join(tmp_dir, "matter.log")
    assert :ok = Log.dump(base_log, source_path)

    observer = Identity.from_seed("instrument", "relay-authority-observer")
    server_identity = Identity.from_seed("town-node", "relay-authority-server")
    instance = {:test, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{
         observer.realm_id => observer.pub,
         relay_identity.realm_id => relay_identity.pub
       },
       relay_realms: [relay_identity.realm_id],
       source: {:path, source_path},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    port = LatticeCarrierServer.port(instance)

    projection =
      start_supervised!(
        {CarrierProjection,
         connect_opts: connect_opts(port, observer, server_identity, base_log.replica),
         replica: base_log.replica,
         peer_realm: server_identity.realm_id,
         pubsub: TownshipWeb.PubSub,
         topic: "township:relay-authority:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    assert {:ok, relay_connection} =
             WebSocket.connect(
               connect_opts(port, relay_identity, server_identity, base_log.replica)
             )

    assert {:ok, %{accepted: [denied_id], quarantined: [], rejected: [], pending: []},
            relay_connection} = WebSocket.relay(relay_connection, denied_op)

    assert denied_id == denied_op.id
    assert :ok = WebSocket.close(relay_connection)

    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert payload.read_model == ReadModel.observe(expected_log)
    assert denied_op.id in payload.read_model.roles.quarantine
    assert payload.read_model.roles.reasons[denied_op.id] == :no_capability
    refute "intruder" in payload.read_model.members.current
  end

  defp payload_ids(payload) do
    payload.causal_replay["nodes"] |> Enum.map(& &1["id"]) |> Enum.sort()
  end

  defp connect_opts(port, observer, server_identity, replica) do
    [
      hostname: "127.0.0.1",
      port: port,
      identity: observer,
      realm: observer.realm_id,
      peer_realm: server_identity.realm_id,
      peer_pubkey: server_identity.pub,
      replica: replica
    ]
  end

  defp spawn_server(port_number, observer) do
    spawn_server(port_number, observer, nil, @source_path)
  end

  defp spawn_server(port_number, observer, relay_identity, source_path) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [
          @script,
          Integer.to_string(port_number),
          "town-node",
          "stable-carrier-server",
          observer.realm_id,
          Base.encode64(observer.pub),
          source_path
        ] ++ relay_args(relay_identity)

    port =
      Port.open({:spawn_executable, elixir_bin()}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:line, 4_096},
        {:args, args},
        {:cd, repo_root()}
      ])

    os_pid = port |> Port.info(:os_pid) |> elem(1)

    on_exit(fn ->
      _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    end)

    {port, await_ready(port, [])}
  end

  defp relay_args(nil), do: []
  defp relay_args(identity), do: [identity.realm_id, Base.encode64(identity.pub)]

  defp stop_server({port, _ws_port}) do
    true = Port.command(port, "stop\n")
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  defp kill_server({port, _ws_port}) do
    os_pid = port |> Port.info(:os_pid) |> elem(1)
    {_output, 0} = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    assert_receive {^port, {:exit_status, _status}}, 10_000
  end

  defp await_ready(port, seen) do
    receive do
      {^port, {:data, {:eol, "SERVER_READY " <> ws_port}}} ->
        String.to_integer(String.trim(ws_port))

      {^port, {:data, {:eol, line}}} ->
        await_ready(port, [line | seen])

      {^port, {:data, {:noeol, chunk}}} ->
        await_ready(port, [chunk | seen])

      {^port, {:exit_status, status}} ->
        flunk("server exited (#{status}) before READY:\n#{format_output(seen)}")
    after
      60_000 -> flunk("server never became ready:\n#{format_output(seen)}")
    end
  end

  defp code_paths do
    :code.get_path()
    |> Enum.map(&List.to_string/1)
    |> Enum.filter(&String.contains?(&1, "_build"))
  end

  defp elixir_bin do
    shim = Path.expand("~/.asdf/shims/elixir")

    cond do
      File.exists?(shim) -> shim
      path = System.find_executable("elixir") -> path
      true -> flunk("no elixir executable available to spawn the server")
    end
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false, reuseaddr: true])
    {:ok, {_ip, port}} = :inet.sockname(socket)
    :ok = :gen_tcp.close(socket)
    port
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)
  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")
end
