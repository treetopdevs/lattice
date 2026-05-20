defmodule LatticeServer.WebSocketResumeTest do
  use ExUnit.Case, async: false

  alias Lattice.Transport.WebSocket.Client
  alias LatticeServer.TestSupport.HTTP

  setup do
    Lattice.reset!()
    LatticeServer.DemoHub.reset()
    LatticeServer.ResumeToken.reset!()
    LatticeServer.ResumeProxy.reset_all!()
    :ok
  end

  test "resume replays missed demo stream frames in order with fresh one-shot JWT" do
    %{port: port} = start_server(resume_buffer_size: 8)
    client_id = "resume-client-success"

    {:ok, client} = Client.connect(port: port)
    {:ok, tab_id, last_seq} = hello_with_resume_client(client, client_id)

    assert :ok = Client.close(client)
    wait_until(fn -> LatticeServer.DemoHub.snapshot().tabs == [] end)

    LatticeServer.DemoHub.event(:deny, %{tab_id: tab_id, reason: :after_drop})
    LatticeServer.DemoHub.snapshot()

    token = session_token!(port, client_id)
    {:ok, reconnect} = Client.connect(port: port)

    assert :ok =
             Client.send_envelope(reconnect, %{
               type: "resume",
               seq: last_seq,
               jwt: token
             })

    assert {:ok, %{"type" => "resume_ok", "replayed" => replayed}} =
             recv_type(reconnect, "resume_ok")

    assert replayed > 0

    assert {:ok,
            %{
              "type" => "server_event",
              "seq" => replay_seq,
              "event" => %{
                "kind" => "deny",
                "data" => %{"reason" => "after_drop"}
              }
            }} = recv_server_event_kind(reconnect, "deny")

    assert replay_seq > last_seq
    Client.close(reconnect)
  end

  test "resume outside the ring buffer asks the browser to rehydrate" do
    %{port: port} = start_server(resume_buffer_size: 2)
    client_id = "resume-client-window"

    {:ok, client} = Client.connect(port: port)
    {:ok, tab_id, last_seq} = hello_with_resume_client(client, client_id)

    assert :ok = Client.close(client)
    wait_until(fn -> LatticeServer.DemoHub.snapshot().tabs == [] end)

    for n <- 1..3 do
      LatticeServer.DemoHub.event(:deny, %{tab_id: tab_id, reason: "missed-#{n}"})
    end

    LatticeServer.DemoHub.snapshot()

    token = session_token!(port, client_id)
    {:ok, reconnect} = Client.connect(port: port)

    assert :ok =
             Client.send_envelope(reconnect, %{
               type: "resume",
               seq: last_seq,
               jwt: token
             })

    assert {:ok, %{"type" => "rehydrate", "reason" => "out_of_window"}} =
             recv_type(reconnect, "rehydrate")

    Client.close(reconnect)
  end

  test "resume JWTs are short-lived and consumed once" do
    assert {:ok, token, _claims} = LatticeServer.ResumeToken.issue("resume-client-token")
    assert {:ok, %{"sub" => "resume-client-token"}} = LatticeServer.ResumeToken.consume(token)
    assert {:error, :jti_replayed} = LatticeServer.ResumeToken.consume(token)

    assert {:ok, expired, _claims} =
             LatticeServer.ResumeToken.issue("resume-client-token-expired", ttl_seconds: -1)

    assert {:error, :token_expired} = LatticeServer.ResumeToken.consume(expired)
  end

  defp start_server(opts) do
    listener = :"lattice_ws_resume_test_#{System.unique_integer([:positive])}"
    port = HTTP.free_port()

    {:ok, _pid} =
      LatticeServer.start_http(
        Keyword.merge(
          [
            listener: listener,
            port: port,
            auto_story?: false,
            resume_proxy_ttl_ms: 5_000,
            grant_targets: %{}
          ],
          opts
        )
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)
    %{port: port}
  end

  defp hello_with_resume_client(client, client_id) do
    assert :ok =
             Client.send_envelope(client, %{
               type: "hello",
               client_id: client_id,
               identity: %{user: "resume", client_id: client_id}
             })

    assert {:ok, %{"type" => "welcome", "tab_id" => tab_id, "client_id" => ^client_id}} =
             recv_type(client, "welcome")

    assert {:ok, %{"type" => "server_event", "seq" => last_seq}} =
             recv_type(client, "server_event")

    {:ok, tab_id, last_seq}
  end

  defp session_token!(port, client_id) do
    assert {:ok, 200, body} =
             HTTP.raw_http(port, "GET", "/api/session-token?client_id=#{client_id}")

    assert %{"token" => token, "client_id" => ^client_id} = Jason.decode!(body)
    token
  end

  defp recv_server_event_kind(client, kind, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_recv_server_event_kind(client, kind, deadline)
  end

  defp do_recv_server_event_kind(client, kind, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 1)

    case Client.recv_envelope(client, remaining) do
      {:ok, %{"type" => "server_event", "event" => %{"kind" => ^kind}} = envelope} ->
        {:ok, envelope}

      {:ok, _other} ->
        do_recv_server_event_kind(client, kind, deadline)

      {:error, reason} ->
        {:error, reason}
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

  defp wait_until(fun, attempts \\ 50)

  defp wait_until(fun, attempts) when attempts > 0 do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      wait_until(fun, attempts - 1)
    end
  end

  defp wait_until(_fun, 0), do: flunk("condition was not met before timeout")
end
