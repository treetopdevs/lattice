defmodule LatticeNodeSpike.TownshipCarrierTest do
  @moduledoc """
  Township G1 acceptance: W0-W3 over two BEAM OS processes and the real WebSocket
  carrier, checked against the existing `Lattice.Sim` oracle.
  """

  use ExUnit.Case, async: false

  alias Lattice.{Carrier, Log, Sim}
  alias Lattice.Carrier.Backoff
  alias LatticeNodeSpike.{TownshipScenario, WsCarrier}

  @moduletag timeout: 120_000

  @script Path.expand("../priv/peer_node.exs", __DIR__)
  @scenario_arg TownshipScenario |> Module.split() |> Enum.join(".")

  test "G1: Township W0-W3 converge over a real WebSocket carrier" do
    {port, ws_port} = spawn_peer("clerk")

    sim_resident = TownshipScenario.base_sim()
    log_resident = Sim.log(sim_resident, "resident")

    {:ok, conn} = connect(ws_port)
    assert {:ok, "base"} = WsCarrier.status(conn)

    {:ok, peer_ids, conn} = WsCarrier.advertise(conn, log_resident)

    assert MapSet.equal?(peer_ids, Log.op_ids(log_resident)),
           "seeded Township prefix must match across OS processes before transfer"

    {:ok, _log_resident, stats, conn} = Carrier.sync(WsCarrier, conn, log_resident)
    assert %{sent: 0, received: 0} = Map.take(stats, [:sent, :received])

    :ok = WsCarrier.close(conn)
    sim_resident = TownshipScenario.diverge(sim_resident, "resident")
    log_resident = Sim.log(sim_resident, "resident")

    {:ok, conn} = reconnect_when_diverged(ws_port)
    {:ok, log_resident, stats, conn} = Carrier.sync(WsCarrier, conn, log_resident)

    assert %{sent: 3, received: 5} = Map.take(stats, [:sent, :received])
    assert stats.pushed.quarantined == []
    assert stats.pulled.quarantined == []

    local_bytes = TownshipScenario.state_bytes(log_resident)
    local_quarantine = authority_quarantine(log_resident)

    {:ok, peer_report} = WsCarrier.state_report(conn)
    assert Base.decode64!(peer_report["state_b64"]) == local_bytes
    assert peer_report["op_ids"] == Enum.sort(Log.op_ids(log_resident))
    assert peer_report["frontier"] == Log.frontier(log_resident)
    assert Enum.sort(peer_report["authority_quarantine"]) == local_quarantine

    assert Enum.any?(local_quarantine, &match?([_op_id, "no_capability"], &1))
    assert Enum.any?(local_quarantine, &match?([_op_id, "not_holder"], &1))

    oracle = TownshipScenario.oracle_sim()

    for realm <- ["clerk", "resident"] do
      oracle_log = Sim.log(oracle, realm)
      assert MapSet.equal?(Log.op_ids(oracle_log), Log.op_ids(log_resident))
      assert TownshipScenario.state_bytes(oracle_log) == local_bytes
      assert authority_quarantine(oracle_log) == local_quarantine
    end

    path =
      Path.join(System.tmp_dir!(), "township_carrier_#{System.unique_integer([:positive])}.log")

    :ok = Log.dump(log_resident, path)
    {:ok, restored} = Log.restore(path)
    File.rm(path)

    assert Log.op_ids(restored) == Log.op_ids(log_resident)
    assert TownshipScenario.state_bytes(restored) == local_bytes
    assert authority_quarantine(restored) == local_quarantine

    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  defp authority_quarantine(log) do
    log
    |> then(&Lattice.Authority.analyze(TownshipScenario.replica_module(), &1))
    |> Map.fetch!(:reasons)
    |> Enum.map(fn {op_id, reason} -> [op_id, Atom.to_string(reason)] end)
    |> Enum.sort()
  end

  defp spawn_peer(realm) do
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

    os_pid = port |> Port.info(:os_pid) |> elem(1)

    on_exit(fn ->
      _ = System.cmd("kill", ["-9", Integer.to_string(os_pid)], stderr_to_stdout: true)
    end)

    {port, await_ready(port, [])}
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
        flunk("peer OS process exited (#{status}) before READY:\n#{format_output(seen)}")
    after
      60_000 ->
        flunk("peer OS process never became ready:\n#{format_output(seen)}")
    end
  end

  defp reconnect_when_diverged(ws_port, attempts \\ 50) do
    backoff = Backoff.new(base_ms: 100, max_ms: 100, seed: "township-carrier")
    {:ok, conn} = connect(ws_port)

    case WsCarrier.status(conn) do
      {:ok, "diverged"} -> {:ok, conn}
      {:ok, "base"} -> await_divergence(conn, attempts, backoff, Backoff.reset_attempt())
      other -> flunk("unexpected peer status after reconnect: #{inspect(other)}")
    end
  end

  defp await_divergence(conn, 0, _backoff, _attempt),
    do: flunk("peer never diverged: #{inspect(conn)}")

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
      true -> flunk("no elixir executable available to spawn the peer OS process")
    end
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)

  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")

  defp connect(ws_port) do
    WsCarrier.connect(
      port: ws_port,
      identity: identity("resident"),
      realm: "resident",
      peer_realm: "clerk",
      peer_pubkey: identity("clerk").pub,
      replica: TownshipScenario.replica()
    )
  end

  defp identity(realm), do: TownshipScenario.session_identity(realm)
end
