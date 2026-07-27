defmodule LatticeCarrierServer.PilotRuntimeTest do
  @moduledoc """
  Wave A1 Pilot Carrier Runtime regressions (plans 158/159).

  These cover the production manifest-driven entrypoint: fail-closed secret-file
  identity loading, refusal to mint a fresh community, refusal of command-line
  seeds, and acknowledged-relay survival across a brutal kill and restart from
  the same paths.
  """

  use ExUnit.Case, async: false

  alias Lattice.Carrier.WebSocket
  alias Lattice.{Identity, Log, Sim}
  alias Township.Matter

  @moduletag timeout: 120_000

  # Referenced dynamically so this file stays RED-runnable before the
  # runtime exists instead of failing to compile.
  @manifest_mod LatticeCarrierServer.Manifest

  @pilot_script Path.expand("../priv/pilot_node.exs", __DIR__)

  @tag :tmp_dir
  test "an acknowledged relay op survives kill -9 and restart from the same paths", %{
    tmp_dir: tmp_dir
  } do
    %{
      manifest_path: manifest_path,
      server_identity: server_identity,
      server_seed_hex: server_seed_hex,
      relay_identity: relay_identity,
      observer: observer,
      replica: replica,
      relayed_op: relayed_op,
      expected_ids: expected_ids
    } = write_pilot_fixture(tmp_dir)

    server = spawn_pilot(manifest_path)
    assert %{"township-pilot" => %{port: port, pubkey: pubkey}} = server.instances
    assert pubkey == Base.encode64(server_identity.pub)

    assert {:ok, relay_connection} =
             WebSocket.connect(connect_opts(port, relay_identity, server_identity, replica))

    assert {:ok, %{accepted: [relayed_id]}, relay_connection} =
             WebSocket.relay(relay_connection, relayed_op)

    assert relayed_id == relayed_op.id
    assert :ok = WebSocket.close(relay_connection)

    kill_pilot(server)

    output_so_far = collected_output(server)
    refute output_so_far =~ server_seed_hex
    refute output_so_far =~ Base.encode64(server_identity.priv)

    restarted = spawn_pilot(manifest_path)
    assert %{"township-pilot" => %{port: restarted_port}} = restarted.instances

    assert {:ok, audit_connection} =
             WebSocket.connect(connect_opts(restarted_port, observer, server_identity, replica))

    assert {:ok, served_ops, audit_connection} = WebSocket.pull(audit_connection, MapSet.new())
    served_ids = served_ops |> Enum.map(& &1.id) |> Enum.sort()
    assert relayed_op.id in served_ids
    assert served_ids == expected_ids
    assert :ok = WebSocket.close(audit_connection)

    stop_pilot(restarted)

    restart_output = collected_output(restarted)
    refute restart_output =~ server_seed_hex
    refute restart_output =~ Base.encode64(server_identity.priv)
  end

  @tag :tmp_dir
  test "startup with a missing or corrupt identity file refuses instead of minting one", %{
    tmp_dir: tmp_dir
  } do
    %{
      manifest_path: manifest_path,
      identity_path: identity_path,
      log_path: log_path
    } = write_pilot_fixture(tmp_dir)

    log_bytes_before = File.read!(log_path)

    # Missing identity file.
    File.rm!(identity_path)
    {output, status} = run_pilot_expecting_refusal(manifest_path)
    assert status == 1
    assert output =~ "PILOT_REFUSED"
    refute File.exists?(identity_path), "refusal must not mint a fresh identity file"
    assert File.read!(log_path) == log_bytes_before, "refusal must not touch the log"

    # Corrupt identity file (not 32 bytes of hex).
    File.write!(identity_path, "not-a-seed")
    File.chmod!(identity_path, 0o600)
    {output, status} = run_pilot_expecting_refusal(manifest_path)
    assert status == 1
    assert output =~ "PILOT_REFUSED"
    assert File.read!(log_path) == log_bytes_before

    # Unit-level: the manifest loader itself fails closed on both cases.
    File.rm!(identity_path)
    assert {:error, _reason} = apply(@manifest_mod, :load, [manifest_path])
  end

  @tag :tmp_dir
  test "a missing log refuses startup rather than creating a new community", %{tmp_dir: tmp_dir} do
    %{manifest_path: manifest_path, log_path: log_path} = write_pilot_fixture(tmp_dir)

    File.rm!(log_path)
    {output, status} = run_pilot_expecting_refusal(manifest_path)
    assert status == 1
    assert output =~ "PILOT_REFUSED"
    refute File.exists?(log_path), "refusal must not create a fresh log"
  end

  @tag :tmp_dir
  test "a service seed passed via argv is rejected and never echoed", %{tmp_dir: tmp_dir} do
    %{manifest_path: manifest_path} = write_pilot_fixture(tmp_dir)

    smuggled_seed = "argv-smuggled-seed-0451"

    {output, status} =
      System.cmd(elixir_bin(), code_path_args() ++ [@pilot_script, manifest_path, smuggled_seed],
        cd: repo_root(),
        stderr_to_stdout: true
      )

    assert status == 64
    assert output =~ "command-line seeds are not supported"
    refute output =~ smuggled_seed, "the rejected argv value must not be echoed"
  end

  # --- fixture -------------------------------------------------------------

  defp write_pilot_fixture(tmp_dir) do
    replica_name = "replica:matter:pilot-runtime"
    sim = Sim.new(Matter, replica_name, ["clerk", "resident"], seed: "pilot-runtime")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    base_log = Sim.log(sim, "clerk")
    relay_identity = Sim.identity(sim, "resident")
    {sim, relayed_op} = Sim.command(sim, "resident", :post, ["resident: pilot relayed"])
    sim = Sim.sync_all(sim)
    expected_ids = sim |> Sim.log("clerk") |> Log.op_ids() |> Enum.sort()

    log_path = Path.join(tmp_dir, "matter.log")
    assert :ok = Log.dump(base_log, log_path)

    server_seed = :crypto.hash(:sha256, "pilot-runtime-server-#{Path.basename(tmp_dir)}")
    server_seed_hex = Base.encode16(server_seed, case: :lower)
    {server_pub, server_priv} = :crypto.generate_key(:eddsa, :ed25519, server_seed)
    server_identity = %Identity{realm_id: "town-node", pub: server_pub, priv: server_priv}

    identity_path = Path.join(tmp_dir, "town-node.identity")
    File.write!(identity_path, server_seed_hex <> "\n")
    File.chmod!(identity_path, 0o600)

    observer = Identity.from_seed("instrument", "pilot-runtime-observer")

    manifest = %{
      "version" => 1,
      "health" => %{"ip" => "127.0.0.1", "port" => 0},
      "instances" => [
        %{
          "name" => "township-pilot",
          "realm" => "town-node",
          "identity_file" => identity_path,
          "log_file" => log_path,
          "listener" => %{"ip" => "127.0.0.1", "port" => 0},
          "trusted_peers" => [
            %{"realm" => observer.realm_id, "pubkey" => Base.encode64(observer.pub)},
            %{"realm" => relay_identity.realm_id, "pubkey" => Base.encode64(relay_identity.pub)}
          ],
          "relay_realms" => [relay_identity.realm_id]
        }
      ]
    }

    manifest_path = Path.join(tmp_dir, "pilot-manifest.json")
    File.write!(manifest_path, Jason.encode!(manifest))

    %{
      manifest_path: manifest_path,
      identity_path: identity_path,
      log_path: log_path,
      server_identity: server_identity,
      server_seed_hex: server_seed_hex,
      relay_identity: relay_identity,
      observer: observer,
      replica: base_log.replica,
      relayed_op: relayed_op,
      expected_ids: expected_ids
    }
  end

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

  # --- pilot process helpers ------------------------------------------------

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

    {instances, lines} = await_pilot_ready(port, %{}, [])
    %{port: port, os_pid: os_pid, instances: instances, lines: lines}
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

      {^port, {:data, {:eol, "PILOT_READY " <> _health}}} = message ->
        {instances, [format_message(message) | seen]}

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

  defp collected_output(%{port: port, lines: lines}) do
    drain_output(port, lines) |> Enum.reverse() |> Enum.join("\n")
  end

  defp drain_output(port, lines) do
    receive do
      {^port, {:data, {:eol, line}}} -> drain_output(port, [line | lines])
      {^port, {:data, {:noeol, chunk}}} -> drain_output(port, [chunk | lines])
      {^port, {:exit_status, _status}} -> lines
    after
      200 -> lines
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

  defp format_message({_port, {:data, {:eol, line}}}), do: line

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
