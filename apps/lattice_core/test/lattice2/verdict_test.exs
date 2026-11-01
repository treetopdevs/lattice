defmodule Lattice2.VerdictTest do
  @moduledoc """
  Plan 287: `Lattice.Verdict` explains the judge's verdict on one op and never
  disagrees with `Lattice.Authority.analyze/2`.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  @moduletag timeout: 300_000

  alias Lattice.{Authority, FaultScenario, Log, Op, Sim, Verdict}
  alias Lattice.Authority.Delegation

  defp thread_logs(logs), do: for({"thread." <> _ = name, log} <- logs, do: {name, log})

  defp posts(log, author) do
    for %Op{kind: :command, author: ^author, body: {:post, [text]}} = op <- Log.topo_ops(log),
        do: {text, op}
  end

  defp keys(realms, seed) do
    sim = Sim.new(Treehouse.Thread, "keys", realms, seed: seed)
    Map.new(realms, &{&1, Sim.identity(sim, &1).pub})
  end

  describe "revoke_offline" do
    setup do
      {:ok, logs} = FaultScenario.run("revoke_offline", "verdict")
      %{logs: thread_logs(logs), writer: keys(~w(root writer peer), "verdict")["writer"]}
    end

    test "offline posts cite the revoke; the pre-revoke post is honored and undecorated",
         %{logs: logs, writer: writer} do
      for {name, log} <- logs do
        [revoke] = for %Op{body: {:revoke, _}} = op <- Log.topo_ops(log), do: op
        posts = Map.new(posts(log, writer))

        assert {:honored, pre} = Verdict.explain(Treehouse.Thread, log, posts["before revoke"].id)
        assert pre.reason == nil
        assert pre.evidence == %{revoked_by: nil, lapsed_by_beacon: nil}, name

        for text <- ["offline 1", "offline 2"] do
          assert {:quarantined, rec} = Verdict.explain(Treehouse.Thread, log, posts[text].id)
          assert rec.reason == :revoked_capability
          assert rec.evidence.revoked_by == revoke.id
          assert rec.evidence.lapsed_by_beacon == nil
          assert rec.cited_delegation_id == posts["before revoke"].cap
          assert rec.author == Base.encode16(writer, case: :lower)
          assert rec.frontier == Enum.sort(Log.frontier(log))
        end

        status = Verdict.delegation_status(Treehouse.Thread, log, posts["before revoke"].cap)
        assert %{status: :revoked, revoked_by: revoke_id} = status
        assert revoke_id == revoke.id
      end
    end
  end

  describe "handoff_lapse" do
    setup do
      {:ok, logs} = FaultScenario.run("handoff_lapse", "verdict")
      %{logs: thread_logs(logs), keys: keys(~w(root agent peer), "verdict")}
    end

    test "post-lapse post names the lapsing beacon; the peer's misuse cites the agent's cap",
         %{logs: logs, keys: keys} do
      %{pre: pre_text, post: post_text, misuse: misuse_text} = FaultScenario.handoff_texts()

      for {_name, log} <- logs do
        agent = Map.new(posts(log, keys["agent"]))
        [{^misuse_text, misuse}] = posts(log, keys["peer"])
        cap = agent[pre_text].cap

        assert {:honored, pre} = Verdict.explain(Treehouse.Thread, log, agent[pre_text].id)
        assert pre.evidence == %{revoked_by: nil, lapsed_by_beacon: nil}
        assert pre.expires_epoch == 3

        assert {:quarantined, post} = Verdict.explain(Treehouse.Thread, log, agent[post_text].id)
        assert post.reason == :lease_expired
        assert post.evidence == %{revoked_by: nil, lapsed_by_beacon: 4}
        assert post.cited_delegation_id == cap

        assert {:quarantined, peer} = Verdict.explain(Treehouse.Thread, log, misuse.id)
        assert peer.reason == :capability_wrong_audience
        assert peer.cited_delegation_id == cap
        assert peer.evidence == %{revoked_by: nil, lapsed_by_beacon: nil}

        status = Verdict.delegation_status(Treehouse.Thread, log, cap)

        assert %{status: :lapsed, expires_epoch: 3, latest_beacon_epoch: 4, revoked_by: nil} =
                 status

        assert status.audience == Base.encode16(keys["agent"], case: :lower)
        assert status.ops == [:post]

        assert %{"audience" => _, "ops" => ["post"], "status" => "lapsed"} =
                 Jason.decode!(Verdict.to_json(status))
      end
    end

    test "without the beacon the agent's delegation is active", %{keys: keys} do
      {:ok, logs} = FaultScenario.run("handoff_lapse", "verdict", variant: :no_beacon)

      for {_name, log} <- thread_logs(logs) do
        [{_, %Op{cap: cap}} | _] = posts(log, keys["agent"])

        assert %{status: :active, latest_beacon_epoch: nil} =
                 Verdict.delegation_status(Treehouse.Thread, log, cap)
      end
    end

    test "an unseen delegation is unknown and an unseen op is reported", %{logs: logs} do
      [{_name, log} | _] = logs

      assert %{status: :unknown, expires_epoch: nil, revoked_by: nil} =
               Verdict.delegation_status(Treehouse.Thread, log, "never-granted")

      assert {:unknown_op, "nope"} = Verdict.explain(Treehouse.Thread, log, "nope")
    end

    test "JSON is byte-identical across calls and across the three synced realms",
         %{logs: logs} do
      [{_, first} | _] = logs

      for id <- Log.op_ids(first) do
        jsons =
          for {_name, log} <- logs do
            {_verdict, rec} = Verdict.explain(Treehouse.Thread, log, id)
            json = Verdict.to_json(rec)
            assert json == Verdict.to_json(elem(Verdict.explain(Treehouse.Thread, log, id), 1))
            json
          end

        assert length(Enum.uniq(jsons)) == 1
      end

      decoded =
        Jason.decode!(
          Verdict.to_json(
            elem(Verdict.explain(Treehouse.Thread, first, hd(Enum.sort(Log.op_ids(first)))), 1)
          )
        )

      assert decoded["schema"] == "lattice-verdict-v1"

      assert Jason.decode!(
               Verdict.to_json(
                 elem(Verdict.explain(Treehouse.Thread, first, hd(Log.frontier(first))), 1)
               )
             )
             |> Map.keys()
             |> Enum.sort() ==
               ~w(author cited_delegation_id evidence expires_epoch frontier kind op_id reason replica schema verdict)
    end
  end

  describe "authority ops and successions" do
    defp demo_sim(seed, opts \\ []) do
      {sim, _} =
        Lattice.Demo.Thread
        |> Sim.new("replica:verdict:authority", ["r0", "r1", "r2"], seed: seed)
        |> Sim.create_replica("r0", opts)

      Sim.sync_all(sim)
    end

    defp carried(%Op{body: {:succeed, _role, deleg, _tick}}), do: deleg

    test "a transfer that re-carries a revoked delegation names that revoke" do
      sim = demo_sim("verdict:retransfer")
      {sim, d} = Sim.transfer(sim, "r0", "r1", :moderator, at_tick: 1)
      {sim, revoke} = Sim.revoke(Sim.sync_all(sim), "r0", d.id)
      {sim, again} = Sim.transfer(sim, "r0", "r1", :moderator, at_tick: 2)
      log = sim |> Sim.sync_all() |> Sim.log("r0")

      assert again.id == d.id, "the delegation is content-addressed"

      [op] =
        for %Op{body: {:transfer, :moderator, _, 2}} = op <- Log.topo_ops(log), do: op

      assert {:quarantined, rec} = Verdict.explain(Lattice.Demo.Thread, log, op.id)
      assert rec.reason == :revoked_capability
      assert rec.cited_delegation_id == d.id
      assert rec.evidence.revoked_by == revoke.id
    end

    test "an activated succession delegation and its descendant are active" do
      sim =
        demo_sim("verdict:succession",
          policies: %{moderator: %{successor: "r1", dormant_ticks: 2}}
        )

      {sim, succeed} = Sim.succeed(sim, "r1", :moderator, at_tick: 3)
      sim = Sim.sync_all(sim)
      {sim, child} = Sim.grant(sim, "r1", "r2", ops: [:lock], roles: [:moderator])
      {sim, lock} = Sim.command(sim, "r1", :lock, [])
      log = sim |> Sim.sync_all() |> Sim.log("r0")
      reasons = Authority.analyze(Lattice.Demo.Thread, log).reasons

      refute Map.has_key?(reasons, succeed.id)
      refute Map.has_key?(reasons, lock.id)
      assert lock.cap == carried(succeed).id

      assert %{status: :active} =
               Verdict.delegation_status(Lattice.Demo.Thread, log, carried(succeed).id)

      assert %{status: :active} = Verdict.delegation_status(Lattice.Demo.Thread, log, child.id)
    end

    test "a succession naming an undeclared role is unquarantined but never active" do
      sim = demo_sim("verdict:ghost-role")
      # No timeline exists for :ghost, so the judge neither honors nor quarantines it.
      {sim, succeed} = Sim.succeed(sim, "r1", :ghost, ops: [:post], at_tick: 3)
      {sim, child} = Sim.grant(Sim.sync_all(sim), "r1", "r2", ops: [:post], roles: [:ghost])

      {sim, post} =
        Sim.command(Sim.sync_all(sim), "r1", :post, ["ghost"], cap: carried(succeed).id)

      log = sim |> Sim.sync_all() |> Sim.log("r0")
      reasons = Authority.analyze(Lattice.Demo.Thread, log).reasons

      refute Map.has_key?(reasons, succeed.id)
      assert reasons[post.id] == :invalid_capability

      assert %{status: :invalid} =
               Verdict.delegation_status(Lattice.Demo.Thread, log, carried(succeed).id)

      assert %{status: :invalid} = Verdict.delegation_status(Lattice.Demo.Thread, log, child.id)
    end

    test "a succession activated by a concurrent policy genesis is active" do
      sim =
        demo_sim("verdict:concurrent-policy",
          policies: %{moderator: %{successor: "r1", dormant_ticks: 10}}
        )

      sim = Sim.partition(sim, "r0", "r1")
      root = Sim.identity(sim, "r0")

      # A root-signed, role-free genesis lowers the threshold, concurrent with the claim.
      relax =
        Delegation.genesis(root, sim.replica, ops: [], roles: [], live: true)

      policies = %{
        moderator: %{successor: Sim.identity(sim, "r1").pub, dormant_ticks: 2}
      }

      {sim, _} = Sim.append(sim, "r0", :authority, {:genesis, relax, policies})
      {sim, succeed} = Sim.succeed(sim, "r1", :moderator, at_tick: 3)
      log = sim |> Sim.heal("r0", "r1") |> Sim.sync_all() |> Sim.log("r0")

      refute Map.has_key?(Authority.analyze(Lattice.Demo.Thread, log).reasons, succeed.id)

      assert %{op_id: id} = Authority.holder_epoch(Lattice.Demo.Thread, log, :moderator)
      assert id == succeed.id

      assert %{status: :active} =
               Verdict.delegation_status(Lattice.Demo.Thread, log, carried(succeed).id)
    end

    test "a concurrent-policy successor and its post descendant stay active after the role is handed on" do
      sim =
        demo_sim("verdict:concurrent-policy-handoff",
          policies: %{moderator: %{successor: "r1", dormant_ticks: 10}}
        )

      sim = Sim.partition(sim, "r0", "r1")
      root = Sim.identity(sim, "r0")

      relax = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: true)

      policies = %{
        moderator: %{successor: Sim.identity(sim, "r1").pub, dormant_ticks: 2}
      }

      {sim, _} = Sim.append(sim, "r0", :authority, {:genesis, relax, policies})

      {sim, succeed} =
        Sim.succeed(sim, "r1", :moderator, ops: [:lock, :post, :unlock], at_tick: 3)

      sim = sim |> Sim.heal("r0", "r1") |> Sim.sync_all()
      {sim, child} = Sim.grant(sim, "r1", "r2", ops: [:post])
      {sim, _transfer} = Sim.transfer(sim, "r1", "r0", :moderator, at_tick: 4)

      {sim, successor_post} =
        Sim.command(sim, "r1", :post, ["successor after handoff"], cap: carried(succeed).id)

      {sim, child_post} =
        Sim.command(Sim.sync_all(sim), "r2", :post, ["child after handoff"], cap: child.id)

      log = sim |> Sim.sync_all() |> Sim.log("r0")
      analysis = Authority.analyze(Lattice.Demo.Thread, log)
      {same, beacons, records} = Authority.analyze_with_records(Lattice.Demo.Thread, log)

      assert same == analysis
      assert {same, beacons} == Authority.analyze_with_beacon_evidence(Lattice.Demo.Thread, log)

      refute Map.has_key?(analysis.reasons, succeed.id)
      refute Map.has_key?(analysis.reasons, successor_post.id)
      refute Map.has_key?(analysis.reasons, child_post.id)

      epoch = analysis.holder_epochs[:moderator]
      refute epoch.op_id == succeed.id
      assert epoch.holder == Sim.identity(sim, "r0").pub

      assert Enum.any?(
               records.moderator,
               &(&1.op_id == succeed.id and &1.delegation_id == carried(succeed).id)
             )

      assert Enum.any?(
               Authority.acquisitions(Lattice.Demo.Thread, log, :moderator),
               &(&1.op_id == succeed.id)
             )

      assert %{status: :active} =
               Verdict.delegation_status(Lattice.Demo.Thread, log, carried(succeed).id)

      assert %{status: :active} = Verdict.delegation_status(Lattice.Demo.Thread, log, child.id)
    end

    test "an authority op cites its carried delegation, not an unrelated cap" do
      sim = demo_sim("verdict:carried-over-cap")
      {sim, d} = Sim.transfer(sim, "r0", "r1", :moderator, at_tick: 1)
      {sim, revoke} = Sim.revoke(Sim.sync_all(sim), "r0", d.id)

      {sim, op} =
        Sim.append(sim, "r0", :authority, {:transfer, :moderator, d, 2}, cap: "unrelated-cap")

      log = sim |> Sim.sync_all() |> Sim.log("r0")

      assert {:quarantined, rec} = Verdict.explain(Lattice.Demo.Thread, log, op.id)
      assert rec.reason == :revoked_capability
      assert rec.cited_delegation_id == d.id
      assert rec.evidence.revoked_by == revoke.id
    end

    test "a delegation carried only with a bad signature is invalid, not unknown" do
      sim = demo_sim("verdict:bad-sig")
      {_sim, good} = Sim.grant(sim, "r0", "r1", ops: [:post])
      forged = %{good | sig: :binary.copy(<<0>>, byte_size(good.sig))}

      {sim, _} = Sim.append(sim, "r0", :authority, {:grant, forged})
      {sim, post} = Sim.command(Sim.sync_all(sim), "r1", :post, ["x"], cap: forged.id)
      log = sim |> Sim.sync_all() |> Sim.log("r0")

      assert Authority.analyze(Lattice.Demo.Thread, log).reasons[post.id] == :invalid_capability

      assert %{status: :invalid, audience: nil, ops: []} =
               Verdict.delegation_status(Lattice.Demo.Thread, log, forged.id)

      assert %{status: :unknown} =
               Verdict.delegation_status(Lattice.Demo.Thread, log, "never-carried")
    end

    test "a non-atom scope serializes as an object, never as an action name" do
      sim = demo_sim("verdict:binary-scope")

      odd =
        Delegation.new(Sim.identity(sim, "r0"), sim.replica, Sim.identity(sim, "r1").pub,
          ops: ["post"]
        )

      {sim, _} = Sim.append(sim, "r0", :authority, {:grant, odd})
      log = sim |> Sim.sync_all() |> Sim.log("r0")
      status = Verdict.delegation_status(Lattice.Demo.Thread, log, odd.id)

      assert %{"ops" => [%{"non_atom" => ~s("post")}]} = Jason.decode!(Verdict.to_json(status))
      refute :post in status.ops
    end

    test "a non-binary audience refuses instead of crashing" do
      sim = demo_sim("verdict:int-audience")
      [genesis | _] = sim.caps["r0"]

      odd =
        Delegation.new(Sim.identity(sim, "r0"), sim.replica, 42,
          ops: [:post],
          parent_id: genesis.id
        )

      {sim, _} = Sim.append(sim, "r0", :authority, {:grant, odd})
      log = sim |> Sim.sync_all() |> Sim.log("r0")
      status = Verdict.delegation_status(Lattice.Demo.Thread, log, odd.id)

      assert status.audience == nil
      assert %{"audience" => nil} = Jason.decode!(Verdict.to_json(status))
    end

    test "a signed op with a non-atom kind serializes instead of crashing" do
      sim = demo_sim("verdict:string-kind")
      who = Sim.identity(sim, "r1")
      log = Sim.log(sim, "r0")

      unsigned = %Op{
        id: nil,
        sig: nil,
        replica: log.replica,
        author: who.pub,
        deps: Log.frontier(log),
        kind: "command",
        body: {:post, ["x"]},
        cap: nil
      }

      op = %{
        unsigned
        | id: Op.recompute_id(unsigned),
          sig: Lattice.Identity.sign(who, Op.canonical_encoding(unsigned))
      }

      assert Op.valid?(op)
      log = Log.from_ops(log.replica, Map.put(Log.ops(log), op.id, op))
      {_verdict, rec} = Verdict.explain(Lattice.Demo.Thread, log, op.id)

      assert %{"kind" => %{"non_atom" => ~s("command")}} = Jason.decode!(Verdict.to_json(rec))
    end

    test "non-UTF-8 ids serialize as tagged hex instead of crashing" do
      sim = demo_sim("verdict:non-utf8-cap")
      {sim, op} = Sim.command(sim, "r1", :post, ["x"], cap: <<255, 0>>)
      log = sim |> Sim.sync_all() |> Sim.log("r0")

      assert {:quarantined, rec} = Verdict.explain(Lattice.Demo.Thread, log, op.id)
      # Row 289 follow-up: an id that is not UTF-8 is not cited at all.
      assert rec.cited_delegation_id == nil
      assert %{"cited_delegation_id" => nil} = Jason.decode!(Verdict.to_json(rec))

      tagged = %{rec | replica: <<255, 1>>, frontier: [<<255, 0>>, :not_a_binary, "ok"]}
      json = Jason.decode!(Verdict.to_json(tagged))

      assert %{"non_utf8_hex" => "ff01"} = json["replica"]

      assert [%{"non_utf8_hex" => "ff00"}, %{"non_binary" => ":not_a_binary"}, "ok"] =
               json["frontier"]

      status = Verdict.delegation_status(Lattice.Demo.Thread, log, <<255, 0>>)

      assert %{"delegation_id" => %{"non_utf8_hex" => "ff00"}, "status" => "unknown"} =
               Jason.decode!(Verdict.to_json(status))
    end

    test "a bad chain is invalid even when it is also revoked or lapsed" do
      sim = demo_sim("verdict:bad-chain")

      # Correctly signed, but its parent is not on the log.
      bad =
        Delegation.new(Sim.identity(sim, "r1"), sim.replica, Sim.identity(sim, "r2").pub,
          ops: [:post],
          parent_id: "missing-parent",
          expires_epoch: 1
        )

      {sim, _} = Sim.append(sim, "r1", :authority, {:grant, bad})
      sim = Sim.sync_all(sim)
      {sim, post} = Sim.command(sim, "r2", :post, ["bad"], cap: bad.id)

      for {variant, sim} <- [
            revoked: elem(Sim.revoke(sim, "r0", bad.id), 0),
            lapsed: elem(Sim.beacon(sim, "r0", 2), 0)
          ] do
        log = sim |> Sim.sync_all() |> Sim.log("r0")

        assert Authority.analyze(Lattice.Demo.Thread, log).reasons[post.id] ==
                 :invalid_capability

        assert %{status: :invalid} = Verdict.delegation_status(Lattice.Demo.Thread, log, bad.id),
               "#{variant} bad chain"
      end
    end

    test "an accepted empty-tuple authority body does not crash a status query" do
      sim = demo_sim("verdict:empty-tuple")
      {sim, grant} = Sim.grant(sim, "r0", "r1", ops: [:post])
      {sim, _} = Sim.append(Sim.sync_all(sim), "r2", :authority, {})
      log = sim |> Sim.sync_all() |> Sim.log("r0")

      assert {:ok, _} = log |> Log.dump_bytes() |> Log.restore_verified_bytes()
      assert %{status: :active} = Verdict.delegation_status(Lattice.Demo.Thread, log, grant.id)
    end

    test "an unactivated succession candidate and its descendant are invalid" do
      sim =
        demo_sim("verdict:early", policies: %{moderator: %{successor: "r1", dormant_ticks: 2}})

      # Below the dormancy threshold, so the judge never honors the claim.
      {sim, succeed} = Sim.succeed(sim, "r1", :moderator, at_tick: 1)
      {sim, child} = Sim.grant(Sim.sync_all(sim), "r1", "r2", ops: [:lock], roles: [:moderator])
      log = sim |> Sim.sync_all() |> Sim.log("r0")

      assert Map.has_key?(Authority.analyze(Lattice.Demo.Thread, log).reasons, succeed.id)

      assert %{status: :invalid} =
               Verdict.delegation_status(Lattice.Demo.Thread, log, carried(succeed).id)

      assert %{status: :invalid} = Verdict.delegation_status(Lattice.Demo.Thread, log, child.id)
    end
  end

  # --- Property: Verdict never disagrees with the judge ----------------------
  #
  # The action shapes follow the M1 convergence generators
  # (`convergence_property_test.exs`, private there), extended with what this module
  # explains: a leased grant, root beacons, revokes and cross-realm cap misuse.

  @realms ["r0", "r1", "r2"]
  @module Lattice.Demo.Thread

  defp realm(i), do: Enum.at(@realms, i)
  defp idx, do: StreamData.member_of([0, 1, 2])

  defp action_gen do
    one_of([
      tuple({constant(:post), idx(), string(:alphanumeric, min_length: 1, max_length: 4)}),
      tuple({constant(:misuse), idx(), idx()}),
      tuple({constant(:lock), idx()}),
      tuple({constant(:transfer), idx()}),
      tuple({constant(:beacon)}),
      tuple({constant(:revoke), member_of([1, 2])}),
      tuple({constant(:partition), idx(), idx()}),
      tuple({constant(:heal), idx(), idx()}),
      tuple({constant(:sync), idx(), idx()})
    ])
  end

  defp run(actions, seed) do
    sim = Sim.new(@module, "replica:verdict:prop", @realms, seed: seed)
    {sim, _} = Sim.create_replica(sim, "r0")
    # r1 holds a lease that the second beacon lapses; r2's grant is unleased.
    {sim, c1} = Sim.grant(sim, "r0", "r1", ops: [:post, :join], expires_epoch: 1)
    {sim, c2} = Sim.grant(sim, "r0", "r2", ops: [:post, :join])
    sim = Sim.sync_all(sim)
    caps = %{1 => c1.id, 2 => c2.id}

    {sim, _tick, _epoch} =
      Enum.reduce(actions, {sim, 1, 0}, fn action, acc -> step(action, acc, caps) end)

    sim =
      for a <- @realms, b <- @realms, a < b, reduce: sim do
        acc -> Sim.heal(acc, a, b)
      end

    {Sim.sync_all(sim), caps}
  end

  defp step({:post, i, text}, {sim, t, e}, _caps),
    do: {elem(Sim.command(sim, realm(i), :post, [text]), 0), t, e}

  # Realm `i` cites realm `j`'s grant (r0 cites r1's for j == 0).
  defp step({:misuse, i, j}, {sim, t, e}, caps),
    do: {elem(Sim.command(sim, realm(i), :post, ["x"], cap: caps[max(j, 1)]), 0), t, e}

  defp step({:lock, i}, {sim, t, e}, _caps),
    do: {elem(Sim.command(sim, realm(i), :lock, []), 0), t, e}

  defp step({:transfer, to_i}, {sim, t, e}, _caps) do
    case Enum.find(@realms, &(Sim.holder(sim, &1, :moderator) == Sim.identity(sim, &1).pub)) do
      nil -> {sim, t, e}
      from -> {elem(Sim.transfer(sim, from, realm(to_i), :moderator, at_tick: t), 0), t + 1, e}
    end
  end

  defp step({:beacon}, {sim, t, e}, _caps),
    do: {elem(Sim.beacon(sim, "r0", e + 1), 0), t, e + 1}

  defp step({:revoke, i}, {sim, t, e}, caps),
    do: {elem(Sim.revoke(sim, "r0", caps[i]), 0), t, e}

  defp step({:partition, i, j}, {sim, t, e}, _caps),
    do: {if(i == j, do: sim, else: Sim.partition(sim, realm(i), realm(j))), t, e}

  defp step({:heal, i, j}, {sim, t, e}, _caps), do: {Sim.heal(sim, realm(i), realm(j)), t, e}

  defp step({:sync, i, j}, {sim, t, e}, _caps),
    do: {if(i == j, do: sim, else: Sim.sync(sim, realm(i), realm(j))), t, e}

  # Guards against a vacuous property: the generator must reach the reasons it decorates.
  test "the generator reaches revoke, lapse and wrong-audience quarantines" do
    reasons =
      1..150
      |> Enum.map(fn n ->
        action_gen() |> list_of(max_length: 14) |> StreamData.seeded(n) |> Enum.at(30)
      end)
      |> Enum.flat_map(fn actions ->
        {sim, _caps} = run(actions, "cover")
        Map.values(Authority.analyze(@module, Sim.log(sim, "r0")).reasons)
      end)
      |> MapSet.new()

    for reason <- [:revoked_capability, :lease_expired, :capability_wrong_audience],
        do: assert(reason in reasons, "generator never produced #{reason}")
  end

  property "explain agrees with analyze on every op, and evidence follows the reason" do
    check all(
            actions <- list_of(action_gen(), max_length: 14),
            seed <- string(:alphanumeric, min_length: 1, max_length: 6),
            max_runs: 150
          ) do
      {sim, _caps} = run(actions, seed)

      for realm <- @realms do
        log = Sim.log(sim, realm)
        {analysis, beacons} = Authority.analyze_with_beacon_evidence(@module, log)
        beacon_epochs = Map.new(beacons, &{&1.op_id, &1.epoch})

        for id <- Log.op_ids(log) do
          {verdict, rec} = Verdict.explain(@module, log, id)

          assert verdict == rec.verdict
          assert verdict == :quarantined == MapSet.member?(analysis.quarantine, id)
          assert rec.reason == Map.get(analysis.reasons, id)

          case rec.reason do
            nil ->
              assert rec.evidence == %{revoked_by: nil, lapsed_by_beacon: nil}

            :revoked_capability ->
              revoke = Log.ops(log)[rec.evidence.revoked_by]
              assert %Op{kind: :authority, body: {:revoke, _}} = revoke
              refute MapSet.member?(analysis.quarantine, revoke.id)
              assert rec.evidence.lapsed_by_beacon == nil

            :lease_expired ->
              assert is_integer(rec.evidence.lapsed_by_beacon)
              assert rec.evidence.lapsed_by_beacon > rec.expires_epoch
              assert rec.evidence.lapsed_by_beacon in Map.values(beacon_epochs)
              assert rec.evidence.revoked_by == nil

            _other ->
              assert rec.evidence == %{revoked_by: nil, lapsed_by_beacon: nil}
          end
        end
      end
    end
  end

  property "delegation status agrees with the live-path predicates" do
    check all(
            actions <- list_of(action_gen(), max_length: 14),
            seed <- string(:alphanumeric, min_length: 1, max_length: 6),
            max_runs: 150
          ) do
      {sim, caps} = run(actions, seed)

      for realm <- @realms, id <- Map.values(caps) do
        log = Sim.log(sim, realm)
        status = Verdict.delegation_status(@module, log, id)

        expected =
          cond do
            Authority.revoked?(log, id) -> :revoked
            Authority.expired?(log, id) -> :lapsed
            Authority.delegation_active?(log, id) -> :active
            true -> :invalid
          end

        assert status.status == expected
      end
    end
  end

  property "records are byte-identical across fully synced realms" do
    check all(
            actions <- list_of(action_gen(), max_length: 10),
            seed <- string(:alphanumeric, min_length: 1, max_length: 6),
            max_runs: 50
          ) do
      {sim, _caps} = run(actions, seed)
      logs = Enum.map(@realms, &Sim.log(sim, &1))

      for id <- Log.op_ids(hd(logs)) do
        jsons = Enum.map(logs, &Verdict.to_json(elem(Verdict.explain(@module, &1, id), 1)))
        assert length(Enum.uniq(jsons)) == 1
      end
    end
  end
end
