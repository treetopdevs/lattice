alias Lattice.Carrier.Wire
alias Lattice.Log
alias LatticeNodeSpike.TownshipRevocationHandoffScenario

[output_dir] = System.argv()
File.mkdir_p!(output_dir)
source_path = Path.join(output_dir, "matter.log")
oracle_path = Path.join(output_dir, "oracle.json")

scenario = TownshipRevocationHandoffScenario.oracle()

projection = fn value ->
  %{
    "opIds" => value.op_ids,
    "readModel" => value.read_model,
    "causalReplay" => value.causal_replay
  }
end

revoked_use_reason =
  scenario.final.projection.read_model.roles.reasons
  |> Map.fetch!(scenario.revoked_use.op.id)
  |> Atom.to_string()

:ok = Log.dump(scenario.pre_revoke_use.log, source_path)

oracle = %{
  "replica" => scenario.replica,
  "issuerRealm" => scenario.issuer.realm,
  "issuerPubkey" => Base.encode64(scenario.issuer.identity.pub),
  "recipientRealm" => scenario.recipient.realm,
  "recipientPubkey" => Base.encode64(scenario.recipient.identity.pub),
  "sourceAuthorPubkeys" =>
    scenario.pre_revoke_use.log
    |> Log.topo_ops()
    |> Enum.map(&Base.encode64(&1.author))
    |> Enum.uniq()
    |> Enum.sort(),
  "sourceFrontier" => Log.frontier(scenario.pre_revoke_use.log),
  "source" => projection.(scenario.pre_revoke_use.projection),
  "grant" => %{
    "delegationId" => scenario.grant.delegation.id,
    "frame" => Wire.encode_op(scenario.grant.op)
  },
  "preRevokeUse" => %{
    "text" => scenario.pre_revoke_use.text,
    "frame" => Wire.encode_op(scenario.pre_revoke_use.op)
  },
  "revoke" => %{
    "frame" => Wire.encode_op(scenario.revoke.op),
    "after" => projection.(scenario.revoke.projection)
  },
  "recipientPull" => %{
    "after" => projection.(scenario.recipient_pull.projection)
  },
  "revokedUse" => %{
    "text" => scenario.revoked_use.text,
    "reason" => revoked_use_reason,
    "frame" => Wire.encode_op(scenario.revoked_use.op),
    "after" => projection.(scenario.final.projection)
  }
}

File.write!(oracle_path, Jason.encode!(oracle, pretty: true))
IO.puts("REVOCATION_FIXTURE_READY #{oracle_path}")
