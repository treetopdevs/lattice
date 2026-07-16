alias Lattice.Carrier.Wire
alias Lattice.{Dag, Identity, Log, Sim}
alias LatticeNodeSpike.{TownshipOnboardingScenario, TownshipScenario}
alias Township.ReadModel

[output_dir] = System.argv()
File.mkdir_p!(output_dir)
source_path = Path.join(output_dir, "matter.log")
oracle_path = Path.join(output_dir, "oracle.json")

projection = fn log ->
  %{
    "opIds" => log |> Log.op_ids() |> Enum.sort(),
    "readModel" => ReadModel.observe(log),
    "causalReplay" => ReadModel.replay(log)
  }
end

contested_member = "resident"
new_member = "neighbor"
no_cap_realm = "post-only"
no_cap_seed = "township-g1:post-only"

base_sim = TownshipOnboardingScenario.base_sim()
base_log = Sim.log(base_sim, "clerk")
participant_identity = Sim.identity(base_sim, "clerk")
peer_identity = Sim.identity(base_sim, "resident")
base_projection = projection.(base_log)
base_frontier = Log.frontier(base_log)

base_member_adds =
  Enum.filter(Log.topo_ops(base_log), fn
    %{kind: :command, body: {:admit, [^contested_member]}} -> true
    _op -> false
  end)

case base_member_adds do
  [%{id: base_member_add_id}] ->
    if contested_member not in base_projection["readModel"].members.current do
      raise "roster fixture contested member must be present at the base"
    end

    partitioned_sim = Sim.partition(base_sim, "clerk", "resident")

    {branched_sim, expected_remove} =
      Sim.command(partitioned_sim, "clerk", :remove_member, [contested_member])

    {branched_sim, expected_peer_admit} =
      Sim.command(branched_sim, "resident", :admit, [contested_member])

    remove_log = Sim.log(branched_sim, "clerk")
    peer_log = Sim.log(branched_sim, "resident")
    combined_ops = Map.merge(Log.ops(remove_log), Log.ops(peer_log))
    remove_ancestors = Dag.ancestors(combined_ops, expected_remove.id)
    peer_ancestors = Dag.ancestors(combined_ops, expected_peer_admit.id)

    if expected_remove.deps != base_frontier or expected_peer_admit.deps != base_frontier do
      raise "roster fixture operations must share the exact base frontier"
    end

    if expected_remove.id == expected_peer_admit.id do
      raise "roster fixture branch operations must have distinct ids"
    end

    if MapSet.member?(remove_ancestors, expected_peer_admit.id) or
         MapSet.member?(peer_ancestors, expected_remove.id) do
      raise "roster fixture branch operations must be concurrent"
    end

    unless MapSet.member?(remove_ancestors, base_member_add_id) and
             MapSet.member?(peer_ancestors, base_member_add_id) do
      raise "roster fixture branches must both observe the base member add"
    end

    genesis_cap_id =
      Enum.find_value(Log.topo_ops(base_log), fn
        %{kind: :authority, body: {:genesis, delegation, _policies}} -> delegation.id
        _op -> nil
      end) || raise "roster fixture missing clerk genesis capability"

    if expected_remove.cap != genesis_cap_id do
      raise "roster fixture remove must cite the clerk genesis capability"
    end

    if is_nil(expected_peer_admit.cap) or expected_peer_admit.cap == expected_remove.cap do
      raise "roster fixture peer admit must cite its distinct resident capability"
    end

    remove_projection = projection.(remove_log)
    peer_projection = projection.(peer_log)

    if remove_projection["readModel"].members.denied != [] or
         peer_projection["readModel"].members.denied != [] do
      raise "roster fixture branches must both be capability-valid"
    end

    if contested_member in remove_projection["readModel"].members.current do
      raise "roster fixture remove must retire the observed base add tag"
    end

    if contested_member not in peer_projection["readModel"].members.current do
      raise "roster fixture peer admit must preserve the contested member"
    end

    contested_sim =
      branched_sim
      |> Sim.heal("clerk", "resident")
      |> Sim.sync_all()

    contested_log = Sim.log(contested_sim, "clerk")
    contested_projection = projection.(contested_log)

    if contested_projection["readModel"].members.denied != [] or
         contested_member not in contested_projection["readModel"].members.current do
      raise "roster fixture merge must preserve the concurrent add"
    end

    {admit_sim, expected_admit} =
      Sim.command(contested_sim, "clerk", :admit, [new_member])

    admit_sim = Sim.sync_all(admit_sim)
    admit_log = Sim.log(admit_sim, "clerk")
    admit_projection = projection.(admit_log)

    if admit_projection["readModel"].members.denied != [] or
         new_member not in admit_projection["readModel"].members.current do
      raise "roster fixture sequential admit must add the new member"
    end

    no_cap_identity = Identity.from_seed(no_cap_realm, no_cap_seed)
    no_cap_sim = TownshipScenario.bootstrap_audience(base_sim, no_cap_identity.pub)
    no_cap_log = Sim.log(no_cap_sim, "clerk")

    :ok = Log.dump(base_log, source_path)

    oracle = %{
      "replica" => base_log.replica,
      "participantRealm" => participant_identity.realm_id,
      "participantPubkey" => Base.encode64(participant_identity.pub),
      "peerRealm" => peer_identity.realm_id,
      "peerPubkey" => Base.encode64(peer_identity.pub),
      "contestedMember" => contested_member,
      "newMember" => new_member,
      "baseMemberAddId" => base_member_add_id,
      "baseFrontier" => base_frontier,
      "base" => base_projection,
      "expectedRemove" => Wire.encode_op(expected_remove),
      "afterRemove" => remove_projection,
      "expectedPeerAdmit" => Wire.encode_op(expected_peer_admit),
      "afterPeer" => peer_projection,
      "afterContested" => contested_projection,
      "expectedAdmit" => Wire.encode_op(expected_admit),
      "afterAdmit" => admit_projection,
      "noCapRealm" => no_cap_realm,
      "noCapPubkey" => Base.encode64(no_cap_identity.pub),
      "noCapFrames" => no_cap_log |> Log.topo_ops() |> Wire.encode_ops()
    }

    File.write!(oracle_path, Jason.encode!(oracle, pretty: true))
    IO.puts("ROSTER_FIXTURE_READY #{oracle_path}")

  _other ->
    raise "roster fixture requires exactly one base add tag for the contested member"
end
