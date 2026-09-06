defmodule Treehouse.BoundedContinuationTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Canonical, CompactionSpike, Log, Op, Reduce, Sim}
  alias Lattice.Authority.{Continuation, ContinuationCertificate, Delegation}
  alias Lattice.Carrier.Wire
  alias Treehouse.ContinuationFixtures, as: F

  defp ready(opts \\ []) do
    {sim, genesis} = F.new(opts)
    {sim, pin, profile} = F.pin(sim, opts)
    {sim, epoch} = Sim.beacon(sim, "founder", 0)
    {Sim.sync_all(sim), genesis, pin, profile, epoch}
  end

  test "V01 empty-role enrollment pin preserves the founder acquisition; legacy proof refuses" do
    {sim, genesis, _pin, _profile, _epoch} = ready()
    assert Authority.holder_epoch(sim.module, Sim.log(sim, "nominee"), :admin).op_id == genesis.id

    assert length(
             Enum.filter(
               Log.topo_ops(Sim.log(sim, "nominee")),
               &match?({:genesis, _, _}, &1.body)
             )
           ) == 2

    {sim, op} = Sim.succeed(sim, "nominee", :admin, ops: [:manage], at_tick: 100)
    assert Sim.quarantined(sim, "nominee", op.id) == {true, :continuation_required}
  end

  test "V01 exact scoped fresh continuation is honored through public Sim" do
    for kind <- [:space, :thread] do
      {sim, _genesis, pin, profile, epoch} = ready(kind: kind)
      {sim, op} = F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])
      assert Sim.quarantined(sim, "nominee", op.id) == false

      assert Authority.holder_epoch(sim.module, Sim.log(sim, "nominee"), F.role(sim)).op_id ==
               op.id
    end
  end

  test "V03 wider ops, extra roles, live, parent and unleased delegation refuse" do
    {sim, _genesis, pin, profile, epoch} = ready()
    {sim, _d} = Sim.transfer(sim, "founder", "holder", :admin, ops: [:manage])
    sim = Sim.sync_all(sim)

    for opts <- [
          [ops: [:manage, :post]],
          [roles: [:admin, :moderator]],
          [live: true],
          [parent_id: "unknown"],
          [expires_epoch: nil]
        ] do
      {branch, op} =
        F.continue(
          sim,
          "holder",
          pin,
          profile,
          Keyword.merge([ops: [:manage], epoch_basis: [epoch.id]], opts)
        )

      assert Sim.quarantined(branch, "holder", op.id) == {true, :continuation_scope_exceeded}
    end
  end

  test "V04 lease window is inclusive and basis must be exact" do
    {sim, _genesis, pin, profile, epoch} = ready()

    for {opts, reason} <- [
          {[expires_epoch: 6], nil},
          {[expires_epoch: 7], :continuation_scope_exceeded},
          {[epoch_basis: []], :invalid_continuation_epoch},
          {[epoch: 1], :invalid_continuation_epoch}
        ] do
      {branch, op} =
        F.continue(sim, "nominee", pin, profile, Keyword.merge([epoch_basis: [epoch.id]], opts))

      assert Sim.quarantined(branch, "nominee", op.id) ==
               if(reason, do: {true, reason}, else: false)
    end
  end

  test "V05 freshly signed altered claim and bad surplus witness cannot authorize" do
    {sim, _genesis, pin, profile, epoch} = ready()

    for opts <- [
          [claim_patch: %{profile_genesis: F.digest("other-pin")}],
          [claim_patch: %{deps: []}],
          [witnesses: ["w1"]],
          [witnesses: ["w1", "w2", "observer"]],
          [
            certificate_transform: fn cert ->
              %{cert | signatures: cert.signatures ++ [hd(cert.signatures)]}
            end
          ]
        ] do
      {branch, op} =
        F.continue(sim, "nominee", pin, profile, Keyword.merge([epoch_basis: [epoch.id]], opts))

      assert Sim.quarantined(branch, "nominee", op.id) ==
               {true, :invalid_continuation_certificate}
    end
  end

  test "V06 independent holder and nominee attempts consume exactly one predecessor" do
    {sim, _genesis, pin, profile, epoch} = ready()
    {sim, _d} = Sim.transfer(sim, "founder", "holder", :admin, ops: [:manage, :post])
    sim = Sim.sync_all(sim)
    {left, a} = F.continue(sim, "holder", pin, profile, epoch_basis: [epoch.id])
    {right, b} = F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])

    sim =
      %{
        sim
        | logs:
            sim.logs
            |> Map.put("holder", Sim.log(left, "holder"))
            |> Map.put("nominee", Sim.log(right, "nominee"))
      }
      |> Sim.sync_all()

    [winner, loser] =
      Enum.filter(Log.topo_ops(Sim.log(sim, "observer")), &(&1.id in [a.id, b.id]))

    for realm <- Map.keys(sim.logs) do
      assert Sim.quarantined(sim, realm, winner.id) == false
      assert Sim.quarantined(sim, realm, loser.id) == {true, :stale_continuation}
    end
  end

  test "V02 absent, concurrent and invalid replacement pins never retroactively authorize" do
    {sim, genesis} = F.new()

    assert_raise ArgumentError, ~r/already contains reserved #root/, fn ->
      Authority.bind_replica(sim.replica, Sim.identity(sim, "founder").pub)
    end

    {sim, epoch} = Sim.beacon(sim, "founder", 0)
    sim = Sim.sync_all(sim)
    # A syntactically valid pin id is not evidence of a retained causal pin.
    {before, attempt} =
      F.continue(sim, "nominee", genesis, F.profile(sim), epoch_basis: [epoch.id])

    assert Sim.quarantined(before, "nominee", attempt.id) == {true, :continuation_not_configured}
    {pinned, pin, profile} = F.pin(sim)

    merged =
      %{pinned | logs: Map.put(pinned.logs, "nominee", Sim.log(before, "nominee"))}
      |> Sim.sync_all()

    assert Sim.quarantined(merged, "nominee", attempt.id) == {true, :continuation_not_configured}
    {merged, invalid, _} = F.pin(merged, profile: Map.put(profile, :unrecognized, true))
    {merged, valid} = F.continue(merged, "nominee", pin, profile, epoch_basis: [epoch.id])
    assert Sim.quarantined(merged, "nominee", valid.id) == false
    assert Log.has?(Sim.log(merged, "nominee"), invalid.id)

    {branch, replacement, new_profile} = F.pin(pinned, nominee: "observer", max_lease_epochs: 3)

    {branch, accepted} =
      F.continue(branch, "observer", replacement, new_profile,
        expires_epoch: 2,
        epoch_basis: [epoch.id]
      )

    assert Sim.quarantined(branch, "observer", accepted.id) == false
    {branch, rejected} = F.continue(branch, "nominee", pin, profile, epoch_basis: [epoch.id])
    assert Sim.quarantined(branch, "nominee", rejected.id) == {true, :unauthorized_continuation}
  end

  test "V03 review derives actual bytes and rejects changed frontier, missing evidence and wrong author" do
    {sim, _genesis, pin, profile, epoch} = ready()
    {branch, expected_op} = F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])
    {:succeed, :admin, d, {:continuation_v1, cert}} = expected_op.body
    log = Sim.log(sim, "nominee")
    author = Sim.identity(sim, "nominee").pub

    assert {:ok, %{claim: claim, profile: ^profile}} =
             Authority.continuation_review(sim.module, log, :admin, author, Log.frontier(log), d)

    assert claim == cert.claim

    assert {:error, :stale_verified_state} =
             Authority.continuation_review(
               sim.module,
               Sim.log(branch, "nominee"),
               :admin,
               author,
               Log.frontier(log),
               d
             )

    missing = Log.from_ops(sim.replica, Map.delete(Log.ops(log), pin.id))

    assert {:error, :invalid_verified_history} =
             Authority.continuation_review(
               sim.module,
               missing,
               :admin,
               author,
               Log.frontier(missing),
               d
             )

    corrupt = %{log | referenced: MapSet.new()}

    assert {:error, :invalid_verified_history} =
             Authority.continuation_review(
               sim.module,
               corrupt,
               :admin,
               author,
               Log.frontier(corrupt),
               d
             )

    assert {:error, :unauthorized_continuation} =
             Authority.continuation_review(
               sim.module,
               log,
               :admin,
               Sim.identity(sim, "observer").pub,
               Log.frontier(log),
               d
             )

    assert {next, authored} =
             Sim.continue_role(sim, "nominee", :admin,
               ops: [:manage, :post],
               expires_epoch: 6,
               witnesses: ["w1", "w2"]
             )

    assert authored.id == expected_op.id
    assert Sim.quarantined(next, "nominee", authored.id) == false
  end

  test "V04 expired and revoked predecessor is a historical ceiling, ordinary child still attenuates" do
    {sim, _genesis, pin, profile, _epoch} = ready()

    {sim, d} =
      Sim.transfer(sim, "founder", "holder", :admin, ops: [:manage, :post], expires_epoch: 0)

    {sim, _} = Sim.revoke(sim, "founder", d.id)
    {sim, epoch} = Sim.beacon(sim, "founder", 1)
    sim = Sim.sync_all(sim)

    {sim, continuation} =
      F.continue(sim, "holder", pin, profile, epoch: 1, epoch_basis: [epoch.id], expires_epoch: 7)

    assert Sim.quarantined(sim, "holder", continuation.id) == false

    {sim, child} =
      Sim.grant(sim, "holder", "member1", parent: d.id, ops: [:post], expires_epoch: 7)

    sim = Sim.sync_all(sim)

    {sim, command} =
      Sim.command(sim, "member1", :post, ["cannot extend old chain"], cap: child.id)

    assert Sim.quarantined(sim, "member1", command.id) != false
  end

  test "V04 equal maximal causal beacons and clipped portable horizon bind exact basis" do
    {sim, _genesis, pin, profile, _epoch} = ready()
    {left, a} = Sim.beacon(sim, "w1", 1, witnesses: ["w1", "w2"])
    {right, b} = Sim.beacon(sim, "w2", 1, witnesses: ["w1", "w2"])

    joined =
      %{
        sim
        | logs:
            sim.logs |> Map.put("w1", Sim.log(left, "w1")) |> Map.put("w2", Sim.log(right, "w2"))
      }
      |> Sim.sync_all()

    {joined, accepted} =
      F.continue(joined, "nominee", pin, profile,
        epoch: 1,
        epoch_basis: [a.id, b.id],
        expires_epoch: 7
      )

    assert Sim.quarantined(joined, "nominee", accepted.id) == false
    {sim, ceiling} = Sim.beacon(sim, "founder", 9_007_199_254_740_990)
    sim = Sim.sync_all(sim)

    {sim, accepted} =
      F.continue(sim, "nominee", pin, profile,
        epoch: 9_007_199_254_740_990,
        epoch_basis: [ceiling.id],
        expires_epoch: 9_007_199_254_740_991
      )

    assert Sim.quarantined(sim, "nominee", accepted.id) == false

    {sim, rejected} =
      F.continue(sim, "nominee", pin, profile,
        epoch: 9_007_199_254_740_990,
        epoch_basis: [ceiling.id],
        expires_epoch: 9_007_199_254_740_992
      )

    assert Sim.quarantined(sim, "nominee", rejected.id) == {true, :malformed_term}
  end

  test "V05 every independently signed claim binding and malformed signature container refuses" do
    {sim, genesis, pin, profile, epoch} = ready()

    for patch <- [
          %{replica: sim.replica <> "other"},
          %{profile_id: F.digest("other-profile")},
          %{holder: Sim.identity(sim, "observer").pub},
          %{holder_epoch: F.digest("other-acquire")},
          %{successor: Sim.identity(sim, "holder").pub},
          %{delegation_id: genesis.id},
          %{author: Sim.identity(sim, "holder").pub},
          %{profile_genesis: epoch.id}
        ] do
      {branch, op} =
        F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id], claim_patch: patch)

      assert Sim.quarantined(branch, "nominee", op.id) ==
               {true, :invalid_continuation_certificate}
    end

    for transform <- [
          fn c -> Map.put(c, :extra, 1) end,
          fn c ->
            %{c | signatures: [%{witness: Sim.identity(sim, "w1").pub, signature: <<1>>}]}
          end,
          fn c -> %{c | claim: Map.put(c.claim, :extra, true)} end
        ] do
      {branch, op} =
        F.continue(sim, "nominee", pin, profile,
          epoch_basis: [epoch.id],
          certificate_transform: transform
        )

      assert Sim.quarantined(branch, "nominee", op.id) == {true, :malformed_term}
    end
  end

  test "V06 same holder fork and transfer race consume one acquisition; fresh retry succeeds" do
    {sim, _genesis, pin, profile, epoch} = ready()
    {sim, _} = Sim.transfer(sim, "founder", "holder", :admin, ops: [:manage, :post])
    sim = Sim.sync_all(sim)
    sim = %{sim | realms: Map.put(sim.realms, "copy", Sim.identity(sim, "holder"))}
    left_realms = ["holder", "w1"]
    right_realms = Map.keys(sim.logs) -- left_realms

    split =
      Enum.reduce(for(a <- left_realms, b <- right_realms, do: {a, b}), sim, fn {a, b}, s ->
        Sim.partition(s, a, b)
      end)

    {split, a} =
      F.continue(split, "holder", pin, profile, epoch_basis: [epoch.id], ops: [:manage])

    {split, b} =
      F.continue(split, "copy", pin, profile, epoch_basis: [epoch.id], ops: [:manage, :post])

    assert a.deps == b.deps

    healed =
      Enum.reduce(for(a <- left_realms, b <- right_realms, do: {a, b}), split, fn {a, b}, s ->
        Sim.heal(s, a, b)
      end)
      |> Sim.sync_all()

    [winner, loser] =
      Enum.filter(Log.topo_ops(Sim.log(healed, "observer")), &(&1.id in [a.id, b.id]))

    assert Sim.quarantined(healed, "observer", winner.id) == false
    assert Sim.quarantined(healed, "observer", loser.id) == {true, :stale_continuation}

    assert {retry, op} =
             Sim.continue_role(healed, "holder", :admin,
               ops: [:manage],
               expires_epoch: 5,
               witnesses: ["w1", "w3"]
             )

    assert Sim.quarantined(retry, "holder", op.id) == false
    {:succeed, _, _, {:continuation_v1, certificate}} = op.body
    assert certificate.claim.holder_epoch == winner.id

    {renewed, renewal} = F.continue(sim, "holder", pin, profile, epoch_basis: [epoch.id])
    {transferred, _} = Sim.transfer(sim, "holder", "nominee", :admin, ops: [:manage])
    transfer = List.last(Log.topo_ops(Sim.log(transferred, "holder")))
    merged = Log.ops(Sim.log(renewed, "holder")) |> Map.put(transfer.id, transfer)
    log = Log.from_ops(sim.replica, merged)
    analysis = Authority.analyze(sim.module, log)
    [first, second] = Enum.filter(Log.topo_ops(log), &(&1.id in [renewal.id, transfer.id]))
    refute Map.has_key?(analysis.reasons, first.id)

    assert analysis.reasons[second.id] ==
             if(second.id == transfer.id, do: :double_transfer, else: :stale_continuation)
  end

  test "V09 threshold loss stalls, hostile quorum cannot add operations" do
    {sim, _genesis, pin, profile, epoch} = ready()
    {sim, _} = Sim.transfer(sim, "founder", "holder", :admin, ops: [:manage])
    sim = Sim.sync_all(sim)

    for {realm, opts, reason} <- [
          {"holder", [witnesses: ["w1", "w3"]], nil},
          {"holder", [witnesses: ["w1"]], :invalid_continuation_certificate},
          {"observer", [witnesses: ["w1", "w2", "w3"]], :unauthorized_continuation},
          {"nominee", [ops: [:manage, :post], witnesses: ["w1", "w2", "w3"]],
           :continuation_scope_exceeded}
        ] do
      {branch, op} =
        F.continue(
          sim,
          realm,
          pin,
          profile,
          Keyword.merge([ops: [:manage], epoch_basis: [epoch.id]], opts)
        )

      assert Sim.quarantined(branch, realm, op.id) == if(reason, do: {true, reason}, else: false)
    end
  end

  test "V11 malformed reserved family refuses all semantic effects and legacy literals stay legacy" do
    {sim, genesis} = F.new()

    for name <- [
          String.replace(sim.replica, "continuation-v1", "continuation-v2"),
          String.replace(sim.replica, "#authority:", "#authority:bad#authority:"),
          String.replace(sim.replica, "space:", "space:bad:"),
          String.replace(sim.replica, "space:", "space:bad\n"),
          sim.replica <> "#root:extra"
        ] do
      root = Sim.identity(sim, "founder")
      {:genesis, original, policies} = genesis.body

      d =
        Delegation.genesis(root, name,
          ops: MapSet.to_list(original.ops),
          roles: [:admin],
          live: true
        )

      op = Op.new(root, name, [], :authority, {:genesis, d, policies})
      log = Log.append!(Log.new(name), op)
      {:ok, body} = sim.module.command_body(:post, ["refused"])
      command = Op.new(root, name, [op.id], :command, body, cap: d.id)
      log = Log.append!(log, command)
      analysis = Authority.analyze(sim.module, log)
      assert analysis.holders.admin == nil
      assert analysis.reasons[op.id] == :unsupported_authority_profile
      assert analysis.reasons[command.id] == :unsupported_authority_profile
      refute Authority.delegation_active?(log, d.id)
      assert {:error, :unsupported_authority_profile} = Authority.verify_chain([d], name)
    end

    assert Continuation.family("replica:custom:#authority:bounded-continuation-v1") == :legacy
    assert Continuation.family("replica:treehouse:space:old-name#root:tag") == :legacy
  end

  test "V10 compaction and fresh dump preserve pin, exact epoch basis, acquisitions and refusals" do
    {sim, _genesis, pin, profile, epoch} = ready()
    frontier = Log.frontier(Sim.log(sim, "nominee"))

    {sim, first} =
      Sim.continue_role(sim, "nominee", :admin,
        ops: [:manage, :post],
        expires_epoch: 6,
        witnesses: ["w1", "w2"]
      )

    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "nominee", :manage, ["first"])
    sim = Sim.sync_all(sim)
    second_frontier = Log.frontier(Sim.log(sim, "nominee"))

    {sim, _second} =
      Sim.continue_role(sim, "nominee", :admin,
        ops: [:manage],
        expires_epoch: 5,
        witnesses: ["w1", "w3"]
      )

    sim = Sim.sync_all(sim)

    {sim, denied} =
      F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id], ops: [:manage, :post])

    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "nominee")
    analysis = Authority.analyze(sim.module, log)
    assert analysis.reasons[denied.id] == :continuation_scope_exceeded

    for at <- [frontier, second_frontier, Log.frontier(log)] do
      assert {:ok, snapshot, retained} = CompactionSpike.compact(sim.module, log, at)
      result = CompactionSpike.reduce_compacted(sim.module, snapshot, retained)
      assert result.reasons == analysis.reasons
      assert result.holders == analysis.holders
      assert result.state == Reduce.reduce(sim.module, log, quarantine: analysis.quarantine)
      assert snapshot.covered_continuation_pin.op_id == pin.id
      assert Enum.map(snapshot.covered_beacon_basis, & &1.op_id) == [epoch.id]
    end

    restored =
      Enum.reduce(Log.topo_ops(log), Log.new(log.replica), fn op, log -> Log.append!(log, op) end)

    assert Authority.analyze(sim.module, restored) == analysis

    path =
      Path.join(
        System.tmp_dir!(),
        "continuation-restore-#{System.unique_integer([:positive])}.log"
      )

    on_exit(fn -> File.rm(path) end)
    assert :ok = Log.dump(log, path)
    assert {:ok, dumped} = Log.restore(path)
    assert Authority.analyze(sim.module, dumped) == analysis
    # A fresh VM loads the app's vocabulary only; Log must preload all R04 atoms.
    script = """
    _host_vocabulary = [:manage, :post, :admit, :remove_member]
    {:ok, restored} = Lattice.Log.restore(#{inspect(path)})
    true = Map.has_key?(restored.ops, #{inspect(first.id)})
    IO.puts("CONTINUATION_RESTORE_OK")
    """

    direct = Path.expand("~/.asdf/installs/elixir/1.19.5-otp-28/bin/elixir")
    executable = if File.exists?(direct), do: direct, else: "elixir"

    {output, status} =
      System.cmd(executable, ["-pa", Application.app_dir(:lattice_core, "ebin"), "-e", script],
        stderr_to_stdout: true
      )

    assert status == 0, output
    assert output =~ "CONTINUATION_RESTORE_OK"
  end

  test "V05 exact continuation outer/proof arities and declared role are required" do
    {sim, _, pin, profile, epoch} = ready()
    {_, candidate} = F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])
    {:succeed, role, d, {:continuation_v1, cert}} = candidate.body

    for {body, reason} <- [
          {{:succeed, role, d, {:continuation_v1}}, :malformed_term},
          {{:succeed, role, d, {:continuation_v1, cert, :extra}}, :malformed_term},
          {Tuple.insert_at(candidate.body, tuple_size(candidate.body), :extra), :malformed_term},
          {{:succeed, role, %{}, {:continuation_v1, cert}}, :malformed_term},
          {{:succeed, :undeclared, d, {:continuation_v1, cert}}, :unauthorized_continuation}
        ] do
      {branch, op} = Sim.append(sim, "nominee", :authority, body)
      assert Sim.quarantined(branch, "nominee", op.id) == {true, reason}
    end
  end

  test "V11 malformed new-proof arities on legacy replicas refuse the continuation family" do
    {sim, _} = F.new(name: "replica:legacy:malformed-continuation-proof")
    {sim, pin, profile} = F.pin(sim)
    {sim, epoch} = Sim.beacon(sim, "founder", 0)

    {_, candidate} =
      F.continue(Sim.sync_all(sim), "nominee", pin, profile, epoch_basis: [epoch.id])

    {:succeed, role, d, {:continuation_v1, cert}} = candidate.body

    for proof <- [{:continuation_v1}, {:continuation_v1, cert, :extra}] do
      {branch, op} = Sim.append(sim, "nominee", :authority, {:succeed, role, d, proof})
      assert Sim.quarantined(branch, "nominee", op.id) == {true, :unauthorized_continuation}
    end
  end

  test "V05 TypeScript-authored three-witness certificate verifies byte-for-byte in BEAM" do
    fixture =
      Path.expand(
        "../../../../clients/lattice-client/test/vectors/continuation/ts_certificate.json",
        __DIR__
      )
      |> File.read!()
      |> Jason.decode!()

    {sim, genesis} = F.new()
    # Wire decoding alone extracts canonical terms; these wrappers are never
    # offered as signed operations or authority evidence.
    wrapper = Wire.encode_op(genesis)
    assert {:ok, profile_op} = Wire.decode_op(Map.put(wrapper, "body", fixture["profileTerm"]))

    assert {:ok, certificate_op} =
             Wire.decode_op(Map.put(wrapper, "body", fixture["certificateTerm"]))

    profile = profile_op.body
    certificate = certificate_op.body
    assert {:ok, id} = ContinuationCertificate.profile_id(profile)
    assert id == fixture["profileId"]

    assert Base.encode64(Canonical.term(["lattice-continuation-profile-v1", profile])) ==
             fixture["profileBytes"]

    assert Base.encode64(ContinuationCertificate.signing_payload(certificate.claim)) ==
             fixture["claimBytes"]

    assert :ok = ContinuationCertificate.verify(certificate, certificate.claim, profile)
    assert length(certificate.signatures) == 3

    for replica <- ["", <<255>>] do
      refute ContinuationCertificate.valid_claim?(%{certificate.claim | replica: replica})
    end

    assert ContinuationCertificate.valid_claim?(%{
             certificate.claim
             | replica: "\uFEFFvalid-\u03BB"
           })

    # Exact consent remains separate from the independently authenticated history.
    refute Authority.holder_epoch(sim.module, Sim.log(sim, "nominee"), :admin).holder ==
             certificate.claim.successor
  end

  test "V01 twelve configured replicas cannot supply a complete thirteen-replica continuation inventory" do
    outcomes =
      Map.new(0..12, fn index ->
        {sim, _} =
          F.new(kind: if(index == 0, do: :space, else: :thread), label: "partial-#{index}")

        sim = if index < 12, do: elem(F.pin(sim), 0), else: sim
        {sim, _} = Sim.beacon(sim, "founder", 0)
        sim = Sim.sync_all(sim)

        result =
          Sim.continue_role(sim, "nominee", F.role(sim),
            ops: [:post],
            expires_epoch: 6,
            witnesses: ["w1", "w2"]
          )

        {index,
         case result do
           {:error, reason} -> reason
           {_sim, %Op{}} -> :reviewed
         end}
      end)

    assert Enum.count(outcomes, fn {_, result} -> result == :reviewed end) == 12
    assert outcomes[12] == :continuation_not_configured
    refute Enum.all?(outcomes, fn {_, result} -> result == :reviewed end)
  end

  test "V06 invalid canonical first candidate does not consume P and a losing candidate cannot activate a child" do
    {sim, _, pin, profile, epoch} = ready()
    {_, good} = F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])

    bad =
      Enum.find_value(1..128, fn n ->
        {_, op} =
          F.continue(sim, "nominee", pin, profile,
            epoch_basis: [epoch.id],
            claim_patch: %{profile_id: F.digest("invalid-#{n}")}
          )

        if op.id < good.id, do: op
      end)

    assert %Op{} = bad
    log = Sim.log(sim, "nominee") |> Log.append!(bad) |> Log.append!(good)
    analysis = Authority.analyze(sim.module, log)
    assert analysis.reasons[bad.id] == :invalid_continuation_certificate
    refute Map.has_key?(analysis.reasons, good.id)

    {_, competing} =
      F.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id], expires_epoch: 5)

    log = Log.append!(log, competing)
    analysis = Authority.analyze(sim.module, log)
    loser = Enum.find([good, competing], &(analysis.reasons[&1.id] == :stale_continuation))
    assert %Op{} = loser
    {:succeed, _, losing_parent, _} = loser.body
    # This child sees only the losing branch, so later healing must remove its
    # apparent capability once the canonical competing acquisition is known.
    nominee = Sim.identity(sim, "nominee")

    child =
      Delegation.new(nominee, sim.replica, Sim.identity(sim, "member1").pub,
        ops: [:post],
        parent_id: losing_parent.id,
        expires_epoch: 5
      )

    child_op = Op.new(nominee, sim.replica, [loser.id], :authority, {:grant, child})
    log = Log.append!(log, child_op)
    {:ok, body} = sim.module.command_body(:post, ["losing parent cannot activate"])

    command =
      Op.new(Sim.identity(sim, "member1"), sim.replica, [child_op.id], :command, body,
        cap: child.id
      )

    log = Log.append!(log, command)
    assert Authority.analyze(sim.module, log).reasons[command.id] == :invalid_capability
  end
end
