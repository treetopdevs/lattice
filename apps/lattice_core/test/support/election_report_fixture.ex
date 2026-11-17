defmodule Township.ElectionReportFixture do
  @moduledoc """
  Test-only research producer for the election evidence report (row 156).

  It is compiled only in `MIX_ENV=test` and builds one unanimous-close scenario on
  the dedicated `Township.ElectionBoard` Sim: two ballot boxes, two opaque
  byte-string fixture ballots, their seals, one close manifest, unanimous attests
  and one close certificate. The Matter carries nothing beyond the election link
  command. The ballots are opaque fixture bytes, not encrypted choices; nothing
  here models a real election, and the scenario makes no security claim. The
  legacy `Lattice.Attestation.Stub` is untouched.

  The body is a minimal copy of the `election_close_policy_test.exs` setup and
  its publish helpers, so a change to the close-policy document shapes breaks it
  loudly.
  """

  alias Lattice.{Identity, Sim}
  alias Township.{Election, ElectionBoard, Matter}

  alias Township.Election.{
    ArtifactCodec,
    ArtifactRef,
    BoardSnapshot,
    OfflineBundle,
    ProfileRef,
    Spec
  }

  alias Township.Election.ClosePolicy.UnanimousBoxesV1, as: ClosePolicy

  @max_bytes 16_384
  @open_certificate_id "administrative-open-proposal:research-fixture"
  @realms ["supervisor", "registrar", "box_a", "box_b", "trustee"]
  @seed "election-report-research-fixture"
  @close_ops [:submit_ballot, :publish_box_seal, :propose_close, :attest_close, :certify_close]

  @doc "Operator-asserted open certificate id used by the fixture."
  @spec open_certificate_id() :: String.t()
  def open_certificate_id, do: @open_certificate_id

  @doc "Build the deterministic unanimous-close research scenario."
  @spec close_scenario() :: map()
  def close_scenario do
    ctx = setup_ctx()
    {ctx, ballot_a} = publish_ballot(ctx, "box_a", "opaque-fixture-ballot-a")
    {ctx, ballot_b} = publish_ballot(ctx, "box_b", "opaque-fixture-ballot-b")
    ctx = publish_close_attempt(ctx, [ballot_a, ballot_b])
    snapshot = snapshot(ctx)

    {:ok, evidence} =
      ClosePolicy.verify(ctx.spec, snapshot, ctx.artifacts, @open_certificate_id)

    %{
      spec: ctx.spec,
      snapshot: snapshot,
      artifacts: ctx.artifacts,
      open_certificate_id: @open_certificate_id,
      evidence: evidence
    }
  end

  @doc "Encode the scenario as offline-bundle bytes (`OfflineBundle.build/3` then `encode/1`)."
  @spec bundle_bytes(map()) :: binary()
  def bundle_bytes(%{spec: spec, snapshot: snapshot, artifacts: artifacts}) do
    {:ok, bundle} = OfflineBundle.build(spec, snapshot, artifacts)
    {:ok, bytes} = OfflineBundle.encode(bundle)
    bytes
  end

  @doc """
  Replay the scenario with one ballot's bytes replaced by bytes of a different
  length and return the resulting `{:invalid, _}` projection.
  """
  @spec tampered_projection(map()) :: Township.Election.Projection.t()
  def tampered_projection(%{spec: spec, snapshot: snapshot, artifacts: artifacts, evidence: ev}) do
    [digest | _rest] = ev.ballot_digests
    tampered = Map.update!(artifacts, digest, &(&1 <> "-tampered"))

    {:ok, %{projection: %{status: {:invalid, _findings}} = projection}} =
      Election.replay(spec, snapshot, tampered)

    projection
  end

  defp setup_ctx do
    matter = Sim.new(Matter, "replica:matter:election-report", @realms, seed: @seed)
    {matter, _genesis} = Sim.create_replica(matter, "supervisor")
    board = Sim.new(ElectionBoard, "replica:election-board:report", @realms, seed: @seed)
    {board, _genesis} = Sim.create_replica(board, "supervisor")

    {:ok, profile} =
      ProfileRef.new(%{
        id: "unselected-report-research",
        version: "unselected",
        parameters_digest: "not-pinned"
      })

    {:ok, spec} =
      Spec.new(%{
        subject: Sim.replica(matter),
        question_digest: "sha256:report-research-question",
        choices: ["approve", "reject"],
        profile: profile,
        supervisor: Sim.identity(board, "supervisor").pub,
        registration_tellers: [Sim.identity(board, "registrar").pub],
        ballot_boxes: [Sim.identity(board, "box_a").pub, Sim.identity(board, "box_b").pub],
        close_policy: %{id: :unanimous_boxes_v1, members: :ballot_boxes, quorum: :all},
        trustees: [Sim.identity(board, "trustee").pub],
        max_corrupt_trustees: 0,
        tally_share_quorum: 1,
        result_policy: :plurality,
        domain: "township:research:report"
      })

    {matter, link_op} = Sim.command(matter, "supervisor", :link_election, [Spec.digest(spec)])
    {:ok, link} = Election.verify_link(spec, Sim.log(matter, "supervisor"), link_op.id)

    {board, _box_a} = Sim.grant(board, "supervisor", "box_a", ops: @close_ops)
    {board, _box_b} = Sim.grant(board, "supervisor", "box_b", ops: @close_ops)

    %{
      artifacts: %{},
      board: Sim.sync_all(board),
      link: link,
      link_op: link_op,
      matter: matter,
      spec: spec
    }
  end

  defp publish_ballot(ctx, box, bytes) do
    ref = artifact_ref(ctx, bytes)

    {board, op} =
      Sim.command(ctx.board, box, :submit_ballot, [
        ctx.link.election_id,
        ArtifactRef.to_canonical_term(ref)
      ])

    {%{ctx | board: board, artifacts: Map.put(ctx.artifacts, ref.digest, bytes)},
     %{box: box, op: op, ref: ref}}
  end

  defp publish_close_attempt(ctx, ballots) do
    {ctx, seal_a} = publish_seal(ctx, "box_a", Enum.filter(ballots, &(&1.box == "box_a")))
    {ctx, seal_b} = publish_seal(ctx, "box_b", Enum.filter(ballots, &(&1.box == "box_b")))
    ctx = %{ctx | board: Sim.sync_all(ctx.board)}

    manifest_document =
      ClosePolicy.manifest_document(
        ctx.link.election_id,
        @open_certificate_id,
        [seal_a, seal_b],
        ballots
      )

    {:ok, manifest_bytes} = ArtifactCodec.encode(manifest_document)
    manifest_ref = artifact_ref(ctx, manifest_bytes)

    {board, _proposal_op} =
      Sim.command(ctx.board, "box_a", :propose_close, [
        ctx.link.election_id,
        ArtifactRef.to_canonical_term(manifest_ref)
      ])

    ctx = %{
      ctx
      | board: Sim.sync_all(board),
        artifacts: Map.put(ctx.artifacts, manifest_ref.digest, manifest_bytes)
    }

    signatures = Enum.map(["box_a", "box_b"], &close_signature(ctx, &1, manifest_ref))

    board =
      Enum.reduce(signatures, ctx.board, fn {box, _pub, signature}, board ->
        {board, _op} =
          Sim.command(board, box, :attest_close, [
            ctx.link.election_id,
            manifest_ref.digest,
            signature
          ])

        board
      end)

    certificate =
      ClosePolicy.certificate_document(
        ctx.link.election_id,
        manifest_ref,
        Enum.map(signatures, fn {_box, pub, signature} -> {pub, signature} end)
      )

    {board, _certificate_op} =
      Sim.command(Sim.sync_all(board), "box_a", :certify_close, [
        ctx.link.election_id,
        certificate
      ])

    %{ctx | board: Sim.sync_all(board)}
  end

  defp close_signature(ctx, box, manifest_ref) do
    identity = Sim.identity(ctx.board, box)

    signature =
      Identity.sign(
        identity,
        ClosePolicy.signature_payload(ctx.link.election_id, manifest_ref.digest)
      )

    {box, identity.pub, signature}
  end

  defp publish_seal(ctx, box, ballots) do
    identity = Sim.identity(ctx.board, box)

    document =
      ClosePolicy.seal_document(ctx.link.election_id, identity.pub, @open_certificate_id, ballots)

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
