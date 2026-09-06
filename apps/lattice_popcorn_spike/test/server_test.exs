# Run from apps/lattice_demo with MIX_ENV=test mix run ../lattice_popcorn_spike/test/server_test.exs
Code.require_file("support/server.exs", __DIR__)
Code.require_file("../browser/lib/realm.ex", __DIR__)
ExUnit.start()

defmodule LatticePopcornSpike.GatewayTest do
  use ExUnit.Case, async: false
  alias Lattice.Transport.WebSocket.Client

  test "native realm signing through real WebSocket: allow, forgery, omission, expiry, tamper, replay and cleanup" do
    {:ok, socket} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)
    {:ok, _} = LatticePopcornSpike.Server.start(port)
    on_exit(fn -> :cowboy.stop_listener(:lattice_popcorn_proof) end)
    {:ok, realm} = GenServer.start_link(LatticeBrowser.Realm, [])
    {:ok, client} = Client.connect(port: port)
    on_exit(fn -> if Process.alive?(client), do: Client.close(client) end)
    send_command(client, realm, %{"command" => "connect"})
    welcome = recv(client, "welcome")
    tab_id = welcome["tab_id"]
    GenServer.call(realm, %{"command" => "receive_server_event", "event" => welcome})
    send_command(client, realm, %{"command" => "request_capability"})
    cap = recv(client, "grant")["cap"]["id"]
    envelope = invoke(client, realm, cap)

    assert %{"ok" => true, "result" => %{"signature_verified" => true}} =
             recv(client, "call_result")

    assert %{deliveries: 1, verified: 1} = stats()
    invoke(client, realm, "forged")
    assert %{"ok" => false} = recv(client, "call_result")
    invoke(client, realm, nil)
    assert %{"type" => "error"} = recv(client, "error")

    {:ok, lease} =
      Lattice.grant(tab_id, LatticePopcornSpike.SignedEcho, [:call],
        expires_at: System.monotonic_time(:millisecond) - 1
      )

    invoke(client, realm, lease.id)
    assert %{"ok" => false, "error" => "unauthorized"} = recv(client, "call_result")
    assert %{deliveries: 1, verified: 1} = stats()

    for type <- ["rpc", "spawn", "send", "registered_name", "setnode"] do
      Client.send_envelope(client, %{"type" => type, "target" => "kernel"})
      assert %{"type" => "error"} = recv(client, "error")
    end

    assert %{deliveries: 1} = stats()
    tampered = put_in(envelope, ["payload", "body", "message"], "changed")
    Client.send_envelope(client, tampered)
    assert %{"ok" => false} = recv(client, "call_result")
    Client.send_envelope(client, envelope)
    assert %{"ok" => false} = recv(client, "call_result")
    assert %{deliveries: 3, verified: 1} = stats()
    send_command(client, realm, %{"command" => "disconnect"})
    assert %{"ok" => true} = recv(client, "disconnect_result")
    refute Lattice.Topology.tab_connected?(tab_id)
  end

  defp stats, do: GenServer.call(LatticePopcornSpike.SignedEcho, :stats)

  defp invoke(client, realm, cap),
    do:
      send_command(client, realm, %{"command" => "invoke", "cap_id" => cap, "message" => "signed"})

  defp send_command(client, realm, command) do
    %{"envelope" => envelope} = GenServer.call(realm, command)
    :ok = Client.send_envelope(client, envelope)
    envelope
  end

  defp recv(client, type), do: recv(client, type, System.monotonic_time(:millisecond) + 5000)

  defp recv(client, type, deadline) do
    remaining = deadline - System.monotonic_time(:millisecond)
    assert remaining > 0
    assert {:ok, frame} = Client.recv_envelope(client, remaining)
    if frame["type"] == type, do: frame, else: recv(client, type, deadline)
  end
end
