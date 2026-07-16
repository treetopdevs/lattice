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

base_sim = TownshipOnboardingScenario.base_sim()
base_log = Sim.log(base_sim, "clerk")
clerk_identity = Sim.identity(base_sim, "clerk")

{closed_sim, expected_close} = Sim.command(base_sim, "clerk", :close_matter, [])
closed_sim = Sim.sync_all(closed_sim)
closed_log = Sim.log(closed_sim, "clerk")

{reopened_sim, expected_reopen} = Sim.command(closed_sim, "clerk", :reopen_matter, [])
reopened_sim = Sim.sync_all(reopened_sim)
reopened_log = Sim.log(reopened_sim, "clerk")

:ok = Log.dump(base_log, source_path)

oracle = %{
  "replica" => base_log.replica,
  "relayRealm" => clerk_identity.realm_id,
  "relayPubkey" => Base.encode64(clerk_identity.pub),
  "base" => projection.(base_log),
  "expectedClose" => Wire.encode_op(expected_close),
  "afterClose" => projection.(closed_log),
  "expectedReopen" => Wire.encode_op(expected_reopen),
  "afterReopen" => projection.(reopened_log)
}

File.write!(oracle_path, Jason.encode!(oracle, pretty: true))
IO.puts("CLERK_FIXTURE_READY #{oracle_path}")
