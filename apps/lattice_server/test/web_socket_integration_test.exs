defmodule LatticeServer.WebSocketIntegrationTest do
  use ExUnit.Case, async: false

  alias Lattice.Transport.WebSocket.Client
  alias LatticeServer.TestSupport.HTTP

  defmodule Echo do
    use GenServer

    def start_link(_opts), do: GenServer.start_link(__MODULE__, %{})
    def init(state), do: {:ok, state}

    def handle_call({:lattice_call, %{from_tab_id: tab_id, payload: payload}}, _from, state) do
      {:reply, {:ok, %{from_tab_id: tab_id, echo: payload}}, state}
    end
  end

  setup do
    Lattice.reset!()
    LatticeServer.DemoHub.reset()
    listener = :"lattice_ws_test_#{System.unique_integer([:positive])}"
    port = HTTP.free_port()
    echo = start_supervised!(Echo)

    {:ok, _pid} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        grant_targets: %{"echo" => echo, {"echo", :ops} => ["call", "cast"]}
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)

    {:ok, port: port}
  end

  test "real WebSocket tab can get a cap, call an allowed target, and receive a denial", %{
    port: port
  } do
    {:ok, client} = Client.connect(port: port)

    assert :ok =
             Client.send_envelope(client, %{
               type: "hello",
               identity: %{user: "ws-integration"}
             })

    assert {:ok, %{"type" => "welcome", "tab_id" => tab_id}} = recv_type(client, "welcome")

    assert :ok = Client.send_envelope(client, %{type: "grant_request", target: "echo"})

    assert {:ok, %{"type" => "grant", "cap" => %{"id" => cap_id}}} =
             recv_type(client, "grant")

    assert :ok =
             Client.send_envelope(client, %{
               type: "call",
               cap_id: cap_id,
               payload: %{message: "over the wire"}
             })

    assert {:ok,
            %{
              "type" => "call_result",
              "ok" => true,
              "result" => %{
                "from_tab_id" => ^tab_id,
                "echo" => %{"message" => "over the wire"}
              }
            }} = recv_type(client, "call_result")

    assert :ok =
             Client.send_envelope(client, %{
               type: "call",
               cap_id: "not-a-real-cap",
               payload: %{message: "denied"}
             })

    assert {:ok, %{"type" => "call_result", "ok" => false, "error" => unknown_cap_error}} =
             recv_type(client, "call_result")

    assert unknown_cap_error == "invalid_request"

    # A different internal failure (malformed cap vs unknown cap) must map to
    # the same coarse public code — the reconnaissance distinction is gone.
    assert :ok =
             Client.send_envelope(client, %{
               type: "call",
               cap_id: %{"id" => "not-a-token"},
               payload: %{message: "denied"}
             })

    assert {:ok, %{"type" => "call_result", "ok" => false, "error" => malformed_cap_error}} =
             recv_type(client, "call_result")

    assert malformed_cap_error == unknown_cap_error

    assert :ok = Client.send_envelope(client, %{type: "disconnect"})

    assert {:ok, %{"type" => "disconnect_result", "ok" => true}} =
             recv_type(client, "disconnect_result")

    assert :ok = Client.close(client)

    assert Enum.any?(
             Lattice.audit_events(),
             &(&1.type == :tab_disconnect and &1.metadata.tab_id == tab_id)
           )
  end

  test "two real WebSocket tabs trigger the mediated bridge story", %{port: port} do
    {:ok, client_a} = Client.connect(port: port)
    {:ok, client_b} = Client.connect(port: port)

    assert :ok = Client.send_envelope(client_a, %{type: "hello", identity: %{user: "a"}})
    assert :ok = Client.send_envelope(client_b, %{type: "hello", identity: %{user: "b"}})
    assert {:ok, %{"type" => "welcome", "tab_id" => tab_a}} = recv_type(client_a, "welcome")
    assert {:ok, %{"type" => "welcome", "tab_id" => tab_b}} = recv_type(client_b, "welcome")

    parent = self()
    task_a = Task.async(fn -> story_loop(client_a, parent) end)
    task_b = Task.async(fn -> story_loop(client_b, parent) end)

    assert_receive {:story_event, "bridge_open",
                    %{"from_tab_id" => ^tab_a, "to_tab_id" => ^tab_b}},
                   5_000

    assert_receive {:story_event, "bridge_result",
                    %{"from_tab_id" => ^tab_a, "to_tab_id" => ^tab_b}},
                   5_000

    assert_receive {:story_event, "bridge_open",
                    %{"from_tab_id" => ^tab_b, "to_tab_id" => ^tab_a}},
                   5_000

    assert_receive {:story_event, "bridge_result",
                    %{"from_tab_id" => ^tab_b, "to_tab_id" => ^tab_a}},
                   5_000

    Client.close(client_a)
    Client.close(client_b)
    Task.shutdown(task_a, :brutal_kill)
    Task.shutdown(task_b, :brutal_kill)
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

  defp story_loop(client, parent) do
    case Client.recv_envelope(client, 1_000) do
      {:ok, %{"type" => "tab_call", "request_id" => request_id, "payload" => payload}} ->
        Client.send_envelope(client, %{
          type: "tab_render_result",
          request_id: request_id,
          result: %{received: payload}
        })

        story_loop(client, parent)

      {:ok, %{"type" => "server_event", "event" => %{"kind" => kind, "data" => data}}} ->
        send(parent, {:story_event, kind, data})
        story_loop(client, parent)

      {:ok, _other} ->
        story_loop(client, parent)

      {:error, :closed} ->
        :ok

      {:error, _reason} ->
        story_loop(client, parent)
    end
  end
end
