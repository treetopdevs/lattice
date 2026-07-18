defmodule TownshipWitnessArtifactFixtureVerifier do
  alias Lattice.Authority
  alias Lattice.Authority.SuccessionCertificate
  alias Lattice.Log
  alias Township.Matter

  def verify(source_path, output_path) do
    {:ok, _apps} = Application.ensure_all_started(:lattice_node_spike)

    Enum.each(
      [
        Lattice.Log,
        Lattice.Op,
        Lattice.Authority.Delegation,
        LatticeNodeSpike.TownshipWitnessArtifactScenario
      ],
      &Code.ensure_loaded!/1
    )

    {:ok, restored} = Log.restore(source_path)
    analysis = Authority.analyze(Matter, restored)
    %{holder: holder, op_id: holder_epoch} = Map.fetch!(analysis.holder_epochs, :clerk)
    policy = Map.fetch!(analysis.policies, :clerk)
    {:ok, recovery} = SuccessionCertificate.normalize_policy(policy.recovery)
    {:ok, policy_id} = SuccessionCertificate.policy_id(recovery)
    [genesis] = Log.topo_ops(restored)

    oracle = %{
      "replica" => restored.replica,
      "source" => source_evidence(source_path, restored),
      "projection" => %{
        "role" => "clerk",
        "holderPubkey" => Base.encode64(holder),
        "holderEpochOperationId" => holder_epoch,
        "successorPubkey" => Base.encode64(policy.successor),
        "policyGenesisOperationId" => genesis.id,
        "policyId" => policy_id,
        "rootPubkey" => restored |> Authority.root() |> Base.encode64(),
        "quarantineReasons" => encode_reasons(analysis.reasons),
        "recovery" => %{
          "mode" => "witnessed",
          "version" => recovery.version,
          "witnesses" => Enum.map(recovery.witnesses, &Base.encode64/1),
          "threshold" => recovery.threshold
        }
      }
    }

    File.write!(output_path, Jason.encode!(oracle, pretty: true))
  end

  defp source_evidence(source_path, log) do
    %{
      "sha256" =>
        source_path
        |> File.read!()
        |> then(&:crypto.hash(:sha256, &1))
        |> Base.encode16(case: :lower),
      "opIds" => log |> Log.topo_ops() |> Enum.map(& &1.id),
      "frontier" => Log.frontier(log)
    }
  end

  defp encode_reasons(reasons) do
    Map.new(reasons, fn {op_id, reason} -> {op_id, Atom.to_string(reason)} end)
  end
end

[source_path, output_path] = System.argv()
TownshipWitnessArtifactFixtureVerifier.verify(source_path, output_path)
IO.puts("WITNESS_FIXTURE_VERIFIED #{output_path}")
