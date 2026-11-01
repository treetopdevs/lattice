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
    assert model.roles.quarantine == ["H32KUYuAjLsX6RSoXWwSYKUZSivCavpQ7i38_EInp6k"]

    assert model.roles.reasons == %{
             "H32KUYuAjLsX6RSoXWwSYKUZSivCavpQ7i38_EInp6k" => :not_holder
           }

    assert model.roles.audit == [
             %{
               event: :command_quarantine,
               op: "H32KUYuAjLsX6RSoXWwSYKUZSivCavpQ7i38_EInp6k",
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
    assert build_map =~ "plans 023-133"
    assert build_map =~ "read-model foundation"

    assert plans_index =~
             "| 122 | Township instrument read model | P1 | M | 121 | DONE |"
  end

  test "observe tolerates ill-formed delegation fields and omits their trust-graph edge" do
    {baseline, _} = listform_log(nil)
    base_edges = ReadModel.observe(baseline, labels: %{}, vouches: []).trust_graph.edges

    for field <- [:roles, :ops] do
      {log, _} = listform_log(field)
      model = ReadModel.observe(log, labels: %{}, vouches: [])
      graph = model.trust_graph

      assert length(graph.edges) == length(base_edges), "field #{field}"
      assert graph.edges == base_edges
    end
  end

  test "observe survives a malformed role or non-binary audience in transfer/succeed/grant bodies" do
    {baseline, _} = listform_log(nil)
    base = ReadModel.observe(baseline, labels: %{}, vouches: [])

    bodies = [
      fn good -> {:transfer, %{}, %{good | roles: [:clerk]}, 0} end,
      fn good -> {:succeed, %{}, %{good | roles: [:clerk]}, 0} end,
      fn good -> {:grant, %{good | roles: [:clerk], audience: 7}} end,
      fn good -> {:transfer, :clerk, %{good | audience: 7}, 0} end
    ]

    for build <- bodies do
      sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "read-model-listform")
      {sim, _genesis} = Sim.create_replica(sim, "clerk")
      {sim, good} = Sim.grant(sim, "clerk", "resident", ops: [:post], roles: [:clerk])
      {sim, _} = Sim.append(sim, "clerk", :authority, build.(good))
      log = sim |> Sim.sync_all() |> Sim.log("clerk")

      model = ReadModel.observe(log, labels: %{}, vouches: [])
      assert model.trust_graph.edges == base.trust_graph.edges
      assert is_list(model.op_dag.nodes)
    end
  end

  test "observe keeps the trust-graph edge for a legacy Canonical.Atom transfer/succeed role" do
    for kind <- [:transfer, :succeed] do
      edges =
        for role <- [:clerk, %Lattice.Canonical.Atom{name: "clerk"}] do
          sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "read-model-listform")
          {sim, _genesis} = Sim.create_replica(sim, "clerk")
          {sim, good} = Sim.grant(sim, "clerk", "resident", ops: [:post], roles: [:clerk])
          {sim, _} = Sim.append(sim, "clerk", :authority, {kind, role, good, 0})
          log = sim |> Sim.sync_all() |> Sim.log("clerk")
          ReadModel.observe(log, labels: %{}, vouches: []).trust_graph.edges
        end

      [atom_edges, wrapped_edges] = edges
      assert wrapped_edges == atom_edges
      assert Enum.any?(wrapped_edges, &String.starts_with?(&1.kind, "#{kind}:clerk"))
    end
  end

  test "observe and ReplicaSnapshot survive short-binary audience or issuer" do
    {baseline, _} = listform_log(nil)
    base = ReadModel.observe(baseline, labels: %{}, vouches: [])

    for build <- [
          fn good -> {:grant, %{good | audience: <<1>>}} end,
          fn good -> {:grant, %{good | issuer: <<1>>}} end
        ] do
      sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "read-model-listform")
      {sim, _genesis} = Sim.create_replica(sim, "clerk")
      {sim, good} = Sim.grant(sim, "clerk", "resident", ops: [:post], roles: [:clerk])
      {sim, _} = Sim.append(sim, "clerk", :authority, build.(good))
      log = sim |> Sim.sync_all() |> Sim.log("clerk")

      model = ReadModel.observe(log, labels: %{}, vouches: [])
      assert model.trust_graph.edges == base.trust_graph.edges
      assert is_list(Lattice.Graph.ReplicaSnapshot.build(Matter, log).nodes)
    end
  end

  test "observe survives non-integer transfer, succeed and heartbeat ticks" do
    for build <- [
          fn good -> {:transfer, :clerk, good, %{}} end,
          fn good -> {:succeed, :clerk, good, %{}} end,
          fn _good -> {:heartbeat, :clerk, %{}} end
        ] do
      sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "read-model-listform")
      {sim, _genesis} = Sim.create_replica(sim, "clerk")
      {sim, good} = Sim.grant(sim, "clerk", "resident", ops: [:post], roles: [:clerk])
      {sim, _} = Sim.append(sim, "clerk", :authority, build.(good))
      log = sim |> Sim.sync_all() |> Sim.log("clerk")

      assert is_list(ReadModel.observe(log, labels: %{}, vouches: []).op_dag.nodes)
      assert is_list(Lattice.Graph.ReplicaSnapshot.build(Matter, log).nodes)
    end
  end

  defp listform_log(field) do
    sim = Sim.new(Matter, @replica, ["clerk", "resident"], seed: "read-model-listform")
    {sim, _genesis} = Sim.create_replica(sim, "clerk")
    {sim, good} = Sim.grant(sim, "clerk", "resident", ops: [:post], roles: [:clerk])

    sim =
      case field do
        nil ->
          sim

        f ->
          bad = %{good | f => MapSet.to_list(Map.fetch!(good, f))}
          {sim, _} = Sim.append(sim, "clerk", :authority, {:grant, bad})
          sim
      end

    {sim |> Sim.sync_all() |> Sim.log("clerk"), nil}
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
