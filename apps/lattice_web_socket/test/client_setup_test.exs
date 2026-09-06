defmodule LatticeWebSocket.ClientSetupTest do
  use ExUnit.Case, async: false

  alias Lattice.Transport.WebSocket.Client

  test "the configured setup deadline closes a peer that never upgrades" do
    {port, listener, peer} =
      start_peer(fn socket ->
        assert {:ok, _request} = :gen_tcp.recv(socket, 0, 3_000)
        assert {:error, :closed} = :gen_tcp.recv(socket, 0, 3_000)
      end)

    connector =
      Task.async(fn ->
        Process.flag(:trap_exit, true)
        Client.start_link(host: "127.0.0.1", port: port, connect_timeout: 500)
      end)

    try do
      # Stay below the legacy five-second read timeout while allowing scheduler
      # contention between the observer, connector and already-started peer.
      assert {:ok, {:error, :timeout}} = Task.yield(connector, 2_000)
      Task.await(peer, 4_000)
    after
      Task.shutdown(connector, :brutal_kill)
      Task.shutdown(peer, :brutal_kill)
      :gen_tcp.close(listener)
    end
  end

  test "the upgrade header byte budget rejects a streaming peer before the deadline" do
    {port, listener, peer} =
      start_peer(fn socket ->
        assert {:ok, _request} = :gen_tcp.recv(socket, 0, 3_000)
        assert :ok = :gen_tcp.send(socket, String.duplicate("H", 64_001))
        assert {:error, :closed} = :gen_tcp.recv(socket, 0, 3_000)
      end)

    connector =
      Task.async(fn ->
        Process.flag(:trap_exit, true)
        Client.start_link(host: "127.0.0.1", port: port, connect_timeout: 5_000)
      end)

    try do
      assert {:ok, {:error, :upgrade_headers_too_large}} = Task.yield(connector, 2_000)
      Task.await(peer, 4_000)
    after
      Task.shutdown(connector, :brutal_kill)
      Task.shutdown(peer, :brutal_kill)
      :gen_tcp.close(listener)
    end
  end

  test "setup never receives beyond the remaining header allowance before rejecting" do
    {port, listener, peer} =
      start_peer(fn socket ->
        assert {:ok, _request} = :gen_tcp.recv(socket, 0, 3_000)
        assert :ok = :gen_tcp.send(socket, String.duplicate("H", 63_999))
        assert_receive :overflow, 3_000
        assert :ok = :gen_tcp.send(socket, String.duplicate("H", 20_000))
        assert {:error, :closed} = :gen_tcp.recv(socket, 0, 3_000)
      end)

    connector =
      Task.async(fn ->
        assert_receive :connect, 3_000
        Process.flag(:trap_exit, true)
        Client.start_link(host: "127.0.0.1", port: port, connect_timeout: 5_000)
      end)

    # Observe actual socket-read sizes during the public setup call. Tracing is
    # confined to this connector and its child; this serial test restores the
    # VM-wide function pattern. No private client implementation is invoked.
    :erlang.trace_pattern({:gen_tcp, :recv, 3}, [{:_, [], [{:return_trace}]}], [:local])
    :erlang.trace(connector.pid, true, [:call, :set_on_spawn])

    try do
      send(connector.pid, :connect)
      assert traced_received_bytes(63_999, 0) == 63_999
      send(peer.pid, :overflow)
      assert {:ok, {:error, :upgrade_headers_too_large}} = Task.yield(connector, 2_000)
      delivery = :erlang.trace_delivered(:all)
      assert_receive {:trace_delivered, :all, ^delivery}, 2_000
      assert drain_received_bytes(0) == 1
      Task.await(peer, 4_000)
    after
      :erlang.trace_pattern({:gen_tcp, :recv, 3}, false, [:local])
      Task.shutdown(connector, :brutal_kill)
      Task.shutdown(peer, :brutal_kill)
      :gen_tcp.close(listener)
    end
  end

  test "short and exactly 64000-byte upgrades preserve coalesced WebSocket frames" do
    for header_size <- [200, 64_000] do
      {port, listener, peer} =
        start_peer(fn socket ->
          assert {:ok, request} = :gen_tcp.recv(socket, 0, 3_000)
          [_, key] = Regex.run(~r/Sec-WebSocket-Key:\s*([^\r\n]+)/i, request)

          accept =
            :crypto.hash(:sha, key <> "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
            |> Base.encode64()

          prefix =
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n" <>
              "Connection: Upgrade\r\nSec-WebSocket-Accept: #{accept}\r\nX-Padding: "

          headers =
            prefix <> String.duplicate("x", header_size - byte_size(prefix) - 4) <> "\r\n\r\n"

          assert byte_size(headers) == header_size
          first = Jason.encode!(%{type: "first"})
          second = Jason.encode!(%{type: "second"})

          assert :ok =
                   :gen_tcp.send(socket, [
                     headers,
                     <<0x81, byte_size(first)>>,
                     first,
                     <<0x81, byte_size(second)>>,
                     second
                   ])

          assert {:error, :closed} = :gen_tcp.recv(socket, 0, 3_000)
        end)

      try do
        assert {:ok, client} =
                 Client.start_link(host: "127.0.0.1", port: port, connect_timeout: 1_000)

        assert {:ok, %{"type" => "first"}} = Client.recv_envelope(client, 1_000)
        assert {:ok, %{"type" => "second"}} = Client.recv_envelope(client, 1_000)
        assert :ok = Client.close(client)
        Task.await(peer, 4_000)
      after
        Task.shutdown(peer, :brutal_kill)
        :gen_tcp.close(listener)
      end
    end
  end

  defp traced_received_bytes(target, received) when received >= target, do: received

  defp traced_received_bytes(target, received) do
    receive do
      {:trace, _pid, :return_from, {:gen_tcp, :recv, 3}, {:ok, bytes}} ->
        traced_received_bytes(target, received + byte_size(bytes))
    after
      2_000 -> flunk("setup received only #{received} of #{target} prefix bytes")
    end
  end

  defp drain_received_bytes(received) do
    receive do
      {:trace, _pid, :return_from, {:gen_tcp, :recv, 3}, {:ok, bytes}} ->
        drain_received_bytes(received + byte_size(bytes))
    after
      0 -> received
    end
  end

  defp start_peer(script) do
    {:ok, listener} =
      :gen_tcp.listen(0, [:binary, active: false, packet: :raw, reuseaddr: true])

    {:ok, port} = :inet.port(listener)
    owner = self()

    peer =
      Task.async(fn ->
        send(owner, {:peer_ready, self()})
        {:ok, socket} = :gen_tcp.accept(listener, 3_000)

        try do
          script.(socket)
        after
          :gen_tcp.close(socket)
        end
      end)

    peer_pid = peer.pid
    assert_receive {:peer_ready, ^peer_pid}, 2_000
    {port, listener, peer}
  end
end
