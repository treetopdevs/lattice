defmodule LatticeStress.AtomvmTabDenialTest do
  use ExUnit.Case, async: false
  alias Lattice.Transport.WebSocket.Client
  alias LatticeStress.ProbeServer

  setup do
    Lattice.reset!()
    LatticeServer.DemoHub.reset()
    {:ok, probe} = ProbeServer.start_link(owner: self(), name: :atomvm_denial_probe)
    listener = :"atomvm_denial_#{System.unique_integer([:positive])}"
    port = free_port()

    {:ok, _} =
      LatticeServer.start_http(
        listener: listener,
        port: port,
        auto_story?: false,
        grant_targets: %{"echo" => probe, {"echo", :ops} => ["echo"]}
      )

    on_exit(fn -> LatticeServer.stop_http(listener) end)
    {:ok, %{port: port, probe: probe}}
  end

  test "Realm-produced forged-cap call is denied over /ws, target never sees it", %{
    port: port,
    probe: probe
  } do
    {:ok, client} = Client.connect(port: port)

    assert :ok =
             Client.send_envelope(client, %{type: "hello", identity: %{surface: "atomvm-tab"}})

    assert {:ok, %{"type" => "welcome"}} = recv_type(client, "welcome")

    # Exactly the shape Protocol.call/3 emits for a cap the tab never legitimately holds
    # (see protocol_test.exs "call/3 builds a call using the held echo cap").
    forged_call = %{
      type: "call",
      cap_id: "forged-not-a-real-cap",
      payload: %{op: "echo", message: "raw reach"}
    }

    assert :ok = Client.send_envelope(client, forged_call)
    assert {:ok, %{"type" => "call_result", "ok" => false}} = recv_type(client, "call_result")
    assert %{call_count: 0} = ProbeServer.stats(probe)
    Client.close(client)
  end

  test "revoke-then-call is denied over /ws (disconnect revokes caps)", %{
    port: port,
    probe: probe
  } do
    {:ok, client} = Client.connect(port: port)

    assert :ok =
             Client.send_envelope(client, %{type: "hello", identity: %{surface: "atomvm-tab"}})

    assert {:ok, %{"type" => "welcome", "tab_id" => tab_id}} = recv_type(client, "welcome")
    assert :ok = Client.send_envelope(client, %{type: "grant_request", target: "echo"})
    assert {:ok, %{"type" => "grant", "cap" => %{"id" => cap_id}}} = recv_type(client, "grant")

    assert :ok = Client.close(client)
    Process.sleep(20)
    assert {:error, :revoked} = Lattice.call(tab_id, cap_id, %{op: "echo"})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  defp free_port do
    {:ok, s} = :gen_tcp.listen(0, [:binary, active: false])
    {:ok, p} = :inet.port(s)
    :gen_tcp.close(s)
    p
  end

  defp recv_type(client, type, timeout \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_recv(client, type, deadline)
  end

  defp do_recv(client, type, deadline) do
    case Client.recv_envelope(client, max(deadline - System.monotonic_time(:millisecond), 1)) do
      {:ok, %{"type" => ^type} = e} -> {:ok, e}
      {:ok, _} -> do_recv(client, type, deadline)
      {:error, r} -> {:error, r}
    end
  end
end
