defmodule TownshipWeb.InstrumentLiveTest do
  # The degraded-state test temporarily overrides the process-global source config.
  use TownshipWeb.ConnCase, async: false

  alias Lattice.{Log, Sim}
  alias Township.Matter
  alias TownshipWeb.CarrierProjection

  defmodule FailingSource do
    @behaviour TownshipWeb.InstrumentSource

    @impl true
    def load(_opts), do: {:error, {:bundle_unverified, ["audit.json mismatch"]}}
  end

  defmodule LiveCarrier do
    def connect(opts) do
      {:ok,
       %{
         control: Keyword.get(opts, :control),
         ops: Keyword.fetch!(opts, :ops)
       }}
    end

    def advertise(conn, _log) do
      case mode(conn) do
        {:advertise_error, reason} -> {:error, reason}
        {:ops, ops} -> {:ok, MapSet.new(ops, & &1.id), conn}
        _mode -> {:ok, MapSet.new(conn.ops, & &1.id), conn}
      end
    end

    def pull(conn, have) do
      ops =
        case mode(conn) do
          {:ops, ops} -> ops
          _mode -> conn.ops
        end

      {:ok, Enum.reject(ops, &MapSet.member?(have, &1.id)), conn}
    end

    def close(_conn), do: :ok

    defp mode(%{control: nil}), do: :ok
    defp mode(%{control: control}), do: Agent.get(control, & &1)
  end

  test "dead and connected renders expose the verified five-panel instrument", %{conn: conn} do
    dead_html = conn |> get("/township") |> html_response(200)

    assert dead_html =~ "Zoning variance #24"
    assert dead_html =~ "Leaning approve (clerk edit)"

    {:ok, view, _connected_html} = live(build_conn(), "/township")
    rendered = render(view)

    for panel <- ~w(threads roles members attest trust-graph op-dag) do
      assert has_element?(view, "##{panel}-panel")
    end

    assert has_element?(view, "#source-status[data-verified='true']")
    assert rendered =~ "township-audit-bundle-v1"

    assert rendered =~
             "df911bb13013abefab7af103992fd1413eb754989ecf74f26cedb9e8ef6d17d3"

    assert has_element?(view, "#threads-panel [data-post]", "resident: posted while offline")
    assert has_element?(view, "#roles-panel [data-reason='not_holder']")

    assert has_element?(
             view,
             "#roles-panel [data-holder='clerk'][data-fingerprint='xI19LiI0w767']"
           )

    assert has_element?(view, "#members-panel [data-member='clerk']")
    assert has_element?(view, "#members-panel [data-member='resident']")
    assert has_element?(view, "#members-panel [data-empty='denied-members']")
    assert has_element?(view, "#attest-panel [data-attestation-status='stubbed']", "W4 · stubbed")
    assert has_element?(view, "#attest-panel [data-receipt-free='false']")
    assert has_element?(view, "#trust-graph-panel [data-trust-node]")
    assert has_element?(view, "#trust-graph-panel [data-trust-edge]")
    assert has_element?(view, "#op-dag-panel [data-op-node]")
    assert has_element?(view, "#op-dag-panel [data-frontier]")
    assert has_element?(view, "#op-dag-panel .op-rail")

    assert has_element?(
             view,
             "#causal-replay-island[phx-hook='TownshipCausalReplay'][phx-update='ignore']"
           )

    replay =
      rendered
      |> LazyHTML.from_fragment()
      |> LazyHTML.query_by_id("causal-replay-island")
      |> LazyHTML.attribute("data-replay")
      |> List.first()
      |> Jason.decode!()

    assert replay["schema"] == "township-causal-replay-v1"
    assert length(replay["frames"]) == 13

    assert has_element?(
             view,
             "#op-dag-panel [data-op-count='13'][data-honored-count='12'][data-quarantined-count='1']"
           )

    root_html = build_conn() |> get("/") |> html_response(200)
    assert root_html =~ "Zoning variance #24"
  end

  test "browser responses carry a strict content security policy", %{conn: conn} do
    conn = get(conn, "/township")

    assert [policy] = Plug.Conn.get_resp_header(conn, "content-security-policy")
    assert policy =~ "default-src 'self'"
    assert policy =~ "connect-src 'self'"
    refute policy =~ "unsafe-eval"
    refute policy =~ "unsafe-inline"
  end

  test "connected instrument withholds the bundle until a carrier snapshot arrives", %{conn: conn} do
    peer_log = peer_log()

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log)],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:live:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)

    {:ok, view, _html} = live(conn, "/township")

    assert has_element?(view, "#instrument-connecting", "Carrier connecting")
    refute render(view) =~ "Zoning variance #24"
    refute has_element?(view, "#threads-panel")
    refute has_element?(view, "#causal-replay-island")

    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    rendered = render(view)

    assert has_element?(
             view,
             "#source-status[data-source='carrier'][data-freshness='fresh'][data-verification='arrival'][data-refresh-trigger='manual']"
           )

    pushed_payload = %{
      payload
      | provenance:
          payload.provenance
          |> Map.put(:refresh_trigger, :server_push)
          |> Map.put(:feed_generation, 4)
    }

    send(view.pid, {:township_instrument, {:fresh, pushed_payload}})

    assert has_element?(
             view,
             "#source-status[data-refresh-trigger='server_push'][data-feed-generation='4']"
           )

    assert rendered =~ payload.read_model.threads.title
    assert rendered =~ "Projection matter"
    assert rendered =~ "clerk: live update"
    assert has_element?(view, "#causal-replay-island")
    refute rendered =~ "township-audit-bundle-v1"
    refute rendered =~ "df911bb13013abef"
  end

  test "fresh carrier state prepares one unsigned participant post without changing the model", %{
    conn: conn
  } do
    peer_log = peer_log()

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log)],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:post-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-post-form")
    assert {:ok, {:fresh, _payload}} = CarrierProjection.refresh(projection)
    assert has_element?(view, "#participant-post-form")

    op_count = peer_log |> Log.op_ids() |> MapSet.size()
    assert has_element?(view, "#op-dag-panel [data-op-count='#{op_count}']")

    post_text = "resident: prepared in the instrument"

    view
    |> form("#participant-post-form", %{"post" => %{"text" => "  #{post_text}  "}})
    |> render_submit()

    assert has_element?(view, "#participant-post-handoff[href^='township://action?intent=']")

    assert has_element?(
             view,
             "#participant-post-prepared[aria-live='polite']",
             "Unsigned and unconfirmed"
           )

    payload = view |> action_intent_href() |> decoded_action_intent()
    assert payload["v"] == 1
    assert payload["id"] =~ ~r/\A[0-9a-f]{32}\z/
    assert payload["replica"] == peer_log.replica
    assert payload["command"] == %{"command" => "post", "text" => post_text}
    assert Map.keys(payload) |> Enum.sort() == ["command", "id", "replica", "v"]

    assert has_element?(view, "#op-dag-panel [data-op-count='#{op_count}']")
    refute has_element?(view, "#threads-panel [data-post]", post_text)
  end

  test "participant post preparation rejects invalid text and disappears when the carrier is stale",
       %{
         conn: conn
       } do
    peer_log = peer_log()
    control = start_supervised!({Agent, fn -> :ok end})

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log), control: control],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:post-intent-state:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")
    assert {:ok, {:fresh, _payload}} = CarrierProjection.refresh(projection)

    view
    |> form("#participant-post-form", %{"post" => %{"text" => " "}})
    |> render_submit()

    assert has_element?(
             view,
             "#participant-post-error[aria-live='polite']",
             "Write an update before opening the app"
           )

    refute has_element?(view, "#participant-post-handoff")

    render_hook(view, "prepare_post", %{"post" => %{"text" => %{"smuggled" => true}}})

    assert has_element?(
             view,
             "#participant-post-error[aria-live='polite']",
             "Write an update before opening the app"
           )

    Agent.update(control, fn _mode -> {:advertise_error, :offline} end)
    assert {:ok, {:stale, _payload}} = CarrierProjection.refresh(projection)
    refute has_element?(view, "#participant-post-form")
    refute has_element?(view, "#participant-post-handoff")
  end

  test "fresh carrier state derives close and reopen intents and clears them when stale", %{
    conn: conn
  } do
    {open_log, closed_log} = peer_status_logs()
    control = start_supervised!({Agent, fn -> {:ops, Log.topo_ops(open_log)} end})

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(open_log), control: control],
         replica: open_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:status-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-status-action")
    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)

    assert has_element?(view, "#participant-status-action", "Prepare close in app")

    render_hook(view, "prepare_status_action", %{"command" => "reopen_matter"})

    assert has_element?(view, "#participant-status-handoff[href^='township://action?intent=']")
    assert has_element?(view, "#participant-status-prepared", "Unsigned close request")

    close_payload = view |> status_action_intent_href() |> decoded_action_intent()
    assert close_payload["v"] == 2
    assert close_payload["replica"] == open_log.replica
    assert close_payload["command"] == %{"command" => "close_matter"}

    replacement_payload = put_in(payload.provenance.replica, open_log.replica <> ":replacement")
    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    refute has_element?(view, "#participant-status-handoff")
    assert has_element?(view, "#participant-status-action", "Prepare close in app")

    send(view.pid, {:township_instrument, {:fresh, payload}})
    render_hook(view, "prepare_status_action", %{})
    assert has_element?(view, "#participant-status-handoff")

    Agent.update(control, fn _ops -> {:ops, Log.topo_ops(closed_log)} end)
    assert {:ok, {:fresh, _payload}} = CarrierProjection.refresh(projection)

    refute has_element?(view, "#participant-status-handoff")
    assert has_element?(view, "#participant-status-action", "Prepare reopen in app")

    view
    |> element("#participant-status-prepare")
    |> render_click()

    reopen_payload = view |> status_action_intent_href() |> decoded_action_intent()
    assert reopen_payload["v"] == 2
    assert reopen_payload["replica"] == open_log.replica
    assert reopen_payload["command"] == %{"command" => "reopen_matter"}

    Agent.update(control, fn _ops -> {:advertise_error, :offline} end)
    assert {:ok, {:stale, _payload}} = CarrierProjection.refresh(projection)
    refute has_element?(view, "#participant-status-action")
    refute has_element?(view, "#participant-status-handoff")
  end

  test "configured but absent projection renders carrier unavailable without bundle fallback", %{
    conn: conn
  } do
    put_projection_config(:missing_township_projection)

    {:ok, view, _html} = live(conn, "/township")
    rendered = render(view)

    assert has_element?(view, "#instrument-unavailable", "Instrument unavailable")
    assert rendered =~ "configured carrier peer is unavailable"
    refute has_element?(view, "#threads-panel")
    refute has_element?(view, "#causal-replay-island")
    refute rendered =~ "Zoning variance #24"
    refute rendered =~ "township-audit-bundle-v1"
    refute rendered =~ "df911bb13013abef"
  end

  test "carrier failure after a fresh pull keeps the instrument visibly stale", %{conn: conn} do
    peer_log = peer_log()
    control = start_supervised!({Agent, fn -> :ok end})

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log), control: control],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:live:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    assert {:ok, {:fresh, fresh}} = CarrierProjection.refresh(projection)
    assert render(view) =~ "Projection matter"

    Agent.update(control, fn _mode -> {:advertise_error, :offline} end)
    assert {:ok, {:stale, stale}} = CarrierProjection.refresh(projection)
    rendered = render(view)

    assert stale.provenance.pulled_at == fresh.provenance.pulled_at

    assert has_element?(
             view,
             "#source-status[data-source='carrier'][data-freshness='stale'][data-verification='arrival']"
           )

    assert rendered =~ "carrier stale"
    assert rendered =~ "Last pull error"
    assert rendered =~ ":offline"
    assert rendered =~ "Projection matter"
    assert rendered =~ "clerk: live update"
    assert has_element?(view, "#causal-replay-island")
  end

  test "an unverified source renders only an explicit unavailable state", %{conn: conn} do
    previous = Application.fetch_env!(:township_web, :instrument_source)
    Application.put_env(:township_web, :instrument_source, FailingSource)
    on_exit(fn -> Application.put_env(:township_web, :instrument_source, previous) end)

    {:ok, view, _html} = live(conn, "/township")
    degraded = render(view)

    assert has_element?(view, "#instrument-unavailable", "Instrument unavailable")
    assert degraded =~ "audit.json mismatch"

    for panel <- ~w(threads roles members attest trust-graph op-dag) do
      refute has_element?(view, "##{panel}-panel")
    end

    refute has_element?(view, "#causal-replay-island")
    refute degraded =~ "township-causal-replay-v1"

    refute degraded =~ "Zoning variance #24"
    refute degraded =~ "xI19LiI0w767"
    refute degraded =~ "not_holder"
    refute degraded =~ "approve"
    refute degraded =~ "township-audit-bundle-v1"
    refute degraded =~ "df911bb13013abefab"
  end

  defp peer_log do
    sim = Sim.new(Matter, "replica:matter:live-projection", ["clerk"], seed: "live-projection")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _title} = Sim.command(sim, "clerk", :set_title, ["Projection matter"])
    {sim, _post} = Sim.command(sim, "clerk", :post, ["clerk: live update"])
    Sim.log(sim, "clerk")
  end

  defp peer_status_logs do
    sim = Sim.new(Matter, "replica:matter:status-action", ["clerk"], seed: "status-action")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    open_log = Sim.log(sim, "clerk")
    {sim, _close} = Sim.command(sim, "clerk", :close_matter, [])
    {open_log, Sim.log(sim, "clerk")}
  end

  defp put_projection_config(projection) do
    previous = Application.get_env(:township_web, :instrument_projection_server, :missing)
    Application.put_env(:township_web, :instrument_projection_server, projection)

    on_exit(fn ->
      case previous do
        :missing -> Application.delete_env(:township_web, :instrument_projection_server)
        value -> Application.put_env(:township_web, :instrument_projection_server, value)
      end
    end)
  end

  defp action_intent_href(view) do
    view
    |> render()
    |> LazyHTML.from_fragment()
    |> LazyHTML.query_by_id("participant-post-handoff")
    |> LazyHTML.attribute("href")
    |> List.first()
  end

  defp status_action_intent_href(view) do
    view
    |> render()
    |> LazyHTML.from_fragment()
    |> LazyHTML.query_by_id("participant-status-handoff")
    |> LazyHTML.attribute("href")
    |> List.first()
  end

  defp decoded_action_intent(url) do
    %URI{scheme: "township", host: "action", query: query} = URI.parse(url)
    %{"intent" => encoded} = URI.decode_query(query)
    {:ok, json} = Base.url_decode64(encoded, padding: false)
    Jason.decode!(json)
  end
end
