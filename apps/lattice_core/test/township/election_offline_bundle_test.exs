defmodule Township.ElectionOfflineBundleTest do
  use ExUnit.Case, async: true

  alias Lattice.{Log, Sim}
  alias Township.{Election, ElectionBoard, Matter}

  alias Township.Election.{
    ArtifactRef,
    BoardSnapshot,
    OfflineBundle,
    ProfileRef,
    Projection,
    Spec
  }

  @max_bytes 4_096
  @realms ["supervisor", "registrar", "box_a", "box_b", "trustee"]

  setup do
    seed = "election-offline-bundle"
    matter = Sim.new(Matter, "replica:matter:offline-bundle", @realms, seed: seed)
    {matter, _genesis} = Sim.create_replica(matter, "supervisor")

    board = Sim.new(ElectionBoard, "replica:election-board:offline-bundle", @realms, seed: seed)
    {board, _genesis} = Sim.create_replica(board, "supervisor")

    {:ok, profile} =
      ProfileRef.new(%{
        id: "unselected-offline-research",
        version: "unselected",
        parameters_digest: "not-pinned"
      })

    producer_only_choice =
      String.to_atom("offline-producer-choice-#{System.unique_integer([:positive])}")

    {:ok, spec} =
      Spec.new(%{
        subject: Sim.replica(matter),
        question_digest: "sha256:offline-question",
        choices: [producer_only_choice, :reject],
        profile: profile,
        supervisor: Sim.identity(board, "supervisor").pub,
        registration_tellers: [Sim.identity(board, "registrar").pub],
        ballot_boxes: [Sim.identity(board, "box_a").pub, Sim.identity(board, "box_b").pub],
        close_policy: %{id: :unanimous_boxes_v1, members: :ballot_boxes, quorum: :all},
        trustees: [Sim.identity(board, "trustee").pub],
        max_corrupt_trustees: 0,
        tally_share_quorum: 1,
        result_policy: :plurality,
        domain: "township:test:offline-bundle"
      })

    {matter, link_op} =
      Sim.command(matter, "supervisor", :link_election, [Spec.digest(spec)])

    {:ok, link} = Election.verify_link(spec, Sim.log(matter, "supervisor"), link_op.id)

    {matter, unrelated_matter_op} =
      Sim.command(matter, "supervisor", :set_title, ["Unrelated public matter edit"])

    {board, _cap_a} = Sim.grant(board, "supervisor", "box_a", ops: [:submit_ballot])
    {board, _cap_b} = Sim.grant(board, "supervisor", "box_b", ops: [:submit_ballot])
    board = Sim.sync_all(board)

    entries = [{"box_a", "opaque-ballot-a"}, {"box_b", "opaque-ballot-b"}]

    {board, artifacts} =
      Enum.reduce(entries, {board, %{}}, fn {box, bytes}, {board, artifacts} ->
        ref = artifact_ref(bytes, spec.profile)

        {board, _op} =
          Sim.command(board, box, :submit_ballot, [
            link.election_id,
            ArtifactRef.to_canonical_term(ref)
          ])

        {board, Map.put(artifacts, ref.digest, bytes)}
      end)

    board = Sim.sync_all(board)

    snapshot = %BoardSnapshot{
      matter_log: Sim.log(matter, "supervisor"),
      matter_link_op_id: link_op.id,
      board_log: Sim.log(board, "supervisor"),
      max_artifact_byte_size: @max_bytes
    }

    %{
      artifacts: artifacts,
      snapshot: snapshot,
      spec: spec,
      unrelated_matter_op_id: unrelated_matter_op.id
    }
  end

  test "complete public evidence encodes deterministically and replays offline", ctx do
    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)

    reversed_log =
      Log.from_ops(
        ctx.snapshot.board_log.replica,
        ctx.snapshot.board_log.ops |> Enum.reverse() |> Map.new()
      )

    reversed_artifacts = ctx.artifacts |> Enum.reverse() |> Map.new()

    {:ok, permuted} =
      OfflineBundle.build(
        ctx.spec,
        %{ctx.snapshot | board_log: reversed_log},
        reversed_artifacts
      )

    assert {:ok, bytes} = OfflineBundle.encode(bundle)
    assert {:ok, ^bytes} = OfflineBundle.encode(permuted)
    assert {:ok, decoded} = OfflineBundle.decode(bytes)
    assert decoded == bundle

    expected = Election.project(ctx.spec, ctx.snapshot, ctx.artifacts)
    assert {:ok, ^expected} = OfflineBundle.verify(bundle)
    assert {:ok, ^expected} = OfflineBundle.verify_bytes(bytes)
    assert %Projection{phase: :setup, status: {:pending, [:profile_unselected]}} = expected
    refute match?({:final, _result}, expected.status)
  end

  test "a fresh BEAM verifies producer-created canonical atoms", ctx do
    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)
    {:ok, bytes} = OfflineBundle.encode(bundle)

    code_paths =
      :code.get_path()
      |> Enum.map(&List.to_string/1)
      |> Enum.filter(&File.dir?/1)

    encoded_bundle = inspect(Base.encode64(bytes), limit: :infinity, printable_limit: :infinity)

    script = """
    {:ok, _apps} = Application.ensure_all_started(:lattice_core)
    bytes = Base.decode64!(#{encoded_bundle})

    case Township.Election.OfflineBundle.verify_bytes(bytes) do
      {:ok, %Township.Election.Projection{phase: :setup}} -> IO.write("verified")
      other -> IO.write("failed:\#{inspect(other)}"); System.halt(1)
    end
    """

    args = Enum.flat_map(code_paths, &["-pa", &1]) ++ ["-e", script]
    elixir = System.find_executable("elixir") || flunk("no elixir executable available on PATH")
    {output, status} = System.cmd(elixir, args, stderr_to_stdout: true)

    assert status == 0, output
    assert output == "verified"
  end

  test "missing, altered, and additional artifact bytes fail closed", ctx do
    [digest | _rest] = Map.keys(ctx.artifacts)

    missing = Map.delete(ctx.artifacts, digest)

    assert {:error, {:pending, requirements}} =
             OfflineBundle.build(ctx.spec, ctx.snapshot, missing)

    assert {:artifact_unavailable, digest} in requirements

    altered = Map.put(ctx.artifacts, digest, "altered")
    assert {:error, {:invalid, findings}} = OfflineBundle.build(ctx.spec, ctx.snapshot, altered)
    assert Enum.any?(findings, &(&1.digest == digest))

    extra = Map.put(ctx.artifacts, "uncommitted-extra", "extra")

    assert {:error, {:artifact_set_mismatch, %{missing: [], unexpected: ["uncommitted-extra"]}}} =
             OfflineBundle.build(ctx.spec, ctx.snapshot, extra)
  end

  test "a built bundle rechecks every byte and rejects extras", ctx do
    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)
    [digest | _rest] = Map.keys(ctx.artifacts)

    assert {:error, {:pending, requirements}} =
             OfflineBundle.verify(%{bundle | artifacts: Map.delete(bundle.artifacts, digest)})

    assert {:artifact_unavailable, digest} in requirements

    assert {:error, {:invalid, findings}} =
             OfflineBundle.verify(%{
               bundle
               | artifacts: Map.put(bundle.artifacts, digest, "altered")
             })

    assert Enum.any?(findings, &(&1.digest == digest))

    assert {:error, {:artifact_set_mismatch, %{missing: [], unexpected: ["uncommitted-extra"]}}} =
             OfflineBundle.verify(%{
               bundle
               | artifacts: Map.put(bundle.artifacts, "uncommitted-extra", "extra")
             })
  end

  test "tampered context or stored projection cannot verify", ctx do
    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)

    forged_spec = %{bundle.spec | question_digest: "sha256:different-question"}
    assert {:error, :matter_link_mismatch} = OfflineBundle.verify(%{bundle | spec: forged_spec})

    forged_log = %{bundle.board_log | replica: "replica:wrong-board"}
    assert {:error, _reason} = OfflineBundle.verify(%{bundle | board_log: forged_log})

    forged_projection = %{bundle.projection | phase: :final}

    assert {:error, :projection_mismatch} =
             OfflineBundle.verify(%{bundle | projection: forged_projection})
  end

  test "forged structural quarantine cannot authenticate itself through projection", ctx do
    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)
    existing_valid_op = bundle.board_log.ops |> Map.values() |> hd()

    forged_log = %{
      bundle.board_log
      | quarantine: [
          %{op: existing_valid_op, reason: "private credential material"}
          | bundle.board_log.quarantine
        ]
    }

    forged_snapshot = %BoardSnapshot{
      matter_log: bundle.matter_log,
      matter_link_op_id: bundle.matter_link_op_id,
      board_log: forged_log,
      max_artifact_byte_size: bundle.max_artifact_byte_size
    }

    forged_projection = Election.project(bundle.spec, forged_snapshot, bundle.artifacts)

    assert {:error, :invalid_board_quarantine} =
             OfflineBundle.verify(%{
               bundle
               | board_log: forged_log,
                 projection: forged_projection
             })
  end

  test "forged Matter quarantine cannot authenticate an unchanged projection", ctx do
    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)
    existing_valid_op = Map.fetch!(bundle.matter_log.ops, ctx.unrelated_matter_op_id)

    forged_matter_log = %{
      bundle.matter_log
      | quarantine: [
          %{op: existing_valid_op, reason: "private credential material"}
          | bundle.matter_log.quarantine
        ]
    }

    assert {:error, :invalid_matter_quarantine} =
             OfflineBundle.verify(%{bundle | matter_log: forged_matter_log})
  end

  test "decoding is total and schema-bound", ctx do
    assert {:error, :corrupt_offline_bundle} = OfflineBundle.decode(<<0, 1, 2, 3>>)
    assert {:error, :corrupt_offline_bundle} = OfflineBundle.verify_bytes(:not_bytes)

    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)

    wrong_schema =
      :erlang.term_to_binary(
        {"different-schema", %{bundle | schema: "different-schema"}},
        [:deterministic]
      )

    assert {:error, :corrupt_offline_bundle} = OfflineBundle.decode(wrong_schema)
  end

  test "the wire rejects compressed, oversized, deep, and noncanonical envelopes", ctx do
    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)
    {:ok, bytes} = OfflineBundle.encode(bundle)
    decoded_term = :erlang.binary_to_term(bytes)

    compressed =
      :erlang.term_to_binary(decoded_term, [:compressed, {:minor_version, 2}])

    assert {:error, :corrupt_offline_bundle} = OfflineBundle.decode(compressed)
    assert {:error, :corrupt_offline_bundle} = OfflineBundle.decode(bytes <> <<0>>)

    oversized = :binary.copy(<<0>>, OfflineBundle.max_envelope_byte_size() + 1)
    assert {:error, :corrupt_offline_bundle} = OfflineBundle.decode(oversized)

    too_deep =
      Enum.reduce(1..300, ["nil"], fn _index, child -> ["list", [child]] end)

    deep_envelope =
      :erlang.term_to_binary(
        [OfflineBundle.schema(), too_deep],
        [:deterministic, {:minor_version, 2}]
      )

    assert {:error, :corrupt_offline_bundle} = OfflineBundle.decode(deep_envelope)
  end

  test "the wire rejects noncanonical field order and alternate primitive tags", ctx do
    {:ok, bundle} = OfflineBundle.build(ctx.spec, ctx.snapshot, ctx.artifacts)
    {:ok, bytes} = OfflineBundle.encode(bundle)

    [schema, ["struct", module_name, pairs] = wire] = :erlang.binary_to_term(bytes)

    reversed_pairs =
      :erlang.term_to_binary(
        [schema, ["struct", module_name, Enum.reverse(pairs)]],
        [:deterministic, {:minor_version, 2}]
      )

    assert {:error, :corrupt_offline_bundle} = OfflineBundle.decode(reversed_pairs)

    {alternate_bool, true} =
      replace_first_wire(wire, fn
        ["bool", true] -> {:replace, ["atom", "true"]}
        ["bool", false] -> {:replace, ["atom", "false"]}
        _term -> :skip
      end)

    alternate_tag =
      :erlang.term_to_binary(
        [schema, alternate_bool],
        [:deterministic, {:minor_version, 2}]
      )

    assert {:error, :corrupt_offline_bundle} = OfflineBundle.decode(alternate_tag)
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

  defp replace_first_wire(term, replace) do
    case replace.(term) do
      {:replace, replacement} ->
        {replacement, true}

      :skip when is_list(term) ->
        replace_first_wire_list(term, replace, [])

      :skip ->
        {term, false}
    end
  end

  defp replace_first_wire_list([], _replace, reversed),
    do: {Enum.reverse(reversed), false}

  defp replace_first_wire_list([head | tail], replace, reversed) do
    case replace_first_wire(head, replace) do
      {updated, true} -> {Enum.reverse(reversed, [updated | tail]), true}
      {updated, false} -> replace_first_wire_list(tail, replace, [updated | reversed])
    end
  end
end
