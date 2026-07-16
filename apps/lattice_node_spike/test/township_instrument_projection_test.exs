defmodule LatticeNodeSpike.TownshipInstrumentProjectionTest do
  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Phoenix.LiveViewTest

  alias Lattice.Carrier.WebSocket, as: WsCarrier
  alias Lattice.{Identity, Log, Sim}
  alias LatticeNodeSpike.TownshipScenario
  alias TownshipWeb.CarrierProjection

  @endpoint TownshipWeb.Endpoint
  @moduletag timeout: 120_000
  @script Path.expand("../priv/peer_node.exs", __DIR__)

  test "real peer pulls update the connected instrument without projection writes" do
    {:ok, _apps} = Application.ensure_all_started(:township_web)
    observer = Identity.from_seed("instrument", "township-instrument-projection")
    {port, ws_port} = spawn_peer(observer)
    connect_opts = connect_opts(ws_port, observer)

    projection =
      start_supervised!(
        {CarrierProjection,
         connect_opts: connect_opts,
         replica: TownshipScenario.replica(),
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:real-peer:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_server(projection)
    {:ok, view, _html} = live(build_conn(), "/township")
    assert has_element?(view, "#instrument-connecting", "Carrier connecting")

    base_log = TownshipScenario.base_sim() |> Sim.log("clerk")
    assert {:ok, {:fresh, base_payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(base_payload) == base_log |> Log.op_ids() |> Enum.sort()

    assert has_element?(
             view,
             "#source-status[data-source='carrier'][data-freshness='fresh'][data-verification='arrival']"
           )

    {:ok, partition_conn} = WsCarrier.connect(connect_opts)
    :ok = WsCarrier.close(partition_conn)
    await_diverged(ws_port, observer)

    expected_sim = TownshipScenario.base_sim() |> TownshipScenario.diverge("clerk")
    expected_log = Sim.log(expected_sim, "clerk")
    stale_reopen_id = stale_reopen_id(expected_log, expected_sim)

    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert payload_ids(payload) == expected_log |> Log.op_ids() |> Enum.sort()
    assert payload.read_model.threads.summary == "Leaning approve (clerk edit)"
    assert "clerk: hearing Tuesday 6pm" in payload.read_model.threads.posts
    assert payload.read_model.roles.reasons[stale_reopen_id] == :not_holder

    rendered = render(view)
    assert rendered =~ "Leaning approve (clerk edit)"
    assert rendered =~ "clerk: hearing Tuesday 6pm"
    assert has_element?(view, "#roles-panel [data-reason='not_holder']")

    {:ok, inspection_conn} = WsCarrier.connect(connect_opts)
    assert {:ok, peer_report} = WsCarrier.state_report(inspection_conn)
    assert peer_report["op_ids"] == expected_log |> Log.op_ids() |> Enum.sort()
    assert [stale_reopen_id, "not_holder"] in peer_report["authority_quarantine"]

    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(inspection_conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  test "wrong peer key withholds carrier state from the connected instrument" do
    {:ok, _apps} = Application.ensure_all_started(:township_web)
    observer = Identity.from_seed("instrument", "township-instrument-projection-auth")
    {port, ws_port} = spawn_peer(observer)

    connect_opts =
      Keyword.put(
        connect_opts(ws_port, observer),
        :peer_pubkey,
        Identity.from_seed("clerk", "wrong-instrument-peer").pub
      )

    projection =
      start_supervised!(
        {CarrierProjection,
         connect_opts: connect_opts,
         replica: TownshipScenario.replica(),
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:wrong-peer:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_server(projection)
    {:ok, view, _html} = live(build_conn(), "/township")
    assert has_element?(view, "#instrument-connecting", "Carrier connecting")

    assert {:ok, {:unavailable, :bad_signature}} = CarrierProjection.refresh(projection)
    rendered = render(view)

    assert has_element?(view, "#instrument-unavailable", "Instrument unavailable")
    refute has_element?(view, "#threads-panel")
    refute has_element?(view, "#causal-replay-island")
    refute rendered =~ "Zoning variance #24"

    {:ok, shutdown_conn} = WsCarrier.connect(connect_opts(ws_port, observer))
    assert {:ok, %{"type" => "shutdown_result"}} = WsCarrier.shutdown(shutdown_conn)
    assert_receive {^port, {:exit_status, 0}}, 10_000
  end

  defp payload_ids(payload) do
    payload.causal_replay["nodes"] |> Enum.map(& &1["id"]) |> Enum.sort()
  end

  defp stale_reopen_id(log, sim) do
    clerk_pub = Sim.identity(sim, "clerk").pub

    Enum.find_value(Log.topo_ops(log), fn op ->
      if op.author == clerk_pub and command_name(op.body) == :reopen_matter, do: op.id
    end)
  end

  defp command_name(body) when is_tuple(body), do: elem(body, 0)
  defp command_name(_body), do: nil

  defp await_diverged(ws_port, observer, attempts \\ 30)

  defp await_diverged(ws_port, observer, attempts) when attempts > 0 do
    {:ok, conn} = WsCarrier.connect(connect_opts(ws_port, observer))
    result = WsCarrier.status(conn)
    :ok = WsCarrier.close(conn)

    case result do
      {:ok, "diverged"} ->
        :ok

      {:ok, "base"} ->
        Process.sleep(10)
        await_diverged(ws_port, observer, attempts - 1)
    end
  end

  defp await_diverged(_ws_port, _observer, 0), do: flunk("peer never diverged")

  defp connect_opts(ws_port, observer) do
    [
      port: ws_port,
      identity: observer,
      realm: "instrument",
      peer_realm: "clerk",
      peer_pubkey: TownshipScenario.session_identity("clerk").pub,
      replica: TownshipScenario.replica()
    ]
  end

  defp spawn_peer(observer) do
    args =
      Enum.flat_map(code_paths(), &["-pa", &1]) ++
        [
          @script,
          "clerk",
          "instrument",
          Base.encode64(observer.pub),
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
        flunk("peer exited (#{status}) before READY:\n#{format_output(seen)}")
    after
      60_000 -> flunk("peer never became ready:\n#{format_output(seen)}")
    end
  end

  defp put_projection_server(projection) do
    previous = Application.get_env(:township_web, :instrument_projection_server, :missing)
    Application.put_env(:township_web, :instrument_projection_server, projection)

    on_exit(fn ->
      case previous do
        :missing -> Application.delete_env(:township_web, :instrument_projection_server)
        value -> Application.put_env(:township_web, :instrument_projection_server, value)
      end
    end)
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
      true -> flunk("no elixir executable available to spawn the peer")
    end
  end

  defp repo_root, do: Path.expand("../../..", __DIR__)
  defp format_output(lines), do: lines |> Enum.reverse() |> Enum.join("\n")
end
