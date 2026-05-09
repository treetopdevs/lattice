defmodule LatticeDemo.PocTest do
  use ExUnit.Case, async: false

  alias LatticeDemo.TestTabClient

  setup do
    Lattice.reset!()
    :ok
  end

  test "echo server is reachable only by explicit cap and secret server is not ambiently reachable" do
    {:ok, _pid, tab} = TestTabClient.connect(identity: %{user: "demo"})
    {:ok, echo_cap} = Lattice.grant(tab.id, Lattice.Demo.EchoServer, [:call])

    assert {:ok, %{echo: %{message: "allowed"}}} =
             Lattice.call(tab.id, echo_cap, %{message: "allowed"})

    assert {:error, :unknown_cap} =
             Lattice.call(tab.id, "secret-server-is-not-a-cap", %{message: "secret"})

    refute Enum.any?(Lattice.audit_events(), fn event ->
             event.type == :grant and event.metadata.target == "Elixir.Lattice.Demo.SecretServer"
           end)
  end

  test "tab worker started through Lattice.spawn_linked is cleaned on disconnect" do
    {:ok, _pid, tab} = TestTabClient.connect()
    {:ok, worker} = Lattice.spawn_linked(tab.id, Lattice.Demo.TabWorker, [], [])

    assert {:pong, tab_id} = Lattice.Demo.TabWorker.ping(worker)
    assert tab_id == tab.id

    assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)
    refute Process.alive?(worker)
  end

  test "deterministic demo flow covers stolen cap, secret denial, bridge, disconnect, and cleanup" do
    {:ok, tab_a_pid, tab_a} = TestTabClient.connect(identity: %{user: "alice"})

    {:ok, _tab_b_pid, tab_b} =
      TestTabClient.connect(
        identity: %{user: "bob"},
        handlers: [relay: fn payload -> %{relayed: payload} end]
      )

    {:ok, worker} = Lattice.spawn_linked(tab_a.id, Lattice.Demo.TabWorker, [], [])

    {:ok, echo_cap} = Lattice.grant(tab_a.id, Lattice.Demo.EchoServer, [:call])

    assert {:ok, %{echo: %{message: "A"}}} =
             TestTabClient.call(tab_a_pid, echo_cap, %{message: "A"})

    assert {:error, :wrong_owner} = Lattice.call(tab_b.id, echo_cap, %{message: "stolen"})
    assert {:error, :unknown_cap} = Lattice.call(tab_a.id, "no-secret-cap", %{message: "secret"})

    {:ok, bridge_cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 10_000)

    assert {:ok, %{relayed: %{op: :relay, body: "hello B"}}} =
             Lattice.call(tab_a.id, bridge_cap, %{op: :relay, body: "hello B"})

    assert {:ok, _closed} = Lattice.disconnect_tab(tab_a.id)
    refute Process.alive?(worker)

    assert Enum.any?(Lattice.audit_events(), &(&1.type == :bridge))
    assert Enum.any?(Lattice.audit_events(), &(&1.type == :worker_cleanup))
  end
end
