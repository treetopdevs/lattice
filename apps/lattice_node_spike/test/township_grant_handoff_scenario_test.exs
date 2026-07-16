defmodule LatticeNodeSpike.TownshipGrantHandoffScenarioTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Sim}
  alias LatticeNodeSpike.{TownshipGrantHandoffScenario, TownshipOnboardingScenario}
  alias Township.Matter

  test "Sim derives the fixed grant, recipient use, and non-attenuating negative from the onboarding base" do
    oracle = TownshipGrantHandoffScenario.oracle()
    existing_base_log = TownshipOnboardingScenario.base_sim() |> Sim.log("clerk")

    assert Log.topo_ops(oracle.base.log) == Log.topo_ops(existing_base_log)
    assert oracle.replica == existing_base_log.replica
    assert oracle.base.projection.op_ids == existing_base_log |> Log.op_ids() |> Enum.sort()

    assert oracle.issuer.realm == "clerk"
    assert oracle.recipient.realm == "grant-recipient"
    assert oracle.unsound_audience.realm == "unsound-audience"
    assert oracle.issuer.identity.pub != oracle.recipient.identity.pub
    assert oracle.recipient.identity.pub != oracle.unsound_audience.identity.pub

    genesis_id = genesis_delegation_id!(oracle.base.log)
    sound = oracle.sound_grant.delegation
    sound_op = oracle.sound_grant.op

    assert sound.issuer == oracle.issuer.identity.pub
    assert sound.audience == oracle.recipient.identity.pub
    assert sound.parent_id == genesis_id
    assert sound.ops == MapSet.new([:admit, :post, :set_summary, :set_title])
    assert sound.roles == MapSet.new()
    assert sound.live == false
    assert sound_op.deps == Log.frontier(oracle.base.log)
    assert sound_op.body == {:grant, sound}
    refute Map.has_key?(oracle.sound_grant.projection.read_model.roles.reasons, sound_op.id)

    recipient_use = oracle.recipient_use.op
    assert recipient_use.cap == sound.id
    assert recipient_use.deps == Log.frontier(oracle.sound_grant.log)
    assert recipient_use.body == {:post, [oracle.recipient_use.text]}
    assert oracle.recipient_use.text in oracle.recipient_use.projection.read_model.threads.posts

    refute Map.has_key?(
             oracle.recipient_use.projection.read_model.roles.reasons,
             recipient_use.id
           )

    unsound = oracle.unsound_grant.delegation
    unsound_op = oracle.unsound_grant.op

    assert unsound.issuer == oracle.recipient.identity.pub
    assert unsound.audience == oracle.unsound_audience.identity.pub
    assert unsound.parent_id == sound.id
    assert unsound.ops == MapSet.new([:close_matter])
    assert unsound.roles == MapSet.new([:clerk])
    assert unsound.live == false

    assert oracle.unsound_grant.projection.read_model.roles.reasons[unsound_op.id] ==
             :not_attenuated

    unsound_use = oracle.unsound_use.op
    assert unsound_use.cap == unsound.id
    assert unsound_op.id in unsound_use.deps
    assert unsound_use.body == {:close_matter, []}
    assert oracle.final.projection.read_model.roles.reasons[unsound_op.id] == :not_attenuated
    assert oracle.final.projection.read_model.roles.reasons[unsound_use.id] == :invalid_capability

    assert Lattice.state(Matter, oracle.final.log) ==
             Lattice.state(Matter, oracle.recipient_use.log)

    assert oracle.final.projection.causal_replay == Township.ReadModel.replay(oracle.final.log)
    assert oracle.final.projection.op_ids == oracle.final.log |> Log.op_ids() |> Enum.sort()
  end

  defp genesis_delegation_id!(log) do
    Enum.find_value(Log.topo_ops(log), fn
      %{kind: :authority, body: {:genesis, delegation, _policies}} -> delegation.id
      _op -> nil
    end) || raise "grant handoff fixture missing genesis delegation"
  end
end
