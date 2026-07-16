alias Lattice.Carrier.Wire
alias Lattice.{Log, Sim}
alias LatticeNodeSpike.TownshipOnboardingScenario
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

summary_text = "Resident contested summary"
peer_summary_text = "Clerk concurrent summary"
title_text = "Budget Hearing"

base_sim = TownshipOnboardingScenario.base_sim()
base_log = Sim.log(base_sim, "clerk")
participant_identity = Sim.identity(base_sim, "resident")
peer_identity = Sim.identity(base_sim, "clerk")

partitioned_sim = Sim.partition(base_sim, "clerk", "resident")

{branched_sim, expected_summary} =
  Sim.command(partitioned_sim, "resident", :set_summary, [summary_text])

{branched_sim, expected_peer_summary} =
  Sim.command(branched_sim, "clerk", :set_summary, [peer_summary_text])

if expected_summary.deps != expected_peer_summary.deps do
  raise "field fixture summary operations must share the base frontier"
end

peer_log = Sim.log(branched_sim, "clerk")

contested_sim =
  branched_sim
  |> Sim.heal("clerk", "resident")
  |> Sim.sync_all()

contested_log = Sim.log(contested_sim, "clerk")

{title_sim, expected_title} =
  Sim.command(contested_sim, "resident", :set_title, [title_text])

title_sim = Sim.sync_all(title_sim)
title_log = Sim.log(title_sim, "clerk")

:ok = Log.dump(base_log, source_path)

oracle = %{
  "replica" => base_log.replica,
  "participantRealm" => participant_identity.realm_id,
  "participantPubkey" => Base.encode64(participant_identity.pub),
  "peerRealm" => peer_identity.realm_id,
  "peerPubkey" => Base.encode64(peer_identity.pub),
  "summaryText" => summary_text,
  "peerSummaryText" => peer_summary_text,
  "titleText" => title_text,
  "base" => projection.(base_log),
  "expectedSummary" => Wire.encode_op(expected_summary),
  "expectedPeerSummary" => Wire.encode_op(expected_peer_summary),
  "afterPeer" => projection.(peer_log),
  "afterSummary" => projection.(contested_log),
  "expectedTitle" => Wire.encode_op(expected_title),
  "afterTitle" => projection.(title_log)
}

File.write!(oracle_path, Jason.encode!(oracle, pretty: true))
IO.puts("FIELD_FIXTURE_READY #{oracle_path}")
