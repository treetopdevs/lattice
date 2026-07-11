defmodule Township.ReadModelTest do
  use ExUnit.Case, async: true

  alias Lattice.{Attestation, Identity, Log, Sim}
  alias Township.{Matter, ReadModel}

  @repo_root Path.expand("../../../..", __DIR__)
  @tracked_dir Path.join(@repo_root, "artifacts/township")
  @replica "replica:matter:read-model-denied"

  test "observe derives the five instrument inputs without mixing their trust boundaries" do
    preload_lattice_core()
    {:ok, log} = Log.restore(Path.join(@tracked_dir, "matter.log"))
    labels = tracked_labels()

    alice = Identity.from_seed("realm:alice", <<9::256>>)
    bob = Identity.from_seed("realm:bob", <<10::256>>)
    carol = Identity.from_seed("realm:carol", <<11::256>>)
    {_alice_token, alice_vouch} = Attestation.cast_vouch(Attestation.Stub, alice, :approve)
    {_bob_token, bob_vouch} = Attestation.cast_vouch(Attestation.Stub, bob, :approve)
    {_carol_token, carol_vouch} = Attestation.cast_vouch(Attestation.Stub, carol, :reject)

    model =
      ReadModel.observe(log,
        labels: labels,
        vouches: [alice_vouch, bob_vouch, carol_vouch]
      )

    assert model.threads == %{
             title: "Zoning variance #24",
             summary: "Leaning approve (clerk edit)",
             posts: [
               "resident: I'll attend",
               "clerk: hearing Tuesday 6pm",
               "resident: posted while offline"
             ],
             clerk_locked?: true
           }

    assert model.members == %{current: ["clerk", "resident"], denied: []}

    assert model.roles.holders == %{clerk: "xI19LiI0w767"}
    assert model.roles.quarantine == ["mVp4COeiXTD__9c6y-OfO406aHuMZFDT3ahLtFZvLag"]

    assert model.roles.reasons == %{
             "mVp4COeiXTD__9c6y-OfO406aHuMZFDT3ahLtFZvLag" => :not_holder
           }

    assert model.roles.audit == [
             %{
               event: :command_quarantine,
               op: "mVp4COeiXTD__9c6y-OfO406aHuMZFDT3ahLtFZvLag",
               reason: :not_holder
             }
           ]

    assert model.attest == %{
             tally: %{outcome: :approve, counts: %{approve: 2, reject: 1}},
             receipt_free?: false,
             status: :stubbed
           }

    assert String.starts_with?(
             model.op_dag.replica,
             "replica:matter:zoning-variance-24#root:"
           )

    assert length(model.op_dag.nodes) > 10
    assert Enum.any?(model.op_dag.nodes, &(&1.status == "quarantined"))
    assert model.op_dag.frontier != []

    assert Enum.any?(model.trust_graph.nodes, &(&1.label == "clerk " <> &1.id))
    assert Enum.any?(model.trust_graph.nodes, &(&1.label == "resident " <> &1.id))

    unlabelled =
      ReadModel.observe(log,
        labels: %{},
        vouches: [alice_vouch, bob_vouch, carol_vouch]
      )

    assert Map.delete(model, :trust_graph) == Map.delete(unlabelled, :trust_graph)

    assert strip_graph_labels(model.trust_graph) ==
             strip_graph_labels(unlabelled.trust_graph)

    {denied_log, denied_op_id} = denied_admission_log()
    denied = ReadModel.observe(denied_log).members.denied

    assert denied == [
             %{
               op_id: denied_op_id,
               command: :admit,
               member: "intruder",
               reason: :no_capability
             }
           ]

    refute "intruder" in ReadModel.observe(denied_log).members.current
  end

  test "Plan 122 records the instrument read model without claiming rendered UI" do
    plan = File.read!(Path.join(@repo_root, "plans/122-township-instrument-read-model-g1.md"))
    plans_index = File.read!(Path.join(@repo_root, "plans/README.md"))
    build_map = File.read!(Path.join(@repo_root, "TOWNSHIP_BUILD_MAP.md"))

    assert plan =~ ~r/## Status\s+DONE/
    assert plan =~ "Township.ReadModel.observe/2"
    assert plan =~ "Vouches and coercion tokens never enter the Matter log"
    assert plan =~ "does not build Phoenix, LiveView, Vue"

    assert build_map =~ ~r/Plan 122 adds the\s+Township\s+instrument read model/
    assert build_map =~ "plans 023-128"
    assert build_map =~ "read-model foundation"

    assert plans_index =~
             "| 122 | Township instrument read model | P1 | M | 121 | DONE |"
  end

  defp denied_admission_log do
    sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "read-model")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, _grant} = Sim.grant(sim, "clerk", "resident", ops: [:admit, :post])
    sim = Sim.sync_all(sim)
    {sim, _admit} = Sim.command(sim, "clerk", :admit, ["resident"])
    {sim, denied} = Sim.command(sim, "resident", :admit, ["intruder"], cap: :none)
    sim = Sim.sync_all(sim)
    {Sim.log(sim, "clerk"), denied.id}
  end

  defp tracked_labels do
    @tracked_dir
    |> Path.join("manifest.json")
    |> File.read!()
    |> Jason.decode!()
    |> Map.fetch!("labels")
  end

  defp preload_lattice_core do
    :lattice_core
    |> Application.spec(:modules)
    |> Enum.each(&Code.ensure_loaded/1)
  end

  defp strip_graph_labels(graph) do
    update_in(graph.nodes, fn nodes -> Enum.map(nodes, &Map.delete(&1, :label)) end)
  end
end
