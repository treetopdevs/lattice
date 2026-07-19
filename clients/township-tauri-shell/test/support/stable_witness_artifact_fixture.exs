alias Lattice.Carrier.Wire
alias Lattice.Log
alias LatticeNodeSpike.TownshipWitnessArtifactScenario

[output_dir, governance_witness_encoded] = System.argv()
File.mkdir_p!(output_dir)
source_path = Path.join(output_dir, "matter.log")
oracle_path = Path.join(output_dir, "oracle.json")

governance_witness =
  with {:ok, decoded} when byte_size(decoded) == 32 <- Base.decode64(governance_witness_encoded),
       true <- Base.encode64(decoded) == governance_witness_encoded do
    decoded
  else
    _ -> raise "packaged governance witness public key is not canonical base64"
  end

scenario = TownshipWitnessArtifactScenario.oracle(governance_witness)
:ok = Log.dump(scenario.log, source_path)

claim = %{
  "version" => scenario.claim.version,
  "replica" => scenario.claim.replica,
  "role" => Atom.to_string(scenario.claim.role),
  "holder" => Base.encode64(scenario.claim.holder),
  "holderEpoch" => scenario.claim.holder_epoch,
  "successor" => Base.encode64(scenario.claim.successor),
  "policyId" => scenario.claim.policy_id
}

recovery = scenario.normalized_recovery

projection = %{
  "role" => "clerk",
  "holderPubkey" => Base.encode64(scenario.holder_epoch.holder),
  "holderEpochOperationId" => scenario.holder_epoch.op_id,
  "successorPubkey" => Base.encode64(scenario.successor_pub),
  "policyGenesisOperationId" => scenario.genesis.id,
  "policyId" => scenario.policy_id,
  "rootPubkey" => Base.encode64(scenario.root),
  "quarantineReasons" => %{},
  "recovery" => %{
    "mode" => "witnessed",
    "version" => recovery.version,
    "witnesses" => Enum.map(recovery.witnesses, &Base.encode64/1),
    "threshold" => recovery.threshold
  }
}

source_ops = Log.topo_ops(scenario.log)

source = %{
  "sha256" =>
    source_path
    |> File.read!()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower),
  "opIds" => Enum.map(source_ops, & &1.id),
  "frontier" => Log.frontier(scenario.log)
}

control_witness = scenario.realms |> Map.fetch!("witness-control") |> Map.fetch!(:pub)

oracle = %{
  "replica" => scenario.replica,
  "realmByPubkey" =>
    Map.new(scenario.realms, fn {realm, identity} -> {Base.encode64(identity.pub), realm} end),
  "oracleCarrierOps" => Enum.map(source_ops, &Wire.encode_op/1),
  "appWitnessPubkey" => Base.encode64(scenario.governance_witness_pub),
  "controlWitnessPubkey" => Base.encode64(control_witness),
  "sourceAuthorPubkeys" =>
    source_ops |> Enum.map(&Base.encode64(&1.author)) |> Enum.uniq() |> Enum.sort(),
  "claim" => claim,
  "claimPayloadSha256" =>
    scenario.claim_payload
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.url_encode64(padding: false),
  "source" => source,
  "projection" => projection
}

File.write!(oracle_path, Jason.encode!(oracle, pretty: true))
IO.puts("WITNESS_FIXTURE_READY #{oracle_path}")
