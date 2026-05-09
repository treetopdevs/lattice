defmodule LatticeStress.RaceConcurrencyTest do
  use ExUnit.Case, async: false

  alias LatticeStress.{Barrier, ProbeServer, ProbeTab}

  setup do
    Lattice.reset!()
    {:ok, probe} = ProbeServer.start_link(owner: self(), name: :race_probe)
    {:ok, tab_a_pid, tab_a} = ProbeTab.connect(identity: %{user: "race-a"})
    {:ok, tab_b_pid, tab_b} = ProbeTab.connect(identity: %{user: "race-b"})
    {:ok, tab_c_pid, tab_c} = ProbeTab.connect(identity: %{user: "race-c"})

    {:ok,
     %{
       probe: probe,
       tab_a_pid: tab_a_pid,
       tab_a: tab_a,
       tab_b_pid: tab_b_pid,
       tab_b: tab_b,
       tab_c_pid: tab_c_pid,
       tab_c: tab_c
     }}
  end

  test "call already delivered may finish while revoke commits, but later calls never deliver", %{
    probe: probe,
    tab_a: tab
  } do
    {:ok, barrier} = Barrier.start_link()
    :ok = ProbeServer.set_barrier(probe, barrier)
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])

    task = Task.async(fn -> Lattice.call(tab.id, cap, %{race: :revoke}) end)
    assert :ok = Barrier.await_waiting(barrier, 1)
    assert :ok = Lattice.revoke(cap, :race_revoke_committed)
    assert :ok = Barrier.release(barrier)
    assert {:ok, _} = Task.await(task)
    assert %{call_count: 1} = ProbeServer.stats(probe)

    assert :ok = ProbeServer.reset(probe)
    assert {:error, :revoked} = Lattice.call(tab.id, cap, %{race: :after_revoke})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  test "call while tab disconnects fails closed after disconnect commits", %{
    probe: probe,
    tab_a: tab
  } do
    {:ok, barrier} = Barrier.start_link()
    :ok = ProbeServer.set_barrier(probe, barrier)
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])

    task = Task.async(fn -> Lattice.call(tab.id, cap, %{race: :disconnect}) end)
    assert :ok = Barrier.await_waiting(barrier, 1)
    assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)
    assert :ok = Barrier.release(barrier)
    assert {:ok, _} = Task.await(task)

    assert :ok = ProbeServer.reset(probe)
    assert {:error, :revoked} = Lattice.call(tab.id, cap, %{race: :after_disconnect})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  test "call while tab ejects fails closed after eject commits", %{probe: probe, tab_a: tab} do
    {:ok, barrier} = Barrier.start_link()
    :ok = ProbeServer.set_barrier(probe, barrier)
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])

    task = Task.async(fn -> Lattice.call(tab.id, cap, %{race: :eject}) end)
    assert :ok = Barrier.await_waiting(barrier, 1)
    assert {:ok, _closed} = Lattice.eject(tab.id, :race_eject_committed)
    assert :ok = Barrier.release(barrier)
    assert {:ok, _} = Task.await(task)

    assert :ok = ProbeServer.reset(probe)
    assert {:error, :revoked} = Lattice.call(tab.id, cap, %{race: :after_eject})
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  test "bridge expiry while many calls are in flight never exceeds authorized deliveries", %{
    tab_a: tab_a,
    tab_b: tab_b,
    tab_b_pid: tab_b_pid
  } do
    {:ok, cap} = Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 8)
    Process.sleep(12)

    results =
      1..25
      |> Task.async_stream(fn i -> Lattice.call(tab_a.id, cap, %{op: :relay, i: i}) end,
        max_concurrency: 10
      )
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.all?(results, &match?({:error, :expired}, &1))
    assert 0 = ProbeTab.delivered_count(tab_b_pid)
  end

  test "use-limit exhausted by concurrent callers delivers at most the configured limit", %{
    probe: probe,
    tab_a: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call], use_limit: 5)

    results =
      1..40
      |> Task.async_stream(fn i -> Lattice.call(tab.id, cap, %{i: i}) end, max_concurrency: 20)
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.count(results, &match?({:ok, _}, &1)) == 5
    assert Enum.count(results, &match?({:error, :use_limit_exceeded}, &1)) == 35
    assert %{call_count: 5} = ProbeServer.stats(probe)
  end

  test "worker cleanup racing with calls leaves no live worker after disconnect", %{
    probe: probe,
    tab_a: tab
  } do
    {:ok, worker} = Lattice.spawn_linked(tab.id, Lattice.Demo.TabWorker, [], [])
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call])

    callers =
      for i <- 1..20 do
        Task.async(fn -> Lattice.call(tab.id, cap, %{i: i}) end)
      end

    assert {:ok, _closed} = Lattice.disconnect_tab(tab.id)
    Enum.each(callers, &Task.await(&1))
    refute Process.alive?(worker)
  end

  test "bridge creation while destination disconnects either fails or creates no usable path", %{
    tab_a: tab_a,
    tab_b: tab_b,
    tab_b_pid: tab_b_pid
  } do
    bridge_task = Task.async(fn -> Lattice.bridge(tab_a.id, tab_b.id, [:call], ttl: 10_000) end)
    disconnect_task = Task.async(fn -> Lattice.disconnect_tab(tab_b.id) end)

    bridge_result = Task.await(bridge_task)
    assert {:ok, _closed} = Task.await(disconnect_task)

    case bridge_result do
      {:ok, cap} ->
        assert {:error, reason} = Lattice.call(tab_a.id, cap, %{op: :relay})
        assert reason in [:tab_not_connected, :revoked, :bridge_required]

      {:error, :tab_not_connected} ->
        :ok
    end

    assert 0 = ProbeTab.delivered_count(tab_b_pid)
  end

  test "bridge revocation while a message is in flight closes later traffic", %{
    tab_a: tab_a,
    tab_b: tab_b,
    tab_b_pid: tab_b_pid
  } do
    {:ok, barrier} = Barrier.start_link()
    {:ok, blocking_pid, blocking_tab} = ProbeTab.connect(barrier: barrier)
    {:ok, cap} = Lattice.bridge(tab_a.id, blocking_tab.id, [:call], ttl: 10_000)

    task = Task.async(fn -> Lattice.call(tab_a.id, cap, %{op: :relay}) end)
    assert :ok = Barrier.await_waiting(barrier, 1)
    assert :ok = Lattice.revoke(cap, :bridge_race)
    assert :ok = Barrier.release(barrier)
    assert {:ok, _} = Task.await(task)
    assert 1 = ProbeTab.delivered_count(blocking_pid)

    assert {:error, :revoked} = Lattice.call(tab_a.id, cap, %{op: :relay})
    assert 1 = ProbeTab.delivered_count(blocking_pid)
    assert 0 = ProbeTab.delivered_count(tab_b_pid)
    assert tab_b.id != blocking_tab.id
  end

  test "cap expiry while many calls are in flight stops later delivery", %{
    probe: probe,
    tab_a: tab
  } do
    {:ok, cap} = Lattice.grant(tab.id, probe, [:call], ttl: 8)
    Process.sleep(12)

    results =
      1..30
      |> Task.async_stream(fn i -> Lattice.call(tab.id, cap, %{i: i}) end, max_concurrency: 10)
      |> Enum.map(fn {:ok, result} -> result end)

    assert Enum.all?(results, &match?({:error, :expired}, &1))
    assert %{call_count: 0} = ProbeServer.stats(probe)
  end

  test "MovableProcess tab-side operation while tab disconnects fails closed", %{tab_a: tab} do
    {:ok, barrier} = Barrier.start_link()

    {:ok, tab_pid, blocking_tab} =
      ProbeTab.connect(
        barrier: barrier,
        handlers: [render_preview: fn payload -> %{rendered: payload.storyboard} end]
      )

    {:ok, proc} = Lattice.MovableProcess.new(blocking_tab.id)
    assert {:ok, _} = Lattice.MovableProcess.generate_storyboard(proc, "race")

    task = Task.async(fn -> Lattice.MovableProcess.render_preview(proc) end)
    assert :ok = Barrier.await_waiting(barrier, 1)
    assert {:ok, _closed} = Lattice.disconnect_tab(blocking_tab.id)
    assert :ok = Barrier.release(barrier)
    assert {:ok, _} = Task.await(task)

    assert {:error, :revoked} = Lattice.MovableProcess.render_preview(proc)
    assert 1 = ProbeTab.delivered_count(tab_pid)
    assert tab.id != blocking_tab.id
  end

  test "TabWorker crash while parent tab is ejected leaves no live worker", %{tab_a: tab} do
    {:ok, worker} = Lattice.spawn_linked(tab.id, Lattice.Demo.TabWorker, [], [])
    crash_task = Task.async(fn -> Process.exit(worker, :kill) end)
    eject_task = Task.async(fn -> Lattice.eject(tab.id, :worker_crash_race) end)

    Task.await(crash_task)
    assert {:ok, _closed} = Task.await(eject_task)
    refute Process.alive?(worker)
  end

  test "CapStore lookup under concurrent grant/revoke pressure fails closed or returns live caps",
       %{
         probe: probe,
         tab_a: tab
       } do
    tasks =
      for i <- 1..100 do
        Task.async(fn ->
          {:ok, cap} = Lattice.grant(tab.id, probe, [:call], id: "pressure_#{i}")
          lookup = Lattice.CapStore.get(cap.id)
          revoke = Lattice.revoke(cap, :pressure)
          {lookup, revoke, Lattice.call(tab.id, cap, %{i: i})}
        end)
      end

    for task <- tasks do
      assert {{:ok, _cap}, :ok, {:error, :revoked}} = Task.await(task)
    end

    assert %{call_count: 0} = ProbeServer.stats(probe)
  end
end
