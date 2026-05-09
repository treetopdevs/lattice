defmodule LatticeServer.WebSocketEnvelopeTest do
  use ExUnit.Case, async: false

  alias Lattice.Transport.WebSocket.Envelope

  setup do
    Lattice.reset!()
    :ok
  end

  test "WebSocket envelope parser accepts known safe JSON envelopes" do
    assert {:ok, %{"type" => "hello", "identity" => %{"user" => "browser"}}} =
             Envelope.parse(~s({"type":"hello","identity":{"user":"browser"}}))
  end

  test "WebSocket envelope parser rejects malformed input" do
    assert {:error, _reason} = Envelope.parse("not json")
    assert {:error, :missing_type} = Envelope.parse(~s({"payload":{}}))
    assert {:error, :unknown_type} = Envelope.parse(~s({"type":"rpc","payload":"no"}))
  end

  test "WebSocket envelope encoder preserves JSON booleans and nulls" do
    assert %{"ok" => true, "result" => nil, "type" => "call_result"} =
             %{type: "call_result", ok: true, result: nil}
             |> Envelope.encode()
             |> Jason.decode!()
  end

  test "server-side WebSocket code does not use unsafe term decoding" do
    root = Path.expand("../../..", __DIR__)

    websocket_source =
      [
        "apps/lattice_server/lib/lattice/transport/web_socket.ex",
        "apps/lattice_server/lib/lattice/transport/web_socket/envelope.ex"
      ]
      |> Enum.map(&File.read!(Path.join(root, &1)))
      |> Enum.join("\n")

    refute websocket_source =~ ~r/(^|[^a-zA-Z0-9_:.])(:erlang\.)?binary_to_term\s*\(/m
  end

  test "server records connect and disconnect events through the same tab boundary state" do
    {:ok, tab} =
      Lattice.connect_tab(%{
        transport: Lattice.Transport.WebSocket,
        connection_pid: self(),
        identity: %{"user" => "ws-test"},
        metadata: %{transport: "websocket-test"}
      })

    assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)

    assert Enum.any?(
             Lattice.audit_events(),
             &(&1.type == :tab_connect and &1.metadata.tab_id == tab.id)
           )

    assert Enum.any?(
             Lattice.audit_events(),
             &(&1.type == :tab_disconnect and &1.metadata.tab_id == tab.id)
           )
  end
end
