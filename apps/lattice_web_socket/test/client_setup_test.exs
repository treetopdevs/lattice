defmodule LatticeWebSocket.ClientSetupTest do
  use ExUnit.Case, async: true

  alias Lattice.Transport.WebSocket.Client

  test "the configured setup deadline closes a peer that never upgrades" do
    {port, listener, peer} =
      start_peer(fn socket ->
        assert {:ok, _request} = :gen_tcp.recv(socket, 0, 1_000)
        assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
      end)

    connector =
      Task.async(fn ->
        Process.flag(:trap_exit, true)
        Client.start_link(host: "127.0.0.1", port: port, connect_timeout: 50)
      end)

    try do
      assert {:ok, {:error, :timeout}} = Task.yield(connector, 500)
      Task.await(peer)
    after
      Task.shutdown(connector, :brutal_kill)
      Task.shutdown(peer, :brutal_kill)
      :gen_tcp.close(listener)
    end
  end

  test "the upgrade header byte budget rejects a streaming peer before the deadline" do
    {port, listener, peer} =
      start_peer(fn socket ->
        assert {:ok, _request} = :gen_tcp.recv(socket, 0, 1_000)
        assert :ok = :gen_tcp.send(socket, String.duplicate("H", 64_001))
        assert {:error, :closed} = :gen_tcp.recv(socket, 0, 1_000)
      end)

    connector =
      Task.async(fn ->
        Process.flag(:trap_exit, true)
        Client.start_link(host: "127.0.0.1", port: port, connect_timeout: 1_000)
      end)

    try do
      assert {:ok, {:error, :upgrade_headers_too_large}} = Task.yield(connector, 500)
      Task.await(peer)
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

    peer =
      Task.async(fn ->
        {:ok, socket} = :gen_tcp.accept(listener)

        try do
          script.(socket)
        after
          :gen_tcp.close(socket)
        end
      end)

    {port, listener, peer}
  end
end
