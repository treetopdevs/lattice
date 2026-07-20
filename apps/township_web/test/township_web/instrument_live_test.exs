defmodule TownshipWeb.InstrumentLiveTest do
  # The degraded-state test temporarily overrides the process-global source config.
  use TownshipWeb.ConnCase, async: false

  alias Lattice.{Log, Sim}
  alias Township.Matter
  alias TownshipWeb.{ActionIntent, CarrierProjection}

  @grant_audience "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE="
  @revoke_delegation "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI"

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
    refute has_element?(view, "#participant-grant-form")
    refute has_element?(view, "#participant-grant-handoff")
    assert rendered =~ "township-audit-bundle-v1"

    assert rendered =~
             "f41566fd3ea93e6394c27e78fda04e7d55fe7a002f18a8cfe8d1cdc5754ce125"

    assert has_element?(view, "#threads-panel [data-post]", "resident: posted while offline")
    assert has_element?(view, "#roles-panel [data-reason='not_holder']")
    assert has_element?(view, "#roles-panel [data-audit-ledger]")

    assert has_element?(
             view,
             "#roles-panel [data-ledger-event='command_quarantine'][data-ledger-reason='not_holder']",
             "command_quarantine not_holder"
           )

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
    refute has_element?(view, "#participant-roster-form")

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

    first_frame = hd(replay["frames"])
    assert is_map(first_frame["holders"])
    assert is_list(first_frame["frontier"])

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
    assert has_element?(view, "#roles-panel [data-audit-ledger]", "No quarantine events.")
    assert has_element?(view, "#causal-replay-island")
    refute rendered =~ "township-audit-bundle-v1"
    refute rendered =~ "df911bb13013abef"
  end

  test "authority ledger includes structural quarantines omitted from authority audit", %{
    conn: conn
  } do
    {peer_log, revoke_id} = structural_quarantine_log()

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log)],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:structural-ledger:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    assert {:ok, {:fresh, _payload}} = CarrierProjection.refresh(projection)

    assert has_element?(
             view,
             "#roles-panel [data-ledger-event='structural_quarantine'][data-ledger-reason='unauthorized_revoke']",
             "structural_quarantine unauthorized_revoke #{String.slice(revoke_id, 0, 12)}"
           )

    refute has_element?(view, "#roles-panel [data-audit-ledger]", "No quarantine events.")
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
    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)

    view
    |> form("#participant-post-form", %{
      "post" => %{"text" => "draft survives malformed fallback"}
    })
    |> render_submit()

    render_hook(view, "prepare_post", %{"post" => %{}})

    assert has_element?(
             view,
             "#participant-post-error[aria-live='polite']",
             "A fresh carrier snapshot is required before opening the app"
           )

    assert has_element?(
             view,
             "#participant-post-form textarea",
             "draft survives malformed fallback"
           )

    refute has_element?(view, "#participant-post-handoff")

    view
    |> form("#participant-post-form", %{"post" => %{"text" => " "}})
    |> render_submit()

    assert has_element?(
             view,
             "#participant-post-error[aria-live='polite']",
             "Write an update before opening the app"
           )

    refute has_element?(view, "#participant-post-handoff")

    replacement_payload = put_in(payload.provenance.replica, peer_log.replica <> ":replacement")
    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    assert has_element?(
             view,
             "#participant-post-error[aria-live='polite']",
             "Write an update before opening the app"
           )

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

  test "fresh carrier state prepares one v4 remove-member request without retargeting or replacing other intents",
       %{conn: conn} do
    peer_log = peer_log()

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log)],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:remove-member-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-roster-form")
    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert has_element?(view, "#participant-roster-form")

    view
    |> form("#participant-summary-form", %{"summary" => %{"text" => "existing summary request"}})
    |> render_submit()

    view
    |> form("#participant-post-form", %{"post" => %{"text" => "existing post request"}})
    |> render_submit()

    render_hook(view, "prepare_status_action", %{})

    assert has_element?(view, "#participant-summary-handoff")
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")

    op_count = peer_log |> Log.op_ids() |> MapSet.size()

    render_hook(view, "prepare_remove_member", %{
      "roster" => %{
        "member" => "  resident:alice  ",
        "command" => "admit",
        "text" => "smuggled"
      }
    })

    assert has_element?(view, "#participant-roster-handoff[href^='township://action?intent=']")
    assert has_element?(view, "#participant-roster-prepared", "Unsigned member removal")

    roster_url = roster_action_intent_href(view)
    roster_payload = decoded_action_intent(roster_url)

    assert roster_payload["v"] == 4
    assert roster_payload["id"] =~ ~r/\A[0-9a-f]{32}\z/
    assert roster_payload["replica"] == peer_log.replica

    assert roster_payload["command"] == %{
             "command" => "remove_member",
             "member" => "resident:alice"
           }

    assert Map.keys(roster_payload) |> Enum.sort() == ["command", "id", "replica", "v"]
    assert Map.keys(roster_payload["command"]) |> Enum.sort() == ["command", "member"]

    assert {:ok, expected_url} =
             ActionIntent.roster_url(peer_log.replica, :remove_member, "resident:alice",
               intent_id: roster_payload["id"]
             )

    assert roster_url == expected_url
    assert has_element?(view, "#participant-summary-handoff")
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")
    assert has_element?(view, "#participant-post-form textarea", "existing post request")
    assert has_element?(view, "#op-dag-panel [data-op-count='#{op_count}']")
    refute has_element?(view, "#members-panel [data-member='resident:alice']")

    replacement_payload = put_in(payload.provenance.replica, peer_log.replica <> ":replacement")
    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    assert has_element?(view, "#participant-roster-form")
    refute has_element?(view, "#participant-roster-handoff")

    send(view.pid, {:township_instrument, {:fresh, payload}})

    view
    |> form("#participant-roster-form", %{"roster" => %{"member" => " "}})
    |> render_submit()

    assert has_element?(
             view,
             "#participant-roster-error[aria-live='polite']",
             "Enter a member before opening the app"
           )

    refute has_element?(view, "#participant-roster-handoff")

    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    refute has_element?(view, "#participant-roster-error")
    assert has_element?(view, "#participant-roster-form input[value='']")

    send(view.pid, {:township_instrument, {:stale, payload}})
    refute has_element?(view, "#participant-roster-form")
    refute has_element?(view, "#participant-roster-handoff")
  end

  test "fresh carrier state prepares one fixed v5 grant without replacing other intents or mutating state",
       %{conn: conn} do
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
         topic: "township:grant-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-grant-form")
    render_hook(view, "prepare_grant", %{"grant" => %{"audience" => @grant_audience}})
    refute has_element?(view, "#participant-grant-handoff")

    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert has_element?(view, "#participant-grant-form")

    view
    |> form("#participant-summary-form", %{"summary" => %{"text" => "existing summary request"}})
    |> render_submit()

    view
    |> form("#participant-post-form", %{"post" => %{"text" => "existing post request"}})
    |> render_submit()

    render_hook(view, "prepare_status_action", %{})

    view
    |> form("#participant-roster-form", %{"roster" => %{"member" => "resident:alice"}})
    |> render_submit()

    op_count = peer_log |> Log.op_ids() |> MapSet.size()

    render_hook(view, "prepare_grant", %{
      "grant" => %{
        "audience" => "  #{@grant_audience}  ",
        "ops" => ["close_matter"],
        "roles" => ["root"],
        "live" => true,
        "cap" => "smuggled"
      },
      "signature" => "smuggled"
    })

    assert has_element?(view, "#participant-grant-handoff[href^='township://action?intent=']")
    assert has_element?(view, "#participant-grant-prepared", "Unsigned resident grant")

    grant_url = grant_action_intent_href(view)
    grant_payload = decoded_action_intent(grant_url)

    assert grant_payload["v"] == 5
    assert grant_payload["id"] =~ ~r/\A[0-9a-f]{32}\z/
    assert grant_payload["replica"] == peer_log.replica

    assert grant_payload["authority"] == %{
             "action" => "grant",
             "audience" => @grant_audience,
             "ops" => ["admit", "post", "set_summary", "set_title"],
             "roles" => [],
             "live" => false
           }

    assert Map.keys(grant_payload) |> Enum.sort() == ["authority", "id", "replica", "v"]

    assert Map.keys(grant_payload["authority"]) |> Enum.sort() ==
             ["action", "audience", "live", "ops", "roles"]

    assert {:ok, expected_url} =
             ActionIntent.grant_url(peer_log.replica, @grant_audience,
               intent_id: grant_payload["id"]
             )

    assert grant_url == expected_url

    send(view.pid, {:township_instrument, {:fresh, payload}})
    assert grant_action_intent_href(view) == grant_url

    assert has_element?(view, "#participant-summary-handoff")
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")
    assert has_element?(view, "#participant-roster-handoff")
    assert has_element?(view, "#participant-post-form textarea", "existing post request")
    assert has_element?(view, "#op-dag-panel [data-op-count='#{op_count}']")
    refute has_element?(view, "#members-panel [data-member='resident:alice']")

    replacement_audience = Base.encode64(:binary.copy(<<66>>, 32))

    view
    |> form("#participant-grant-form", %{"grant" => %{"audience" => replacement_audience}})
    |> render_submit()

    replacement_url = grant_action_intent_href(view)
    refute replacement_url == grant_url
    assert decoded_action_intent(replacement_url)["authority"]["audience"] == replacement_audience
    assert has_element?(view, "#participant-summary-handoff")
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")
    assert has_element?(view, "#participant-roster-handoff")

    view
    |> form("#participant-grant-form", %{"grant" => %{"audience" => "not-base64!"}})
    |> render_submit()

    assert has_element?(
             view,
             "#participant-grant-error[aria-live='polite']",
             "Enter a canonical recipient public key before opening the app"
           )

    refute has_element?(view, "#participant-grant-handoff")
    assert has_element?(view, "#participant-summary-handoff")
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")
    assert has_element?(view, "#participant-roster-handoff")

    replacement_payload = put_in(payload.provenance.replica, peer_log.replica <> ":replacement")
    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    assert has_element?(view, "#participant-grant-form")
    refute has_element?(view, "#participant-grant-error")
    assert has_element?(view, "#participant-grant-form input[value='']")

    send(view.pid, {:township_instrument, {:fresh, payload}})

    view
    |> form("#participant-grant-form", %{"grant" => %{"audience" => @grant_audience}})
    |> render_submit()

    send(view.pid, {:township_instrument, {:unavailable, :offline}})
    refute has_element?(view, "#participant-grant-form")
    refute has_element?(view, "#participant-grant-handoff")

    send(view.pid, {:township_instrument, {:fresh, payload}})

    view
    |> form("#participant-grant-form", %{"grant" => %{"audience" => @grant_audience}})
    |> render_submit()

    Agent.update(control, fn _mode -> {:advertise_error, :offline} end)
    assert {:ok, {:stale, _payload}} = CarrierProjection.refresh(projection)
    refute has_element?(view, "#participant-grant-form")
    refute has_element?(view, "#participant-grant-handoff")
  end

  test "fresh carrier state prepares and clears one exact v6 revocation selector", %{conn: conn} do
    peer_log = peer_log()

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log)],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:revoke-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-revoke-form")
    render_hook(view, "prepare_revoke", %{"revoke" => %{"delegation" => @revoke_delegation}})
    refute has_element?(view, "#participant-revoke-handoff")

    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert has_element?(view, "#participant-revoke-form")
    op_count = peer_log |> Log.op_ids() |> MapSet.size()

    render_hook(view, "prepare_revoke", %{
      "revoke" => %{"delegation" => "  #{@revoke_delegation}\t", "issuer" => "smuggled"},
      "signature" => "smuggled"
    })

    revoke_url = revoke_action_intent_href(view)
    revoke_payload = decoded_action_intent(revoke_url)

    assert revoke_payload == %{
             "v" => 6,
             "id" => revoke_payload["id"],
             "replica" => peer_log.replica,
             "authority" => %{"action" => "revoke", "delegation" => @revoke_delegation}
           }

    assert revoke_payload["id"] =~ ~r/\A[0-9a-f]{32}\z/

    assert {:ok, expected_url} =
             ActionIntent.revoke_url(peer_log.replica, @revoke_delegation,
               intent_id: revoke_payload["id"]
             )

    assert revoke_url == expected_url
    assert has_element?(view, "#participant-revoke-prepared", "Unsigned revocation request")
    assert has_element?(view, "#op-dag-panel [data-op-count='#{op_count}']")

    replacement_delegation = Base.url_encode64(:binary.copy(<<67>>, 32), padding: false)

    view
    |> form("#participant-revoke-form", %{"revoke" => %{"delegation" => replacement_delegation}})
    |> render_submit()

    replacement_url = revoke_action_intent_href(view)
    refute replacement_url == revoke_url

    assert decoded_action_intent(replacement_url)["authority"]["delegation"] ==
             replacement_delegation

    view
    |> form("#participant-revoke-form", %{
      "revoke" => %{
        "delegation" => "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJ"
      }
    })
    |> render_submit()

    assert has_element?(
             view,
             "#participant-revoke-error[aria-live='polite']",
             "Enter a canonical delegation id before opening the app"
           )

    refute has_element?(view, "#participant-revoke-handoff")

    send(view.pid, {:township_instrument, {:fresh, payload}})
    assert has_element?(view, "#participant-revoke-error")
    refute has_element?(view, "#participant-revoke-handoff")

    view
    |> form("#participant-revoke-form", %{"revoke" => %{"delegation" => @revoke_delegation}})
    |> render_submit()

    replacement_payload = put_in(payload.provenance.replica, peer_log.replica <> ":replacement")
    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    assert has_element?(view, "#participant-revoke-form input[value='']")
    refute has_element?(view, "#participant-revoke-error")
    refute has_element?(view, "#participant-revoke-handoff")

    send(view.pid, {:township_instrument, {:fresh, payload}})

    view
    |> form("#participant-revoke-form", %{"revoke" => %{"delegation" => @revoke_delegation}})
    |> render_submit()

    send(view.pid, {:township_instrument, {:stale, payload}})
    refute has_element?(view, "#participant-revoke-form")
    refute has_element?(view, "#participant-revoke-handoff")
  end

  test "fresh carrier state prepares and clears one exact v7 clerk witness selector", %{
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
         topic: "township:witness-succession-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-witness-succession-form")

    render_hook(view, "prepare_witness_succession", %{
      "witness_succession" => %{"role" => "clerk"}
    })

    refute has_element?(view, "#participant-witness-succession-handoff")

    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert has_element?(view, "#participant-witness-succession-form")

    render_hook(view, "prepare_witness_succession", %{
      "witness_succession" => %{"role" => "clerk", "holder" => "smuggled"},
      "signature" => "smuggled"
    })

    witness_url = witness_succession_action_intent_href(view)
    witness_payload = decoded_action_intent(witness_url)

    assert witness_payload == %{
             "v" => 7,
             "id" => witness_payload["id"],
             "replica" => peer_log.replica,
             "authority" => %{
               "action" => "witness_succession",
               "role" => "clerk"
             }
           }

    assert witness_payload["id"] =~ ~r/\A[0-9a-f]{32}\z/

    assert {:ok, expected_url} =
             ActionIntent.witness_succession_url(peer_log.replica, :clerk,
               intent_id: witness_payload["id"]
             )

    assert witness_url == expected_url

    assert has_element?(
             view,
             "#participant-witness-succession-prepared",
             "Unsigned clerk recovery witness request"
           )

    op_count = peer_log |> Log.op_ids() |> MapSet.size()
    assert has_element?(view, "#op-dag-panel [data-op-count='#{op_count}']")

    send(view.pid, {:township_instrument, {:fresh, payload}})
    assert witness_succession_action_intent_href(view) == witness_url

    render_hook(view, "prepare_witness_succession", %{
      "witness_succession" => %{"role" => "resident"}
    })

    assert has_element?(
             view,
             "#participant-witness-succession-error[aria-live='polite']",
             "Select the clerk role before opening the app"
           )

    refute has_element?(view, "#participant-witness-succession-handoff")

    view
    |> form("#participant-witness-succession-form", %{
      "witness_succession" => %{"role" => "clerk"}
    })
    |> render_submit()

    form_payload = view |> witness_succession_action_intent_href() |> decoded_action_intent()
    assert Map.keys(form_payload) |> Enum.sort() == ["authority", "id", "replica", "v"]

    assert form_payload["authority"] == %{
             "action" => "witness_succession",
             "role" => "clerk"
           }

    replacement_payload = put_in(payload.provenance.replica, peer_log.replica <> ":replacement")
    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    assert has_element?(
             view,
             "#participant-witness-succession-form select option[value=''][selected]"
           )

    refute has_element?(view, "#participant-witness-succession-error")
    refute has_element?(view, "#participant-witness-succession-handoff")

    send(view.pid, {:township_instrument, {:fresh, payload}})

    view
    |> form("#participant-witness-succession-form", %{
      "witness_succession" => %{"role" => "clerk"}
    })
    |> render_submit()

    send(view.pid, {:township_instrument, {:stale, payload}})
    refute has_element?(view, "#participant-witness-succession-form")
    refute has_element?(view, "#participant-witness-succession-handoff")
  end

  test "fresh carrier state prepares admit in the same single roster-request slot", %{conn: conn} do
    peer_log = peer_log()

    projection =
      start_supervised!(
        {CarrierProjection,
         carrier: LiveCarrier,
         connect_opts: [ops: Log.topo_ops(peer_log)],
         replica: peer_log.replica,
         peer_realm: "clerk",
         pubsub: TownshipWeb.PubSub,
         topic: "township:admit-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-admit-form")
    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert has_element?(view, "#participant-admit-form")
    assert has_element?(view, "#participant-roster-form")

    view
    |> form("#participant-summary-form", %{"summary" => %{"text" => "existing summary request"}})
    |> render_submit()

    view
    |> form("#participant-post-form", %{"post" => %{"text" => "existing post request"}})
    |> render_submit()

    render_hook(view, "prepare_status_action", %{})

    render_hook(view, "prepare_admit", %{
      "admit" => %{
        "member" => "  resident:bob  ",
        "command" => "remove_member",
        "text" => "smuggled"
      }
    })

    assert has_element?(view, "#participant-roster-handoff[href^='township://action?intent=']")
    assert has_element?(view, "#participant-roster-prepared", "Unsigned member admission")
    refute has_element?(view, "#participant-admit-handoff")

    admit_url = roster_action_intent_href(view)
    admit_payload = decoded_action_intent(admit_url)

    assert admit_payload["v"] == 4
    assert admit_payload["replica"] == peer_log.replica
    assert admit_payload["command"] == %{"command" => "admit", "member" => "resident:bob"}

    assert {:ok, expected_admit_url} =
             ActionIntent.roster_url(peer_log.replica, :admit, "resident:bob",
               intent_id: admit_payload["id"]
             )

    assert admit_url == expected_admit_url
    assert has_element?(view, "#participant-summary-handoff")
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")
    assert has_element?(view, "#participant-post-form textarea", "existing post request")

    view
    |> form("#participant-roster-form", %{"roster" => %{"member" => "resident:alice"}})
    |> render_submit()

    remove_url = roster_action_intent_href(view)
    remove_payload = decoded_action_intent(remove_url)

    refute remove_url == admit_url

    assert remove_payload["command"] == %{
             "command" => "remove_member",
             "member" => "resident:alice"
           }

    assert has_element?(view, "#participant-roster-prepared", "Unsigned member removal")
    assert has_element?(view, "#participant-summary-handoff")
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")

    view
    |> form("#participant-admit-form", %{"admit" => %{"member" => "resident:carol"}})
    |> render_submit()

    form_admit_payload = view |> roster_action_intent_href() |> decoded_action_intent()
    assert form_admit_payload["command"] == %{"command" => "admit", "member" => "resident:carol"}
    assert has_element?(view, "#participant-roster-prepared", "Unsigned member admission")

    replacement_payload = put_in(payload.provenance.replica, peer_log.replica <> ":replacement")
    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    assert has_element?(view, "#participant-admit-form")
    assert has_element?(view, "#participant-roster-form")
    refute has_element?(view, "#participant-roster-handoff")

    send(view.pid, {:township_instrument, {:fresh, payload}})

    view
    |> form("#participant-admit-form", %{"admit" => %{"member" => " "}})
    |> render_submit()

    assert has_element?(view, "#participant-roster-error")

    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    refute has_element?(view, "#participant-roster-error")
    assert has_element?(view, "#participant-admit-form input[value='']")
  end

  test "fresh carrier state prepares one v3 summary edit the client cannot retarget", %{
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
         topic: "township:summary-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-summary-form")
    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert has_element?(view, "#participant-summary-form")

    view
    |> form("#participant-summary-form", %{
      "summary" => %{"text" => "  Needs traffic study  "}
    })
    |> render_submit()

    assert has_element?(
             view,
             "#participant-summary-handoff[href^='township://action?intent=']"
           )

    summary_payload = view |> summary_action_intent_href() |> decoded_action_intent()
    assert summary_payload["v"] == 3
    assert summary_payload["replica"] == peer_log.replica

    assert summary_payload["command"] == %{
             "command" => "set_summary",
             "text" => "Needs traffic study"
           }

    assert Map.keys(summary_payload) |> Enum.sort() == ["command", "id", "replica", "v"]

    view
    |> form("#participant-post-form", %{"post" => %{"text" => "existing post request"}})
    |> render_submit()

    render_hook(view, "prepare_status_action", %{})
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")

    render_hook(view, "prepare_summary_edit", %{
      "summary" => %{
        "text" => "smuggle attempt",
        "command" => "set_title",
        "field" => "set_title"
      }
    })

    retarget_payload = view |> summary_action_intent_href() |> decoded_action_intent()

    assert retarget_payload["command"] == %{
             "command" => "set_summary",
             "text" => "smuggle attempt"
           }

    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")

    replacement_payload = put_in(payload.provenance.replica, peer_log.replica <> ":replacement")
    send(view.pid, {:township_instrument, {:fresh, replacement_payload}})

    assert has_element?(view, "#participant-summary-form")
    refute has_element?(view, "#participant-summary-handoff")

    send(view.pid, {:township_instrument, {:fresh, payload}})

    view
    |> form("#participant-summary-form", %{"summary" => %{"text" => " "}})
    |> render_submit()

    assert has_element?(
             view,
             "#participant-summary-error[aria-live='polite']",
             "Write an update before opening the app"
           )

    refute has_element?(view, "#participant-summary-handoff")

    send(view.pid, {:township_instrument, {:stale, payload}})
    refute has_element?(view, "#participant-summary-form")
    refute has_element?(view, "#participant-summary-handoff")
  end

  test "fresh carrier state prepares title in the same single field-request slot", %{
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
         topic: "township:title-intent:#{System.unique_integer([:positive])}",
         schedule: :manual}
      )

    put_projection_config(projection)
    {:ok, view, _html} = live(conn, "/township")

    refute has_element?(view, "#participant-title-form")
    assert {:ok, {:fresh, payload}} = CarrierProjection.refresh(projection)
    assert has_element?(view, "#participant-title-form")

    view
    |> form("#participant-summary-form", %{"summary" => %{"text" => "summary request"}})
    |> render_submit()

    view
    |> form("#participant-post-form", %{"post" => %{"text" => "existing post request"}})
    |> render_submit()

    render_hook(view, "prepare_status_action", %{})
    assert has_element?(view, "#participant-summary-handoff")

    render_hook(view, "prepare_title_edit", %{
      "title" => %{
        "text" => "  Budget Hearing  ",
        "command" => "set_summary",
        "field" => "set_summary"
      }
    })

    assert has_element?(view, "#participant-title-handoff[href^='township://action?intent=']")
    refute has_element?(view, "#participant-summary-handoff")
    assert has_element?(view, "#participant-post-handoff")
    assert has_element?(view, "#participant-status-handoff")

    title_payload = view |> title_action_intent_href() |> decoded_action_intent()
    assert title_payload["v"] == 3
    assert title_payload["replica"] == peer_log.replica
    assert title_payload["command"] == %{"command" => "set_title", "text" => "Budget Hearing"}

    render_hook(view, "prepare_summary_edit", %{"summary" => %{"text" => "replacement summary"}})
    assert has_element?(view, "#participant-summary-handoff")
    refute has_element?(view, "#participant-title-handoff")

    send(view.pid, {:township_instrument, {:stale, payload}})
    refute has_element?(view, "#participant-title-form")
    refute has_element?(view, "#participant-title-handoff")
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

  defp structural_quarantine_log do
    sim =
      Sim.new(
        Matter,
        "replica:matter:structural-quarantine",
        ["clerk", "resident"],
        seed: "structural-quarantine"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, unauthorized_revoke} = Sim.revoke(sim, "resident", delegation.id)
    sim = Sim.sync_all(sim)

    {Sim.log(sim, "clerk"), unauthorized_revoke.id}
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

  defp summary_action_intent_href(view) do
    view
    |> render()
    |> LazyHTML.from_fragment()
    |> LazyHTML.query_by_id("participant-summary-handoff")
    |> LazyHTML.attribute("href")
    |> List.first()
  end

  defp title_action_intent_href(view) do
    view
    |> render()
    |> LazyHTML.from_fragment()
    |> LazyHTML.query_by_id("participant-title-handoff")
    |> LazyHTML.attribute("href")
    |> List.first()
  end

  defp roster_action_intent_href(view) do
    view
    |> render()
    |> LazyHTML.from_fragment()
    |> LazyHTML.query_by_id("participant-roster-handoff")
    |> LazyHTML.attribute("href")
    |> List.first()
  end

  defp grant_action_intent_href(view) do
    view
    |> render()
    |> LazyHTML.from_fragment()
    |> LazyHTML.query_by_id("participant-grant-handoff")
    |> LazyHTML.attribute("href")
    |> List.first()
  end

  defp revoke_action_intent_href(view) do
    view
    |> render()
    |> LazyHTML.from_fragment()
    |> LazyHTML.query_by_id("participant-revoke-handoff")
    |> LazyHTML.attribute("href")
    |> List.first()
  end

  defp witness_succession_action_intent_href(view) do
    view
    |> render()
    |> LazyHTML.from_fragment()
    |> LazyHTML.query_by_id("participant-witness-succession-handoff")
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
