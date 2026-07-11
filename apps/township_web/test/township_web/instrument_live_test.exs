defmodule TownshipWeb.InstrumentLiveTest do
  # The degraded-state test temporarily overrides the process-global source config.
  use TownshipWeb.ConnCase, async: false

  defmodule FailingSource do
    @behaviour TownshipWeb.InstrumentSource

    @impl true
    def load(_opts), do: {:error, {:bundle_unverified, ["audit.json mismatch"]}}
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

    refute degraded =~ "Zoning variance #24"
    refute degraded =~ "xI19LiI0w767"
    refute degraded =~ "not_holder"
    refute degraded =~ "approve"
    refute degraded =~ "township-audit-bundle-v1"
    refute degraded =~ "df911bb13013abefab"
  end
end
