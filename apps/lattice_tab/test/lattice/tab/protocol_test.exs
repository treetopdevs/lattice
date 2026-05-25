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
end
