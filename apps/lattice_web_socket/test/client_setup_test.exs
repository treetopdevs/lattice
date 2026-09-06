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
