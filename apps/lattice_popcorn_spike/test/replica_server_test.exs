Code.require_file("support/server.exs", __DIR__)
ExUnit.start()

defmodule LatticePopcornSpike.ReplicaGatewayTest do
  use ExUnit.Case, async: false
  alias Lattice.Transport.WebSocket.Client
  alias LatticeBrowser.Durable

  test "two signed replicas converge through Gateway; revoked writes never materialize" do
    {:ok, listener} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, port} = :inet.port(listener)
    :gen_tcp.close(listener)
    {:ok, _} = LatticePopcornSpike.Server.start(port)
    on_exit(fn -> :cowboy.stop_listener(:lattice_popcorn_proof) end)
    {ca, capa, a} = connect(port)
    {cb, capb, b} = connect(port)
    {:ok, a, _} = Durable.post(a, "alice")
    {:ok, b, _} = Durable.post(b, "bob")
    {a, _} = sync(ca, capa, a)
    {b, _} = sync(cb, capb, b)
    {a, _} = sync(ca, capa, a)
    assert Durable.view(a)["notes"] == Durable.view(b)["notes"]
    assert Enum.sort(Durable.view(a)["notes"]) == ["alice", "bob"]
    assert Durable.view(a)["op_ids"] == Durable.view(b)["op_ids"]
    {:ok, restored} = Durable.restore(Durable.capsule(a))
    assert restored.identity == a.identity
    {:ok, stale, op} = Durable.post(a, "offline revoked")
    GenServer.call(LatticePopcornSpike.ReplicaServer, {:revoke, Durable.view(a)["public_key"]})
    {a, result} = sync(ca, capa, stale)
    refute op.id in result["accepted"]
    assert Durable.view(a)["rejected"][op.id] == "revoked_capability"
    refute "offline revoked" in Durable.view(a)["notes"]
    assert {:error, :revoked_capability} = Durable.post(a, "observed revoked")
    {b, _} = sync(cb, capb, b)
    assert Durable.view(a)["op_ids"] == Durable.view(b)["op_ids"]
    assert Durable.view(a)["notes"] == Durable.view(b)["notes"]
    {_, replay} = sync(ca, capa, a)
    assert replay["accepted"] == []
    [first | rest] = Durable.upload(a)

    response =
      request(ca, capa, %{"action" => "sync", "ops" => [Map.put(first, "sig", "AAAA") | rest]})

    assert response["ok"] == false
    response = request(ca, "forged", %{"action" => "sync", "ops" => Durable.upload(a)})
    assert response["ok"] == false
    Client.close(ca)
    Client.close(cb)
  end

  defp connect(port) do
    {:ok, client} = Client.connect(port: port)
    :ok = Client.send_envelope(client, %{"type" => "hello"})
    recv(client, "welcome")
    :ok = Client.send_envelope(client, %{"type" => "grant_request", "target" => "replica_demo"})
    cap = recv(client, "grant")["cap"]["id"]
    {:ok, state} = Durable.restore(nil)

    response =
      request(client, cap, %{
        "action" => "enroll",
        "public_key" => Durable.view(state)["public_key"]
      })

    assert response["ok"]
    {:ok, state} = Durable.receive_log(state, response["result"]["log"])
    {client, cap, state}
  end

  defp sync(client, cap, state) do
    response = request(client, cap, %{"action" => "sync", "ops" => Durable.upload(state)})
    assert response["ok"]
    {:ok, state} = Durable.receive_log(state, response["result"]["log"])
    {state, response["result"]}
  end

  defp request(client, cap, payload) do
    Client.send_envelope(client, %{"type" => "call", "cap_id" => cap, "payload" => payload})
    recv(client, "call_result")
  end

  defp recv(client, type), do: recv(client, type, System.monotonic_time(:millisecond) + 5000)

  defp recv(client, type, deadline) do
    remaining = deadline - System.monotonic_time(:millisecond)
    assert remaining > 0
    assert {:ok, frame} = Client.recv_envelope(client, remaining)
    if frame["type"] == type, do: frame, else: recv(client, type, deadline)
  end
end
