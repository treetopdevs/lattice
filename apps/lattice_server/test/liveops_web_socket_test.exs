defmodule LatticeServer.LiveOpsWebSocketTest do
  use ExUnit.Case, async: false

  alias Lattice.Transport.WebSocket.Client
  alias LatticeServer.TestSupport.HTTP

  setup do
    Lattice.reset!()
    LatticeServer.DemoHub.reset()

    listener = :"lattice_liveops_ws_#{System.unique_integer([:positive])}"
    port = HTTP.free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        auto_story?: false,
        static_dir: Path.expand("../../../examples/liveops_demo", __DIR__)
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)

    {:ok, port: port}
  end

  test "liveops role joins and actions move through the WebSocket gateway", %{port: port} do
    {:ok, client} = Client.connect(port: port)

    assert :ok =
             Client.send_envelope(client, %{
               type: "hello",
               identity: %{surface: "liveops-demo", role: "observer"}
             })

    assert {:ok, %{"type" => "welcome", "tab_id" => tab_id}} = recv_type(client, "welcome")

    assert :ok = Client.send_envelope(client, %{type: "state_request"})
    assert {:ok, %{"type" => "snapshot", "liveops" => liveops}} = recv_type(client, "snapshot")

    assert [%{"role" => "observer", "tab_id" => ^tab_id, "caps" => [observe_cap]}] =
             liveops["actors"]

    assert observe_cap["action"] == "observe"

    assert :ok =
             Client.send_envelope(client, %{
               type: "liveops_action",
               action: "publish",
               cap_id: observe_cap["id"],
               payload: %{request_id: "approval-missing"}
             })

    assert {:ok,
            %{
              "type" => "liveops_result",
              "ok" => false,
              "error" => ":cap_action_mismatch"
            }} = recv_type(client, "liveops_result")

    assert Enum.any?(
             Lattice.audit_events(),
             &(&1.type == :liveops_denied and &1.metadata.tab_id == tab_id and
                 &1.metadata.reason == :cap_action_mismatch)
           )

    Client.close(client)
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
end
