defmodule Lattice.Tab.ProtocolTest do
  use ExUnit.Case, async: true

  alias Lattice.Tab.Protocol

  describe "init/1 and hello/1" do
    test "init/1 starts in :connecting with the supplied client_id" do
      state = Protocol.init("client-abc-123")
      assert state.client_id == "client-abc-123"
      assert state.status == :connecting
      assert state.tab_id == nil
      assert state.caps == %{}
    end

    test "hello/1 builds a hello envelope carrying the client_id and a status intent" do
      {state, outbound, intents} = Protocol.hello(Protocol.init("client-abc-123"))

      assert [%{"type" => "hello", "client_id" => "client-abc-123", "identity" => identity}] =
               outbound

      assert identity["surface"] == "atomvm-tab"
      assert identity["client_id"] == "client-abc-123"
      assert intents == [%{kind: "status", text: "connecting"}]
      assert state.status == :connecting
    end
  end

  describe "handle/2 — connection" do
    setup do
      {:ok, state: Protocol.init("client-abc-123")}
    end

    test "welcome stores tab_id/session_id and emits state_request", %{state: state} do
      env = %{"type" => "welcome", "tab_id" => "tab_9", "session_id" => "sess_1", "client_id" => "client-abc-123"}
      {state, outbound, intents} = Protocol.handle(state, env)

      assert state.tab_id == "tab_9"
      assert state.session_id == "sess_1"
      assert state.status == :online
      assert outbound == [%{"type" => "state_request"}]
      assert %{kind: "status", text: "connected", tab_id: "tab_9"} in intents
    end

    test "grant stores the echo cap_id and emits a cap intent", %{state: state} do
      env = %{"type" => "grant", "cap" => %{"id" => "cap_echo_42"}}
      {state, outbound, intents} = Protocol.handle(state, env)

      assert state.caps["echo"] == "cap_echo_42"
      assert outbound == []
      assert %{kind: "cap", text: "granted", cap_id: "cap_echo_42"} in intents
    end
  end

  describe "build + result" do
    setup do
      base = Protocol.init("c1")
      {state, _o, _i} = Protocol.handle(base, %{"type" => "grant", "cap" => %{"id" => "cap_echo_42"}})
      {:ok, granted: state}
    end

    test "grant_request/2 builds a grant_request envelope" do
      {_state, outbound, _intents} = Protocol.grant_request(Protocol.init("c1"), "echo")
      assert outbound == [%{"type" => "grant_request", "target" => "echo"}]
    end

    test "call/3 builds a call using the held echo cap", %{granted: state} do
      {_state, outbound, _intents} = Protocol.call(state, "echo", "visible capability")

      assert [%{"type" => "call", "cap_id" => "cap_echo_42", "payload" => payload}] = outbound
      assert payload == %{"op" => "echo", "message" => "visible capability"}
    end

    test "call/3 without a held cap emits an error intent and no outbound" do
      {_state, outbound, intents} = Protocol.call(Protocol.init("c1"), "echo", "x")
      assert outbound == []
      assert [%{kind: "error", text: "no cap held"}] = intents
    end

    test "call_result maps ok:true to an allowed intent", %{granted: state} do
      {_state, outbound, intents} = Protocol.handle(state, %{"type" => "call_result", "ok" => true, "result" => %{"echo" => "hi"}})
      assert outbound == []
      assert %{kind: "call_result", ok: true} = hd(intents)
    end

    test "cast_result maps ok:false to a denied intent", %{granted: state} do
      {_state, _outbound, intents} = Protocol.handle(state, %{"type" => "cast_result", "ok" => false, "error" => ":denied"})
      assert %{kind: "cast_result", ok: false} = hd(intents)
    end
  end

  describe "handle/2 — tab_call milestone" do
    setup do
      {state, _o, _i} = Protocol.handle(Protocol.init("c1"), %{"type" => "welcome", "tab_id" => "tab_A", "session_id" => "s", "client_id" => "c1"})
      {:ok, state: state}
    end

    test "tab_call computes a real tab_render_result echoing pulse + op", %{state: state} do
      env = %{
        "type" => "tab_call",
        "request_id" => "req_42",
        "from_tab_id" => "tab_B",
        "payload" => %{"op" => "render", "pulse" => "blue"}
      }

      {^state, outbound, intents} = Protocol.handle(state, env)

      assert [%{"type" => "tab_render_result", "request_id" => "req_42", "result" => result}] = outbound
      assert result["realm"] == "atomvm"
      assert result["received_by"] == "tab_A"
      assert result["from_tab_id"] == "tab_B"
      assert result["op"] == "render"
      assert result["pulse"] == "blue"
      assert result["rendered"] == true
      assert %{kind: "pulse", route: "bridge"} in intents
    end

    test "error envelope becomes an error intent, no outbound", %{state: state} do
      {_state, outbound, intents} = Protocol.handle(state, %{"type" => "error", "error_type" => "denied", "reason" => ":nope"})
      assert outbound == []
      assert %{kind: "error", text: "denied"} = hd(intents)
    end

    test "unknown envelope type is a no-op", %{state: state} do
      assert {^state, [], []} = Protocol.handle(state, %{"type" => "totally_unknown"})
    end
  end
end
