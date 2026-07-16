defmodule Township.ElectionClosePolicyTest do
  use ExUnit.Case, async: true

  alias Lattice.{Identity, Sim}
  alias Township.{Election, ElectionBoard, Matter}

  alias Township.Election.{
    ArtifactCodec,
    ArtifactRef,
    BoardSnapshot,
    ProfileRef,
    Spec
  }

  alias Township.Election.ClosePolicy.UnanimousBoxesV1, as: ClosePolicy

  @max_bytes 16_384
  @open_certificate_id "administrative-open-proposal:test"
  @realms ["supervisor", "registrar", "box_a", "box_b", "trustee"]

  setup do
    seed = "election-close-policy"
    matter = Sim.new(Matter, "replica:matter:close", @realms, seed: seed)
    {matter, _genesis} = Sim.create_replica(matter, "supervisor")
    board = Sim.new(ElectionBoard, "replica:election-board:close", @realms, seed: seed)
    {board, _genesis} = Sim.create_replica(board, "supervisor")

    {:ok, profile} =
      ProfileRef.new(%{
        id: "unselected-close-research",
        version: "unselected",
        parameters_digest: "not-pinned"
      })

    {:ok, spec} =
      Spec.new(%{
        subject: Sim.replica(matter),
        question_digest: "sha256:close-question",
        choices: [:approve, :reject],
        profile: profile,
        supervisor: Sim.identity(board, "supervisor").pub,
        registration_tellers: [Sim.identity(board, "registrar").pub],
        ballot_boxes: [Sim.identity(board, "box_a").pub, Sim.identity(board, "box_b").pub],
        close_policy: %{id: :unanimous_boxes_v1, members: :ballot_boxes, quorum: :all},
        trustees: [Sim.identity(board, "trustee").pub],
        max_corrupt_trustees: 0,
        tally_share_quorum: 1,
        result_policy: :plurality,
        domain: "township:test:close"
      })

    {matter, link_op} =
      Sim.command(matter, "supervisor", :link_election, [Spec.digest(spec)])

    {:ok, link} = Election.verify_link(spec, Sim.log(matter, "supervisor"), link_op.id)

    close_ops = [
      :submit_ballot,
      :publish_box_seal,
      :propose_close,
      :attest_close,
      :certify_close
    ]

    {board, _box_a} = Sim.grant(board, "supervisor", "box_a", ops: close_ops)
    {board, _box_b} = Sim.grant(board, "supervisor", "box_b", ops: close_ops)
    board = Sim.sync_all(board)

    %{
      artifacts: %{},
      ballots: [],
      board: board,
      link: link,
      link_op: link_op,
      matter: matter,
      spec: spec
    }
  end

  test "unanimous evidence fixes exact wrappers while deduplicating inner ballot bytes", ctx do
    {ctx, ballot_a} = publish_ballot(ctx, "box_a", "same encrypted ballot")
    {ctx, ballot_b} = publish_ballot(ctx, "box_b", "same encrypted ballot")
    {ctx, attempt} = publish_close_attempt(ctx, [ballot_a, ballot_b])

    assert {:ok, evidence} = verify(ctx)
    assert evidence.election_id == ctx.link.election_id
    assert evidence.open_certificate_id == @open_certificate_id
    assert evidence.manifest_digest == attempt.manifest_ref.digest
    assert evidence.ballot_wrapper_ids == Enum.sort([ballot_a.op.id, ballot_b.op.id])
    assert evidence.ballot_digests == [ballot_a.ref.digest]
    assert evidence.prerequisite == :administrative_open_asserted

    assert Election.project(ctx.spec, snapshot(ctx), ctx.artifacts).phase == :setup
  end

  test "a seal that omits a causally prior ballot is invalid", ctx do
    {ctx, _ballot} = publish_ballot(ctx, "box_a", "omitted ballot")
    {ctx, _seal} = publish_seal(ctx, "box_a", [])
    ctx = %{ctx | board: Sim.sync_all(ctx.board)}

    assert {:invalid, findings} = verify(ctx)
    assert Enum.any?(findings, &(&1.reason == :checkpoint_incomplete))
  end

  test "missing box evidence stays pending and altered manifest bytes fail closed", ctx do
    {ctx, ballot_a} = publish_ballot(ctx, "box_a", "ballot-a")
    {ctx, _seal_a} = publish_seal(ctx, "box_a", [ballot_a])
    ctx = %{ctx | board: Sim.sync_all(ctx.board)}

    assert {:pending, requirements} = verify(ctx)

    box_b_id = ClosePolicy.box_id(Sim.identity(ctx.board, "box_b").pub)
    assert {:box_seal_missing, box_b_id} in requirements

    {ctx, ballot_b} = publish_ballot(ctx, "box_b", "ballot-b")
    {ctx, attempt} = publish_close_attempt(ctx, [ballot_a, ballot_b])

    unavailable = %{ctx | artifacts: Map.delete(ctx.artifacts, attempt.manifest_ref.digest)}
    assert {:pending, requirements} = verify(unavailable)
    assert {:artifact_unavailable, attempt.manifest_ref.digest} in requirements

    corrupted = %{ctx | artifacts: Map.put(ctx.artifacts, attempt.manifest_ref.digest, "corrupt")}
    assert {:invalid, findings} = verify(corrupted)

    assert Enum.any?(findings, fn finding ->
             finding.reason in [:artifact_size_mismatch, :artifact_digest_mismatch]
           end)
  end

  test "a manifest or certificate missing one configured box remains fail-closed", ctx do
    {ctx, ballot_a} = publish_ballot(ctx, "box_a", "manifest-a")
    {ctx, ballot_b} = publish_ballot(ctx, "box_b", "manifest-b")

    {manifest_ctx, _attempt} =
      publish_close_attempt(ctx, [ballot_a, ballot_b], manifest_boxes: ["box_a"])

    assert {:invalid, findings} = verify(manifest_ctx)
    assert Enum.any?(findings, &(&1.reason == :checkpoint_incomplete))

    {signature_ctx, _attempt} =
      publish_close_attempt(ctx, [ballot_a, ballot_b], signers: ["box_a"])

    assert {:pending, requirements} = verify(signature_ctx)

    box_b_id = ClosePolicy.box_id(Sim.identity(signature_ctx.board, "box_b").pub)
    assert {:close_signature_missing, box_b_id} in requirements
  end

  test "ballots published after the certified seals are late, not hash-order winners", ctx do
    {ctx, ballot_a} = publish_ballot(ctx, "box_a", "included-a")
    {ctx, ballot_b} = publish_ballot(ctx, "box_b", "included-b")
    {ctx, _attempt} = publish_close_attempt(ctx, [ballot_a, ballot_b])
    {ctx, late} = publish_ballot(ctx, "box_a", "late-ballot")
    ctx = %{ctx | board: Sim.sync_all(ctx.board)}

    assert {:ok, evidence} = verify(ctx)
    assert ballot_a.op.id in evidence.ballot_wrapper_ids
    assert ballot_b.op.id in evidence.ballot_wrapper_ids
    refute late.op.id in evidence.ballot_wrapper_ids
    refute late.ref.digest in evidence.ballot_digests
  end

  test "two fully certified manifests are forked and no digest winner is selected", ctx do
    {ctx, first_a} = publish_ballot(ctx, "box_a", "first-a")
    {ctx, first_b} = publish_ballot(ctx, "box_b", "first-b")
    {ctx, first} = publish_close_attempt(ctx, [first_a, first_b])

    {ctx, second_a} = publish_ballot(ctx, "box_a", "second-a")
    {ctx, second_b} = publish_ballot(ctx, "box_b", "second-b")

    {ctx, second} =
      publish_close_attempt(ctx, [first_a, first_b, second_a, second_b])

    assert {:forked, findings} = verify(ctx)
    assert Enum.any?(findings, &(&1.reason == :forked_close))

    digests = Enum.sort([first.manifest_ref.digest, second.manifest_ref.digest])
    assert Enum.any?(findings, &(&1.manifest_digests == digests))
  end

  test "two distinct valid seals by one box are equivocation unless full closes fork", ctx do
    {ctx, first_a} = publish_ballot(ctx, "box_a", "prefix-a")
    {ctx, first_b} = publish_ballot(ctx, "box_b", "prefix-b")
    {ctx, _first_seal_a} = publish_seal(ctx, "box_a", [first_a])
    {ctx, _first_seal_b} = publish_seal(ctx, "box_b", [first_b])
    ctx = %{ctx | board: Sim.sync_all(ctx.board)}

    {ctx, second_a} = publish_ballot(ctx, "box_a", "later-a")
    {ctx, second_b} = publish_ballot(ctx, "box_b", "later-b")

    {ctx, _certified_attempt} =
      publish_close_attempt(ctx, [first_a, first_b, second_a, second_b])

    assert {:invalid, findings} = verify(ctx)
    assert Enum.any?(findings, &(&1.reason == :box_equivocation))
  end

  test "same-byte manifest retransmission may change availability metadata without changing close",
       ctx do
    {ctx, ballot_a} = publish_ballot(ctx, "box_a", "metadata-a")
    {ctx, ballot_b} = publish_ballot(ctx, "box_b", "metadata-b")
    {ctx, attempt} = publish_close_attempt(ctx, [ballot_a, ballot_b])

    retransmitted_ref = %{
      attempt.manifest_ref
      | availability_certificate: "late-availability-metadata"
    }

    {board, retransmission_op} =
      Sim.command(ctx.board, "box_b", :propose_close, [
        ctx.link.election_id,
        ArtifactRef.to_canonical_term(retransmitted_ref)
      ])

    ctx = %{ctx | board: Sim.sync_all(board)}

    assert {:ok, evidence} = verify(ctx)
    assert evidence.manifest_digest == attempt.manifest_ref.digest
    refute Enum.any?(evidence.rejected, &(&1.op_id == retransmission_op.id))
  end

  test "a malformed extra artifact stays rejected without erasing valid close evidence", ctx do
    {ctx, ballot_a} = publish_ballot(ctx, "box_a", "valid-a")
    {ctx, ballot_b} = publish_ballot(ctx, "box_b", "valid-b")
    {ctx, attempt} = publish_close_attempt(ctx, [ballot_a, ballot_b])
    {ctx, malformed_seal} = publish_seal(ctx, "box_a", [])
    ctx = %{ctx | board: Sim.sync_all(ctx.board)}

    assert {:ok, evidence} = verify(ctx)
    assert evidence.manifest_digest == attempt.manifest_ref.digest
    assert Enum.any?(evidence.rejected, &(&1.op_id == malformed_seal.op.id))
  end

  test "an attest for an unknown manifest stays rejected without erasing valid close evidence",
       ctx do
    {ctx, ballot_a} = publish_ballot(ctx, "box_a", "known-a")
    {ctx, ballot_b} = publish_ballot(ctx, "box_b", "known-b")
    {ctx, attempt} = publish_close_attempt(ctx, [ballot_a, ballot_b])

    unknown_digest = "unknown-manifest"
    identity = Sim.identity(ctx.board, "box_a")

    signature =
      Identity.sign(
        identity,
        ClosePolicy.signature_payload(ctx.link.election_id, unknown_digest)
      )

    {board, extra_attest} =
      Sim.command(ctx.board, "box_a", :attest_close, [
        ctx.link.election_id,
        unknown_digest,
        signature
      ])

    ctx = %{ctx | board: Sim.sync_all(board)}

    assert {:ok, evidence} = verify(ctx)
    assert evidence.manifest_digest == attempt.manifest_ref.digest

    assert Enum.any?(
             evidence.rejected,
             &(&1.op_id == extra_attest.id and &1.reason == :invalid_role_signature)
           )
  end

  test "canonical close documents reject alternate JSON bytes", _ctx do
    document = %{"schema" => "test", "value" => [1, 2]}
    assert {:ok, bytes} = ArtifactCodec.encode(document)
    assert {:ok, ^document} = ArtifactCodec.decode(bytes)
    assert {:error, :noncanonical_artifact} = ArtifactCodec.decode(bytes <> "\n")
    assert {:error, :noncanonical_artifact} = ArtifactCodec.encode(%{atom_key: "forbidden"})
  end

  defp publish_ballot(ctx, box, bytes) do
    ref = artifact_ref(ctx, bytes)

    {board, op} =
      Sim.command(ctx.board, box, :submit_ballot, [
        ctx.link.election_id,
        ArtifactRef.to_canonical_term(ref)
      ])

    record = %{box: box, op: op, ref: ref}

    {%{
       ctx
       | board: board,
         artifacts: Map.put(ctx.artifacts, ref.digest, bytes),
         ballots: ctx.ballots ++ [record]
     }, record}
  end

  defp publish_close_attempt(ctx, ballots, opts \\ []) do
    {ctx, seal_a} = publish_seal(ctx, "box_a", Enum.filter(ballots, &(&1.box == "box_a")))
    {ctx, seal_b} = publish_seal(ctx, "box_b", Enum.filter(ballots, &(&1.box == "box_b")))
    ctx = %{ctx | board: Sim.sync_all(ctx.board)}

    seals = [seal_a, seal_b]
    manifest_boxes = Keyword.get(opts, :manifest_boxes, ["box_a", "box_b"])
    manifest_seals = Enum.filter(seals, &(&1.box in manifest_boxes))

    manifest_document =
      ClosePolicy.manifest_document(
        ctx.link.election_id,
        @open_certificate_id,
        manifest_seals,
        ballots
      )

    {:ok, manifest_bytes} = ArtifactCodec.encode(manifest_document)
    manifest_ref = artifact_ref(ctx, manifest_bytes)

    {board, proposal_op} =
      Sim.command(ctx.board, "box_a", :propose_close, [
        ctx.link.election_id,
        ArtifactRef.to_canonical_term(manifest_ref)
      ])

    ctx = %{
      ctx
      | board: Sim.sync_all(board),
        artifacts: Map.put(ctx.artifacts, manifest_ref.digest, manifest_bytes)
    }

    signatures =
      for box <- Keyword.get(opts, :signers, ["box_a", "box_b"]) do
        identity = Sim.identity(ctx.board, box)

        signature =
          Identity.sign(
            identity,
            ClosePolicy.signature_payload(ctx.link.election_id, manifest_ref.digest)
          )

        {box, identity.pub, signature}
      end

    {board, attest_ops} =
      Enum.reduce(signatures, {ctx.board, []}, fn {box, _pub, signature}, {board, ops} ->
        {board, op} =
          Sim.command(board, box, :attest_close, [
            ctx.link.election_id,
            manifest_ref.digest,
            signature
          ])

        {board, [op | ops]}
      end)

    board = Sim.sync_all(board)

    certificate =
      ClosePolicy.certificate_document(
        ctx.link.election_id,
        manifest_ref,
        Enum.map(signatures, fn {_box, pub, signature} -> {pub, signature} end)
      )

    {board, certificate_op} =
      Sim.command(board, "box_a", :certify_close, [ctx.link.election_id, certificate])

    ctx = %{ctx | board: Sim.sync_all(board)}

    {ctx,
     %{
       attest_ops: attest_ops,
       certificate_op: certificate_op,
       manifest_ref: manifest_ref,
       proposal_op: proposal_op,
       seals: [seal_a, seal_b]
     }}
  end

  defp publish_seal(ctx, box, ballots) do
    identity = Sim.identity(ctx.board, box)

    document =
      ClosePolicy.seal_document(
        ctx.link.election_id,
        identity.pub,
        @open_certificate_id,
        ballots
      )

    {:ok, bytes} = ArtifactCodec.encode(document)
    ref = artifact_ref(ctx, bytes)

    {board, op} =
      Sim.command(ctx.board, box, :publish_box_seal, [
        ctx.link.election_id,
        ArtifactRef.to_canonical_term(ref)
      ])

    {%{ctx | board: board, artifacts: Map.put(ctx.artifacts, ref.digest, bytes)},
     %{box: box, box_pub: identity.pub, op: op, ref: ref}}
  end

  defp verify(ctx) do
    ClosePolicy.verify(ctx.spec, snapshot(ctx), ctx.artifacts, @open_certificate_id)
  end

  defp snapshot(ctx) do
    %BoardSnapshot{
      matter_log: Sim.log(ctx.matter, "supervisor"),
      matter_link_op_id: ctx.link_op.id,
      board_log: Sim.log(ctx.board, "supervisor"),
      max_artifact_byte_size: @max_bytes
    }
  end

  defp artifact_ref(ctx, bytes) do
    {:ok, ref} =
      ArtifactRef.new(bytes,
        codec: ArtifactRef.foundation_codec(),
        profile: ProfileRef.artifact_id(ctx.spec.profile),
        max_byte_size: @max_bytes
      )

    ref
  end
end
