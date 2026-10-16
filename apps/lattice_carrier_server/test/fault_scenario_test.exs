defmodule LatticeCarrierServer.FaultScenarioTest do
  # Plan 204: the two process-level fault scenarios, written in the plan 203 evidence
  # format. With LATTICE_FAULT_OUT set, the `:fault_evidence` tests write evidence
  # directories there for `mix lattice.fault verify|report`.
  use ExUnit.Case, async: false

  alias Lattice.{FaultScenario, Log, Sim}
  alias Lattice.FaultScenario.{Evidence, Report}
  alias LatticeCarrierServer.FaultScenario, as: Carrier

  @moduletag timeout: 180_000
  @seed "plan-204"

  setup do
    Carrier.isolate_application()
  end

  @tag :tmp_dir
  test "the booted runtime relays one signed Thread post", %{tmp_dir: dir} do
    {_sim, base, [op]} = Carrier.thread("stall_shutdown", @seed, 1)
    f = Carrier.boot(dir, base)
    assert {:ok, %{accepted: [id]}} = LatticeCarrierServer.Holder.relay(f.holder, "relay", op)
    assert id == op.id
    assert {:ok, %{log: log}} = Log.restore_verified(f.path)
    assert log.replica == FaultScenario.expected_replicas("stall_shutdown", @seed)["thread"]
    assert op.id in Log.op_ids(log)
  end

  describe "stall_shutdown" do
    @describetag :tmp_dir
    @describetag :fault_evidence

    test "a drain blocked by a stalled sync fails closed", %{tmp_dir: dir} do
      result = Carrier.stall_shutdown(dir, @seed)
      assert_held(result)
      assert_evidence("stall_shutdown", result, dir)
    end

    test "negative control: releasing the sync before the deadline is violated", %{
      tmp_dir: dir
    } do
      result = Carrier.stall_shutdown(dir, @seed, variant: :released)
      assert {"drain_returned_error", false} in result.checks
      assert verdict("stall_shutdown", result, dir) == "violated"
    end
  end

  describe "crash_relay" do
    @describetag :tmp_dir
    @describetag :fault_evidence

    test "acknowledged relays survive a halted BEAM and match Sim", %{tmp_dir: dir} do
      result = Carrier.crash_relay(dir, @seed)
      assert_held(result)
      assert_evidence("crash_relay", result, dir)
    end

    test "negative control: restarting from a lost log is violated", %{tmp_dir: dir} do
      result = Carrier.crash_relay(dir, @seed, variant: :lost_log)
      assert {"acked_survive_restart", false} in result.checks
      assert verdict("crash_relay", result, dir) == "violated"
    end
  end

  @tag :tmp_dir
  test "verify refuses a crash_relay directory carrying another replica's Thread log", %{
    tmp_dir: dir
  } do
    out = Path.join(dir, "evidence")
    run = Path.join(dir, "run")
    File.mkdir_p!(run)
    result = Carrier.crash_relay(run, @seed)
    assert {:ok, "held"} = write(out, "crash_relay", result)
    assert {:ok, _} = Evidence.verify(out)

    # An authentic, verifiable Thread log of the same name and shape from another seed.
    {sim, _base, _posts} = Carrier.thread("crash_relay", "another-seed", 3)
    other = Sim.log(sim, "owner")
    refute other.replica == result.logs["thread.server"].replica
    :ok = Log.dump(other, Path.join([out, "logs", "thread.server.log"]))

    assert {:error, reasons} = Evidence.verify(out)
    assert Enum.any?(reasons, &(&1 =~ "unexpected replica"))
  end

  defp assert_held(%{checks: checks}) do
    for {check, ok} <- checks, do: assert(ok, "#{check} did not hold")
  end

  # Write, verify in this VM, render, and copy to LATTICE_FAULT_OUT when set.
  defp assert_evidence(name, result, dir) do
    out = Path.join([dir, "evidence", name])
    assert {:ok, "held"} = write(out, name, result)

    assert {:ok, %{verdict: "held", checks: checks}} = Evidence.verify(out)
    assert Enum.all?(checks, &(&1.source == :process and &1.ok))

    {:ok, page, [entry]} = Report.write(Path.dirname(out))
    assert {:ok, _} = entry.result
    assert File.read!(page) =~ "replay verified, process checks recorded"

    case System.get_env("LATTICE_FAULT_OUT") do
      nil -> :ok
      root -> copy_evidence(out, Path.join(Path.expand(root), name))
    end
  end

  defp verdict(name, result, dir) do
    out = Path.join([dir, "evidence", name])
    {:ok, verdict} = write(out, name, result)
    assert {:ok, %{verdict: ^verdict}} = Evidence.verify(out)
    verdict
  end

  defp write(out, name, %{logs: logs, checks: checks, observed_ms: observed_ms}),
    do: Evidence.write(out, name, @seed, logs, checks: checks, observed_ms: observed_ms)

  defp copy_evidence(from, to) do
    File.rm_rf!(to)
    File.mkdir_p!(Path.dirname(to))
    {:ok, _} = File.cp_r(from, to)
  end
end
