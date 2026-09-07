defmodule Treehouse.MemberContinuitySemanticReciprocalTest do
  use ExUnit.Case, async: true
  alias Lattice.{Log, Op, Sync}
  alias Lattice.Carrier.Wire
  alias Treehouse.MemberContinuity
  alias Treehouse.MemberContinuityCertificate, as: Certificate
  alias Treehouse.MemberContinuitySemanticVectors, as: Vectors

  @vectors Path.expand(
             "../../../../clients/lattice-client/test/vectors/member_continuity_semantics",
             __DIR__
           )

  test "independently signed histories have exact public graph, reasons and ordinary state in both orders" do
    for producer <- ["beam", "ts"] do
      corpus = read(producer)

      for item <- corpus["cases"], frames <- [item["frames"], Enum.reverse(item["frames"])] do
        log = import!(item["replica"], frames)
        assert json(Vectors.summary(log)) == item["expected"], "#{producer}/#{item["name"]}"
        # Duplicate delivery changes neither accepted content nor projection.
        {:ok, ops} = Wire.decode_ops(frames)
        {again, %{pending: []}} = Sync.deliver(log, ops)
        assert again == log
      end
    end

    assert read("beam")["authoring"]["claim_id"] != read("ts")["authoring"]["claim_id"]
  end

  test "opposite runtime review and assembly reproduce exact independently signed intent bytes" do
    for producer <- ["beam", "ts"] do
      a = read(producer)["authoring"]
      log = import!(a["replica"], a["frames"])
      request = Vectors.request_from_json(a["request"])
      assert {:ok, review} = MemberContinuity.review(log, request)
      assert Base.encode64(review.claim_bytes) == a["claim_bytes"]
      assert Base.encode64(review.possession_bytes) == a["possession_bytes"]
      assert review.claim_id == a["claim_id"]
      assert {:ok, claim} = Certificate.claim_from_wire(a["claim_term"])
      assert claim == review.claim
      assert {:ok, certificate} = Certificate.certificate_from_wire(a["certificate_term"])

      signer = %{
        pub: request.author,
        sign: fn bytes ->
          assert Base.encode64(bytes) == a["frame_bytes"]
          send(self(), :semantic_signer_called)
          Base.decode64!(a["frame"]["sig"])
        end
      }

      assert {:error, :application_continuity_invalid_certificate} =
               MemberContinuity.assemble(
                 log,
                 review,
                 %{certificate | possession: <<0::512>>},
                 signer
               )

      refute_received :semantic_signer_called
      assert {:ok, assembled} = MemberContinuity.assemble(log, review, certificate, signer)
      assert_received :semantic_signer_called
      refute_received :semantic_signer_called
      assert {:ok, expected_op} = Wire.decode_op(a["frame"])
      assert assembled.op == expected_op
      assert Base.encode64(Op.canonical_encoding(assembled.op)) == a["frame_bytes"]
      assert Op.valid?(assembled.op)
    end
  end

  @tag :tmp_dir
  @tag timeout: 120_000
  test "separate cold processes authenticate first semantic frame and verified restore", %{
    tmp_dir: dir
  } do
    for producer <- ["beam", "ts"] do
      corpus = read(producer)

      for item <- corpus["cases"], mode <- ["first_frame", "restore"] do
        path = Path.join(dir, "#{producer}-#{item["name"]}.dump")
        log = import!(item["replica"], item["frames"])
        :ok = Log.dump(log, path)

        script = """
        false = :code.is_loaded(Treehouse.MemberContinuityCertificate)
        false = :code.is_loaded(Treehouse.MemberContinuity)
        Code.ensure_loaded!(Treehouse.Space)
        Code.ensure_loaded!(Lattice.Authority)
        Code.ensure_loaded!(Lattice.Authority.Delegation)
        [vector_path, name, dump, mode] = System.argv()
        corpus = vector_path |> File.read!() |> Jason.decode!()
        item = Enum.find(corpus["cases"], &(&1["name"] == name))
        log = if mode == "first_frame" do
          # Receive the attestation before causal dependencies, without codec warming.
          frame = Enum.find(item["frames"], fn frame ->
            match?(["tuple", [["atom", "attest_member_key_v1"], _]], frame["body"])
          end)
          {:ok, first} = Lattice.Carrier.Wire.decode_op(frame)
          true = Lattice.Op.valid?(first)
          false = :code.is_loaded(Treehouse.MemberContinuityCertificate)
          {:ok, ops} = Lattice.Carrier.Wire.decode_ops(item["frames"])
          {log, %{pending: []}} = Lattice.Sync.deliver(Lattice.Log.new(item["replica"]), Enum.reverse(ops))
          log
        else
          # This process has not decoded frames or called the continuity observer.
          {:ok, %{log: restored}} = Lattice.Log.restore_verified(dump)
          false = :code.is_loaded(Treehouse.MemberContinuityCertificate)
          restored
        end
        :ok = Lattice.Log.verify_authenticity(log)
        {:ok, observed} = apply(Treehouse.MemberContinuity, :observe, [log])
        true = observed.verified_frontier == item["expected"]["frontier"]
        true = Enum.map(observed.records, & &1.claim_id) == Enum.map(item["expected"]["records"], & &1["claim_id"])
        true = Enum.map(observed.links, &Atom.to_string(&1.status)) == Enum.map(item["expected"]["links"], & &1["status"])
        true = (observed.quarantine |> Jason.encode!() |> Jason.decode!()) == item["expected"]["quarantine"]
        {:ok, expected_ops} = Lattice.Carrier.Wire.decode_ops(item["frames"])
        true = log.ops == Map.new(expected_ops, &{&1.id, &1})
        IO.puts("COLD_SEMANTIC_FIRST_FRAME_AND_RESTORE_OK")
        """

        {output, status} =
          System.cmd(
            elixir_executable(),
            [
              "-pa",
              Application.app_dir(:lattice_core, "ebin"),
              "-pa",
              Application.app_dir(:jason, "ebin"),
              "-e",
              script,
              Path.join(@vectors, "#{producer}_semantics.json"),
              item["name"],
              path,
              mode
            ],
            env: [{"ERL_FLAGS", "+S 4:4"}],
            stderr_to_stdout: true
          )

        assert status == 0, "#{producer}/#{item["name"]}: #{output}"
        assert output =~ "COLD_SEMANTIC_FIRST_FRAME_AND_RESTORE_OK"
      end
    end
  end

  @tag :tmp_dir
  test "opposite signed histories cannot authenticate forged or incomplete logs or dumps", %{
    tmp_dir: dir
  } do
    for producer <- ["beam", "ts"] do
      a = read(producer)["authoring"]
      log = import!(a["replica"], a["frames"] ++ [a["frame"]])
      op = log.ops[a["frame"]["id"]]
      forged = %{log | ops: Map.put(log.ops, op.id, %{op | sig: <<0::512>>})}
      assert {:error, :invalid_verified_history} = MemberContinuity.observe(forged)

      assert {:error, :invalid_verified_history} =
               MemberContinuity.observe(%{log | ops: Map.delete(log.ops, hd(op.deps))})

      assert {:error, :invalid_verified_history} =
               MemberContinuity.observe(%{log | replica: "wrong-replica"})

      path = Path.join(dir, "#{producer}-forged.dump")
      :ok = Log.dump(forged, path)

      script = """
      Code.ensure_loaded!(Treehouse.Space)
      Code.ensure_loaded!(Lattice.Authority)
      {:error, _} = Lattice.Log.restore_verified(hd(System.argv()))
      IO.puts("FORGED_SEMANTIC_DUMP_REFUSED")
      """

      {output, status} =
        System.cmd(
          elixir_executable(),
          ["-pa", Application.app_dir(:lattice_core, "ebin"), "-e", script, path],
          env: [{"ERL_FLAGS", "+S 4:4"}],
          stderr_to_stdout: true
        )

      assert status == 0, output
      assert output =~ "FORGED_SEMANTIC_DUMP_REFUSED"
    end
  end

  @tag :tmp_dir
  test "BEAM independently regenerates its exact new vector bytes", %{tmp_dir: dir} do
    path = Path.join(dir, "fresh.json")
    Vectors.export!(path)
    assert File.read!(path) == File.read!(Path.join(@vectors, "beam_semantics.json"))
  end

  defp import!(replica, frames) do
    Code.ensure_loaded!(Treehouse.Space)
    Code.ensure_loaded!(Lattice.Authority)
    Code.ensure_loaded!(Lattice.Authority.Delegation)
    Code.ensure_loaded!(Lattice.Log)

    assert Enum.all?(frames, fn frame -> match?({:ok, _}, Wire.decode_op(frame)) end),
           inspect(
             for frame <- frames,
                 match?({:error, _}, Wire.decode_op(frame)),
                 do: {frame["id"], frame["body"]}
           )

    {:ok, ops} = Wire.decode_ops(frames)
    assert Enum.all?(ops, &Op.valid?/1)
    {log, %{pending: []}} = Sync.deliver(Log.new(replica), ops)
    assert :ok = Log.verify_authenticity(log)
    log
  end

  defp read(producer),
    do: Path.join(@vectors, "#{producer}_semantics.json") |> File.read!() |> Jason.decode!()

  defp json(value), do: value |> Jason.encode!() |> Jason.decode!()

  # Local invocations supply the documented OTP/Elixir PATH prefix; CI supplies
  # erlef/setup-beam. Do not require a developer's local version-manager layout.
  defp elixir_executable,
    do: System.find_executable("elixir") || raise("Elixir executable unavailable")
end
