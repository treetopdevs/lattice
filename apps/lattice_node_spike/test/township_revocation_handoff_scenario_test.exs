defmodule LatticeNodeSpike.TownshipRevocationHandoffScenarioTest do
  use ExUnit.Case, async: true

  alias Lattice.{Dag, Log}
  alias LatticeNodeSpike.TownshipRevocationHandoffScenario
  alias Township.{Matter, ReadModel}

  test "Sim derives an honored revoke and causally later revoked-capability refusal" do
    oracle = TownshipRevocationHandoffScenario.oracle()

    assert oracle.issuer.realm == "clerk"
    assert oracle.recipient.realm == "revocation-recipient"
    assert oracle.issuer.identity.pub != oracle.recipient.identity.pub

    delegation = oracle.grant.delegation
    pre_revoke = oracle.pre_revoke_use.op
    revoke = oracle.revoke.op
    revoked_use = oracle.revoked_use.op

    assert delegation.issuer == oracle.issuer.identity.pub
    assert delegation.audience == oracle.recipient.identity.pub
    assert delegation.replica == oracle.replica
    assert delegation.ops == MapSet.new([:post])
    refute Map.has_key?(oracle.grant.projection.read_model.roles.reasons, oracle.grant.op.id)

    assert pre_revoke.author == oracle.recipient.identity.pub
    assert pre_revoke.cap == delegation.id
    assert pre_revoke.body == {:post, [oracle.pre_revoke_use.text]}
    refute Map.has_key?(oracle.pre_revoke_use.projection.read_model.roles.reasons, pre_revoke.id)

    assert revoke.author == oracle.issuer.identity.pub
    assert revoke.body == {:revoke, delegation.id}
    assert revoke.deps == Log.frontier(oracle.pre_revoke_use.log)
    refute Map.has_key?(oracle.revoke.projection.read_model.roles.reasons, revoke.id)
    refute Map.has_key?(oracle.revoke.recipient_log_before_pull.ops, revoke.id)

    assert Map.has_key?(oracle.recipient_pull.log.ops, revoke.id)
    assert Map.has_key?(oracle.recipient_pull.log.ops, oracle.grant.op.id)
    assert Log.frontier(oracle.recipient_pull.log) == [revoke.id]
    assert revoked_use.author == oracle.recipient.identity.pub
    assert revoked_use.cap == delegation.id
    assert revoked_use.body == {:post, [oracle.revoked_use.text]}
    assert revoked_use.deps == Log.frontier(oracle.recipient_pull.log)
    assert MapSet.member?(Dag.ancestors(oracle.final.log.ops, revoked_use.id), revoke.id)

    assert oracle.final.projection.read_model.roles.reasons[revoked_use.id] ==
             :revoked_capability

    assert List.last(oracle.final.projection.causal_replay["frames"])["quarantine"][
             revoked_use.id
           ] ==
             "revoked_capability"

    assert oracle.pre_revoke_use.text in oracle.final.projection.read_model.threads.posts
    refute oracle.revoked_use.text in oracle.final.projection.read_model.threads.posts

    assert Lattice.state(Matter, oracle.final.log) ==
             Lattice.state(Matter, oracle.pre_revoke_use.log)

    assert oracle.final.projection.causal_replay == ReadModel.replay(oracle.final.log)
    assert oracle.final.projection.op_ids == oracle.final.log |> Log.op_ids() |> Enum.sort()
  end

  test "oracle is byte-deterministic" do
    assert :erlang.term_to_binary(TownshipRevocationHandoffScenario.oracle(), [:deterministic]) ==
             :erlang.term_to_binary(TownshipRevocationHandoffScenario.oracle(), [:deterministic])
  end
end
