defmodule LatticeCarrierServer.RuntimeIsolationTest do
  @moduledoc """
  Manifest-driven runtime contracts (plan 158): multiple isolated replica
  instances under one supervisor, corrupt-log startup refusal, and no
  identity material in captured logs.
  """

  use ExUnit.Case, async: false

  import ExUnit.CaptureLog

  alias Lattice.Carrier.WebSocket
  alias Lattice.{Identity, Log, Op}
  alias LatticeCarrierServer.{Holder, Runtime}

  @moduletag timeout: 120_000

  setup do
    previous = Application.get_env(:lattice_carrier_server, :manifest, :missing)

    on_exit(fn ->
      :ok = safe_stop()
      restore_manifest_config(previous)
      {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
    end)

    :ok
  end

  @tag :tmp_dir
  test "two manifest instances serve isolated replicas from isolated logs", %{tmp_dir: tmp_dir} do
    alpha = instance_fixture(tmp_dir, "alpha")
    beta = instance_fixture(tmp_dir, "beta")

    manifest_path =
      write_manifest(tmp_dir, %{
        "version" => 1,
        "health" => %{"ip" => "127.0.0.1", "port" => 0},
        "instances" => [alpha.entry, beta.entry]
      })

    boot!(manifest_path)

    relayed =
      Op.new(
        alpha.relay_identity,
        alpha.replica,
        [alpha.base.id],
        :command,
        {:post, "alpha only"}
      )

    assert {:ok, connection} = connect(alpha)
    assert {:ok, %{accepted: [relayed_id]}, connection} = WebSocket.relay(connection, relayed)
    assert relayed_id == relayed.id
    assert :ok = WebSocket.close(connection)

    # The other instance's served state and durable log are untouched.
    assert {:ok, beta_connection} = connect(beta)
    assert {:ok, beta_ops, beta_connection} = WebSocket.pull(beta_connection, MapSet.new())
    assert Enum.map(beta_ops, & &1.id) == [beta.base.id]
    assert :ok = WebSocket.close(beta_connection)

    assert {:ok, alpha_log} = Log.restore(alpha.log_path)
    assert relayed.id in Log.op_ids(alpha_log)
    assert {:ok, beta_log} = Log.restore(beta.log_path)
    refute relayed.id in Log.op_ids(beta_log)

    # Readiness covers both instances.
    health_port = LatticeCarrierServer.Health.port()
    assert is_integer(health_port)

    {:ok, _inets} = Application.ensure_all_started(:inets)

    assert {:ok, {{_http, 204, _reason}, _headers, ""}} =
             :httpc.request(
               :get,
               {String.to_charlist("http://127.0.0.1:#{health_port}/readyz"), []},
               [],
               body_format: :binary
             )
  end

  @tag :tmp_dir
  test "a corrupt log refuses startup without rewriting it or leaking secrets", %{
    tmp_dir: tmp_dir
  } do
    fixture = instance_fixture(tmp_dir, "corrupt")
    File.write!(fixture.log_path, "not a lattice log dump")

    manifest_path =
      write_manifest(tmp_dir, %{"version" => 1, "instances" => [fixture.entry]})

    :ok = safe_stop()
    Application.put_env(:lattice_carrier_server, :manifest, manifest_path)

    log_output =
      capture_log(fn ->
        assert {:error, _reason} = Application.ensure_all_started(:lattice_carrier_server)
      end)

    # Fail closed: the corrupt log is preserved byte-for-byte, no fresh
    # community is minted, and no identity material reaches the log output.
    assert File.read!(fixture.log_path) == "not a lattice log dump"
    refute log_output =~ fixture.seed_hex
    refute log_output =~ Base.encode64(fixture.server_identity.priv)
  end

  @tag :tmp_dir
  test "all manifest logs preflight before any instance can start", %{tmp_dir: tmp_dir} do
    alpha = instance_fixture(tmp_dir, "preflight-alpha")
    beta = instance_fixture(tmp_dir, "preflight-beta")
    File.write!(beta.log_path, "corrupt")

    manifest_path =
      write_manifest(tmp_dir, %{
        "version" => 1,
        "instances" => [alpha.entry, beta.entry]
      })

    assert {:error, {:source_restore_failed, {:instance, 2}}} =
             Runtime.prepare(manifest_path)
  end

  @tag :tmp_dir
  test "one exhausted instance does not restart a healthy sibling", %{tmp_dir: tmp_dir} do
    alpha = instance_fixture(tmp_dir, "restart-alpha")
    beta = instance_fixture(tmp_dir, "restart-beta")

    manifest_path =
      write_manifest(tmp_dir, %{
        "version" => 1,
        "instances" => [alpha.entry, beta.entry]
      })

    boot!(manifest_path)

    beta_holder = GenServer.whereis(Holder.via(beta.name))
    alpha_supervisor = runtime_child_pid({LatticeCarrierServer, alpha.name})
    Process.exit(alpha_supervisor, :kill)

    wait_until(fn ->
      case runtime_child_pid({LatticeCarrierServer, alpha.name}) do
        pid when is_pid(pid) -> pid != alpha_supervisor and Process.alive?(pid)
        _other -> false
      end
    end)

    assert GenServer.whereis(Holder.via(beta.name)) == beta_holder
  end

  @tag :tmp_dir
  test "a persistently broken route remains contained without exhausting the shared supervisor",
       %{
         tmp_dir: tmp_dir
       } do
    alpha = instance_fixture(tmp_dir, "contained-alpha")
    beta = instance_fixture(tmp_dir, "contained-beta")

    manifest_path =
      write_manifest(tmp_dir, %{
        "version" => 1,
        "instances" => [alpha.entry, beta.entry]
      })

    boot!(manifest_path)

    owner = runtime_child_pid({LatticeCarrierServer, alpha.name})
    %{route: route} = :sys.get_state(owner)
    beta_holder = GenServer.whereis(Holder.via(beta.name))
    application_supervisor = Process.whereis(LatticeCarrierServer.ApplicationSupervisor)
    File.rm!(alpha.log_path)
    Process.exit(route, :kill)
    Process.sleep(500)

    assert Process.alive?(owner)
    assert Process.alive?(application_supervisor)
    assert GenServer.whereis(Holder.via(beta.name)) == beta_holder
  end

  @tag :tmp_dir
  test "a supervisor startup failure erases prepared secret-bearing instances", %{
    tmp_dir: tmp_dir
  } do
    alpha = instance_fixture(tmp_dir, "failed-start-alpha")
    alpha_key = {Runtime, {:instance, alpha.name}}
    {:ok, occupied} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, health_port} = :inet.port(occupied)

    manifest =
      write_manifest(tmp_dir, %{
        "version" => 1,
        "health" => %{"ip" => "127.0.0.1", "port" => health_port},
        "instances" => [alpha.entry]
      })

    :ok = safe_stop()
    Application.put_env(:lattice_carrier_server, :manifest, manifest)

    assert {:error, _reason} = Application.ensure_all_started(:lattice_carrier_server)
    assert :persistent_term.get(alpha_key, :missing) == :missing
    assert Runtime.deployment() == nil
    :gen_tcp.close(occupied)
  end

  @tag :tmp_dir
  test "an initially unavailable route refuses the whole manifest deployment", %{
    tmp_dir: tmp_dir
  } do
    alpha = instance_fixture(tmp_dir, "failed-route-alpha")
    alpha_key = {Runtime, {:instance, alpha.name}}
    {:ok, occupied} = :gen_tcp.listen(0, [:binary, active: false, ip: {127, 0, 0, 1}])
    {:ok, carrier_port} = :inet.port(occupied)
    entry = put_in(alpha.entry, ["listener", "port"], carrier_port)
    manifest = write_manifest(tmp_dir, %{"version" => 1, "instances" => [entry]})

    :ok = safe_stop()
    Application.put_env(:lattice_carrier_server, :manifest, manifest)

    assert {:error, _reason} = Application.ensure_all_started(:lattice_carrier_server)
    assert :persistent_term.get(alpha_key, :missing) == :missing
    assert Runtime.deployment() == nil
    :gen_tcp.close(occupied)
  end

  @tag :tmp_dir
  test "preparing a replacement manifest erases removed secret-bearing instances", %{
    tmp_dir: tmp_dir
  } do
    alpha = instance_fixture(tmp_dir, "stale-alpha")
    beta = instance_fixture(tmp_dir, "stale-beta")
    alpha_manifest = write_manifest(tmp_dir, %{"version" => 1, "instances" => [alpha.entry]})
    beta_manifest = write_manifest(tmp_dir, %{"version" => 1, "instances" => [beta.entry]})
    alpha_key = {Runtime, {:instance, alpha.name}}

    assert {:ok, _children} = Runtime.prepare(alpha_manifest)
    refute :persistent_term.get(alpha_key, :missing) == :missing

    assert {:ok, _children} = Runtime.prepare(beta_manifest)
    assert :persistent_term.get(alpha_key, :missing) == :missing
  end

  @tag :tmp_dir
  test "stopping the application erases prepared secret-bearing instances", %{tmp_dir: tmp_dir} do
    alpha = instance_fixture(tmp_dir, "shutdown-alpha")
    manifest = write_manifest(tmp_dir, %{"version" => 1, "instances" => [alpha.entry]})
    alpha_key = {Runtime, {:instance, alpha.name}}

    boot!(manifest)
    refute :persistent_term.get(alpha_key, :missing) == :missing

    :ok = Application.stop(:lattice_carrier_server)
    assert :persistent_term.get(alpha_key, :missing) == :missing
    assert Runtime.deployment() == nil
  end

  @tag :tmp_dir
  test "a structurally invalid tagged log refuses startup", %{tmp_dir: tmp_dir} do
    alpha = instance_fixture(tmp_dir, "invalid-structure")
    invalid = %Log{replica: nil, ops: %{}, referenced: :not_a_set, quarantine: []}
    bytes = :erlang.term_to_binary({:lattice_log_dump_v1, invalid}, [:deterministic])
    File.write!(alpha.log_path, bytes)
    manifest = write_manifest(tmp_dir, %{"version" => 1, "instances" => [alpha.entry]})

    assert {:error, {:source_restore_failed, {:instance, 1}}} =
             Runtime.prepare(manifest)
  end

  defp instance_fixture(tmp_dir, name) do
    replica = "replica:carrier-isolation:#{name}"
    author = Identity.from_seed("author", "carrier-isolation-author-#{name}")
    relay_identity = Identity.from_seed("resident", "carrier-isolation-relay-#{name}")
    observer = Identity.from_seed("instrument", "carrier-isolation-observer-#{name}")
    base = Op.new(author, replica, [], :command, {:post, "base #{name}"})

    dir = Path.join(tmp_dir, name)
    File.mkdir_p!(dir)
    log_path = Path.join(dir, "matter.log")
    assert :ok = replica |> Log.new() |> Log.append!(base) |> Log.dump(log_path)

    seed = :crypto.hash(:sha256, "carrier-isolation-server-#{name}-#{Path.basename(tmp_dir)}")
    seed_hex = Base.encode16(seed, case: :lower)
    {pub, priv} = :crypto.generate_key(:eddsa, :ed25519, seed)
    server_identity = %Identity{realm_id: "town-node-#{name}", pub: pub, priv: priv}

    identity_path = Path.join(dir, "identity")
    File.write!(identity_path, seed_hex)
    File.chmod!(identity_path, 0o600)

    entry = %{
      "name" => "pilot-#{name}",
      "realm" => server_identity.realm_id,
      "identity_file" => identity_path,
      "log_file" => log_path,
      "listener" => %{"ip" => "127.0.0.1", "port" => 0},
      "trusted_peers" => [
        %{"realm" => observer.realm_id, "pubkey" => Base.encode64(observer.pub)},
        %{"realm" => relay_identity.realm_id, "pubkey" => Base.encode64(relay_identity.pub)}
      ],
      "relay_realms" => [relay_identity.realm_id]
    }

    %{
      name: "pilot-#{name}",
      replica: replica,
      base: base,
      relay_identity: relay_identity,
      observer: observer,
      server_identity: server_identity,
      seed_hex: seed_hex,
      identity_path: identity_path,
      log_path: log_path,
      entry: entry
    }
  end

  defp write_manifest(tmp_dir, manifest) do
    path = Path.join(tmp_dir, "manifest-#{System.unique_integer([:positive])}.json")
    File.write!(path, Jason.encode!(manifest))
    path
  end

  defp connect(fixture) do
    WebSocket.connect(
      hostname: "127.0.0.1",
      port: LatticeCarrierServer.port(fixture.name),
      identity: fixture.relay_identity,
      realm: fixture.relay_identity.realm_id,
      peer_realm: fixture.server_identity.realm_id,
      peer_pubkey: fixture.server_identity.pub,
      replica: fixture.replica
    )
  end

  defp boot!(manifest_path) do
    :ok = safe_stop()
    Application.put_env(:lattice_carrier_server, :manifest, manifest_path)
    {:ok, _apps} = Application.ensure_all_started(:lattice_carrier_server)
  end

  defp safe_stop do
    case Application.stop(:lattice_carrier_server) do
      :ok -> :ok
      {:error, {:not_started, :lattice_carrier_server}} -> :ok
    end
  end

  defp restore_manifest_config(:missing) do
    Application.delete_env(:lattice_carrier_server, :manifest)
  end

  defp restore_manifest_config(value) do
    Application.put_env(:lattice_carrier_server, :manifest, value)
  end

  defp runtime_child_pid(id) do
    LatticeCarrierServer.RuntimeSupervisor
    |> Supervisor.which_children()
    |> Enum.find_value(fn
      {^id, pid, _type, _modules} -> pid
      _child -> nil
    end)
  end

  defp wait_until(fun, attempts \\ 50)

  defp wait_until(fun, attempts) when attempts > 0 do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      wait_until(fun, attempts - 1)
    end
  end

  defp wait_until(_fun, 0), do: flunk("condition did not become true")
end
