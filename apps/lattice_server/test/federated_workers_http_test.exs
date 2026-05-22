defmodule LatticeServer.FederatedWorkersHTTPTest do
  use ExUnit.Case, async: false

  alias Lattice.Transport.WebSocket.Client
  alias LatticeServer.TestSupport.HTTP

  setup do
    Lattice.reset!()
    LatticeServer.DemoHub.reset()
    listener = :"lattice_federated_workers_test_#{System.unique_integer([:positive])}"
    port = HTTP.free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        auto_story?: false,
        grant_targets: %{}
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)

    {:ok, port: port}
  end

  test "run endpoint denies direct worker-to-worker caps and allows explicit bridge", %{
    port: port
  } do
    {:ok, worker_a} = Client.connect(port: port)
    {:ok, worker_b} = Client.connect(port: port)

    assert :ok = hello(worker_a, "worker-a")
    assert :ok = hello(worker_b, "worker-b")
    assert {:ok, %{"type" => "welcome", "tab_id" => tab_a}} = recv_type(worker_a, "welcome")
    assert {:ok, %{"type" => "welcome", "tab_id" => tab_b}} = recv_type(worker_b, "welcome")

    parent = self()
    worker_loop = Task.async(fn -> reply_to_worker_calls(worker_b, parent) end)

    body = Jason.encode!(%{from_tab_id: tab_a, to_tab_id: tab_b})

    assert {:ok, 200, response_body} =
             HTTP.raw_http(
               port,
               "POST",
               "/api/federated-workers/run",
               [{"content-type", "application/json"}],
               body
             )

    response = Jason.decode!(response_body)

    assert %{
             "denied_direct" => %{"ok" => false, "error" => "bridge_required"},
             "bridged" => %{
               "ok" => true,
               "result" => %{
                 "realm" => "websocket_test_worker",
                 "worker_b_received" => "mediated"
               }
             }
           } = response

    assert_receive {:worker_tab_call, %{"op" => "relay", "body" => "mediated"}}, 1_000
    refute_receive {:worker_tab_call, %{"op" => "relay", "body" => "direct"}}, 100

    assert {:ok, direct_cap} = Lattice.CapStore.get(response["direct_cap_id"])
    assert direct_cap.revoked?
    assert {:ok, bridge_cap} = Lattice.CapStore.get(response["bridge_cap_id"])
    assert bridge_cap.revoked?

    assert :ok =
             Client.send_envelope(worker_a, %{
               type: "call",
               cap_id: response["bridge_cap_id"],
               payload: %{op: "relay", body: "after-run"}
             })

    assert {:ok, %{"type" => "call_result", "ok" => false, "error" => ":revoked"}} =
             recv_type(worker_a, "call_result")

    refute_receive {:worker_tab_call, %{"op" => "relay", "body" => "after-run"}}, 100

    Client.close(worker_a)
    Client.close(worker_b)
    Task.shutdown(worker_loop, :brutal_kill)
  end

  defp hello(client, worker) do
    Client.send_envelope(client, %{
      type: "hello",
      identity: %{surface: "browser-worker-demo", worker: worker}
    })
  end

  defp reply_to_worker_calls(client, parent) do
    case Client.recv_envelope(client, 1_000) do
      {:ok, %{"type" => "tab_call", "request_id" => request_id, "payload" => payload}} ->
        send(parent, {:worker_tab_call, payload})

        Client.send_envelope(client, %{
          type: "tab_render_result",
          request_id: request_id,
          result: %{
            realm: "websocket_test_worker",
            worker_b_received: payload["body"]
          }
        })

        reply_to_worker_calls(client, parent)

      {:ok, _other} ->
        reply_to_worker_calls(client, parent)

      {:error, :closed} ->
        :ok

      {:error, _reason} ->
        reply_to_worker_calls(client, parent)
    end
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
