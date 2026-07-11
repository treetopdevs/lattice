defmodule LatticeNodeSpike.CarrierScenarioRunnerTest do
  use ExUnit.Case, async: false

  alias LatticeNodeSpike.{CarrierScenarioRunner, Scenario}

  @moduletag timeout: 120_000

  test "GATE: runs a partition and heal against the deterministic scenario oracle" do
    report =
      CarrierScenarioRunner.run!(Scenario,
        peer_realm: "node_a",
        local_realm: "node_b"
      )

    assert %{sent: 0, received: 0} = Map.take(report.base_sync, [:sent, :received])
    assert %{sent: 3, received: 3} = Map.take(report.heal_sync, [:sent, :received])
    assert %{sent: 0, received: 0} = Map.take(report.idempotent_sync, [:sent, :received])
    assert report.peer_state["op_ids"] == report.op_ids
  end
end
