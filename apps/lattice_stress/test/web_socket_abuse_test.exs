defmodule LatticeStress.WebSocketAbuseTest do
  use ExUnit.Case, async: false

  alias Lattice.Transport.WebSocket.Client
  alias Lattice.Transport.WebSocket.Envelope
  alias LatticeStress.ProbeServer

  setup do
    Lattice.reset!()
    LatticeServer.DemoHub.reset()
    {:ok, probe} = ProbeServer.start_link(owner: self(), name: :ws_probe)
    listener = :"lattice_stress_ws_#{System.unique_integer([:positive])}"
    port = free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        auto_story?: false,
        grant_targets: %{"probe" => probe, {"probe", :ops} => ["call", "cast"]}
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)
    {:ok, %{port: port, probe: probe}}
  end

  test "malformed JSON is rejected at protocol level and no target observes it", %{
    port: port,
    probe: probe
  } do
    {:ok, client} = Client.connect(port: port)
    assert :ok = Client.send_raw_text(client, "not-json")
    assert {:ok, %{"type" => "error", "error_type" => "malformed"}} = Client.recv_envelope(client)
    assert %{call_count: 0, cast_count: 0} = ProbeServer.stats(probe)
    Client.close(client)
  end

  test "oversized envelopes are rejected by the parser" do
    oversized = String.duplicate("x", 65_537)
    assert {:error, :malformed} = Envelope.parse(oversized)
  end

  test "unknown message types and missing fields are rejected without delivery", %{probe: probe} do
    assert {:error, :unknown_type} = Envelope.parse(~s({"type":"rpc","payload":"no"}))
    assert {:error, :missing_type} = Envelope.parse(~s({"payload":{"cap_id":"x"}}))
    assert %{call_count: 0, cast_count: 0} = ProbeServer.stats(probe)
  end

  test "malformed cap id in a WebSocket call fails closed", %{port: port, probe: probe} do
    {:ok, client, _tab_id} = connected_client(port)

    assert :ok =
             Client.send_envelope(client, %{
               type: "call",
               cap_id: %{"id" => "not-a-token"},
               payload: %{attack: "malformed-cap"}
             })

    assert {:ok, %{"type" => "call_result", "ok" => false, "error" => "invalid_request"}} =
             recv_type(client, "call_result")

    assert %{call_count: 0} = ProbeServer.stats(probe)
    Client.close(client)
  end

  test "valid cap used against a mismatched requested target is denied before delivery", %{
    port: port,
    probe: probe
  } do
    {:ok, client, _tab_id} = connected_client(port)
    {:ok, cap_id} = grant_probe(client)

    assert :ok =
             Client.send_envelope(client, %{
               type: "call",
               cap_id: cap_id,
               target: "secret",
               payload: %{attack: "wrong-target"}
             })

    assert {:ok, %{"type" => "call_result", "ok" => false, "error" => "invalid_request"}} =
             recv_type(client, "call_result")

    assert %{call_count: 0} = ProbeServer.stats(probe)
    assert_audit(:deny, reason: :target_mismatch)
    Client.close(client)
  end

  test "fake grant target is denied and audited", %{port: port, probe: probe} do
    {:ok, client, _tab_id} = connected_client(port)

    assert :ok = Client.send_envelope(client, %{type: "grant_request", target: "secret"})

    assert {:ok, %{"type" => "error", "error_type" => "grant_denied"}} =
             recv_type(client, "error")

    assert %{call_count: 0} = ProbeServer.stats(probe)
    assert_audit(:deny, reason: :unknown_grant_target)
    Client.close(client)
  end

  test "slow tab-side client that never answers causes timeout rather than ambient delivery", %{
    port: port
  } do
    {:ok, client_a, tab_a} = connected_client(port)
    {:ok, client_b, tab_b} = connected_client(port)

    {:ok, cap} = Lattice.bridge(tab_a, tab_b, [:call], ttl: 10_000)
    assert {:error, :timeout} = Lattice.Gateway.call(tab_a, cap, %{op: :relay}, 20)

    assert {:ok, %{"type" => "tab_call", "request_id" => request_id}} =
             recv_type(client_b, "tab_call")

    assert :ok =
             Client.send_envelope(client_b, %{
               type: "tab_render_result",
               request_id: request_id,
               result: %{late: true}
             })

    assert {:ok, %{"type" => "error", "error_type" => "unknown_request"}} =
             recv_type(client_b, "error")

    Client.close(client_a)
    Client.close(client_b)
  end

  test "disconnecting socket mid-session revokes caps and later replay is denied", %{
    port: port,
    probe: probe
  } do
    {:ok, client, tab_id} = connected_client(port)
    {:ok, cap_id} = grant_probe(client)
    assert :ok = Client.close(client)
    Process.sleep(20)

    assert {:error, :revoked} = Lattice.call(tab_id, cap_id, %{after_close: true})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  defp connected_client(port) do
    {:ok, client} = Client.connect(port: port)
    assert :ok = Client.send_envelope(client, %{type: "hello", identity: %{user: "abuse"}})
    assert {:ok, %{"type" => "welcome", "tab_id" => tab_id}} = recv_type(client, "welcome")
    {:ok, client, tab_id}
  end

  defp grant_probe(client) do
    assert :ok = Client.send_envelope(client, %{type: "grant_request", target: "probe"})
    assert {:ok, %{"type" => "grant", "cap" => %{"id" => cap_id}}} = recv_type(client, "grant")
    {:ok, cap_id}
  end

  defp free_port do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    port
  end

  defp recv_type(client, type, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_recv_type(client, type, deadline)
  end

  defp do_recv_type(client, type, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 1)

    case Client.recv_envelope(client, remaining) do
      {:ok, %{"type" => ^type} = envelope} -> {:ok, envelope}
      {:ok, _other} -> do_recv_type(client, type, deadline)
      {:error, reason} -> {:error, reason}
    end
  end

  defp assert_audit(type, filters) do
    assert Enum.any?(Lattice.audit_events(), fn event ->
             event.type == type and
               Enum.all?(filters, fn {key, value} -> event.metadata[key] == value end)
           end)
  end
end
