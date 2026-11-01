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
    :ok = Supervisor.terminate_child(LatticeCore.Supervisor, Lattice.Audit)

    on_exit(fn ->
      case Supervisor.restart_child(LatticeCore.Supervisor, Lattice.Audit) do
        {:ok, _pid} -> :ok
        {:error, :running} -> :ok
        {:error, {:already_started, _pid}} -> :ok
      end
    end)

    # A cast that runs `broadcast_event/2`; the following call is queued
    # behind it, so the snapshot synchronizes on the cast having run.
    LatticeServer.DemoHub.event(:row_231_probe, %{})

    assert %{audit_count: 0, liveops: %{counters: %{audit: 0}}} =
             LatticeServer.DemoHub.snapshot()

    assert Process.whereis(LatticeServer.DemoHub) == hub
    assert Process.whereis(Lattice.LiveOps) == liveops
  end
end
