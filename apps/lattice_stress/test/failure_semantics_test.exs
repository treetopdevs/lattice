defmodule LatticeStress.FailureSemanticsTest do
  use ExUnit.Case, async: false

  alias LatticeStress.{ProbeServer, ProbeTab}

  setup do
    Lattice.reset!()
    Lattice.Demo.SecretServer.reset_deliveries()
    {:ok, probe} = ProbeServer.start_link(owner: self(), name: :failure_probe)
    {:ok, tab_pid, tab} = ProbeTab.connect(identity: %{user: "failure"})
    {:ok, %{probe: probe, tab_pid: tab_pid, tab: tab}}
  end

  test "server target crash fails closed with target_down and no new delivery", %{
    probe: probe,
    tab: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])
    assert {:ok, _} = Lattice.call(tab.id, cap, %{before: :crash})
    assert %{call_count: 1} = ProbeServer.stats(probe)

    ProbeServer.crash(probe)
    wait_until(fn -> not Process.alive?(probe) end)

    assert {:error, :target_down} = Lattice.call(tab.id, cap, %{after: :crash})
  end

  test "CapStore crash loses volatile caps and fails closed after supervisor restart", %{
    probe: probe,
    tab: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])
    old = Process.whereis(Lattice.CapStore)
    Process.exit(old, :kill)
    wait_until(fn -> restarted?(Lattice.CapStore, old) end)

    assert {:error, :unknown_cap} = Lattice.call(tab.id, cap, %{after_cap_store_crash: true})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  test "Topology crash loses volatile tabs and stale caps fail closed after restart", %{
    probe: probe,
    tab: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])
    old = Process.whereis(Lattice.Topology)
    Process.exit(old, :kill)
    wait_until(fn -> restarted?(Lattice.Topology, old) end)

    refute Lattice.Topology.tab_connected?(tab.id)
    assert {:error, :tab_not_connected} = Lattice.call(tab.id, cap, %{after_topology_crash: true})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  test "Audit crash loses volatile history but authorization still fails closed afterward", %{
    probe: probe,
    tab: tab
  } do
    old = Process.whereis(Lattice.Audit)
    Process.exit(old, :kill)
    wait_until(fn -> restarted?(Lattice.Audit, old) end)

    assert {:error, :unknown_cap} = Lattice.call(tab.id, "forged-after-audit-crash", %{})
    assert %{call_count: 0} = ProbeServer.stats(probe)
    assert Enum.any?(Lattice.audit_events(), &(&1.type == :deny))
  end

  test "tab transport crash disconnects tab and revokes owned caps", %{
    probe: probe,
    tab_pid: tab_pid,
    tab: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])
    Process.unlink(tab_pid)
    Process.exit(tab_pid, :kill)
    wait_until(fn -> match?({:ok, %{state: :disconnected}}, Lattice.Topology.get_tab(tab.id)) end)

    assert {:error, :revoked} = Lattice.call(tab.id, cap, %{after_tab_crash: true})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  test "SecretServer crash and restart does not create ambient authority", %{tab: tab} do
    old = Process.whereis(Lattice.Demo.SecretServer)
    Process.exit(old, :kill)
    wait_until(fn -> restarted?(Lattice.Demo.SecretServer, old) end)
    Lattice.Demo.SecretServer.reset_deliveries()

    assert {:error, :unknown_cap} = Lattice.call(tab.id, "secret-after-restart", %{})
    assert [] = Lattice.Demo.SecretServer.deliveries()
  end

  defp restarted?(name, old_pid) do
    pid = Process.whereis(name)
    is_pid(pid) and pid != old_pid and Process.alive?(pid)
  end

  defp wait_until(fun, timeout \\ 1_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_wait_until(fun, deadline)
  end

  defp do_wait_until(fun, deadline) do
    cond do
      fun.() ->
        :ok

      System.monotonic_time(:millisecond) >= deadline ->
        flunk("condition did not become true before timeout")

      true ->
        Process.sleep(5)
        do_wait_until(fun, deadline)
    end
  end
end
