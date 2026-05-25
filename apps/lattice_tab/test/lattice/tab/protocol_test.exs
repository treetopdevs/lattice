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
end
