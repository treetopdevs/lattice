defmodule LatticeWebSocket.ClientTest do
  use ExUnit.Case, async: true

  import Bitwise

  alias Lattice.Transport.WebSocket.Client

  test "hostname takes precedence over the legacy host option" do
    {port, server} = start_server(fn _socket -> Process.sleep(25) end)

    assert {:ok, client} =
             Client.connect(
               hostname: "127.0.0.1",
               host: "does-not-resolve.invalid",
               port: port,
               path: "/carrier"
             )

    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  test "an atomic request parses a split response and excludes streaming mode" do
    {port, server} =
      start_server(fn socket ->
        assert {:ok, request} = recv_client_text(socket)
        assert Jason.decode!(request) == %{"type" => "request"}

        frame = server_text_frame(Jason.encode!(%{type: "request_result", value: 42}))
        split_at = div(byte_size(frame), 2)
        <<first::binary-size(split_at), second::binary>> = frame
        assert :ok = :gen_tcp.send(socket, first)
        Process.sleep(10)
        assert :ok = :gen_tcp.send(socket, second)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")

    assert {:ok, %{"type" => "request_result", "value" => 42}} =
             Client.request_envelope(client, %{type: "request"}, 500)

    assert {:error, :client_mode_conflict} = Client.recv_envelope(client, 50)
    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  test "an atomic setup receive consumes a server-first envelope before requests" do
    {port, server} =
      start_server(fn socket ->
        nonce = server_text_frame(Jason.encode!(%{type: "carrier_nonce", nonce: "server-nonce"}))
        assert :ok = :gen_tcp.send(socket, nonce)

        assert {:ok, request} = recv_client_text(socket)
        assert Jason.decode!(request) == %{"type" => "frontier"}

        response = server_text_frame(Jason.encode!(%{type: "frontier_result", ids: []}))
        assert :ok = :gen_tcp.send(socket, response)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")

    assert {:ok, %{"type" => "carrier_nonce", "nonce" => "server-nonce"}} =
             Client.recv_atomic_envelope(client, 500)

    assert {:ok, %{"type" => "frontier_result", "ids" => []}} =
             Client.request_envelope(client, %{type: "frontier"}, 500)

    assert {:error, :client_mode_conflict} = Client.recv_envelope(client, 50)
    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  test "a typed notification cannot satisfy the pending atomic request" do
    {port, server} =
      start_server(fn socket ->
        assert {:ok, request} = recv_client_text(socket)
        assert Jason.decode!(request) == %{"type" => "frontier"}

        notification =
          server_text_frame(Jason.encode!(%{type: "ops_available", generation: 2}))

        response = server_text_frame(Jason.encode!(%{type: "frontier_result", ids: ["op-1"]}))
        assert :ok = :gen_tcp.send(socket, notification <> response)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")
    subscription = make_ref()

    assert {:ok, ^subscription} =
             Client.subscribe(client, "ops_available", self(),
               tag: :feed,
               subscription: subscription
             )

    assert {:error, :subscription_conflict} =
             Client.subscribe(client, "ops_available", self(), subscription: subscription)

    assert {:ok, %{"type" => "frontier_result", "ids" => ["op-1"]}} =
             Client.request_envelope(client, %{type: "frontier"}, 500)

    assert_receive {:feed, ^subscription, %{"type" => "ops_available", "generation" => 2}}

    assert :ok = Client.unsubscribe(client, subscription)
    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  test "ping and pong control frames do not displace an atomic response" do
    {port, server} =
      start_server(fn socket ->
        assert {:ok, request} = recv_client_text(socket)
        assert Jason.decode!(request) == %{"type" => "health"}

        frames =
          server_frame(0x9, "pulse") <>
            server_frame(0xA, "already-alive") <>
            server_text_frame(Jason.encode!(%{type: "health_result"}))

        <<first::binary-size(3), rest::binary>> = frames
        assert :ok = :gen_tcp.send(socket, first)
        Process.sleep(10)
        assert :ok = :gen_tcp.send(socket, rest)
        assert {:ok, {0xA, "pulse"}} = recv_client_frame(socket)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")

    assert {:ok, %{"type" => "health_result"}} =
             Client.request_envelope(client, %{type: "health"}, 500)

    assert :ok = Task.await(server)
    assert :ok = Client.close(client)
  end

  test "legacy streaming receives coalesced frames and excludes atomic requests" do
    {port, server} =
      start_server(fn socket ->
        assert {:ok, request} = recv_client_text(socket)
        assert Jason.decode!(request) == %{"type" => "stream"}

        frames =
          server_text_frame(Jason.encode!(%{type: "first"})) <>
            server_text_frame(Jason.encode!(%{type: "second"}))

        assert :ok = :gen_tcp.send(socket, frames)
        Process.sleep(50)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")
    assert :ok = Client.send_envelope(client, %{type: "stream"})
    assert {:ok, %{"type" => "first"}} = Client.recv_envelope(client, 500)
    assert {:ok, %{"type" => "second"}} = Client.recv_envelope(client, 500)

    assert {:error, :client_mode_conflict} =
             Client.request_envelope(client, %{type: "atomic"}, 50)

    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  test "legacy streaming applies backpressure while the caller is not receiving" do
    parent = self()
    payload = String.duplicate("x", 8_000)
    frame = server_text_frame(Jason.encode!(%{type: "burst", payload: payload}))

    {port, server} =
      start_server(fn socket ->
        assert {:ok, request} = recv_client_text(socket)
        assert Jason.decode!(request) == %{"type" => "stream"}
        send(parent, :burst_started)

        result =
          Enum.reduce_while(1..5_000, :ok, fn _index, :ok ->
            case :gen_tcp.send(socket, frame) do
              :ok -> {:cont, :ok}
              {:error, reason} -> {:halt, {:error, reason}}
            end
          end)

        send(parent, {:burst_finished, result})
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")
    assert :ok = Client.send_envelope(client, %{type: "stream"})
    assert_receive :burst_started

    Process.sleep(200)
    assert process_footprint(client) < 1_000_000

    assert :ok = Client.close(client)
    assert_receive {:burst_finished, _result}, 1_000
    assert :ok = Task.await(server)
  end

  test "a fragmented WebSocket message fails closed and notifies subscribers" do
    {port, server} =
      start_server(fn socket ->
        assert {:ok, _request} = recv_client_text(socket)
        assert :ok = :gen_tcp.send(socket, server_frame(0x1, "{", fin: false))
        Process.sleep(50)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")
    assert {:ok, subscription} = Client.subscribe(client, "ops_available", self(), tag: :feed)

    assert {:error, {:protocol_error, :fragmented_frame}} =
             Client.request_envelope(client, %{type: "request"}, 500)

    assert_receive {:feed, ^subscription, {:closed, {:protocol_error, :fragmented_frame}}}

    assert {:error, :closed} = Client.request_envelope(client, %{type: "later"}, 50)
    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  test "an atomic request timeout closes the uncorrelated response channel" do
    {port, server} =
      start_server(fn socket ->
        assert {:ok, _request} = recv_client_text(socket)
        Process.sleep(100)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")
    assert {:ok, subscription} = Client.subscribe(client, "ops_available", self(), tag: :feed)
    assert {:error, :timeout} = Client.request_envelope(client, %{type: "slow"}, 25)
    assert_receive {:feed, ^subscription, {:closed, :timeout}}
    assert {:error, :closed} = Client.request_envelope(client, %{type: "later"}, 50)
    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  test "a server close frame is acknowledged and closes subscribers once" do
    close_payload = <<1_000::16>>

    {port, server} =
      start_server(fn socket ->
        assert {:ok, _request} = recv_client_text(socket)
        assert :ok = :gen_tcp.send(socket, server_frame(0x8, close_payload))
        assert {:ok, {0x8, ^close_payload}} = recv_client_frame(socket)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")
    assert {:ok, subscription} = Client.subscribe(client, "ops_available", self(), tag: :feed)
    assert {:error, :closed} = Client.request_envelope(client, %{type: "request"}, 500)
    assert_receive {:feed, ^subscription, {:closed, :closed}}
    refute_receive {:feed, ^subscription, {:closed, _reason}}, 25
    assert :ok = Task.await(server)
    assert :ok = Client.close(client)
  end

  test "a continuation frame fails closed explicitly" do
    {port, server} =
      start_server(fn socket ->
        assert {:ok, _request} = recv_client_text(socket)
        assert :ok = :gen_tcp.send(socket, server_frame(0x0, "continued"))
        Process.sleep(25)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")

    assert {:error, {:protocol_error, :fragmented_frame}} =
             Client.request_envelope(client, %{type: "request"}, 500)

    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  test "only one atomic request may be in flight" do
    parent = self()

    {port, server} =
      start_server(fn socket ->
        assert {:ok, request} = recv_client_text(socket)
        send(parent, {:request_received, self(), Jason.decode!(request)})

        receive do
          :respond ->
            assert :ok =
                     :gen_tcp.send(
                       socket,
                       server_text_frame(Jason.encode!(%{type: "first_result"}))
                     )
        end
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")

    first =
      Task.async(fn -> Client.request_envelope(client, %{type: "first"}, 500) end)

    assert_receive {:request_received, server_pid, %{"type" => "first"}}

    assert {:error, :request_in_progress} =
             Client.request_envelope(client, %{type: "second"}, 50)

    send(server_pid, :respond)
    assert {:ok, %{"type" => "first_result"}} = Task.await(first)
    assert :ok = Task.await(server)
    assert :ok = Client.close(client)
  end

  test "a known notification cannot consume a reply after its owner exits" do
    {port, server} =
      start_server(fn socket ->
        assert {:ok, _request} = recv_client_text(socket)

        frames =
          server_text_frame(Jason.encode!(%{type: "ops_available", generation: 2})) <>
            server_text_frame(Jason.encode!(%{type: "request_result"}))

        assert :ok = :gen_tcp.send(socket, frames)
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")
    owner = spawn(fn -> Process.sleep(:infinity) end)
    assert {:ok, _subscription} = Client.subscribe(client, "ops_available", owner)
    Process.exit(owner, :kill)

    assert eventually(fn ->
             {:monitors, monitors} = Process.info(client, :monitors)
             {:process, owner} not in monitors
           end)

    assert {:ok, %{"type" => "request_result"}} =
             Client.request_envelope(client, %{type: "request"}, 500)

    assert :ok = Task.await(server)
    assert :ok = Client.close(client)
  end

  test "an unsolicited off-protocol atomic frame closes instead of queueing" do
    parent = self()

    {port, server} =
      start_server(fn socket ->
        send(parent, {:server_ready, self()})

        receive do
          :send_unsolicited ->
            assert :ok =
                     :gen_tcp.send(socket, server_text_frame(Jason.encode!(%{type: "mystery"})))

            Process.sleep(50)
        end
      end)

    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")
    assert {:ok, subscription} = Client.subscribe(client, "ops_available", self(), tag: :feed)
    assert_receive {:server_ready, server_pid}
    send(server_pid, :send_unsolicited)

    assert_receive {:feed, ^subscription, {:closed, {:protocol_error, :unexpected_envelope}}},
                   200

    assert {:error, :closed} = Client.request_envelope(client, %{type: "later"}, 50)
    assert :ok = Task.await(server)
    assert :ok = Client.close(client)
  end

  test "notification type reservations are bounded for the socket lifetime" do
    {port, server} = start_server(fn _socket -> Process.sleep(100) end)
    assert {:ok, client} = Client.connect(host: "127.0.0.1", port: port, path: "/carrier")

    for index <- 1..32 do
      assert {:ok, _subscription} = Client.subscribe(client, "event_#{index}", self())
    end

    assert {:error, :too_many_notification_types} =
             Client.subscribe(client, "event_33", self())

    assert :ok = Client.close(client)
    assert :ok = Task.await(server)
  end

  defp start_server(script) do
    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, packet: :raw, reuseaddr: true])

    {:ok, port} = :inet.port(listener)

    server =
      Task.async(fn ->
        {:ok, socket} = :gen_tcp.accept(listener)
        :ok = accept_websocket(socket)
        script.(socket)
        :gen_tcp.close(socket)
        :gen_tcp.close(listener)
      end)

    {port, server}
  end

  defp accept_websocket(socket) do
    with {:ok, request} <- recv_headers(socket, ""),
         [_, key] <- Regex.run(~r/Sec-WebSocket-Key:\s*([^\r\n]+)/i, request),
         accept <-
           :crypto.hash(:sha, String.trim(key) <> "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
           |> Base.encode64() do
      :gen_tcp.send(socket, [
        "HTTP/1.1 101 Switching Protocols\r\n",
        "Upgrade: websocket\r\n",
        "Connection: Upgrade\r\n",
        "Sec-WebSocket-Accept: ",
        accept,
        "\r\n\r\n"
      ])
    else
      _other -> {:error, :bad_handshake}
    end
  end

  defp recv_headers(socket, acc) do
    if String.contains?(acc, "\r\n\r\n") do
      {:ok, acc}
    else
      with {:ok, chunk} <- :gen_tcp.recv(socket, 0, 1_000) do
        recv_headers(socket, acc <> chunk)
      end
    end
  end

  defp recv_client_text(socket) do
    with {:ok, {0x1, payload}} <- recv_client_frame(socket) do
      {:ok, payload}
    end
  end

  defp recv_client_frame(socket) do
    with {:ok, <<first, second>>} <- :gen_tcp.recv(socket, 2, 1_000),
         true <- (second &&& 0x80) == 0x80,
         {:ok, length} <- recv_length(socket, second &&& 0x7F),
         {:ok, mask} <- :gen_tcp.recv(socket, 4, 1_000),
         {:ok, payload} <- :gen_tcp.recv(socket, length, 1_000) do
      {:ok, {first &&& 0x0F, apply_mask(payload, mask)}}
    else
      false -> {:error, :unmasked_client_frame}
      other -> other
    end
  end

  defp recv_length(_socket, length) when length < 126, do: {:ok, length}

  defp recv_length(socket, 126) do
    with {:ok, <<length::16>>} <- :gen_tcp.recv(socket, 2, 1_000), do: {:ok, length}
  end

  defp recv_length(socket, 127) do
    with {:ok, <<length::64>>} <- :gen_tcp.recv(socket, 8, 1_000), do: {:ok, length}
  end

  defp apply_mask(payload, mask) do
    payload
    |> :binary.bin_to_list()
    |> Enum.with_index()
    |> Enum.map(fn {byte, index} -> bxor(byte, :binary.at(mask, rem(index, 4))) end)
    |> :binary.list_to_bin()
  end

  defp server_text_frame(payload) do
    server_frame(0x1, payload)
  end

  defp server_frame(opcode, payload, opts \\ []) do
    payload = IO.iodata_to_binary(payload)
    length = byte_size(payload)
    fin = if Keyword.get(opts, :fin, true), do: 0x80, else: 0

    header =
      cond do
        length < 126 -> <<fin ||| opcode, length>>
        length < 65_536 -> <<fin ||| opcode, 126, length::16>>
        true -> <<fin ||| opcode, 127, length::64>>
      end

    header <> payload
  end

  defp eventually(fun, attempts \\ 50)

  defp eventually(fun, attempts) when attempts > 0 do
    if fun.() do
      true
    else
      Process.sleep(5)
      eventually(fun, attempts - 1)
    end
  end

  defp eventually(_fun, 0), do: false

  defp process_footprint(pid) do
    {:memory, memory} = Process.info(pid, :memory)
    {:binary, binaries} = Process.info(pid, :binary)
    memory + Enum.sum(for {_address, size, _references} <- binaries, do: size)
  end
end
