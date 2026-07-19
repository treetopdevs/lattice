defmodule LatticeNodeSpike.TownshipWitnessArtifactScenario do
  @moduledoc """
  Deterministic Sim oracle for the witnessed-succession fixture preflight.

  One clerk-authored valid genesis pins a threshold-two witnessed recovery
  policy naming an externally supplied governance witness public key plus one
  control witness. Neither witness authors a source operation, so the packaged
  witness ceremony starts from a source whose only authority evidence is the
  valid genesis itself.
  """

  alias Lattice.Authority
  alias Lattice.Authority.Delegation
  alias Lattice.Authority.SuccessionCertificate
  alias Lattice.Identity
  alias Lattice.Log
  alias Lattice.Sim
  alias Township.Matter

  @replica_name "replica:matter:township-witness-artifact"
  @seed "township-witness-artifact:fixture"
  @clerk "clerk"
  @resident "resident"
  @control_witness "witness-control"
  @realms [@clerk, @resident, @control_witness]

  @spec oracle(binary()) :: map()
  def oracle(governance_witness_pub) when byte_size(governance_witness_pub) == 32 do
    clerk = Identity.from_seed(@clerk, "#{@seed}:#{@clerk}")
    replica = Authority.bind_replica(@replica_name, clerk.pub)
    sim = Sim.new(Matter, replica, @realms, seed: @seed)

    resident = Sim.identity(sim, @resident)
    control = Sim.identity(sim, @control_witness)

    unless clerk.pub == Sim.identity(sim, @clerk).pub do
      raise "fixture clerk identity diverged from the Sim seed convention"
    end

    if governance_witness_pub in [clerk.pub, resident.pub, control.pub] do
      raise "the governance witness key must not collide with a fixture realm identity"
    end

    recovery = %{
      mode: :witnessed,
      version: 1,
      witnesses: [governance_witness_pub, control.pub],
      threshold: 2
    }

    delegation =
      Delegation.genesis(clerk, replica, ops: [:close_matter], roles: [:clerk], live: true)

    {sim, genesis} =
      Sim.append(
        sim,
        @clerk,
        :authority,
        {:genesis, delegation, %{clerk: %{successor: resident.pub, recovery: recovery}}}
      )

    log = Sim.log(sim, @clerk)
    analysis = Authority.analyze(Matter, log)
    epoch = Map.fetch!(analysis.holder_epochs, :clerk)
    effective = Map.fetch!(analysis.policies, :clerk)
    root = Authority.root(log)

    {:ok, normalized_recovery} = SuccessionCertificate.normalize_policy(effective.recovery)
    {:ok, policy_id} = SuccessionCertificate.policy_id(normalized_recovery)

    {:ok, claim} =
      SuccessionCertificate.claim(
        replica,
        :clerk,
        epoch.holder,
        epoch.op_id,
        effective.successor,
        normalized_recovery
      )

    unless epoch == %{holder: clerk.pub, op_id: genesis.id} and
             effective == %{successor: resident.pub, recovery: recovery} and
             analysis.reasons == %{} and
             root == clerk.pub and
             Log.frontier(log) == [genesis.id] and
             MapSet.to_list(Log.op_ids(log)) == [genesis.id] do
      raise "witness fixture source diverged from the expected BEAM projection"
    end

    %{
      replica: replica,
      realms: %{@clerk => clerk, @resident => resident, @control_witness => control},
      governance_witness_pub: governance_witness_pub,
      log: log,
      genesis: genesis,
      holder_epoch: epoch,
      successor_pub: effective.successor,
      root: root,
      normalized_recovery: normalized_recovery,
      policy_id: policy_id,
      claim: claim,
      claim_payload: SuccessionCertificate.signing_payload(claim)
    }
  end
end
