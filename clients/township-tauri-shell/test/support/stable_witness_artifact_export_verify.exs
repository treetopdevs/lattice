alias Lattice.Authority.SuccessionWitnessArtifact

# Independent BEAM oracle for the packaged witness-ceremony export sink.
#
# argv: [artifact_json_path, oracle_json_path]. The artifact file holds the
# exact bytes captured from the packaged app's export sink; the oracle file is
# the stable_witness_artifact_fixture.exs output. One app signature against a
# threshold-two witnessed policy must verify structurally and then fail closed
# as {:error, :insufficient_recovery_witnesses} — any other outcome (including
# :ok) means the exported artifact or the fixture policy drifted.

[artifact_json_path, oracle_json_path] = System.argv()

# The oracle role/mode strings decode through String.to_existing_atom/1; keep
# the recognised atoms alive in this script so decoding cannot mint new ones.
_known_atoms = [:clerk, :witnessed]

decode_key! = fn encoded ->
  with {:ok, decoded} when byte_size(decoded) == 32 <- Base.decode64(encoded),
       true <- Base.encode64(decoded) == encoded do
    decoded
  else
    _ -> raise "oracle public key is not canonical padded base64: #{inspect(encoded)}"
  end
end

oracle = oracle_json_path |> File.read!() |> Jason.decode!()
claim_json = Map.fetch!(oracle, "claim")
recovery_json = oracle |> Map.fetch!("projection") |> Map.fetch!("recovery")

expected_claim = %{
  version: Map.fetch!(claim_json, "version"),
  replica: Map.fetch!(claim_json, "replica"),
  role: claim_json |> Map.fetch!("role") |> String.to_existing_atom(),
  holder: decode_key!.(Map.fetch!(claim_json, "holder")),
  holder_epoch: Map.fetch!(claim_json, "holderEpoch"),
  successor: decode_key!.(Map.fetch!(claim_json, "successor")),
  policy_id: Map.fetch!(claim_json, "policyId")
}

policy = %{
  mode: recovery_json |> Map.fetch!("mode") |> String.to_existing_atom(),
  version: Map.fetch!(recovery_json, "version"),
  witnesses: recovery_json |> Map.fetch!("witnesses") |> Enum.map(decode_key!),
  threshold: Map.fetch!(recovery_json, "threshold")
}

exported_json = File.read!(artifact_json_path)

case SuccessionWitnessArtifact.verify_json(exported_json, expected_claim, policy) do
  {:error, :insufficient_recovery_witnesses} ->
    IO.puts("WITNESS_EXPORT_VERIFIED")

  other ->
    raise "expected {:error, :insufficient_recovery_witnesses} for the exported " <>
            "one-signature artifact, got: #{inspect(other)}"
end
