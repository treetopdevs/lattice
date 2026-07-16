defmodule Township.ElectionProjectionTest do
  use ExUnit.Case, async: true

  alias Lattice.{Canonical, Log, Sim}
  alias Township.{Election, ElectionBoard, Matter}
  alias Township.Election.{ArtifactRef, BoardSnapshot, ProfileRef, Projection, Projector, Spec}

  @max_bytes 4_096
  @realms ["supervisor", "registrar", "box_a", "box_b", "trustee_a", "trustee_b"]

  setup do
    seed = "election-projection"

    matter = Sim.new(Matter, "replica:matter:projection", @realms, seed: seed)
    {matter, _genesis} = Sim.create_replica(matter, "supervisor")

    board = Sim.new(ElectionBoard, "replica:election-board:projection", @realms, seed: seed)
    {board, _genesis} = Sim.create_replica(board, "supervisor")

    {:ok, profile} =
      ProfileRef.new(%{
        id: "unselected-research-profile",
        version: "unselected",
        parameters_digest: "not-pinned"
      })

    {:ok, spec} =
      Spec.new(%{
        subject: Sim.replica(matter),
        question_digest: "sha256:projection-question",
        choices: [:approve, :reject],
        profile: profile,
        supervisor: Sim.identity(board, "supervisor").pub,
        registration_tellers: [Sim.identity(board, "registrar").pub],
        ballot_boxes: [Sim.identity(board, "box_a").pub, Sim.identity(board, "box_b").pub],
        close_policy: %{id: :unanimous_boxes_v1, members: :ballot_boxes, quorum: :all},
        trustees: [
          Sim.identity(board, "trustee_a").pub,
          Sim.identity(board, "trustee_b").pub
        ],
        max_corrupt_trustees: 0,
        tally_share_quorum: 2,
        result_policy: :plurality,
        domain: "township:test:projection"
      })

    {matter, link_op} =
      Sim.command(matter, "supervisor", :link_election, [Spec.digest(spec)])

    {:ok, link} = Election.verify_link(spec, Sim.log(matter, "supervisor"), link_op.id)

    {board, _registrar_cap} =
      Sim.grant(board, "supervisor", "registrar", ops: [:publish_roster, :submit_ballot])

    {board, _box_a_cap} =
      Sim.grant(board, "supervisor", "box_a", ops: [:submit_ballot, :publish_box_seal])

    {board, _box_b_cap} =
      Sim.grant(board, "supervisor", "box_b", ops: [:submit_ballot, :publish_box_seal])

    {board, _trustee_a_cap} =
      Sim.grant(board, "supervisor", "trustee_a",
        ops: [:publish_setup, :publish_protocol_artifact]
      )

    {board, _trustee_b_cap} =
      Sim.grant(board, "supervisor", "trustee_b", ops: [:publish_protocol_artifact])

    board = Sim.sync_all(board)

    snapshot = %BoardSnapshot{
      matter_log: Sim.log(matter, "supervisor"),
      matter_link_op_id: link_op.id,
      board_log: Sim.log(board, "supervisor"),
      max_artifact_byte_size: @max_bytes
    }

    %{board: board, link: link, snapshot: snapshot, spec: spec}
  end

  test "projection re-verifies provenance and never promotes the unselected profile", context do
    bytes = "opaque encrypted ballot"
    ref = artifact_ref(bytes, context.spec.profile)

    {board, ballot_op} =
      Sim.command(context.board, "box_a", :submit_ballot, [
        context.link.election_id,
        ArtifactRef.to_canonical_term(ref)
      ])

    board = Sim.sync_all(board)
    snapshot = %{context.snapshot | board_log: Sim.log(board, "supervisor")}
    projection = Election.project(context.spec, snapshot, %{ref.digest => bytes})

    assert %Projection{
             election_id: election_id,
             phase: :setup,
             status: {:pending, [:profile_unselected]},
             close_id: nil,
             rejected: [],
             faults: []
           } = projection

    assert election_id == context.link.election_id
    assert Log.has?(snapshot.board_log, ballot_op.id)
    refute match?({:final, _result}, projection.status)
  end

  test "an invalid same-id forgery cannot poison a genuine board command", context do
    bytes = "opaque ballot after forged-first delivery"
    ref = artifact_ref(bytes, context.spec.profile)

    {board, genuine} =
      Sim.command(context.board, "box_a", :submit_ballot, [
        context.link.election_id,
        ArtifactRef.to_canonical_term(ref)
      ])

    board = Sim.sync_all(board)
    forgery = %{genuine | sig: <<0::512>>}

    poisoned_log = %{
      Sim.log(board, "supervisor")
      | quarantine: [%{op: forgery, reason: :bad_signature}]
    }

    snapshot = %{context.snapshot | board_log: poisoned_log}

    assert {:ok, view} =
             Projector.foundation_view(context.spec, snapshot, %{ref.digest => bytes})

    assert Log.has?(view.safe_log, genuine.id)

    assert Enum.any?(view.commands, fn
             {%{id: id}, :submit_ballot, _args} -> id == genuine.id
             _command -> false
           end)

    assert %{op_id: genuine_id, reason: :bad_signature} =
             Enum.find(view.rejected, &(&1.op_id == genuine.id))

    assert genuine_id == genuine.id

    assert %Projection{status: {:pending, [:profile_unselected]}} =
             Election.project(context.spec, snapshot, %{ref.digest => bytes})
  end

  test "wrong-election and wrong-role publishers stay auditable but do not mutate projection",
       context do
    bytes = "same opaque ballot"
    ref = artifact_ref(bytes, context.spec.profile)
    ref_term = ArtifactRef.to_canonical_term(ref)

    {board, wrong_role} =
      Sim.command(context.board, "registrar", :submit_ballot, [
        context.link.election_id,
        ref_term
      ])

    {board, wrong_election} =
      Sim.command(board, "box_a", :submit_ballot, ["different-election", ref_term])

    {board, valid_a} =
      Sim.command(board, "box_a", :submit_ballot, [context.link.election_id, ref_term])

    {board, valid_b} =
      Sim.command(board, "box_b", :submit_ballot, [context.link.election_id, ref_term])

    board = Sim.sync_all(board)
    snapshot = %{context.snapshot | board_log: Sim.log(board, "supervisor")}
    projection = Election.project(context.spec, snapshot, %{ref.digest => bytes})

    assert %{op_id: wrong_role_id, reason: :unauthorized_publisher} =
             Enum.find(projection.rejected, &(&1.op_id == wrong_role.id))

    assert wrong_role_id == wrong_role.id

    assert %{op_id: wrong_election_id, reason: :wrong_election} =
             Enum.find(projection.rejected, &(&1.op_id == wrong_election.id))

    assert wrong_election_id == wrong_election.id
    assert Log.has?(snapshot.board_log, valid_a.id)
    assert Log.has?(snapshot.board_log, valid_b.id)
    assert projection.status == {:pending, [:profile_unselected]}
  end

  test "missing bytes remain pending while altered committed bytes fail closed", context do
    bytes = "artifact committed by digest"
    ref = artifact_ref(bytes, context.spec.profile)

    {board, _ballot_op} =
      Sim.command(context.board, "box_a", :submit_ballot, [
        context.link.election_id,
        ArtifactRef.to_canonical_term(ref)
      ])

    board = Sim.sync_all(board)
    snapshot = %{context.snapshot | board_log: Sim.log(board, "supervisor")}

    assert %Projection{status: {:pending, requirements}} =
             Election.project(context.spec, snapshot, %{})

    assert :profile_unselected in requirements
    assert {:artifact_unavailable, ref.digest} in requirements

    assert %Projection{status: {:invalid, findings}, close_id: nil, phase: :setup} =
             Election.project(context.spec, snapshot, %{ref.digest => "altered"})

    assert Enum.any?(findings, fn finding ->
             finding.reason == :artifact_size_mismatch and finding.digest == ref.digest and
               is_binary(finding.op_id)
           end)
  end

  test "the reduction is byte-identical across op and artifact map permutations", context do
    refs = Enum.map(["ballot-a", "ballot-b"], &artifact_ref(&1, context.spec.profile))

    {board, _a} =
      Sim.command(context.board, "box_a", :submit_ballot, [
        context.link.election_id,
        ArtifactRef.to_canonical_term(Enum.at(refs, 0))
      ])

    {board, _b} =
      Sim.command(board, "box_b", :submit_ballot, [
        context.link.election_id,
        ArtifactRef.to_canonical_term(Enum.at(refs, 1))
      ])

    board = Sim.sync_all(board)
    log = Sim.log(board, "supervisor")
    reversed_log = Log.from_ops(log.replica, log.ops |> Enum.reverse() |> Map.new())

    artifacts = Map.new(Enum.zip(Enum.map(refs, & &1.digest), ["ballot-a", "ballot-b"]))
    reversed_artifacts = artifacts |> Enum.reverse() |> Map.new()

    first =
      Election.project(context.spec, %{context.snapshot | board_log: log}, artifacts)

    second =
      Election.project(
        context.spec,
        %{context.snapshot | board_log: reversed_log},
        reversed_artifacts
      )

    assert first == second

    assert Canonical.term(Projection.to_canonical_term(first)) ==
             Canonical.term(Projection.to_canonical_term(second))
  end

  test "malformed and self-asserted contexts are total and can never become final", context do
    forged_spec = %{context.spec | schema: "self-asserted"}
    malformed = Election.project(forged_spec, context.snapshot, %{})

    assert %Projection{election_id: nil, phase: :setup, status: {:invalid, findings}} = malformed
    assert %{reason: :unsupported_schema} in findings

    bad_bound =
      Election.project(context.spec, %{context.snapshot | max_artifact_byte_size: 0}, %{})

    assert %Projection{phase: :setup, status: {:invalid, _}, close_id: nil} = bad_bound

    bad_artifacts = Election.project(context.spec, context.snapshot, :not_a_map)
    assert %Projection{phase: :setup, status: {:invalid, _}, close_id: nil} = bad_artifacts

    for projection <- [malformed, bad_bound, bad_artifacts] do
      refute match?({:final, _}, projection.status)
    end
  end

  test "artifact metadata must match the frozen profile and foundation codec", context do
    {:ok, wrong_profile} =
      ArtifactRef.new("ballot",
        codec: ArtifactRef.foundation_codec(),
        profile: "different-profile",
        max_byte_size: @max_bytes
      )

    {:ok, wrong_codec} =
      ArtifactRef.new("ballot",
        codec: "unreviewed-codec",
        profile: ProfileRef.artifact_id(context.spec.profile),
        max_byte_size: @max_bytes
      )

    {board, profile_op} =
      Sim.command(context.board, "box_a", :submit_ballot, [
        context.link.election_id,
        ArtifactRef.to_canonical_term(wrong_profile)
      ])

    {board, codec_op} =
      Sim.command(board, "box_b", :submit_ballot, [
        context.link.election_id,
        ArtifactRef.to_canonical_term(wrong_codec)
      ])

    board = Sim.sync_all(board)
    snapshot = %{context.snapshot | board_log: Sim.log(board, "supervisor")}

    projection =
      Election.project(context.spec, snapshot, %{
        wrong_profile.digest => "ballot",
        wrong_codec.digest => "ballot"
      })

    assert projection.status ==
             {:invalid,
              [
                %{digest: wrong_codec.digest, op_id: codec_op.id, reason: :noncanonical_artifact},
                %{
                  digest: wrong_profile.digest,
                  op_id: profile_op.id,
                  reason: :unsupported_profile
                }
              ]
              |> Enum.sort_by(&Canonical.term/1)}
  end

  test "a trustee contribution id must be the configured outer publisher key", context do
    ref = artifact_ref("opaque trustee contribution", context.spec.profile)
    trustee_b = Sim.identity(context.board, "trustee_b").pub

    {board, spoofed} =
      Sim.command(context.board, "trustee_a", :publish_protocol_artifact, [
        context.link.election_id,
        "close-digest",
        "mix",
        1,
        trustee_b,
        ArtifactRef.to_canonical_term(ref)
      ])

    {board, valid} =
      Sim.command(board, "trustee_a", :publish_protocol_artifact, [
        context.link.election_id,
        "close-digest",
        "mix",
        1,
        Sim.identity(board, "trustee_a").pub,
        ArtifactRef.to_canonical_term(ref)
      ])

    board = Sim.sync_all(board)
    snapshot = %{context.snapshot | board_log: Sim.log(board, "supervisor")}

    projection =
      Election.project(context.spec, snapshot, %{ref.digest => "opaque trustee contribution"})

    assert %{op_id: spoofed_id, reason: :unauthorized_publisher} =
             Enum.find(projection.rejected, &(&1.op_id == spoofed.id))

    assert spoofed_id == spoofed.id
    refute Enum.any?(projection.rejected, &(&1.op_id == valid.id))
  end

  @tag timeout: 5_000
  test "dense valid dependency DAGs are structurally checked in bounded time", context do
    identity = Sim.identity(context.board, "box_a")

    dense_log =
      Enum.reduce(1..26, context.snapshot.board_log, fn index, log ->
        op =
          Lattice.Op.new(identity, log.replica, log |> Log.op_ids() |> Enum.sort(), :inbox, {
            :dense_probe,
            index
          })

        Log.append!(log, op)
      end)

    task =
      Task.async(fn ->
        Election.project(context.spec, %{context.snapshot | board_log: dense_log}, %{})
      end)

    result = Task.yield(task, 1_500) || Task.shutdown(task, :brutal_kill)
    assert {:ok, %Projection{phase: :setup}} = result
  end

  defp artifact_ref(bytes, profile) do
    {:ok, ref} =
      ArtifactRef.new(bytes,
        codec: ArtifactRef.foundation_codec(),
        profile: ProfileRef.artifact_id(profile),
        max_byte_size: @max_bytes
      )

    ref
  end
end
