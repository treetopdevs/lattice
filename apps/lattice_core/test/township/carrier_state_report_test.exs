defmodule Township.CarrierStateReportTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Op, Sim, Sync}
  alias Township.{CarrierStateReport, Matter}

  test "reports deterministic state and keeps structural attempts outside authority op ids" do
    sim =
      Sim.new(Matter, "replica:matter:carrier-state-report", ["clerk", "resident"],
        seed: "state-report"
      )

    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, delegation} = Sim.grant(sim, "clerk", "resident", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, _accepted} = Sim.command(sim, "resident", :post, ["accepted before revoke"])
    sim = Sim.sync_all(sim)
    {sim, _revoke} = Sim.revoke(sim, "clerk", delegation.id)
    sim = Sim.sync(sim, "clerk", "resident")

    {sim, revoked} =
      Sim.command(sim, "resident", :post, ["rejected after revoke"], cap: delegation.id)

    log = sim |> Sim.sync_all() |> Sim.log("clerk")

    forged =
      sim
      |> Sim.identity("resident")
      |> Op.new(log.replica, Log.frontier(log), :command, {:post, "bad signature"})
      |> Map.put(:sig, <<0::512>>)

    {log, %{quarantined: [{forged_id, :bad_signature}]}} = Sync.deliver(log, [forged])
    assert forged_id == forged.id

    report = CarrierStateReport.report(log)
    expected_state = Lattice.state(Matter, log)

    assert report.state == expected_state

    assert Base.decode64!(report.state_b64) ==
             :erlang.term_to_binary(expected_state, [:deterministic, {:minor_version, 2}])

    assert report.op_ids == log |> Log.op_ids() |> Enum.sort()
    assert report.frontier == Log.frontier(log)
    assert report.log_size == Log.size(log)
    assert [revoked.id, "revoked_capability"] in report.authority_quarantine
    assert [forged.id, "bad_signature"] in report.structural_quarantine
    refute forged.id in report.op_ids
  end
end
