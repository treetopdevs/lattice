alias Lattice.Carrier.Wire
alias Lattice.Log
alias LatticeNodeSpike.TownshipGrantHandoffScenario

[output_dir] = System.argv()
File.mkdir_p!(output_dir)
source_path = Path.join(output_dir, "matter.log")
oracle_path = Path.join(output_dir, "oracle.json")

scenario = TownshipGrantHandoffScenario.oracle()

projection = fn value ->
  %{
    "opIds" => value.op_ids,
    "readModel" => value.read_model,
    "causalReplay" => value.causal_replay
  }
end

reason = fn value ->
  case value do
    reason when is_atom(reason) -> Atom.to_string(reason)
    reason when is_binary(reason) -> reason
  end
end

unsound_grant_reason =
  scenario.unsound_grant.projection.read_model.roles.reasons
  |> Map.fetch!(scenario.unsound_grant.op.id)
  |> reason.()

unsound_use_reason =
  scenario.final.projection.read_model.roles.reasons
  |> Map.fetch!(scenario.unsound_use.op.id)
  |> reason.()

:ok = Log.dump(scenario.base.log, source_path)

oracle = %{
  "replica" => scenario.replica,
  "issuerRealm" => scenario.issuer.realm,
  "issuerPubkey" => Base.encode64(scenario.issuer.identity.pub),
  "recipientRealm" => scenario.recipient.realm,
  "recipientPubkey" => Base.encode64(scenario.recipient.identity.pub),
  "unsoundAudienceRealm" => scenario.unsound_audience.realm,
  "unsoundAudiencePubkey" => Base.encode64(scenario.unsound_audience.identity.pub),
  "baseAuthorPubkeys" =>
    scenario.base.log
    |> Log.topo_ops()
    |> Enum.map(&Base.encode64(&1.author))
    |> Enum.uniq()
    |> Enum.sort(),
  "baseFrontier" => Log.frontier(scenario.base.log),
  "base" => projection.(scenario.base.projection),
  "soundGrant" => %{
    "delegationId" => scenario.sound_grant.delegation.id,
    "parentDelegationId" => scenario.sound_grant.delegation.parent_id,
    "frame" => Wire.encode_op(scenario.sound_grant.op),
    "after" => projection.(scenario.sound_grant.projection)
  },
  "recipientUse" => %{
    "text" => scenario.recipient_use.text,
    "frame" => Wire.encode_op(scenario.recipient_use.op),
    "after" => projection.(scenario.recipient_use.projection)
  },
  "unsoundGrant" => %{
    "delegationId" => scenario.unsound_grant.delegation.id,
    "parentDelegationId" => scenario.unsound_grant.delegation.parent_id,
    "reason" => unsound_grant_reason,
    "frame" => Wire.encode_op(scenario.unsound_grant.op),
    "after" => projection.(scenario.unsound_grant.projection)
  },
  "unsoundUse" => %{
    "reason" => unsound_use_reason,
    "frame" => Wire.encode_op(scenario.unsound_use.op),
    "after" => projection.(scenario.final.projection)
  }
}

File.write!(oracle_path, Jason.encode!(oracle, pretty: true))
IO.puts("GRANT_FIXTURE_READY #{oracle_path}")
