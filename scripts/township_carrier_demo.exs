# Township G1 real-carrier demo.
#
#   mix run scripts/township_carrier_demo.exs
#
# Runs Township W0-W3 across two BEAM OS processes through the real WebSocket
# carrier. W4 remains the attestation stub; this script does not implement M4
# receipt-free crypto, AtomVM/WASM, or production compaction.

unless Code.ensure_loaded?(LatticeNodeSpike.TownshipScenario) do
  root = Path.expand("..", __DIR__)
  Path.wildcard(Path.join(root, "_build/*/lib/*/ebin")) |> Enum.each(&Code.append_path/1)
end

{:ok, _} = Application.ensure_all_started(:crypto)
{:ok, _} = Application.ensure_all_started(:jason)
{:ok, _} = Application.ensure_all_started(:cowboy)

defmodule TownshipCarrierDemo do
  alias Lattice.{Carrier, Log, Sim}
  alias Lattice.Carrier.Backoff
  alias LatticeNodeSpike.{TownshipScenario, WsCarrier}

  @script Path.expand("../apps/lattice_node_spike/priv/peer_node.exs", __DIR__)
  @scenario_arg TownshipScenario |> Module.split() |> Enum.join(".")

  def h(title), do: IO.puts("\n\e[1m\e[36m== #{title} ==\e[0m")
  def say(msg), do: IO.puts("  #{msg}")

  def spawn_peer(realm) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [
          @script,
          realm,
          "resident",
          Base.encode64(identity("resident").pub),
          @scenario_arg
        ]

    port =
      Port.open({:spawn_executable, elixir_bin()}, [
        :binary,
        :exit_status,
        :stderr_to_stdout,
        {:line, 4096},
        {:args, args},
        {:cd, repo_root()}
      ])

    {port, port |> Port.info(:os_pid) |> elem(1), await_ready(port, [])}
  end

  def connect(ws_port) do
    WsCarrier.connect(
      port: ws_port,
      identity: identity("resident"),
      realm: "resident",
      peer_realm: "clerk",
      peer_pubkey: identity("clerk").pub,
      replica: TownshipScenario.replica()
    )
  end

  def reconnect_when_diverged(ws_port) do
    backoff = Backoff.new(base_ms: 100, max_ms: 100, seed: "township-carrier")
    {:ok, conn} = connect(ws_port)
    await_divergence(conn, 50, backoff, Backoff.reset_attempt())
  end

  def authority_quarantine(log) do
    log
    |> then(&Lattice.Authority.analyze(TownshipScenario.replica_module(), &1))
    |> Map.fetch!(:reasons)
    |> Enum.map(fn {op_id, reason} -> [op_id, Atom.to_string(reason)] end)
    |> Enum.sort()
  end

  def check!(label, true), do: say("OK: #{label}")
  def check!(label, false), do: raise("Township carrier demo check failed: #{label}")

  def run(ws_port) do
    h("W0. Shared civic prefix over two BEAM OS processes")
    sim_resident = TownshipScenario.base_sim()
    log_resident = Sim.log(sim_resident, "resident")

    {:ok, conn} = connect(ws_port)
    {:ok, "base"} = WsCarrier.status(conn)
    {:ok, peer_ids, conn} = WsCarrier.advertise(conn, log_resident)

    check!(
      "clerk and resident independently derive the same Township prefix",
      MapSet.equal?(peer_ids, Log.op_ids(log_resident))
    )

    {:ok, _log_resident, stats, conn} = Carrier.sync(WsCarrier, conn, log_resident)
    check!("initial carrier sync transfers no ops", stats.sent == 0 and stats.received == 0)

    h("W1. Partition, offline deliberation, heal")
    :ok = WsCarrier.close(conn)
    say("socket closed: clerk and resident now author offline Township ops")

    sim_resident = TownshipScenario.diverge(sim_resident, "resident")
    log_resident = Sim.log(sim_resident, "resident")

    {:ok, conn} = reconnect_when_diverged(ws_port)
    {:ok, log_resident, stats, conn} = Carrier.sync(WsCarrier, conn, log_resident)
    say("carrier sync healed the partition: sent=#{stats.sent}, received=#{stats.received}")

    h("W2. Authority soundness and identical semantic quarantine")
    local_quarantine = authority_quarantine(log_resident)
    {:ok, peer_report} = WsCarrier.state_report(conn)
    peer_quarantine = Enum.sort(peer_report["authority_quarantine"])

    check!(
      "both OS processes materialize byte-identical Township state",
      Base.decode64!(peer_report["state_b64"]) == TownshipScenario.state_bytes(log_resident)
    )

    check!(
      "both OS processes have identical op ids",
      peer_report["op_ids"] == Enum.sort(Log.op_ids(log_resident))
    )

    check!("semantic quarantine reasons match", peer_quarantine == local_quarantine)

    check!(
      "unauthorized admission is quarantined",
      Enum.any?(local_quarantine, &match?([_id, "no_capability"], &1))
    )

    check!(
      "post-transfer clerk op is quarantined",
      Enum.any?(local_quarantine, &match?([_id, "not_holder"], &1))
    )

    h("W3. Sim oracle and durable dump/restore")
    oracle = TownshipScenario.oracle_sim()

    for realm <- ["clerk", "resident"] do
      oracle_log = Sim.log(oracle, realm)

      check!(
        "#{realm} oracle op set matches carrier log",
        MapSet.equal?(Log.op_ids(oracle_log), Log.op_ids(log_resident))
      )

      check!(
        "#{realm} oracle state bytes match carrier log",
        TownshipScenario.state_bytes(oracle_log) == TownshipScenario.state_bytes(log_resident)
      )

      check!(
        "#{realm} oracle quarantine matches carrier log",
        authority_quarantine(oracle_log) == local_quarantine
      )
    end

    path = Path.join(System.tmp_dir!(), "township_carrier_demo.log")
    :ok = Log.dump(log_resident, path)
    {:ok, restored} = Log.restore(path)
    File.rm(path)

    check!("dump/restore preserves op ids", Log.op_ids(restored) == Log.op_ids(log_resident))

    check!(
      "dump/restore preserves materialized state",
      TownshipScenario.state_bytes(restored) == TownshipScenario.state_bytes(log_resident)
    )

    check!(
      "dump/restore preserves semantic quarantine",
      authority_quarantine(restored) == local_quarantine
    )

    h("W4 boundary")
    say("W0-W3 ran over two BEAM OS processes through LatticeNodeSpike.WsCarrier.")
    say("W4 remains the existing Lattice.Attestation.Stub; receipt_free? is still false.")
    say("M4 receipt-free crypto is not implemented.")
    say("No native AtomVM/WASM browser realm is implemented in this slice.")

    {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
  end

  def await_exit(port) do
    receive do
      {^port, {:exit_status, 0}} -> :ok
      {^port, {:exit_status, status}} -> raise("peer OS process exited with #{status}")
    after
      10_000 -> raise("peer OS process did not exit after shutdown")
    end
  end

  defp await_ready(port, seen) do
    receive do
      {^port, {:data, {:eol, "PEER_READY " <> ws_port}}} ->
        String.to_integer(String.trim(ws_port))

      {^port, {:data, {:eol, line}}} ->
        await_ready(port, [line | seen])

      {^port, {:data, {:noeol, chunk}}} ->
        await_ready(port, [chunk | seen])

      {^port, {:exit_status, status}} ->
        raise("peer OS process exited (#{status}) before READY:\n#{format_output(seen)}")
    after
      60_000 ->
        raise("peer OS process never became ready:\n#{format_output(seen)}")
    end
  end

  defp await_divergence(conn, 0, _backoff, _attempt),
    do: raise("peer never diverged: #{inspect(conn)}")

  defp await_divergence(conn, attempts, backoff, attempt) do
    case WsCarrier.status(conn) do
      {:ok, "diverged"} ->
        {:ok, conn}

      {:ok, "base"} ->
        Process.sleep(Backoff.delay_ms(backoff, attempt))
        await_divergence(conn, attempts - 1, backoff, attempt + 1)
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
      true -> raise("no elixir executable available to spawn the peer OS process")
    end
  end

  defp repo_root, do: Path.expand("..", __DIR__)
  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")
  defp identity(realm), do: TownshipScenario.session_identity(realm)
end

IO.puts("\e[1mTownship G1 - real WebSocket carrier acceptance\e[0m")

{port, os_pid, ws_port} = TownshipCarrierDemo.spawn_peer("clerk")

try do
  TownshipCarrierDemo.run(ws_port)
  TownshipCarrierDemo.await_exit(port)
after
  _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
end

IO.puts("\n\e[1m\e[32mTownship carrier demo complete.\e[0m")
