defmodule LatticeNodeSpike.CarrierTelemetryTest do
  use ExUnit.Case, async: false

  alias Lattice.{Carrier, Net, Sim}
  alias Lattice.Carrier.{Session, SimNet, Telemetry, Wire}
  alias LatticeNodeSpike.{Peer, Scenario, WsCarrier, WsHandler}

  @moduletag timeout: 120_000
  @script Path.expand("../priv/peer_node.exs", __DIR__)

  test "Carrier.sync emits transfer telemetry without sockets" do
    attach([:lattice, :carrier, :sync, :stop])

    base = Scenario.base_sim()
    diverged = Scenario.diverge(base, "node_b")
    log_b = Sim.log(diverged, "node_b")
    conn = SimNet.connect(Net.new(), "node_b", "node_a", Sim.log(base, "node_a"))

    assert {:ok, _log_b, stats, _conn} = Carrier.sync(SimNet, conn, log_b)
    assert %{sent: 3, received: 0} = Map.take(stats, [:sent, :received])

    assert_receive {:telemetry, [:lattice, :carrier, :sync, :stop], %{sent: 3, received: 0},
                    %{carrier: SimNet}}
  end

  test "WsCarrier.connect emits a successful connect event" do
    attach([:lattice, :carrier, :connect])

    {port, ws_port} = spawn_peer("node_a")

    {:ok, conn} = connect(ws_port)

    assert_receive {:telemetry, [:lattice, :carrier, :connect], %{},
                    %{realm: "node_b", peer_realm: "node_a"}}

    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  test "WsHandler emits auth failure telemetry" do
    attach([:lattice, :carrier, :auth_failure])

    challenge =
      "node_a"
      |> Session.challenge(Scenario.replica(), wire_version: Wire.version())
      |> Session.sign_challenge(identity("node_a"))

    state = %{
      authenticated?: false,
      trusted_peer_realm: "node_a",
      trusted_peer_pubkey: Lattice.Identity.from_seed("node_a", "wrong-carrier-spike").pub
    }

    assert {:reply, {:text, reply}, ^state} =
             WsHandler.websocket_handle({:text, Jason.encode!(challenge)}, state)

    assert %{"type" => "error", "reason" => "bad_signature"} = Jason.decode!(reply)

    assert_receive {:telemetry, [:lattice, :carrier, :auth_failure], %{},
                    %{reason: :bad_signature, expected_realm: "node_a", peer_realm: "node_a"}}
  end

  test "WsHandler emits pre-auth rejection telemetry" do
    attach([:lattice, :carrier, :pre_auth_reject])

    state = %{authenticated?: false}

    assert {:reply, {:text, reply}, ^state} =
             WsHandler.websocket_handle({:text, Jason.encode!(%{type: "frontier"})}, state)

    assert %{"type" => "error", "reason" => "unauthenticated"} = Jason.decode!(reply)

    assert_receive {:telemetry, [:lattice, :carrier, :pre_auth_reject], %{}, %{type: "frontier"}}
  end

  test "WsHandler emits disconnect telemetry for an authenticated socket" do
    attach([:lattice, :carrier, :disconnect])

    peer =
      start_supervised!(
        {Peer,
         [
           realm: "node_a",
           identity: identity("node_a"),
           name: :"telemetry_peer_#{System.unique_integer([:positive])}"
         ]}
      )

    assert :ok =
             WsHandler.terminate(:normal, nil, %{
               authenticated?: true,
               peer: peer,
               realm: "node_a"
             })

    assert_receive {:telemetry, [:lattice, :carrier, :disconnect], %{}, %{realm: "node_a"}}
  end

  defp attach(event) do
    test_pid = self()
    handler_id = {__MODULE__, event, make_ref()}

    :ok =
      Telemetry.attach(
        handler_id,
        event,
        &__MODULE__.handle_event/4,
        test_pid
      )

    on_exit(fn -> Telemetry.detach(handler_id) end)
  end

  def handle_event(event, measurements, metadata, test_pid) do
    send(test_pid, {:telemetry, event, measurements, metadata})
  end

  defp spawn_peer(realm) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [@script, realm, "node_b", Base.encode64(identity("node_b").pub)]

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
      identity: identity("node_b"),
      realm: "node_b",
      peer_realm: "node_a",
      peer_pubkey: identity("node_a").pub,
      replica: Scenario.replica()
    ]

    WsCarrier.connect(Keyword.merge(defaults, opts))
  end

  defp identity(realm), do: Lattice.Identity.from_seed(realm, "carrier-spike")
end
