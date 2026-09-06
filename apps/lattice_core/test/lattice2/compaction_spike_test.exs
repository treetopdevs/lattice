defmodule Lattice2.CompactionSpikeTest do
  @moduledoc """
  Plan 013 GATE: for a generated log `L` with a chosen stable frontier `F`,
  `compact(L, F)` + the ops of `L` above `F` must reduce **byte-identically** to
  `L` under the real `Lattice.Authority` + `Lattice.Reduce` pipeline — state,
  quarantine set, reasons, holders, and requests — across scenarios that include
  an authority transfer and a stale-holder quarantine straddling `F`.

  The prototype under test is `Lattice.CompactionSpike` (test/support, throwaway,
  wired into nothing). Design + findings: `docs/adr/0006-compaction.md`.
  """
  use ExUnit.Case, async: true
  use ExUnitProperties

  @moduletag timeout: 300_000

  alias Lattice.{Authority, Canonical, CompactionSpike, Dag, Log, Reduce, Sim, Sync}
  alias Lattice.Authority.Delegation
  alias Lattice.Demo.Thread
  alias Mix.Tasks.Lattice.ExportVectors.DualAuthorityFixture

  @replica "replica:thread:compaction"
  @realms ["r0", "r1", "r2"]
  @witness_realms ["r0", "r1", "w0", "w1", "w2"]

  test "GATE (1) witnessed beacons and a lease straddle the stable frontier" do
    sim = Sim.new(Thread, @replica, @witness_realms, seed: "compaction:beacon")

    {sim, _} =
      Sim.create_replica(sim, "r0",
        policies: %{
          __beacon__: %{
            mode: :witnessed,
            version: 1,
            witnesses: ["w0", "w1", "w2"],
            threshold: 2,
            max_epoch_step: 2
          }
        }
      )

    {sim, lease} = Sim.grant(sim, "r0", "r1", ops: [:post], expires_epoch: 4)
    {sim, _} = Sim.beacon(sim, "r0", 2)
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.beacon(sim, "w0", 3, witnesses: ["w0", "w1"])
    sim = Sim.sync_all(sim)
    {sim, early} = Sim.command(sim, "r1", :post, ["before lapse"], cap: lease.id)
    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, witnessed} = Sim.beacon(sim, "w0", 5, witnesses: ["w0", "w1"])
    sim = Sim.sync_all(sim)
    beacon_frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, late} = Sim.command(sim, "r1", :post, ["after lapse"], cap: lease.id)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "r0")
    full = Authority.analyze(Thread, log)
    refute Map.has_key?(full.reasons, early.id)
    refute Map.has_key?(full.reasons, witnessed.id)
    assert full.reasons[late.id] == :lease_expired
    assert_compaction_equivalence(log, frontier)
    {_snapshot, retained, _result} = assert_compaction_equivalence(log, beacon_frontier)
    refute Log.has?(retained, witnessed.id)
    assert Log.has?(retained, late.id)
  end

  defp t2b(term), do: :erlang.term_to_binary(term, [:deterministic])

  # The GATE oracle: compact at `frontier`, re-reduce, compare byte-for-byte
  # against the full-log pipeline. Returns the pieces for extra assertions.
  defp assert_compaction_equivalence(%Log{} = log, frontier) do
    assert_compaction_equivalence(Thread, log, frontier)
  end

  defp assert_compaction_equivalence(module, %Log{} = log, frontier) do
    full = Authority.analyze(module, log)
    full_state = Reduce.reduce(module, log, quarantine: full.quarantine)

    assert {:ok, snapshot, retained} = CompactionSpike.compact(module, log, frontier)
    res = CompactionSpike.reduce_compacted(module, snapshot, retained)

    assert t2b(res.state) == t2b(full_state), "state diverged: #{inspect(res.state)}"
    assert res.quarantine == full.quarantine, "quarantine set diverged"
    assert res.reasons == full.reasons, "quarantine reasons diverged"
    assert res.holders == full.holders, "holders diverged"
    assert res.requests == full.requests, "requests diverged"

    {snapshot, retained, res}
  end

  # --- The named straddle scenario (deterministic) --------------------------

  # Builds a log where the authority history relevant to decisions above F lies
  # beneath F: transfer below F; stale-holder conflict, revoked-capability use,
  # premature succession, observed-remove, and a double-transfer all above F.
  defp straddle_scenario do
    sim = Sim.new(Thread, @replica, @realms, seed: "compaction-spike")

    {sim, _g} =
      Sim.create_replica(sim, "r0", policies: %{moderator: %{successor: "r2", dormant_ticks: 5}})

    {sim, _g1} = Sim.grant(sim, "r0", "r1", ops: [:post, :set_title, :join, :leave])
    {sim, g2} = Sim.grant(sim, "r0", "r2", ops: [:post, :join, :leave])
    sim = Sim.sync_all(sim)

    # Below F: activity, a lock by the genesis holder, a queued request, the
    # moderator transfer r0 -> r1, and a revoke of r2's grant.
    {sim, _} = Sim.command(sim, "r1", :post, ["hello below F"])
    {sim, _} = Sim.command(sim, "r1", :join, ["r1"])
    {sim, _} = Sim.command(sim, "r2", :join, ["r2"])
    {sim, _} = Sim.command(sim, "r0", :lock, [])
    {sim, _} = Sim.request(sim, "r2", "ref-below", {:lock, []})
    sim = Sim.sync_all(sim)
    {sim, _d1} = Sim.transfer(sim, "r0", "r1", :moderator, at_tick: 1)
    sim = Sim.sync_all(sim)
    {sim, _} = Sim.command(sim, "r1", :unlock, [])
    {sim, _} = Sim.revoke(sim, "r0", g2.id)
    sim = Sim.sync_all(sim)

    frontier = Log.frontier(Sim.log(sim, "r0"))

    # Above F: fork a stale lock by the pre-transfer holder (concurrent with the
    # transfer that moves the role away), then advance the main line.
    {branch, stale_lock} = Sim.command(sim, "r1", :lock, [])
    {sim, _d2} = Sim.transfer(sim, "r1", "r2", :moderator, at_tick: 2)
    sim = Sim.sync_all(sim)
    {sim, r2_lock} = Sim.command(sim, "r2", :lock, [])
    {sim, revoked_post} = Sim.command(sim, "r2", :post, ["after revoke"], cap: g2.id)
    {sim, _} = Sim.command(sim, "r1", :leave, ["r1"])
    {sim, no_cap} = Sim.command(sim, "r1", :post, ["forged"], cap: :none)
    {sim, premature} = Sim.succeed(sim, "r2", :moderator, at_tick: 3)
    {sim, _} = Sim.request(sim, "r1", "ref-above", {:unlock, []})
    {sim, _} = Sim.command(sim, "r0", :post, ["r0 above F"])
    sim = Sim.sync_all(sim)

    # Double transfer above F: r2, on one frontier, hands the role to both r0
    # and r1 without either branch seeing the other.
    {branch_a, da} = Sim.transfer(sim, "r2", "r0", :moderator, at_tick: 4)
    {branch_b, db} = Sim.transfer(sim, "r2", "r1", :moderator, at_tick: 4)

    {m1, _, _} = Sync.reconcile(Sim.log(branch_a, "r2"), Sim.log(branch_b, "r2"))
    {full_log, _, _} = Sync.reconcile(m1, Sim.log(branch, "r1"))

    rejected_descendant_transfers =
      for {op_id, %{body: {:transfer, :moderator, %Delegation{id: delegation_id}, 4}}} <-
            Log.ops(full_log),
          delegation_id in [da.id, db.id],
          do: op_id

    %{
      log: full_log,
      frontier: frontier,
      stale_lock: stale_lock,
      r2_lock: r2_lock,
      revoked_post: revoked_post,
      no_cap: no_cap,
      premature: premature,
      rejected_descendant_transfers: rejected_descendant_transfers
    }
  end

  test "GATE: transfer + stale-holder + revocation + succession straddling F reduce byte-identically after compaction" do
    %{log: log, frontier: frontier} = ctx = straddle_scenario()

    {_snapshot, retained, res} = assert_compaction_equivalence(log, frontier)

    # The named straddles landed with the expected verdicts, decided on the
    # compacted side from the snapshot's authority summary alone.
    assert res.reasons[ctx.stale_lock.id] == :stale_holder
    assert res.reasons[ctx.revoked_post.id] == :revoked_capability
    assert res.reasons[ctx.no_cap.id] == :no_capability
    assert res.reasons[ctx.premature.id] == :premature_succession

    assert Enum.sort(for {id, :invalid_transfer} <- res.reasons, do: id) ==
             Enum.sort(ctx.rejected_descendant_transfers)

    refute Map.has_key?(res.reasons, ctx.r2_lock.id)

    # The straddle ops are genuinely above F (retained), and compaction
    # genuinely dropped ops beneath F.
    assert Log.has?(retained, ctx.stale_lock.id)
    assert Log.has?(retained, ctx.revoked_post.id)
    assert Log.has?(retained, ctx.premature.id)
    assert Log.size(retained) < Log.size(log)
    assert Log.size(retained) > 0
  end

  test "malformed retained heartbeat cannot crash full or compacted succession replay" do
    sim =
      Sim.new(Thread, @replica, @realms, seed: "compaction-malformed-heartbeat")

    {sim, _genesis} =
      Sim.create_replica(sim, "r0", policies: %{moderator: %{successor: "r1", dormant_ticks: 3}})

    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, heartbeat} = Sim.append(sim, "r0", :authority, {:heartbeat, :moderator, "9"})
    sim = Sim.sync_all(sim)
    {sim, succession} = Sim.succeed(sim, "r1", :moderator, at_tick: 3)
    sim = Sim.sync_all(sim)

    {_snapshot, _retained, res} =
      assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    assert res.reasons[heartbeat.id] == :malformed_term
    refute Map.has_key?(res.reasons, succession.id)
    assert res.holders.moderator == Sim.identity(sim, "r1").pub
  end

  test "covered malformed heartbeat below F cannot poison the snapshot or crash succession replay" do
    sim =
      Sim.new(Thread, @replica, @realms, seed: "compaction-covered-malformed-heartbeat")

    {sim, _genesis} =
      Sim.create_replica(sim, "r0", policies: %{moderator: %{successor: "r1", dormant_ticks: 3}})

    {sim, heartbeat} = Sim.append(sim, "r0", :authority, {:heartbeat, :moderator, "9"})
    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))

    {sim, succession} = Sim.succeed(sim, "r1", :moderator, at_tick: 3)
    sim = Sim.sync_all(sim)

    {snapshot, retained, res} =
      assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    # The malformed heartbeat is genuinely beneath F: compacted away, its
    # quarantine frozen into the snapshot, and its string tick excluded from
    # the role summary the succession replay does arithmetic on.
    refute Log.has?(retained, heartbeat.id)
    assert snapshot.roles.moderator.last_active_tick == 0
    assert res.reasons[heartbeat.id] == :malformed_term
    refute Map.has_key?(res.reasons, succession.id)
    assert res.holders.moderator == Sim.identity(sim, "r1").pub
  end

  test "out-of-range retained succession proof stays quarantined after compaction" do
    sim = Sim.new(Thread, @replica, @realms, seed: "compaction-malformed-succession")

    {sim, _genesis} =
      Sim.create_replica(sim, "r0", policies: %{moderator: %{successor: "r1", dormant_ticks: 3}})

    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, succession} = Sim.succeed(sim, "r1", :moderator, at_tick: 3)
    {:succeed, :moderator, delegation, 3} = succession.body
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "r0")

    malformed = %{
      succession
      | body: {:succeed, :moderator, delegation, Canonical.max_integer() + 1}
    }

    malformed_log = Log.from_ops(log.replica, Map.put(log.ops, succession.id, malformed))
    {_snapshot, retained, res} = assert_compaction_equivalence(malformed_log, frontier)

    assert Log.has?(retained, succession.id)
    assert res.reasons[succession.id] == :malformed_term
    assert res.holders.moderator == Sim.identity(sim, "r0").pub
  end

  test "undeclared-role malformed succession remains structurally quarantined after compaction" do
    sim = Sim.new(Thread, @replica, @realms, seed: "compaction-undeclared-succession")

    {sim, _genesis} =
      Sim.create_replica(sim, "r0", policies: %{moderator: %{successor: "r1", dormant_ticks: 3}})

    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, succession} = Sim.succeed(sim, "r1", :moderator, at_tick: 3)
    {:succeed, :moderator, delegation, 3} = succession.body
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "r0")

    malformed = %{
      succession
      | body: {:succeed, :not_a_role, delegation, Canonical.max_integer() + 1}
    }

    malformed_log = Log.from_ops(log.replica, Map.put(log.ops, succession.id, malformed))
    {_snapshot, retained, res} = assert_compaction_equivalence(malformed_log, frontier)

    assert Log.has?(retained, succession.id)
    assert res.reasons[succession.id] == :malformed_term
    assert res.holders.moderator == Sim.identity(sim, "r0").pub
  end

  test "undeclared-role malformed transfer remains structurally quarantined after compaction" do
    sim = Sim.new(Thread, @replica, @realms, seed: "compaction-undeclared-transfer")
    {sim, _genesis} = Sim.create_replica(sim, "r0")
    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, delegation} = Sim.transfer(sim, "r0", "r1", :moderator, at_tick: 1)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "r0")

    transfer =
      log
      |> Log.topo_ops()
      |> Enum.find(fn
        %{body: {:transfer, :moderator, %Delegation{id: id}, 1}} -> id == delegation.id
        _op -> false
      end)

    malformed = %{
      transfer
      | body: {:transfer, :not_a_role, delegation, Canonical.max_integer() + 1}
    }

    malformed_log = Log.from_ops(log.replica, Map.put(log.ops, transfer.id, malformed))
    {_snapshot, retained, res} = assert_compaction_equivalence(malformed_log, frontier)

    assert Log.has?(retained, transfer.id)
    assert res.reasons[transfer.id] == :malformed_term
    assert res.holders.moderator == Sim.identity(sim, "r0").pub
  end

  test "retained foreign-replica capability keeps its wrong-replica reason after compaction" do
    sim = Sim.new(Thread, @replica, @realms, seed: "compaction-foreign-replica-capability")
    {sim, _genesis} = Sim.create_replica(sim, "r0")
    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))
    root = Sim.identity(sim, "r0")
    resident = Sim.identity(sim, "r1")
    foreign_replica = Authority.bind_replica("replica:thread:foreign", root.pub)

    foreign_genesis =
      Delegation.genesis(root, foreign_replica,
        ops: [:post],
        roles: [:moderator],
        live: true
      )

    foreign_grant =
      Delegation.new(root, foreign_replica, resident.pub,
        ops: [:post],
        roles: [],
        parent_id: foreign_genesis.id
      )

    {sim, _foreign_genesis_op} =
      Sim.append(sim, "r0", :authority, {:genesis, foreign_genesis, %{}})

    {sim, _foreign_grant_op} = Sim.append(sim, "r0", :authority, {:grant, foreign_grant})
    sim = Sim.sync_all(sim)

    {sim, command} =
      Sim.command(sim, "r1", :post, ["foreign capability"], cap: foreign_grant.id)

    sim = Sim.sync_all(sim)
    {_snapshot, retained, res} = assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    assert Log.has?(retained, command.id)
    assert res.reasons[command.id] == :wrong_replica
  end

  test "retained honored succession activates its descendant transfer after compaction" do
    {sim, _grants} = setup_sim("compaction-retained-succession-transfer")
    frontier = Log.frontier(Sim.log(sim, "r0"))

    {sim, succession} = Sim.succeed(sim, "r1", :moderator, at_tick: 2)
    sim = Sim.sync_all(sim)
    {sim, transfer_delegation} = Sim.transfer(sim, "r1", "r2", :moderator, at_tick: 3)
    sim = Sim.sync_all(sim)
    {sim, lock} = Sim.command(sim, "r2", :lock, [], cap: transfer_delegation.id)
    sim = Sim.sync_all(sim)

    {_snapshot, _retained, res} =
      assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    refute Map.has_key?(res.reasons, succession.id)
    refute Map.has_key?(res.reasons, lock.id)
    assert res.holders.moderator == Sim.identity(sim, "r2").pub
    assert res.state.locked?
  end

  test "retained witnessed succession remains honored after compaction" do
    sim = setup_witnessed_sim("compaction-retained-witnessed-succession")
    frontier = Log.frontier(Sim.log(sim, "r0"))

    {sim, succession} =
      Sim.succeed(sim, "r1", :moderator, witnesses: ["w0", "w1"])

    sim = Sim.sync_all(sim)
    {_snapshot, retained, res} = assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    assert Log.has?(retained, succession.id)
    refute Map.has_key?(res.reasons, succession.id)
    assert res.holders.moderator == Sim.identity(sim, "r1").pub
  end

  test "covered replayed genesis cannot replace the witnessed holder epoch" do
    sim = setup_witnessed_sim("compaction-replayed-genesis-witnessed-epoch")

    genesis_delegation =
      sim
      |> Sim.log("r0")
      |> Log.topo_ops()
      |> Enum.find_value(fn
        %{body: {:genesis, %Delegation{} = delegation, _policies}} -> delegation
        _op -> nil
      end)

    {sim, replayed_genesis} =
      Sim.append(sim, "r1", :authority, {:genesis, genesis_delegation, %{}})

    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))

    {sim, succession} =
      Sim.succeed(sim, "r1", :moderator, witnesses: ["w0", "w1"])

    sim = Sim.sync_all(sim)
    {_snapshot, retained, res} = assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    refute Log.has?(retained, replayed_genesis.id)
    assert Log.has?(retained, succession.id)
    assert res.reasons[replayed_genesis.id] == :unauthorized_genesis
    refute Map.has_key?(res.reasons, succession.id)
    assert res.holders.moderator == Sim.identity(sim, "r1").pub
  end

  test "retained witnessed succession stays rejected when recovery is not configured" do
    source = setup_witnessed_sim("compaction-witnessed-certificate-source")

    {_source, source_succession} =
      Sim.succeed(source, "r1", :moderator, witnesses: ["w0", "w1"])

    {:succeed, :moderator, _delegation, {:witnessed, certificate}} = source_succession.body

    sim = Sim.new(Thread, @replica, @witness_realms, seed: "compaction-legacy-witnessed-proof")

    {sim, _genesis} =
      Sim.create_replica(sim, "r0", policies: %{moderator: %{successor: "r1", dormant_ticks: 3}})

    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, succession} = Sim.succeed(sim, "r1", :moderator, certificate: certificate)
    sim = Sim.sync_all(sim)

    {_snapshot, retained, res} = assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    assert Log.has?(retained, succession.id)
    assert res.reasons[succession.id] == :witnessed_recovery_not_configured
    assert res.holders.moderator == Sim.identity(sim, "r0").pub
  end

  test "retained integer succession requires a certificate under witnessed recovery" do
    sim = setup_witnessed_sim("compaction-witnessed-policy-integer-proof")
    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, succession} = Sim.succeed(sim, "r1", :moderator, at_tick: 1_000_000)
    sim = Sim.sync_all(sim)

    {_snapshot, retained, res} = assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    assert Log.has?(retained, succession.id)
    assert res.reasons[succession.id] == :recovery_certificate_required
    assert res.holders.moderator == Sim.identity(sim, "r0").pub
  end

  test "retained succession rejects a hybrid recovery and dormancy policy" do
    sim =
      Sim.new(Thread, @replica, @witness_realms, seed: "compaction-hybrid-recovery-policy")

    {sim, _genesis} =
      Sim.create_replica(sim, "r0",
        policies: %{
          moderator: %{
            successor: "r1",
            dormant_ticks: 3,
            recovery: %{
              mode: :witnessed,
              version: 1,
              witnesses: ["w0", "w1", "w2"],
              threshold: 2
            }
          }
        }
      )

    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, succession} = Sim.succeed(sim, "r1", :moderator, at_tick: 3)
    sim = Sim.sync_all(sim)

    {_snapshot, retained, res} = assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    assert Log.has?(retained, succession.id)
    assert res.reasons[succession.id] == :invalid_recovery_policy
    assert res.holders.moderator == Sim.identity(sim, "r0").pub
  end

  test "covered witnessed succession seeds a zero-tick acquire after compaction" do
    sim = setup_witnessed_sim("compaction-covered-witnessed-succession")

    {sim, succession} =
      Sim.succeed(sim, "r1", :moderator, witnesses: ["w0", "w1"])

    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "r0"))
    {sim, lock} = Sim.command(sim, "r1", :lock, [])
    sim = Sim.sync_all(sim)

    {snapshot, retained, res} = assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    refute Log.has?(retained, succession.id)
    assert Log.has?(retained, lock.id)
    assert snapshot.roles.moderator.last_acquire.at_tick == 0
    assert snapshot.roles.moderator.last_active_tick == 0
    refute Map.has_key?(res.reasons, lock.id)
    assert res.holders.moderator == Sim.identity(sim, "r1").pub
    assert res.state.locked?
  end

  test "covered honored succession activates retained capability use and same-role transfer" do
    {sim, _grants} = setup_sim("compaction-covered-succession-activation")

    {sim, succession} = Sim.succeed(sim, "r1", :moderator, at_tick: 2)
    sim = Sim.sync_all(sim)
    {:succeed, :moderator, succession_root, _proof} = succession.body
    frontier = Log.frontier(Sim.log(sim, "r0"))

    {sim, lock} = Sim.command(sim, "r1", :lock, [], cap: succession_root.id)
    {sim, transfer_delegation} = Sim.transfer(sim, "r1", "r2", :moderator, at_tick: 3)
    sim = Sim.sync_all(sim)

    {_snapshot, retained, res} =
      assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)

    refute Log.has?(retained, succession.id)
    assert Log.has?(retained, lock.id)
    refute Map.has_key?(res.reasons, lock.id)
    assert res.holders.moderator == Sim.identity(sim, "r2").pub
    assert res.state.locked?
    assert transfer_delegation.parent_id == succession_root.id
  end

  test "covered succession for an undeclared role cannot activate a retained capability" do
    sim =
      Sim.new(Thread, @replica, ["root", "attacker"], seed: "compaction-undeclared-succession")

    {sim, _genesis} = Sim.create_replica(sim, "root")
    attacker = Sim.identity(sim, "attacker")

    candidate =
      Delegation.genesis(attacker, Sim.replica(sim),
        ops: [:post],
        roles: [:ghost]
      )

    {sim, disguised_succession} =
      Sim.append(sim, "attacker", :authority, {:succeed, :ghost, candidate, 0})

    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "root"))

    {sim, retained_post} =
      Sim.command(sim, "attacker", :post, ["not authorized"], cap: candidate.id)

    sim = Sim.sync_all(sim)

    {_snapshot, _retained, res} =
      assert_compaction_equivalence(Sim.log(sim, "root"), frontier)

    refute Map.has_key?(res.reasons, disguised_succession.id)
    assert res.reasons[retained_post.id] == :invalid_capability
    refute "not authorized" in res.state.messages
  end

  test "covered succession activates candidate descendants only for its own role" do
    sim =
      Sim.new(
        DualAuthorityFixture,
        "replica:dual-authority:compaction-cross-role",
        ["root", "successor", "target"],
        seed: "compaction-cross-role"
      )

    {sim, _genesis} =
      Sim.create_replica(sim, "root",
        policies: %{clerk: %{successor: "successor", dormant_ticks: 3}}
      )

    root = Sim.identity(sim, "root")

    mayor_genesis =
      Delegation.genesis(root, Sim.replica(sim),
        ops: [:close_mayor],
        roles: [:mayor],
        live: true
      )

    {sim, _mayor_genesis} =
      Sim.append(sim, "root", :authority, {:genesis, mayor_genesis, %{}})

    {sim, _mayor_delegation} =
      Sim.transfer(sim, "root", "successor", :mayor,
        at_tick: 0,
        ops: [:close_mayor]
      )

    sim = Sim.sync_all(sim)
    successor = Sim.identity(sim, "successor")
    target = Sim.identity(sim, "target")

    succession_root =
      Delegation.new(successor, Sim.replica(sim), successor.pub,
        ops: [:close_clerk, :close_mayor],
        roles: [:clerk, :mayor],
        parent_id: nil
      )

    {sim, succession} =
      Sim.append(sim, "successor", :authority, {:succeed, :clerk, succession_root, 3})

    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "root"))

    cross_role_child =
      Delegation.new(successor, Sim.replica(sim), target.pub,
        ops: [:close_mayor],
        roles: [:mayor],
        parent_id: succession_root.id
      )

    {sim, cross_role_transfer} =
      Sim.append(
        sim,
        "successor",
        :authority,
        {:transfer, :mayor, cross_role_child, 4}
      )

    sim = Sim.sync_all(sim)

    {_snapshot, _retained, res} =
      assert_compaction_equivalence(
        DualAuthorityFixture,
        Sim.log(sim, "root"),
        frontier
      )

    refute Map.has_key?(res.reasons, succession.id)
    assert res.reasons[cross_role_transfer.id] == :invalid_transfer
    assert res.holders.mayor == successor.pub
  end

  test "verification: a snapshot is valid iff re-reducing the covered ops reproduces it" do
    %{log: log, frontier: frontier} = straddle_scenario()
    {:ok, snapshot, _retained} = CompactionSpike.compact(Thread, log, frontier)

    covered_ids = Dag.reachable(Log.ops(log), frontier)
    covered_log = Log.from_ops(log.replica, Map.take(Log.ops(log), MapSet.to_list(covered_ids)))

    assert CompactionSpike.verify(Thread, snapshot, covered_log) == :ok

    # Tampering with snapshot content (rewriting the frozen holder summary so a
    # different realm appears to hold :moderator at F) is caught.
    assert snapshot.frozen_holders != %{}
    tampered = %{snapshot | frozen_holders: %{moderator: "forged-pubkey"}}
    assert CompactionSpike.verify(Thread, tampered, covered_log) == {:error, :snapshot_mismatch}

    # A covered-op set that does not reduce to the snapshot is caught.
    [victim | _] = covered_log |> Log.ops() |> Map.keys() |> Enum.sort()
    pruned = Log.from_ops(covered_log.replica, Map.delete(Log.ops(covered_log), victim))
    assert CompactionSpike.verify(Thread, snapshot, pruned) == {:error, :snapshot_mismatch}
  end

  test "an unstable frontier (a retained op that does not dominate F) is rejected, not compacted" do
    sim = Sim.new(Thread, @replica, @realms, seed: "compaction-unstable")
    {sim, _g} = Sim.create_replica(sim, "r0")
    {sim, _g1} = Sim.grant(sim, "r0", "r1", ops: [:post])
    sim = Sim.sync_all(sim)

    # Two concurrent posts: op_a on r0, op_b on r1 (never synced before merge).
    {sim, op_a} = Sim.command(sim, "r0", :post, ["a"])
    {sim, op_b} = Sim.command(sim, "r1", :post, ["b"])
    {merged, _, _} = Sync.reconcile(Sim.log(sim, "r0"), Sim.log(sim, "r1"))

    # F = r0's frontier (dominated by op_a). op_b is above F but concurrent with
    # op_a — compacting here would break the authority/CRDT ancestry summaries.
    frontier = [op_a.id]

    assert {:error, {:unstable_frontier, unstable}} =
             CompactionSpike.compact(Thread, merged, frontier)

    assert unstable == op_b.id
  end

  # --- Property: randomized two-phase histories ------------------------------

  defp action_gen do
    one_of([
      tuple({constant(:post), idx(), string(:alphanumeric, min_length: 1, max_length: 5)}),
      tuple({constant(:title), idx(), string(:alphanumeric, min_length: 1, max_length: 5)}),
      tuple({constant(:join), idx()}),
      tuple({constant(:leave), idx()}),
      tuple({constant(:lock), idx()}),
      tuple({constant(:unlock), idx()}),
      tuple({constant(:transfer), idx()}),
      tuple({constant(:revoke), member_of([1, 2])}),
      tuple({constant(:request), idx(), string(:alphanumeric, min_length: 1, max_length: 8)}),
      tuple({constant(:heartbeat), idx()}),
      tuple({constant(:succeed), idx()}),
      tuple({constant(:partition), idx(), idx()}),
      tuple({constant(:heal), idx(), idx()}),
      tuple({constant(:sync), idx(), idx()})
    ])
  end

  defp idx, do: StreamData.member_of([0, 1, 2])

  defp realm(i), do: Enum.at(@realms, i)

  defp setup_sim(seed) do
    sim = Sim.new(Thread, @replica, @realms, seed: seed)

    {sim, _g} =
      Sim.create_replica(sim, "r0", policies: %{moderator: %{successor: "r1", dormant_ticks: 2}})

    {sim, g1} = Sim.grant(sim, "r0", "r1", ops: [:post, :set_title, :join, :leave])
    {sim, g2} = Sim.grant(sim, "r0", "r2", ops: [:post, :set_title, :join, :leave])
    {Sim.sync_all(sim), %{1 => g1, 2 => g2}}
  end

  defp setup_witnessed_sim(seed) do
    sim = Sim.new(Thread, @replica, @witness_realms, seed: seed)

    {sim, _genesis} =
      Sim.create_replica(sim, "r0",
        policies: %{
          moderator: %{
            successor: "r1",
            recovery: %{
              mode: :witnessed,
              version: 1,
              witnesses: ["w0", "w1", "w2"],
              threshold: 2
            }
          }
        }
      )

    Sim.sync_all(sim)
  end

  defp heal_all(sim) do
    Enum.reduce(@realms, sim, fn a, acc ->
      Enum.reduce(@realms, acc, fn b, acc2 -> if a < b, do: Sim.heal(acc2, a, b), else: acc2 end)
    end)
  end

  defp run_phase(sim, tick, actions, grants) do
    Enum.reduce(actions, {sim, tick}, &apply_action(&1, &2, grants))
  end

  defp apply_action({:post, i, text}, {sim, t}, _g),
    do: {elem(Sim.command(sim, realm(i), :post, [text]), 0), t}

  defp apply_action({:title, i, text}, {sim, t}, _g),
    do: {elem(Sim.command(sim, realm(i), :set_title, [text]), 0), t}

  defp apply_action({:join, i}, {sim, t}, _g),
    do: {elem(Sim.command(sim, realm(i), :join, [realm(i)]), 0), t}

  defp apply_action({:leave, i}, {sim, t}, _g),
    do: {elem(Sim.command(sim, realm(i), :leave, [realm(i)]), 0), t}

  defp apply_action({:lock, i}, {sim, t}, _g),
    do: {elem(Sim.command(sim, realm(i), :lock, []), 0), t}

  defp apply_action({:unlock, i}, {sim, t}, _g),
    do: {elem(Sim.command(sim, realm(i), :unlock, []), 0), t}

  defp apply_action({:transfer, to_i}, {sim, t}, _g) do
    # Author the transfer from whichever realm currently believes it holds.
    case Enum.find(@realms, fn r -> Sim.holder(sim, r, :moderator) == Sim.identity(sim, r).pub end) do
      nil -> {sim, t}
      from -> {elem(Sim.transfer(sim, from, realm(to_i), :moderator, at_tick: t), 0), t + 1}
    end
  end

  defp apply_action({:revoke, which}, {sim, t}, grants),
    do: {elem(Sim.revoke(sim, "r0", grants[which].id), 0), t}

  defp apply_action({:request, i, ref}, {sim, t}, _g),
    do: {elem(Sim.request(sim, realm(i), ref, {:lock, []}), 0), t}

  defp apply_action({:heartbeat, i}, {sim, t}, _g),
    do: {elem(Sim.heartbeat(sim, realm(i), :moderator, t), 0), t + 1}

  defp apply_action({:succeed, i}, {sim, t}, _g),
    do: {elem(Sim.succeed(sim, realm(i), :moderator, at_tick: t), 0), t + 1}

  defp apply_action({:partition, i, j}, {sim, t}, _g),
    do: {if(i == j, do: sim, else: Sim.partition(sim, realm(i), realm(j))), t}

  defp apply_action({:heal, i, j}, {sim, t}, _g), do: {Sim.heal(sim, realm(i), realm(j)), t}

  defp apply_action({:sync, i, j}, {sim, t}, _g),
    do: {if(i == j, do: sim, else: Sim.sync(sim, realm(i), realm(j))), t}

  property "GATE (generated): compact(L, F) ⊕ ops-above-F reduces byte-identically to L" do
    check all(
            phase1 <- list_of(action_gen(), max_length: 10),
            phase2 <- list_of(action_gen(), max_length: 10),
            seed <- string(:alphanumeric, min_length: 1, max_length: 6),
            max_runs: 150
          ) do
      {sim, grants} = setup_sim(seed)

      # Phase 1 (beneath F), then full heal + converge: F is a stable frontier.
      {sim, tick} = run_phase(sim, 1, phase1, grants)
      sim = sim |> heal_all() |> Sim.sync_all()
      frontier = Log.frontier(Sim.log(sim, "r0"))

      # Phase 2 (above F), then full heal + converge again.
      {sim, _tick} = run_phase(sim, tick, phase2, grants)
      sim = sim |> heal_all() |> Sim.sync_all()

      assert_compaction_equivalence(Sim.log(sim, "r0"), frontier)
    end
  end
end
