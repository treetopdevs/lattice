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
relay_identity = Sim.identity(base_sim, "resident")

{post_sim, expected_post} =
  Sim.command(base_sim, "resident", :post, ["resident: posted while offline"])

post_sim = Sim.sync_all(post_sim)
post_log = Sim.log(post_sim, "clerk")

{restart_sim, expected_restart_post} =
  Sim.command(post_sim, "resident", :post, ["resident: pushed after restart"])

restart_sim = Sim.sync_all(restart_sim)
restart_log = Sim.log(restart_sim, "clerk")

{authority_sim, authority_invalid_op} =
  Sim.command(post_sim, "resident", :admit, ["intruder"], cap: :none)

authority_sim = Sim.sync_all(authority_sim)
authority_log = Sim.log(authority_sim, "clerk")

:ok = Log.dump(base_log, source_path)

oracle = %{
  "replica" => base_log.replica,
  "relayRealm" => relay_identity.realm_id,
  "relayPubkey" => Base.encode64(relay_identity.pub),
  "baseOpIds" => base_log |> Log.op_ids() |> Enum.sort(),
  "expectedPost" => Wire.encode_op(expected_post),
  "expectedRestartPost" => Wire.encode_op(expected_restart_post),
  "authorityInvalidOp" => Wire.encode_op(authority_invalid_op),
  "afterPost" => projection.(post_log),
  "afterRestartPost" => projection.(restart_log),
  "afterAuthorityInvalid" => projection.(authority_log),
  "opAuthors" =>
    Enum.map(Log.topo_ops(authority_log), fn op ->
      %{"id" => op.id, "author" => Base.encode64(op.author)}
    end)
}

File.write!(oracle_path, Jason.encode!(oracle, pretty: true))
IO.puts("FIXTURE_READY #{oracle_path}")
