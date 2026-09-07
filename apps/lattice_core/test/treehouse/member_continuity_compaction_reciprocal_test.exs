defmodule Treehouse.MemberContinuityCompactionReciprocalTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, CompactionSpike, Dag, Log, Op, Reduce, Sync}
  alias Lattice.Carrier.Wire
  alias Treehouse.{MemberContinuity, Space}
  alias Treehouse.MemberContinuityCertificate, as: Certificate

  @vectors Path.expand(
             "../../../../clients/lattice-client/test/vectors/member_continuity_semantics",
             __DIR__
           )
  @cases ~w(review_assembled wrong_capability bad_certificate missing_admission stale_parent_context causal_removed_voucher concurrent_removed_voucher same_old_fork all_head_resolution mixed_parent_wrappers cross_old_target_collision future_parent_invalidation)

  for producer <- ~w(beam ts), name <- @cases do
    @tag producer: producer, scenario: name
    test "#{producer}/#{name} mirrors actual signed continuity at every legal nonempty stable cut",
         context do
      item = read(context.producer)["cases"] |> Enum.find(&(&1["name"] == context.scenario))
      log = import!(item)
      full = Authority.analyze(Space, log)
      expected_reasons = Map.new(item["expected"]["quarantine"], &{&1["op_id"], &1["reason"]})

      assert Map.new(full.reasons, fn {id, reason} -> {id, Atom.to_string(reason)} end) ==
               expected_reasons

      raw_state = Reduce.reduce(Space, log, quarantine: full.quarantine)
      assert {:ok, observed} = MemberContinuity.observe(log)
      cuts = legal_cuts(log)
      assert cuts != [], "no legal nonempty cut for #{context.scenario}"

      for delivered <- deliveries(log), frontier <- cuts do
        assert {:ok, snapshot, retained} =
                 CompactionSpike.compact_application(Space, delivered, frontier)

        assert Enum.any?(snapshot.covered_valid_beacons, &(&1.epoch == 0))
        assert map_size(retained.ops) > 0

        assert Enum.any?(retained.ops, fn {_, op} ->
                 match?({:attest_member_key_v1, _}, op.body)
               end)

        result = CompactionSpike.reduce_application(Space, snapshot, retained)
        assert is_map(result), inspect({context.scenario, frontier, result})
        assert result.reasons == full.reasons
        assert result.quarantine == full.quarantine
        assert result.holders == full.holders
        assert result.requests == full.requests
        assert bytes(result.state) == bytes(raw_state)
        assert_projection(log, result.reasons, observed)
      end
    end
  end

  test "rehashed fabricated covered continuity verdicts cannot become trusted mirror evidence" do
    for producer <- ~w(beam ts) do
      item = Enum.find(read(producer)["cases"], &(&1["name"] == "all_head_resolution"))
      log = import!(item)
      frontier = List.last(legal_cuts(log))
      assert {:ok, snapshot, retained} = CompactionSpike.compact_application(Space, log, frontier)

      {id, _} =
        Enum.find(snapshot.covered_ops, fn {_, op} ->
          match?({:attest_member_key_v1, _}, op.body)
        end)

      reason = :application_continuity_invalid_parent

      forged = %{
        snapshot
        | covered_individual_reasons: Map.put(snapshot.covered_individual_reasons, id, reason),
          covered_final_reasons: Map.put(snapshot.covered_final_reasons, id, reason),
          covered_conflict_losers: Map.delete(snapshot.covered_conflict_losers, id),
          hash: nil
      }

      forged = %{
        forged
        | hash:
            :crypto.hash(
              :sha256,
              :erlang.term_to_binary(forged, [:deterministic, {:minor_version, 2}])
            )
      }

      assert {:error, :application_snapshot_mismatch} =
               CompactionSpike.reduce_application(Space, forged, retained)
    end
  end

  test "cuts retaining actual signed beacon authority remain explicit profile refusals" do
    for producer <- ~w(beam ts) do
      item = Enum.find(read(producer)["cases"], &(&1["name"] == "review_assembled"))
      log = import!(item)

      genesis =
        Enum.find_value(log.ops, fn {id, op} -> if match?({:genesis, _, _}, op.body), do: id end)

      assert {:ok, snapshot, retained} =
               CompactionSpike.compact_application(Space, log, [genesis])

      outside =
        retained.ops
        |> Enum.reject(fn {_, op} -> op.kind in [:command, :inbox] end)
        |> Enum.map(&elem(&1, 0))
        |> Enum.sort()

      assert outside != []

      assert {:error, {:application_authority_rebinding_outside_profile, ^outside}} =
               CompactionSpike.reduce_application(Space, snapshot, retained)
    end
  end

  # No compacted observer API exists. Exercise the exported head projection using
  # only mirror verdicts, and compare every honored claim/wrapper to the authenticated observer.
  defp assert_projection(log, reasons, observed) do
    records =
      for {id, op} <- log.ops,
          not Map.has_key?(reasons, id),
          {:ok, cert} <- [MemberContinuity.certificate(op)],
          do: {id, cert}

    actual =
      Enum.map(records, fn {id, cert} ->
        {Certificate.claim_id(cert.claim), id, Certificate.claim_bytes(cert.claim)}
      end)
      |> Enum.sort()

    expected =
      for record <- observed.records,
          wrapper <- record.wrappers,
          do: {record.claim_id, wrapper.op_id, Certificate.claim_bytes(record.claim)}

    assert actual == Enum.sort(expected)

    for link <- observed.links do
      assert MemberContinuity.heads(records, link.old_pub) == link.heads
    end
  end

  defp legal_cuts(log) do
    ordered = Dag.topo_sort(log.ops)
    ancestors = Dag.all_ancestors(log.ops)

    for count <- 1..(length(ordered) - 1),
        covered = Enum.take(ordered, count),
        retained = Enum.drop(ordered, count),
        Enum.all?(retained, &(&1.kind in [:command, :inbox])),
        Enum.any?(retained, &match?({:attest_member_key_v1, _}, &1.body)),
        covered_log = Log.from_ops(log.replica, Map.new(covered, &{&1.id, &1})),
        frontier = Log.frontier(covered_log),
        Enum.all?(retained, &MapSet.subset?(MapSet.new(frontier), Map.fetch!(ancestors, &1.id))),
        do: frontier
  end

  defp deliveries(log) do
    ordered = Dag.topo_sort(log.ops)
    appended = Enum.reduce(ordered, Log.new(log.replica), &Log.append!(&2, &1))

    reconciled =
      Enum.reduce(Enum.reverse(ordered), Log.new(log.replica), fn op, acc ->
        ids = Dag.reachable(log.ops, [op.id])
        source = Log.from_ops(log.replica, Map.take(log.ops, MapSet.to_list(ids)))
        {merged, _, _} = Sync.reconcile(acc, source)
        merged
      end)

    assert appended.ops == log.ops
    assert reconciled.ops == log.ops
    [appended, reconciled]
  end

  defp import!(item) do
    for module <- [Space, Authority, Lattice.Authority.Delegation, Log],
        do: Code.ensure_loaded!(module)

    assert {:ok, ops} = Wire.decode_ops(item["frames"])
    assert Enum.all?(ops, &Op.valid?/1)
    {log, %{pending: []}} = Sync.deliver(Log.new(item["replica"]), Enum.reverse(ops))
    assert :ok = Log.verify_authenticity(log)
    log
  end

  defp read(producer),
    do: Path.join(@vectors, "#{producer}_semantics.json") |> File.read!() |> Jason.decode!()

  defp bytes(term), do: :erlang.term_to_binary(term, [:deterministic])
end
