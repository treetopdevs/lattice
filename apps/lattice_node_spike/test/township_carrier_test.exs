defmodule LatticeNodeSpike.TownshipCarrierTest do
  use ExUnit.Case, async: false

  alias Lattice.{Authority, Log, Sim}
  alias Lattice.Authority.Delegation
  alias Lattice.Carrier.WebSocket, as: WsCarrier
  alias LatticeNodeSpike.{CarrierScenarioRunner, Peer, TownshipScenario}
  alias Township.Matter

  @moduletag timeout: 120_000
  @script Path.expand("../priv/peer_node.exs", __DIR__)

  test "Township scenario oracle converges and quarantines the stale clerk action" do
    oracle = TownshipScenario.oracle_sim()
    logs = Enum.map(TownshipScenario.realms(), &Sim.log(oracle, &1))
    states = Enum.map(logs, &Lattice.state(Matter, &1))

    assert states |> Enum.uniq() |> length() == 1

    reasons = Enum.map(logs, &Authority.analyze(Matter, &1).reasons)
    assert reasons |> Enum.uniq() |> length() == 1

    stale_reopen_id = stale_reopen_id(hd(logs), oracle)

    assert stale_reopen_id
    assert Enum.all?(reasons, &(Map.get(&1, stale_reopen_id) == :not_holder))
  end

  test "peer can serve Township scenario state and authority quarantine" do
    name = :"township_peer_#{System.unique_integer([:positive])}"

    peer =
      start_supervised!(
        {Peer,
         [
           realm: "clerk",
           identity: TownshipScenario.session_identity("clerk"),
           scenario: TownshipScenario,
           name: name
         ]}
      )

    base_log = TownshipScenario.base_sim() |> Sim.log("clerk")

    assert Peer.state_report(peer).state_b64 ==
             Base.encode64(TownshipScenario.state_bytes(base_log))

    Peer.socket_closed(peer)
    assert_peer_phase(peer, :diverged)

    diverged = TownshipScenario.base_sim() |> TownshipScenario.diverge("clerk")
    diverged_log = Sim.log(diverged, "clerk")
    stale_reopen_id = stale_reopen_id(diverged_log, diverged)

    report = Peer.state_report(peer)

    assert report.state_b64 == Base.encode64(TownshipScenario.state_bytes(diverged_log))
    assert [stale_reopen_id, "not_holder"] in report.authority_quarantine
  end

  test "Township peer OS process serves the deterministic base prefix" do
    {port, ws_port} = spawn_peer("clerk")
    resident_log = TownshipScenario.base_sim() |> Sim.log("resident")

    {:ok, conn} = connect(ws_port)
    assert {:ok, "base"} = WsCarrier.status(conn)

    {:ok, peer_ids, conn} = WsCarrier.advertise(conn, resident_log)
    assert MapSet.equal?(peer_ids, Log.op_ids(resident_log))

    {:ok, peer_report} = WsCarrier.state_report(conn)
    clerk_log = TownshipScenario.base_sim() |> Sim.log("clerk")
    assert Base.decode64!(peer_report["state_b64"]) == TownshipScenario.state_bytes(clerk_log)

    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  test "Township peer can seed a post-only bootstrap grant for a runtime device key" do
    name = :"township_peer_#{System.unique_integer([:positive])}"
    device_pubkey = :crypto.hash(:sha256, "release-author-device")

    peer =
      start_supervised!(
        {Peer,
         [
           realm: "clerk",
           identity: TownshipScenario.session_identity("clerk"),
           scenario: TownshipScenario,
           bootstrap_audience_pubkey: device_pubkey,
           name: name
         ]}
      )

    base_ids =
      TownshipScenario.base_sim()
      |> Sim.log("resident")
      |> Log.op_ids()

    assert [
             %{
               kind: :authority,
               body:
                 {:grant,
                  %Delegation{audience: ^device_pubkey, ops: ops, roles: roles, live: false}}
             }
           ] = Peer.missing_for(peer, base_ids)

    assert MapSet.equal?(ops, MapSet.new([:post]))
    assert MapSet.equal?(roles, MapSet.new())
  end

  test "Township carrier session rejects the wrong peer key before sync" do
    {port, ws_port} = spawn_peer("clerk")
    wrong_pubkey = Lattice.Identity.from_seed("clerk", "wrong-township-g1").pub

    assert {:error, :bad_signature} = connect(ws_port, peer_pubkey: wrong_pubkey)

    {:ok, conn} = connect(ws_port)
    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  test "GATE: Township W0-W3 converge over a real WebSocket carrier" do
    report =
      CarrierScenarioRunner.run!(TownshipScenario,
        peer_realm: "clerk",
        local_realm: "resident"
      )

    assert %{sent: 2, received: 5} = Map.take(report.heal_sync, [:sent, :received])
    assert "resident: posted while offline" in report.peer_state["state"]["posts"]

    stale_reopen_id = stale_reopen_id(report.log, TownshipScenario.oracle_sim())
    assert [stale_reopen_id, "not_holder"] in report.authority_quarantine
  end

  defp stale_reopen_id(%Log{} = log, %Sim{} = sim) do
    clerk_pub = Sim.identity(sim, "clerk").pub

    log
    |> Log.topo_ops()
    |> Enum.find_value(fn op ->
      if op.author == clerk_pub and command_name(op.body) == :reopen_matter do
        op.id
      end
    end)
  end

  defp command_name(body) when is_tuple(body), do: elem(body, 0)
  defp command_name(_body), do: nil

  defp assert_peer_phase(peer, phase, attempts \\ 20)

  defp assert_peer_phase(peer, phase, attempts) when attempts > 0 do
    if Peer.status(peer) == phase do
      assert true
    else
      Process.sleep(10)
      assert_peer_phase(peer, phase, attempts - 1)
    end
  end

  defp assert_peer_phase(peer, phase, 0), do: assert(Peer.status(peer) == phase)

  defp spawn_peer(realm) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [
          @script,
          realm,
          "resident",
          Base.encode64(identity("resident").pub),
          "LatticeNodeSpike.TownshipScenario"
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

  defp connect(ws_port, opts \\ []) do
    defaults = [
      port: ws_port,
      identity: identity("resident"),
      realm: "resident",
      peer_realm: "clerk",
      peer_pubkey: identity("clerk").pub,
      replica: TownshipScenario.replica()
    ]

    WsCarrier.connect(Keyword.merge(defaults, opts))
  end

  defp identity(realm), do: TownshipScenario.session_identity(realm)
end
