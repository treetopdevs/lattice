defmodule LatticeCarrierServer.TreehouseRouteBootTest do
  @moduledoc """
  Plan 181 slice 0: characterization of a hand-written Treehouse route manifest.

  This is not a RED test. It pins, with discriminating mutations, that the
  existing `pilot_node.exs` manifest path already boots one `Treehouse.Space`
  route and one `Treehouse.Thread` route from empty replica-named logs with no
  server source change. Every manifest here is hand-written by the test, so none
  of it is a staged, sealed, admitted or catalog-signed route, and the harness
  `kill -9` and stdin-EOF stops produce no stop seal and claim no controlled-stop
  semantics. The darwin run uses the dev-only directory-sync approximation, so
  no durable-ack claim is made here for macOS.

  The oracle is `Lattice.Sim`: the relayed and restarted logs must carry the Sim
  op ids and the Sim frames. Semantic quarantine is never reported by the relay
  (`Log.accept/2` only classifies structure), so the exact `no_capability` and
  `operation_not_granted` verdicts are asserted over the pulled log and compared with
  `Sim.quarantined/3`. A post under a capability whose op set lacks `post` is
  `operation_not_granted`; `role_not_granted` is reserved for a command that needs
  an authority role the capability does not carry, which a Thread `post` never does.
  """

  use ExUnit.Case, async: false

  alias Lattice.Carrier.Wire
  alias Lattice.Carrier.WebSocket
  alias Lattice.{Authority, Identity, Log, Op, Sim, Sync}
  alias LatticeCarrierServer.Manifest
  alias Treehouse.{Space, Thread}

  @moduletag timeout: 180_000

  @pilot_script Path.expand("../priv/pilot_node.exs", __DIR__)
  @space_name "treehouse:space:r13-lite-boot"
  @thread_name "treehouse:thread:r13-lite-boot:canopy"

  # --- positive boot and restart ------------------------------------------------

  @tag :tmp_dir
  test "a hand-written Space and Thread manifest boots, relays and restarts to the Sim ids", %{
    tmp_dir: dir
  } do
    oracle = oracle()
    fixture = fixture(dir)
    server = spawn_pilot(fixture.manifest_path)

    # The joiner may post only because a founder grant was relayed first, and the
    # joiner never submits to the Space route.
    relay_baseline!(server, fixture, oracle)

    kill_pilot(server)
    restarted = spawn_pilot(fixture.manifest_path)

    assert restart_ids(restarted, fixture, :space) == oracle.space_ids
    assert restart_ids(restarted, fixture, :thread) == oracle.thread_ids

    # Byte-equal frames, signatures included, not only ids.
    for {route, expected} <- [space: oracle.space_ops, thread: oracle.thread_ops ++ [oracle.post]] do
      pulled = pull(restarted, route, fixture.observer, fixture)

      assert Wire.encode_ops(Enum.sort_by(pulled, & &1.id)) ==
               Wire.encode_ops(Enum.sort_by(expected, & &1.id))
    end

    # The observer is read-only on both routes; a pull is all it may do.
    for route <- [:space, :thread] do
      assert {:error, {:peer_error, "read_only"}} =
               relay(restarted, route, fixture.observer, oracle.post, fixture)
    end

    stop_pilot(restarted)
  end

  # --- wire negatives against the live relay, re-pulled after kill -9 ---------------

  @tag :tmp_dir
  test "quarantine, bad signature, wrong replica and missing dependency stay exact and durable as specified",
       %{tmp_dir: dir} do
    oracle = oracle()
    fixture = fixture(dir)
    server = spawn_pilot(fixture.manifest_path)

    relay_all!(server, fixture, oracle, oracle.space_ops, :space)
    relay_all!(server, fixture, oracle, Enum.take(oracle.thread_ops, 2), :thread)

    # (d) joiner posts without a capability, then under a capability whose op set lacks `post`.
    # The relay stores them: the report is `accepted`, not `quarantined`, because
    # authority verdicts are computed from the log, not at delivery.
    assert {:ok, %{accepted: [no_cap_id], quarantined: [], rejected: [], pending: []}} =
             relay(server, :thread, fixture.joiner, oracle.no_cap, fixture)

    assert no_cap_id == oracle.no_cap.id

    relay_all!(server, fixture, oracle, [oracle.weak_grant], :thread)

    assert {:ok, %{accepted: [weak_id], quarantined: [], rejected: [], pending: []}} =
             relay(server, :thread, fixture.joiner, oracle.weak_post, fixture)

    assert weak_id == oracle.weak_post.id

    relay_all!(server, fixture, oracle, [oracle.grant], :thread)

    # (e) a bad signature on a not-yet-present op is structurally quarantined and
    # is never served. The id excludes the signature, so the forgery shares the
    # genuine post's id, and the genuine op must still be accepted afterwards.
    forged = %{oracle.post | sig: <<0::512>>}

    assert {:ok,
            %{accepted: [], quarantined: [{forged_id, :bad_signature}], rejected: [], pending: []}} =
             relay(server, :thread, fixture.joiner, forged, fixture)

    assert forged_id == oracle.post.id
    assert advertised_ids(server, :thread, fixture) |> Enum.member?(oracle.post.id) == false

    assert {:ok, %{accepted: [post_id], quarantined: [], rejected: [], pending: []}} =
             relay(server, :thread, fixture.joiner, oracle.post, fixture)

    assert post_id == oracle.post.id

    # A duplicate delivery is an idempotent no-op.
    assert {:ok, %{accepted: [], quarantined: [], rejected: [], pending: []}} =
             relay(server, :thread, fixture.joiner, oracle.post, fixture)

    # Wrong replica: the one structural `rejected` outcome. A Space frame cannot
    # enter the Thread log.
    assert {:ok, %{accepted: [], quarantined: [], rejected: [{wrong_id, :wrong_replica}]}} =
             relay(server, :thread, fixture.founder, hd(oracle.space_ops), fixture)

    assert wrong_id == hd(oracle.space_ops).id

    # (f) a missing dependency is `pending`: the relay lacks it and did not persist it.
    orphan =
      Op.new(
        fixture.joiner.identity,
        thread_replica(),
        ["missing-dependency"],
        :command,
        {:post, ["orphan"]},
        cap: oracle.delegation.id
      )

    assert {:ok, %{accepted: [], quarantined: [], rejected: [], pending: [orphan_id]}} =
             relay(server, :thread, fixture.joiner, orphan, fixture)

    assert orphan_id == orphan.id

    expected_ids =
      Enum.sort([
        hd(oracle.thread_ops).id,
        Enum.at(oracle.thread_ops, 1).id,
        oracle.no_cap.id,
        oracle.weak_grant.id,
        oracle.weak_post.id,
        oracle.grant.id,
        oracle.post.id
      ])

    assert advertised_ids(server, :thread, fixture) == expected_ids

    kill_pilot(server)
    restarted = spawn_pilot(fixture.manifest_path)

    pulled = pull(restarted, :thread, fixture.observer, fixture)
    pulled_ids = pulled |> Enum.map(& &1.id) |> Enum.sort()
    assert pulled_ids == expected_ids
    refute orphan.id in pulled_ids
    assert oracle.post.id in pulled_ids

    # Each pulled frame is the signed Sim frame, and the verdicts match Sim exactly.
    for op <- pulled do
      assert Op.valid?(op)
      assert op == Map.fetch!(oracle.thread_by_id, op.id)
    end

    {log, %{pending: []}} = Sync.deliver(Log.new(thread_replica()), pulled)
    reasons = Authority.analyze(Thread, log).reasons

    assert reasons[oracle.no_cap.id] == :no_capability
    assert reasons[oracle.weak_post.id] == :operation_not_granted
    refute Map.has_key?(reasons, oracle.post.id)
    assert {true, :no_capability} == oracle.sim_verdicts[oracle.no_cap.id]
    assert {true, :operation_not_granted} == oracle.sim_verdicts[oracle.weak_post.id]
    assert false == oracle.sim_verdicts[oracle.post.id]

    # The retained structural quarantine is evidence on disk, not a served op.
    assert {:ok, restored} = Log.restore(fixture.logs.thread)

    assert Enum.any?(
             Log.quarantine(restored),
             &(&1.op.id == forged.id and &1.reason == :bad_signature)
           )

    refute Log.has?(restored, orphan.id)

    stop_pilot(restarted)
  end

  # --- discriminating mutations -------------------------------------------------

  @tag :tmp_dir
  test "mutation (a): omitting the Thread instance fails the Thread route", %{tmp_dir: dir} do
    oracle = oracle()
    fixture = fixture(dir, instances: [:space])
    server = spawn_pilot(fixture.manifest_path)

    refute Map.has_key?(server.instances, "thread")

    # Only the Space listener exists, so a Thread challenge reaches a Space holder.
    port = server.instances["space"].port

    assert {:error, {:peer_error, "unauthenticated"}} =
             WebSocket.connect(
               connect_opts(
                 port,
                 fixture.founder.identity,
                 fixture.relay_identities.space,
                 thread_replica()
               )
             )

    relay_all!(server, fixture, oracle, oracle.space_ops, :space)
    stop_pilot(server)
  end

  test "a Space listener refuses a Thread challenge with the exact wrong_replica reason" do
    founder = Identity.from_seed("founder", "r13-lite-wrong-replica")
    server_identity = Identity.from_seed("relay-space", "r13-lite-wrong-replica-server")
    instance = {:r13_lite_boot, System.unique_integer([:positive])}

    start_supervised!(
      {LatticeCarrierServer,
       instance: instance,
       identity: server_identity,
       trusted_peers: %{founder.realm_id => founder.pub},
       source: {:log, Log.new(space_replica())},
       listener: [ip: {127, 0, 0, 1}, port: 0]}
    )

    handler = {__MODULE__, make_ref()}
    parent = self()

    :ok =
      :telemetry.attach(
        handler,
        [:lattice, :carrier, :auth_failure],
        &__MODULE__.handle_telemetry/4,
        parent
      )

    on_exit(fn -> :telemetry.detach(handler) end)

    assert {:error, {:peer_error, "unauthenticated"}} =
             WebSocket.connect(
               connect_opts(
                 LatticeCarrierServer.port(instance),
                 founder,
                 server_identity,
                 thread_replica()
               )
             )

    assert_receive {:telemetry, [:lattice, :carrier, :auth_failure], %{},
                    %{reason: :wrong_replica}}
  end

  @tag :tmp_dir
  test "mutation (b): a respawn against a log at a different path loses the Sim ids", %{
    tmp_dir: dir
  } do
    oracle = oracle()
    fixture = fixture(dir)
    server = spawn_pilot(fixture.manifest_path)
    relay_baseline!(server, fixture, oracle)
    kill_pilot(server)

    # Positive control with the same helper: the original paths restore the Sim ids.
    control = spawn_pilot(fixture.manifest_path)
    assert restart_ids(control, fixture, :thread) == oracle.thread_ids
    kill_pilot(control)

    elsewhere = Path.join(dir, "elsewhere-thread.log")
    assert :ok = Log.dump(Log.new(thread_replica()), elsewhere)
    moved = rewrite_manifest(fixture, %{"thread" => elsewhere})
    mutated = spawn_pilot(moved)

    assert restart_ids(mutated, fixture, :thread) != oracle.thread_ids
    assert restart_ids(mutated, fixture, :thread) == []
    stop_pilot(mutated)
  end

  @tag :tmp_dir
  test "mutation (c): deleting the log before respawn refuses startup and recreates nothing", %{
    tmp_dir: dir
  } do
    oracle = oracle()
    fixture = fixture(dir)
    server = spawn_pilot(fixture.manifest_path)
    relay_baseline!(server, fixture, oracle)
    kill_pilot(server)

    control = spawn_pilot(fixture.manifest_path)
    assert restart_ids(control, fixture, :thread) == oracle.thread_ids
    kill_pilot(control)

    File.rm!(fixture.logs.thread)
    {output, status} = run_pilot_expecting_refusal(fixture.manifest_path)
    assert status == 1
    assert output =~ "PILOT_REFUSED"
    refute File.exists?(fixture.logs.thread), "refusal must not recreate the log"
  end

  # --- pins of existing refusals ----------------------------------------------------

  @tag :tmp_dir
  test "dropping relay_realms makes the Thread route read-only for founder and joiner", %{
    tmp_dir: dir
  } do
    oracle = oracle()
    fixture = fixture(dir, relay_realms: %{thread: []})
    server = spawn_pilot(fixture.manifest_path)

    for who <- [fixture.founder, fixture.joiner] do
      assert {:error, {:peer_error, "read_only"}} =
               relay(server, :thread, who, hd(oracle.thread_ops), fixture)
    end

    assert pull(server, :thread, fixture.observer, fixture) == []
    stop_pilot(server)
  end

  @tag :tmp_dir
  test "the joiner cannot relay to the Space route and an untrusted realm cannot connect", %{
    tmp_dir: dir
  } do
    oracle = oracle()
    fixture = fixture(dir)
    server = spawn_pilot(fixture.manifest_path)

    assert {:error, {:peer_error, "read_only"}} =
             relay(server, :space, fixture.joiner, hd(oracle.space_ops), fixture)

    stranger = Identity.from_seed("stranger", "r13-lite-stranger")

    assert {:error, {:peer_error, "unauthenticated"}} =
             WebSocket.connect(
               connect_opts(
                 server.instances["thread"].port,
                 stranger,
                 fixture.relay_identities.thread,
                 thread_replica()
               )
             )

    stop_pilot(server)
  end

  test "a manifest under the unresolved macOS temp path is refused by the path-permission check" do
    unique = "r13-lite-boot-#{System.unique_integer([:positive])}"
    raw = Path.join(System.tmp_dir!(), unique)
    File.mkdir_p!(raw)
    on_exit(fn -> File.rm_rf(raw) end)

    path = Path.join(raw, "manifest.json")
    File.write!(path, Jason.encode!(%{"version" => 1, "instances" => []}))
    File.chmod!(path, 0o600)

    assert {:error, {:invalid_manifest, {:manifest_path_permissions, offender}}} =
             Manifest.load(path)

    case :os.type() do
      {:unix, :darwin} -> assert offender == "/var"
      _other -> assert is_binary(offender)
    end
  end

  # `Sim.create_replica/3` binds the replica id to the founder's root key, so the
  # empty path-backed logs and every challenge must carry the bound id.
  defp space_replica, do: Authority.bind_replica(@space_name, founder_pub())
  defp thread_replica, do: Authority.bind_replica(@thread_name, founder_pub())
  defp founder_pub, do: Identity.from_seed("founder", "r13-lite-boot:founder").pub

  def handle_telemetry(event, measurements, metadata, receiver),
    do: send(receiver, {:telemetry, event, measurements, metadata})

  # --- Sim oracle ---------------------------------------------------------------------

  defp oracle do
    space = Sim.new(Space, @space_name, ["founder", "joiner"], seed: "r13-lite-boot")
    {space, space_genesis} = Sim.create_replica(space, "founder")
    {space, create_space} = Sim.command(space, "founder", :create_space, ["Canopy"])

    thread = Sim.new(Thread, @thread_name, ["founder", "joiner"], seed: "r13-lite-boot")
    {thread, thread_genesis} = Sim.create_replica(thread, "founder")
    {thread, create_thread} = Sim.command(thread, "founder", :create_thread, ["Canopy"])

    {_space, space_thread} =
      Sim.command(space, "founder", :create_thread, [Sim.replica(thread), "Canopy"])

    thread = Sim.sync_all(thread)

    {with_no_cap, no_cap} = Sim.command(thread, "joiner", :post, ["before grant"], cap: :none)

    {weak_sim, weak_delegation} = Sim.grant(thread, "founder", "joiner", ops: [:author_edit])
    weak_sim = Sim.sync_all(weak_sim)
    weak_grant = grant_op(weak_sim, weak_delegation)

    {weak_sim, weak_post} =
      Sim.command(weak_sim, "joiner", :post, ["weak"], cap: weak_delegation.id)

    {granted, delegation} =
      Sim.grant(thread, "founder", "joiner", ops: [:post, :author_edit, :author_tombstone])

    granted = Sim.sync_all(granted)
    grant = grant_op(granted, delegation)
    {granted, post} = Sim.command(granted, "joiner", :post, ["joined"], cap: delegation.id)
    granted = Sim.sync_all(granted)

    verdicts = %{
      no_cap.id => Sim.quarantined(Sim.sync_all(with_no_cap), "founder", no_cap.id),
      weak_post.id => Sim.quarantined(Sim.sync_all(weak_sim), "founder", weak_post.id),
      post.id => Sim.quarantined(granted, "founder", post.id)
    }

    space_ops = [space_genesis, create_space, space_thread]
    thread_ops = [thread_genesis, create_thread, grant]

    thread_all =
      [thread_genesis, create_thread, no_cap, weak_grant, weak_post, grant, post]

    %{
      space_ops: space_ops,
      thread_ops: thread_ops,
      thread_all: thread_all,
      thread_by_id: Map.new(thread_all, &{&1.id, &1}),
      space_ids: space_ops |> Enum.map(& &1.id) |> Enum.sort(),
      thread_ids: (thread_ops ++ [post]) |> Enum.map(& &1.id) |> Enum.sort(),
      no_cap: no_cap,
      weak_grant: weak_grant,
      weak_post: weak_post,
      grant: grant,
      delegation: delegation,
      post: post,
      sim_verdicts: verdicts
    }
  end

  # `Sim.grant/4` returns the delegation; the relay needs the signed grant op that carries it.
  defp grant_op(sim, %{id: delegation_id}) do
    sim
    |> Sim.log("founder")
    |> Log.ops()
    |> Map.values()
    |> Enum.find(&match?({:grant, %{id: ^delegation_id}}, &1.body))
  end

  # --- manifest fixture ------------------------------------------------------------

  defp fixture(dir, opts \\ []) do
    ids = Sim.new(Space, @space_name, ["founder", "joiner"], seed: "r13-lite-boot")
    founder = Sim.identity(ids, "founder")
    joiner = Sim.identity(ids, "joiner")
    observer = Identity.from_seed("observer", "r13-lite-boot-observer")

    names = Keyword.get(opts, :instances, [:space, :thread])
    relay_overrides = Keyword.get(opts, :relay_realms, %{})
    default_relay = %{space: [founder.realm_id], thread: [founder.realm_id, joiner.realm_id]}
    replicas = %{space: space_replica(), thread: thread_replica()}
    logs = Map.new([:space, :thread], &{&1, Path.join(dir, "#{&1}.log")})

    # Empty replica-named logs: the founder relays genesis into them.
    for name <- names, do: assert(:ok = Log.dump(Log.new(replicas[name]), logs[name]))

    instances =
      for name <- names do
        {seed_hex, _service} = service_identity(name)
        identity_path = Path.join(dir, "#{name}.identity")
        File.write!(identity_path, seed_hex <> "\n")
        File.chmod!(identity_path, 0o600)

        %{
          "name" => Atom.to_string(name),
          "realm" => "relay-#{name}",
          "identity_file" => identity_path,
          "log_file" => logs[name],
          "listener" => %{"ip" => "127.0.0.1", "port" => 0},
          "trusted_peers" =>
            Enum.map(
              [founder, joiner, observer],
              &%{"realm" => &1.realm_id, "pubkey" => Base.encode64(&1.pub)}
            ),
          "relay_realms" => Map.get(relay_overrides, name, default_relay[name])
        }
      end

    manifest = %{
      "version" => 1,
      "health" => %{"ip" => "127.0.0.1", "port" => 0},
      "instances" => instances
    }

    manifest_path = Path.join(dir, "treehouse-manifest.json")
    File.write!(manifest_path, Jason.encode!(manifest))
    File.chmod!(manifest_path, 0o600)

    %{
      dir: dir,
      manifest: manifest,
      manifest_path: manifest_path,
      logs: logs,
      founder: %{identity: founder},
      joiner: %{identity: joiner},
      observer: %{identity: observer},
      relay_identities:
        Map.new([:space, :thread], fn name -> {name, elem(service_identity(name), 1)} end)
    }
  end

  # The relay's own transport key: a separate role that never authors an op.
  defp service_identity(name) do
    seed = :crypto.hash(:sha256, "r13-lite-boot-relay-#{name}-identity")
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519, seed)

    {Base.encode16(seed, case: :lower),
     %Identity{realm_id: "relay-#{name}", pub: pub, priv: priv}}
  end

  defp rewrite_manifest(fixture, log_overrides) do
    instances =
      Enum.map(fixture.manifest["instances"], fn instance ->
        case Map.fetch(log_overrides, instance["name"]) do
          {:ok, path} -> Map.put(instance, "log_file", path)
          :error -> instance
        end
      end)

    path = Path.join(fixture.dir, "mutated-manifest.json")
    File.write!(path, Jason.encode!(%{fixture.manifest | "instances" => instances}))
    File.chmod!(path, 0o600)
    path
  end

  # --- relay helpers ---------------------------------------------------------------

  defp replica_for(:space), do: space_replica()
  defp replica_for(:thread), do: thread_replica()

  defp connect_opts(port, identity, server_identity, replica) do
    [
      hostname: "127.0.0.1",
      port: port,
      identity: identity,
      realm: identity.realm_id,
      peer_realm: server_identity.realm_id,
      peer_pubkey: server_identity.pub,
      replica: replica
    ]
  end

  defp connect(server, route, who, fixture) do
    name = Atom.to_string(route)
    %{port: port, pubkey: pubkey} = Map.fetch!(server.instances, name)
    service = fixture.relay_identities[route]
    assert pubkey == Base.encode64(service.pub)
    WebSocket.connect(connect_opts(port, who.identity, service, replica_for(route)))
  end

  defp relay(server, route, who, op, fixture) do
    {:ok, connection} = connect(server, route, who, fixture)
    result = WebSocket.relay(connection, op)
    _ = WebSocket.close(connection)

    case result do
      {:ok, report, _connection} -> {:ok, report}
      {:error, _reason} = error -> error
    end
  end

  defp relay_all!(server, fixture, _oracle, ops, route) do
    for op <- ops do
      assert {:ok, %{accepted: [id], quarantined: [], rejected: [], pending: []}} =
               relay(server, route, fixture.founder, op, fixture)

      assert id == op.id
    end
  end

  # Founder relays the Sim-authored baseline; the joiner relays one post under its grant.
  defp relay_baseline!(server, fixture, oracle) do
    relay_all!(server, fixture, oracle, oracle.space_ops, :space)
    relay_all!(server, fixture, oracle, oracle.thread_ops, :thread)

    assert {:ok, %{accepted: [post_id]}} =
             relay(server, :thread, fixture.joiner, oracle.post, fixture)

    assert post_id == oracle.post.id
  end

  defp pull(server, route, who, fixture) do
    {:ok, connection} = connect(server, route, who, fixture)
    {:ok, ops, connection} = WebSocket.pull(connection, MapSet.new())
    :ok = WebSocket.close(connection)
    ops
  end

  defp advertised_ids(server, route, fixture) do
    {:ok, connection} = connect(server, route, fixture.observer, fixture)
    {:ok, ids, connection} = WebSocket.advertise(connection, nil)
    :ok = WebSocket.close(connection)
    ids |> Enum.sort()
  end

  defp restart_ids(server, fixture, route) do
    server |> pull(route, fixture.observer, fixture) |> Enum.map(& &1.id) |> Enum.sort()
  end

  # --- pilot process helpers (as in pilot_runtime_test.exs) ----------------------------

  defp spawn_pilot(manifest_path) do
    args = code_path_args() ++ [@pilot_script, manifest_path]

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

    instances = await_pilot_ready(port, %{}, [])
    %{port: port, os_pid: os_pid, instances: instances}
  end

  defp await_pilot_ready(port, instances, seen) do
    receive do
      {^port, {:data, {:eol, "INSTANCE " <> rest}}} ->
        [name, ws_port, pubkey] = String.split(String.trim(rest), " ")

        await_pilot_ready(
          port,
          Map.put(instances, name, %{port: String.to_integer(ws_port), pubkey: pubkey}),
          ["INSTANCE #{rest}" | seen]
        )

      {^port, {:data, {:eol, "PILOT_READY " <> _health}}} ->
        instances

      {^port, {:data, {:eol, line}}} ->
        await_pilot_ready(port, instances, [line | seen])

      {^port, {:data, {:noeol, chunk}}} ->
        await_pilot_ready(port, instances, [chunk | seen])

      {^port, {:exit_status, status}} ->
        flunk("pilot exited (#{status}) before READY:\n#{format_output(seen)}")
    after
      60_000 -> flunk("pilot never became ready:\n#{format_output(seen)}")
    end
  end

  defp stop_pilot(%{port: port}) do
    true = Port.command(port, "stop\n")
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  defp kill_pilot(%{port: port, os_pid: os_pid}) do
    {_output, 0} = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    assert_receive {^port, {:exit_status, _status}}, 10_000
  end

  defp run_pilot_expecting_refusal(manifest_path) do
    System.cmd(elixir_bin(), code_path_args() ++ [@pilot_script, manifest_path],
      cd: repo_root(),
      stderr_to_stdout: true
    )
  end

  defp code_path_args do
    :code.get_path()
    |> Enum.map(&List.to_string/1)
    |> Enum.filter(&String.contains?(&1, "_build"))
    |> Enum.flat_map(&["-pa", &1])
  end

  defp elixir_bin do
    shim = Path.expand("~/.asdf/shims/elixir")

    cond do
      File.exists?(shim) -> shim
      path = System.find_executable("elixir") -> path
      true -> flunk("no elixir executable available to spawn the pilot")
    end
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)
  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")
end
