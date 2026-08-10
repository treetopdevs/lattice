defmodule LatticeCarrierServer.ReleaseTest do
  @moduledoc """
  The `lattice_carrier_pilot` release must actually build the way production
  builds it: `MIX_ENV=prod mix release lattice_carrier_pilot` invoked from
  the umbrella root (plan 158/159). A release definition that only lives in
  a child app's `mix.exs` is invisible to `mix release` at the umbrella
  root — Mix umbrella releases must be declared in the root project's
  `releases:` keyword list. This regression actually shells out to `mix
  release` rather than asserting the release atom exists in a keyword list,
  so it fails for the same reason a real deploy would fail.
  """

  use ExUnit.Case, async: false

  @moduletag :packaged_release
  @moduletag timeout: 700_000

  setup_all do
    release_dir = Path.join([repo_root(), "_build", "prod", "rel", "lattice_carrier_pilot"])
    File.rm_rf!(release_dir)

    {output, status} =
      run_command_with_timeout(
        mix_bin(),
        ["release", "lattice_carrier_pilot", "--overwrite"],
        [cd: repo_root(), env: [{"MIX_ENV", "prod"}]],
        600_000,
        "mix release lattice_carrier_pilot"
      )

    assert status == 0,
           "mix release lattice_carrier_pilot failed; output tail:\n#{bounded_binary_tail(output)}"

    refute String.contains?(output, "Unknown release")

    release_bin = Path.join(release_dir, "bin/lattice_carrier_pilot")
    assert File.exists?(release_bin), "expected a built release executable at #{release_bin}"

    {:ok, release_bin: release_bin}
  end

  test "MIX_ENV=prod mix release lattice_carrier_pilot succeeds from the umbrella root", %{
    release_bin: release_bin
  } do
    {renamed_output, renamed_status} =
      System.cmd(release_bin, ["eval", ~s|IO.puts("SHOULD_NOT_BOOT")|],
        stderr_to_stdout: true,
        env: [
          {"RELEASE_NAME", "renamed_pilot"},
          {"SECRET_KEY_BASE", String.duplicate("s", 64)}
        ]
      )

    bounded_renamed_output = bounded_binary_tail(renamed_output)
    assert renamed_status != 0
    assert String.contains?(bounded_renamed_output, "LATTICE_CARRIER_MANIFEST is required")
    refute String.contains?(bounded_renamed_output, "SHOULD_NOT_BOOT")
  end

  if :os.type() == {:unix, :linux} do
    alias Lattice.Carrier.WebSocket
    alias Lattice.{Identity, Log, Sim}
    alias Township.Matter

    @tag :tmp_dir
    test "the packaged Linux pilot preserves an acknowledged relay across kill and restart", %{
      tmp_dir: tmp_dir,
      release_bin: release_bin
    } do
      {:ok, _inets} = Application.ensure_all_started(:inets)

      %{
        manifest_path: manifest_path,
        server_identity: server_identity,
        server_seed_hex: server_seed_hex,
        relay_identity: relay_identity,
        observer: observer,
        replica: replica,
        relayed_op: relayed_op,
        expected_ids: expected_ids,
        carrier_port: carrier_port,
        health_port: health_port,
        port_reservations: port_reservations
      } = write_release_fixture(tmp_dir)

      release =
        spawn_release(
          release_bin,
          manifest_path,
          tmp_dir,
          server_identity.priv,
          port_reservations
        )

      assert_ready(release, health_port)

      assert {:ok, relay_connection} =
               WebSocket.connect(
                 connect_opts(carrier_port, relay_identity, server_identity, replica)
               )

      assert {:ok, %{accepted: [relayed_id]}, relay_connection} =
               WebSocket.relay(relay_connection, relayed_op)

      assert relayed_id == relayed_op.id
      assert :ok = WebSocket.close(relay_connection)

      kill_release(release)

      release_output = collected_output(release)
      route_marker = ~s(carrier pilot instance route started name="packaged-township-pilot")

      route_started? = release |> safe_output(release_output) |> String.contains?(route_marker)
      assert route_started?, "packaged pilot never logged its route-start marker"

      assert_no_private_seed(release_output, server_seed_hex, server_identity.priv)

      restart_reservations = reserve_ports(carrier_port, health_port)

      restarted =
        spawn_release(
          release_bin,
          manifest_path,
          tmp_dir,
          server_identity.priv,
          restart_reservations.sockets
        )

      assert_ready(restarted, health_port)

      assert {:ok, audit_connection} =
               WebSocket.connect(connect_opts(carrier_port, observer, server_identity, replica))

      assert {:ok, served_ops, audit_connection} =
               WebSocket.pull(audit_connection, MapSet.new())

      assert served_ops |> Enum.map(& &1.id) |> Enum.sort() == expected_ids
      assert :ok = WebSocket.close(audit_connection)

      kill_release(restarted)

      restarted_output = collected_output(restarted)

      restarted_route_started? =
        restarted |> safe_output(restarted_output) |> String.contains?(route_marker)

      assert restarted_route_started?, "restarted pilot never logged its route-start marker"

      assert_no_private_seed(restarted_output, server_seed_hex, server_identity.priv)
    end

    defp write_release_fixture(tmp_dir) do
      replica_name = "replica:matter:packaged-pilot-runtime"
      sim = Sim.new(Matter, replica_name, ["clerk", "resident"], seed: "packaged-pilot-runtime")
      {sim, _genesis} = Sim.create_replica(sim, "clerk")
      {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:post])
      sim = Sim.sync_all(sim)
      base_log = Sim.log(sim, "clerk")
      relay_identity = Sim.identity(sim, "resident")
      {sim, relayed_op} = Sim.command(sim, "resident", :post, ["resident: packaged relay"])
      sim = Sim.sync_all(sim)
      expected_ids = sim |> Sim.log("clerk") |> Log.op_ids() |> Enum.sort()

      data_dir = Path.join(tmp_dir, "pilot-data")
      File.mkdir_p!(data_dir)
      File.chmod!(data_dir, 0o700)

      log_path = Path.join(data_dir, "matter.log")
      assert :ok = Log.dump(base_log, log_path)

      server_seed = :crypto.hash(:sha256, "packaged-pilot-server-#{Path.basename(tmp_dir)}")
      server_seed_hex = Base.encode16(server_seed, case: :lower)
      {server_pub, server_priv} = :crypto.generate_key(:eddsa, :ed25519, server_seed)

      server_identity = %Identity{
        realm_id: "packaged-town-node",
        pub: server_pub,
        priv: server_priv
      }

      identity_path = Path.join(data_dir, "town-node.identity")
      File.write!(identity_path, server_seed_hex <> "\n")
      File.chmod!(identity_path, 0o600)

      observer = Identity.from_seed("instrument", "packaged-pilot-observer")

      %{
        carrier_port: carrier_port,
        health_port: health_port,
        sockets: port_reservations
      } = reserve_ports()

      manifest = %{
        "version" => 1,
        "health" => %{"ip" => "127.0.0.1", "port" => health_port},
        "instances" => [
          %{
            "name" => "packaged-township-pilot",
            "realm" => server_identity.realm_id,
            "identity_file" => identity_path,
            "log_file" => log_path,
            "listener" => %{"ip" => "127.0.0.1", "port" => carrier_port},
            "trusted_peers" => [
              %{"realm" => observer.realm_id, "pubkey" => Base.encode64(observer.pub)},
              %{
                "realm" => relay_identity.realm_id,
                "pubkey" => Base.encode64(relay_identity.pub)
              }
            ],
            "relay_realms" => [relay_identity.realm_id]
          }
        ]
      }

      manifest_path = Path.join(data_dir, "pilot-manifest.json")
      File.write!(manifest_path, Jason.encode!(manifest))

      %{
        manifest_path: manifest_path,
        server_identity: server_identity,
        server_seed_hex: server_seed_hex,
        relay_identity: relay_identity,
        observer: observer,
        replica: base_log.replica,
        relayed_op: relayed_op,
        expected_ids: expected_ids,
        carrier_port: carrier_port,
        health_port: health_port,
        port_reservations: port_reservations
      }
    end

    defp spawn_release(
           release_bin,
           manifest_path,
           tmp_dir,
           private_seed,
           port_reservations
         ) do
      release_tmp = Path.join(tmp_dir, "release-tmp-#{System.unique_integer([:positive])}")
      File.mkdir_p!(release_tmp)

      env =
        [
          {"LATTICE_CARRIER_MANIFEST", manifest_path},
          {"RELEASE_DISTRIBUTION", "none"},
          {"RELEASE_TMP", release_tmp}
        ]
        |> Enum.map(fn {key, value} -> {String.to_charlist(key), String.to_charlist(value)} end)

      Enum.each(port_reservations, fn socket -> :ok = :gen_tcp.close(socket) end)

      port =
        Port.open({:spawn_executable, release_bin}, [
          :binary,
          :exit_status,
          :stderr_to_stdout,
          {:line, 4_096},
          {:args, ["start"]},
          {:cd, repo_root()},
          {:env, env}
        ])

      os_pid =
        case Port.info(port, :os_pid) do
          {:os_pid, pid} when is_integer(pid) -> pid
          nil -> flunk("packaged pilot exited before its OS pid could be observed")
          other -> flunk("packaged pilot returned an invalid OS pid: #{inspect(other)}")
        end

      release_output = %{port: port, redactions: private_seed_encodings(private_seed)}
      process_token = process_token!(os_pid, release_output)
      on_exit(fn -> terminate_release(os_pid, process_token) end)

      %{
        port: port,
        os_pid: os_pid,
        process_token: process_token,
        redactions: release_output.redactions
      }
    end

    defp assert_ready(release, health_port) do
      url = "http://127.0.0.1:#{health_port}/readyz"
      deadline = System.monotonic_time(:millisecond) + 60_000
      await_ready(release, url, deadline)
    end

    defp await_ready(%{port: port} = release, url, deadline) do
      receive do
        {^port, {:exit_status, status}} ->
          flunk(
            "packaged pilot exited (#{status}) before readiness:\n#{safe_collected_output(release)}"
          )
      after
        0 ->
          request = {String.to_charlist(url), []}

          case :httpc.request(:get, request, [connect_timeout: 500, timeout: 1_000],
                 body_format: :binary
               ) do
            {:ok, {{_http, 204, _reason}, _headers, ""}} ->
              :ok

            last_result ->
              if System.monotonic_time(:millisecond) < deadline do
                Process.sleep(50)
                await_ready(release, url, deadline)
              else
                flunk(
                  "packaged pilot never became ready; last response: #{inspect(last_result)}; " <>
                    "output:\n#{safe_collected_output(release)}"
                )
              end
          end
      end
    end

    defp kill_release(%{port: port, os_pid: os_pid, process_token: process_token} = release) do
      :ok = terminate_release(os_pid, process_token)

      receive do
        {^port, {:exit_status, _status}} ->
          :ok
      after
        10_000 ->
          flunk("packaged pilot did not exit after kill:\n#{safe_collected_output(release)}")
      end
    end

    defp terminate_release(os_pid, expected_token) do
      if process_token(os_pid) == {:ok, expected_token} do
        _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
      end

      :ok
    end

    defp collected_output(%{port: port}) do
      port |> drain_output([]) |> Enum.reverse() |> IO.iodata_to_binary()
    end

    defp safe_collected_output(release) do
      release
      |> collected_output()
      |> then(&safe_output(release, &1))
      |> bounded_binary_tail()
    end

    defp safe_output(%{redactions: redactions}, output) do
      Enum.reduce(redactions, output, fn encoding, redacted ->
        String.replace(redacted, encoding, "[REDACTED_PRIVATE_SEED]")
      end)
    end

    defp drain_output(port, fragments) do
      receive do
        {^port, {:data, {:eol, line}}} -> drain_output(port, ["\n", line | fragments])
        {^port, {:data, {:noeol, chunk}}} -> drain_output(port, [chunk | fragments])
      after
        100 -> fragments
      end
    end

    defp assert_no_private_seed(output, seed_hex, private_seed) do
      leaked_hex? = String.contains?(output, seed_hex)
      refute leaked_hex?, "release output exposed the private seed as lower-case hex"

      for encoding <- private_seed_encodings(private_seed) do
        leaked_encoding? = String.contains?(output, encoding)
        refute leaked_encoding?, "release output exposed a private-seed encoding"
      end
    end

    defp private_seed_encodings(private_seed) do
      [
        Base.encode16(private_seed, case: :lower),
        Base.encode16(private_seed),
        Base.encode64(private_seed),
        Base.encode64(private_seed, padding: false),
        Base.url_encode64(private_seed, padding: false),
        inspect(private_seed, limit: :infinity)
      ]
    end

    defp process_token!(os_pid, release) do
      case process_token(os_pid) do
        {:ok, token} ->
          token

        :error ->
          flunk(
            "packaged pilot process token was unavailable for pid #{os_pid}; output:\n" <>
              safe_collected_output(release)
          )
      end
    end

    defp process_token(os_pid), do: portable_process_token(os_pid)

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

    defp reserve_ports do
      carrier_socket = reserve_port!(0, "carrier")
      health_socket = reserve_port!(0, "health")

      {:ok, {_ip, carrier_port}} = :inet.sockname(carrier_socket)
      {:ok, {_ip, health_port}} = :inet.sockname(health_socket)
      refute carrier_port == health_port

      %{
        carrier_port: carrier_port,
        health_port: health_port,
        sockets: [carrier_socket, health_socket]
      }
    end

    defp reserve_ports(carrier_port, health_port) do
      carrier_socket = reserve_port!(carrier_port, "carrier restart")
      health_socket = reserve_port!(health_port, "health restart")

      %{sockets: [carrier_socket, health_socket]}
    end

    defp reserve_port!(port, label) do
      case :gen_tcp.listen(port, [
             :binary,
             active: false,
             ip: {127, 0, 0, 1},
             reuseaddr: true
           ]) do
        {:ok, socket} -> socket
        {:error, reason} -> flunk("could not reserve #{label} port #{port}: #{inspect(reason)}")
      end
    end
  else
    @tag skip: "the production pilot durability contract is Linux-only"
    test "the packaged Linux pilot preserves an acknowledged relay across kill and restart" do
      :ok
    end
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)

  defp run_command_with_timeout(executable, args, opts, timeout_ms, label) do
    env =
      opts
      |> Keyword.get(:env, [])
      |> Enum.map(fn {key, value} -> {String.to_charlist(key), String.to_charlist(value)} end)

    port =
      Port.open({:spawn_executable, executable}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:args, args},
        {:cd, Keyword.fetch!(opts, :cd)},
        {:env, env}
      ])

    os_pid =
      case Port.info(port, :os_pid) do
        {:os_pid, pid} when is_integer(pid) -> pid
        nil -> flunk("#{label} exited before its OS pid could be observed")
        other -> flunk("#{label} returned an invalid OS pid: #{inspect(other)}")
      end

    process_token = command_process_token!(port, os_pid, label)
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    await_command(port, os_pid, process_token, deadline, timeout_ms, [], label)
  end

  defp await_command(port, os_pid, process_token, deadline, timeout_ms, chunks, label) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {^port, {:data, data}} ->
        await_command(port, os_pid, process_token, deadline, timeout_ms, [data | chunks], label)

      {^port, {:exit_status, status}} ->
        {chunks |> Enum.reverse() |> IO.iodata_to_binary(), status}
    after
      remaining ->
        if portable_process_token(os_pid) == {:ok, process_token} do
          _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
        end

        flunk(
          "#{label} exceeded #{timeout_ms}ms; captured output tail:\n" <>
            bounded_output_tail(chunks)
        )
    end
  end

  defp bounded_output_tail(chunks) do
    # Command-build output carries no pilot seed material. It is bounded for
    # diagnostics; release-process output takes the redacted path above.
    chunks |> Enum.reverse() |> IO.iodata_to_binary() |> bounded_binary_tail()
  end

  defp bounded_binary_tail(binary) do
    valid = String.replace_invalid(binary)
    start = max(String.length(valid) - 4_096, 0)
    String.slice(valid, start, 4_096)
  end

  defp command_process_token!(port, os_pid, label) do
    case portable_process_token(os_pid) do
      {:ok, token} ->
        token

      :error ->
        flunk(
          "#{label} process token was unavailable for pid #{os_pid}; captured output tail:\n" <>
            (port |> drain_command_output([]) |> bounded_output_tail())
        )
    end
  end

  defp drain_command_output(port, chunks) do
    receive do
      {^port, {:data, data}} -> drain_command_output(port, [data | chunks])
      {^port, {:exit_status, _status}} -> chunks
    after
      100 -> chunks
    end
  end

  defp portable_process_token(os_pid) do
    case proc_start_token(os_pid) do
      {:ok, token} -> {:ok, {:proc_start, token}}
      :error -> ps_start_token(os_pid)
    end
  end

  defp proc_start_token(os_pid) do
    with {:ok, stat} <- File.read("/proc/#{os_pid}/stat"),
         [fields] <- Regex.run(~r/^\d+ \(.*\) (.*)$/s, stat, capture: :all_but_first),
         token when is_binary(token) <- fields |> String.split() |> Enum.at(19) do
      {:ok, token}
    else
      _unavailable -> :error
    end
  end

  defp ps_start_token(os_pid) do
    case System.cmd("ps", ["-o", "lstart=", "-p", Integer.to_string(os_pid)],
           stderr_to_stdout: true
         ) do
      {output, 0} ->
        case String.trim(output) do
          "" -> :error
          token -> {:ok, {:ps_start, token}}
        end

      {_output, _status} ->
        :error
    end
  end

  defp mix_bin do
    if System.get_env("CI") == "true" do
      System.find_executable("mix") || flunk("CI-provided mix executable is unavailable")
    else
      shim = Path.expand("~/.asdf/shims/mix")

      if File.exists?(shim) do
        shim
      else
        flunk("required asdf mix shim is unavailable at #{shim}")
      end
    end
  end
end
