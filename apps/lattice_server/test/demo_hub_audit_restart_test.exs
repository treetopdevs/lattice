defmodule LatticeServer.DemoHubAuditRestartTest do
  use ExUnit.Case, async: false

  # Row 231: DemoHub read the audit list through `Lattice.audit_events/0` and
  # took a LiveOps snapshot, so either read exited `:noproc` while Audit was
  # mid-restart and killed DemoHub. Terminating the child through the
  # supervisor makes the unavailable window deterministic.

  setup do
    :ok = LatticeServer.DemoHub.reset()
    on_exit(fn -> LatticeServer.DemoHub.reset() end)
    :ok
  end

  test "DemoHub snapshot and event broadcast survive an unavailable Audit" do
    hub = Process.whereis(LatticeServer.DemoHub)
    liveops = Process.whereis(Lattice.LiveOps)
    stop_audit()

    # A cast that runs `broadcast_event/2`; the following call is queued
    # behind it, so the snapshot synchronizes on the cast having run.
    LatticeServer.DemoHub.event(:row_231_probe, %{})

    assert %{audit_count: 0, liveops: %{counters: %{audit: 0}}} =
             LatticeServer.DemoHub.snapshot()

    assert Process.whereis(LatticeServer.DemoHub) == hub
    assert Process.whereis(Lattice.LiveOps) == liveops
  end

  test "DemoHub register and unregister survive an unavailable Audit" do
    hub = Process.whereis(LatticeServer.DemoHub)
    stop_audit()

    # register/2 and unregister/1 broadcast presence, which reads the audit
    # count; auto_story? false keeps the bridge story out of the run.
    tab = %{id: "row-231-tab", session_id: "row-231-session", metadata: %{}}

    assert %{audit_count: 0, tabs: [%{id: "row-231-tab"}]} =
             LatticeServer.DemoHub.register(tab, auto_story?: false)

    assert_receive {:lattice_demo_push, %{type: "presence", audit_count: 0}}
    assert :ok = LatticeServer.DemoHub.unregister("row-231-tab")
    assert Process.whereis(LatticeServer.DemoHub) == hub
  end

  test "DemoHub snapshot survives LiveOps dying while the snapshot call is queued" do
    hub = Process.whereis(LatticeServer.DemoHub)
    liveops = Process.whereis(Lattice.LiveOps)
    :ok = :sys.suspend(liveops)

    snapshot = Task.async(fn -> LatticeServer.DemoHub.snapshot() end)
    await_queued_snapshot_call(liveops, hub)

    Process.exit(liveops, :kill)

    assert %{type: "snapshot", liveops: nil} = Task.await(snapshot)
    assert Process.whereis(LatticeServer.DemoHub) == hub

    # Leave a restarted LiveOps for the next test.
    await_restarted(Lattice.LiveOps, liveops)
  end

  defp stop_audit do
    :ok = Supervisor.terminate_child(LatticeCore.Supervisor, Lattice.Audit)

    on_exit(fn ->
      case Supervisor.restart_child(LatticeCore.Supervisor, Lattice.Audit) do
        {:ok, _pid} -> :ok
        {:error, :running} -> :ok
        {:error, {:already_started, _pid}} -> :ok
      end
    end)
  end

  defp await_restarted(name, old_pid, attempts \\ 200) do
    case Process.whereis(name) do
      pid when is_pid(pid) and pid != old_pid ->
        :ok

      _other when attempts > 0 ->
        Process.sleep(5)
        await_restarted(name, old_pid, attempts - 1)

      _other ->
        flunk("#{inspect(name)} was not restarted by its supervisor")
    end
  end

  # The suspended LiveOps still accepts messages, so DemoHub's call sits in
  # its mailbox until LiveOps is killed.
  defp await_queued_snapshot_call(liveops, hub, attempts \\ 200) do
    {:messages, messages} = Process.info(liveops, :messages)

    queued? =
      Enum.any?(messages, fn
        {:"$gen_call", {^hub, _tag}, :snapshot} -> true
        _other -> false
      end)

    cond do
      queued? ->
        :ok

      attempts > 0 ->
        Process.sleep(5)
        await_queued_snapshot_call(liveops, hub, attempts - 1)

      true ->
        flunk("DemoHub's LiveOps snapshot call never reached the LiveOps mailbox")
    end
  end
end
