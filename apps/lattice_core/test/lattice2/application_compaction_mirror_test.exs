defmodule Lattice2.ApplicationCompactionMirrorTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, CompactionSpike, Log, Op, Reduce, Sim, Sync}
  alias Lattice.Authority.Delegation
  alias Lattice.Demo.Thread
  alias Treehouse.{Invitation, Space}

  defmodule PolicyReplica do
    @moduledoc false
    use Lattice.Replica

    state do
      field(:events, merge: :causal_list, default: [])
    end

    command(:source, [:label], do: [{:events, {:append, {:source, label}}}])
    command(:reference, [:target_id], do: [{:events, {:append, {:reference, target_id}}}])
    command(:deny, [:label], do: [{:events, {:append, {:denied, label}}}])
    command(:claim, [:key, :label], do: [{:events, {:append, {:claim, key, label}}}])
    command(:explode, [], do: raise("effect explosion"))

    def command_op_status(%Op{body: {:deny, [_label]}}, _visible_ids, _context),
      do: {:error, :application_denied}

    def command_op_status(
          %Op{body: {:reference, [target_id]}} = op,
          visible_ids,
          %{visible_ops: visible_ops, verdicts: verdicts}
        ) do
      notify_context(op, visible_ids, %{visible_ops: visible_ops, verdicts: verdicts})

      cond do
        not MapSet.member?(visible_ids, target_id) ->
          {:error, :application_target_not_visible}

        not Map.has_key?(visible_ops, target_id) ->
          {:error, :application_target_not_visible}

        Map.get(verdicts, target_id) != :honored ->
          {:error, :application_target_quarantined}

        not match?(%Op{kind: :command, body: {:source, [_]}}, visible_ops[target_id]) ->
          {:error, :application_wrong_target}

        true ->
          :ok
      end
    end

    def command_op_status(op, visible_ids, context) do
      notify_context(op, visible_ids, context)

      :ok
    end

    def command_conflicts(ops, verdicts, ancestors) do
      if observer = Process.get(:application_mirror_observer) do
        send(observer, {:application_conflicts, ops, verdicts, ancestors})
      end

      ops
      |> Map.values()
      |> Enum.filter(fn
        %Op{id: id, kind: :command, body: {:claim, [_key, _label]}} ->
          Map.get(verdicts, id) == :honored

        _other ->
          false
      end)
      |> Enum.group_by(fn %Op{body: {:claim, [key, _label]}} -> key end)
      |> Enum.reduce(%{}, fn {_key, claims}, conflicts ->
        claims
        |> Enum.sort_by(& &1.id)
        |> conflict_losers(ancestors)
        |> Enum.reduce(conflicts, &Map.put(&2, &1.id, :application_conflict))
      end)
    end

    defp conflict_losers([], _ancestors), do: []

    defp conflict_losers([winner | rest], ancestors) do
      Enum.filter(rest, fn candidate ->
        winner_visible = Map.get(ancestors, candidate.id, MapSet.new())
        candidate_visible = Map.get(ancestors, winner.id, MapSet.new())

        not MapSet.member?(winner_visible, winner.id) and
          not MapSet.member?(candidate_visible, candidate.id)
      end)
    end

    defp notify_context(op, visible_ids, context) do
      if observer = Process.get(:application_mirror_observer) do
        send(observer, {:application_context, op.id, visible_ids, context})
      end
    end
  end

  defmodule BeaconReplica do
    @moduledoc false
    use Lattice.Replica

    state do
      field(:events, merge: :causal_list, default: [])
    end

    command(:observe_beacons, [:expected], do: [{:events, {:append, expected}}])
    command(:mask_beacon, [:target], do: [{:events, {:append, {:mask, target}}}])

    def command_op_status(op, visible, context) do
      if observer = Process.get(:application_mirror_observer),
        do: send(observer, {:application_context, op.id, visible, context})

      case op.body do
        {:observe_beacons, [expected]} ->
          case Map.fetch(context, :valid_beacons) do
            :error -> {:error, :missing_valid_beacons}
            {:ok, ^expected} -> :ok
            {:ok, _other} -> {:error, :wrong_valid_beacons}
          end

        _other ->
          :ok
      end
    end

    def command_conflicts(ops, verdicts, ancestors) do
      if observer = Process.get(:application_mirror_observer),
        do: send(observer, {:application_conflicts, ops, verdicts, ancestors})

      for {id, %Op{kind: :command, body: {:mask_beacon, [target]}}} <- ops,
          Map.get(verdicts, id) == :honored,
          into: %{},
          do: {target, :application_conflict}
    end
  end

  for {label, options} <- [
        {"conflict callback", [conflict: true]},
        {"unsupported callback", [unsupported: true]},
        {"conflict finite lease", [conflict: true, finite: true]},
        {"unsupported finite lease", [unsupported: true, finite: true]},
        {"invalid-only finite lease", [invalid_only: true, finite: true]},
        {"exact high uint64 callback", [conflict: true, epoch: 18_446_744_073_709_551_615]}
      ] do
    @tag :beacon_evidence
    test "verified application beacon evidence preserves #{label} under both real deliveries" do
      options = unquote(options)
      fixture = beacon_mirror_log(options)

      outcomes =
        Enum.map(delivery_sequences(fixture.log), &assert_beacon_mirror(&1, fixture, options))

      assert Enum.at(outcomes, 0) == Enum.at(outcomes, 1)
    end
  end

  @tag :beacon_evidence
  test "rehashed beacon tampering cannot replace authentic covered evidence" do
    fixture = beacon_mirror_log(conflict: true)

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(BeaconReplica, fixture.log, fixture.frontier)

    assert snapshot.covered_valid_beacons == fixture.expected
    [first, second] = fixture.expected

    for evidence <- [
          [],
          [first],
          [first, first, second],
          Enum.reverse(fixture.expected),
          [%{first | epoch: first.epoch + 20}, second],
          [%{first | op_id: fixture.invalid.id}, second],
          fixture.expected ++ [%{op_id: fixture.invalid.id, epoch: 99}],
          [Map.put(first, :covered?, true), second]
        ] do
      tampered = %{snapshot | covered_valid_beacons: evidence, hash: nil}
      tampered = %{tampered | hash: :crypto.hash(:sha256, term_bytes(tampered))}

      assert {:error, :application_snapshot_mismatch} ==
               CompactionSpike.reduce_application(BeaconReplica, tampered, retained)
    end
  end

  defp beacon_mirror_log(options) do
    label = inspect(options)

    name =
      if options[:unsupported],
        do: "replica:treehouse:space:beacon-mirror#authority:future-v1",
        else: "replica:application-beacon-mirror"

    {sim, _genesis} =
      BeaconReplica
      |> Sim.new(name, ["root", "peer"], seed: "mirror-beacons-#{label}")
      |> Sim.create_replica("root")

    root = Sim.identity(sim, "root")
    peer = Sim.identity(sim, "peer")
    base = Sim.log(sim, "root")
    cap = root_cap(base)

    delegation =
      Delegation.new(root, base.replica, peer.pub,
        parent_id: cap,
        ops: [:observe_beacons],
        expires_epoch: if(options[:finite], do: 0)
      )

    grant = Op.new(root, base.replica, Log.frontier(base), :authority, {:grant, delegation})
    covered = Log.append!(base, grant)
    epoch = options[:epoch] || 1

    {covered, expected, valid} =
      if options[:invalid_only] do
        {covered, [], nil}
      else
        zero = Op.new(root, base.replica, Log.frontier(covered), :authority, {:beacon, 0})
        covered = Log.append!(covered, zero)
        valid = Op.new(root, base.replica, Log.frontier(covered), :authority, {:beacon, epoch})

        {Log.append!(covered, valid),
         Enum.sort_by(
           [%{op_id: zero.id, epoch: 0}, %{op_id: valid.id, epoch: epoch}],
           & &1.op_id
         ), valid}
      end

    invalid =
      Op.new(
        peer,
        base.replica,
        Log.frontier(covered),
        :authority,
        {:beacon, 18_446_744_073_709_551_615}
      )

    covered = Log.append!(covered, invalid)
    malformed = Op.new(root, base.replica, Log.frontier(covered), :authority, {:beacon, 9, %{}})
    covered = Log.append!(covered, malformed)
    wrong_kind = Op.new(root, base.replica, Log.frontier(covered), :command, {:beacon, 9})
    covered = Log.append!(covered, wrong_kind)

    covered_probe =
      Op.new(root, base.replica, Log.frontier(covered), :command, {:observe_beacons, [expected]},
        cap: cap
      )

    covered = Log.append!(covered, covered_probe)

    covered =
      if options[:conflict] do
        mask =
          Op.new(root, base.replica, Log.frontier(covered), :command, {:mask_beacon, [valid.id]},
            cap: cap
          )

        Log.append!(covered, mask)
      else
        covered
      end

    frontier = Log.frontier(covered)

    retained =
      Op.new(peer, base.replica, frontier, :command, {:observe_beacons, [expected]},
        cap: delegation.id
      )

    log = Log.append!(covered, retained)
    assert :ok == Log.verify_authenticity(log)

    for op <- Log.topo_ops(log) do
      wire = op |> Lattice.Carrier.Wire.encode_op() |> Jason.encode!() |> Jason.decode!()
      assert {:ok, ^op} = Lattice.Carrier.Wire.decode_op(wire)
    end

    assert MapSet.subset?(
             MapSet.new(frontier),
             Lattice.Dag.all_ancestors(Log.ops(log))[retained.id]
           )

    %{
      log: log,
      frontier: frontier,
      expected: expected,
      valid: valid,
      invalid: invalid,
      retained: retained
    }
  end

  defp assert_beacon_mirror(delivered, fixture, options) do
    previous = Process.put(:application_mirror_observer, self())
    drain_messages([])

    try do
      full = Authority.analyze(BeaconReplica, delivered)
      full_trace = drain_messages([]) |> normalize_callback_trace()
      full_state = Reduce.reduce(BeaconReplica, delivered, quarantine: full.quarantine)

      assert {:ok, snapshot, retained} =
               CompactionSpike.compact_application(BeaconReplica, delivered, fixture.frontier)

      construction_trace = drain_messages([]) |> normalize_callback_trace()
      result = CompactionSpike.reduce_application(BeaconReplica, snapshot, retained)
      replay_trace = drain_messages([]) |> normalize_callback_trace()

      retained_trace =
        Enum.filter(
          replay_trace,
          &match?({:application_context, id, _, _} when id == fixture.retained.id, &1)
        )

      full_retained =
        Enum.filter(
          full_trace,
          &match?({:application_context, id, _, _} when id == fixture.retained.id, &1)
        )

      if options[:finite] && !options[:invalid_only] do
        assert full_retained == []
        assert retained_trace == []

        expected_reason =
          if options[:unsupported], do: :unsupported_authority_profile, else: :lease_expired

        assert result.reasons[fixture.retained.id] == expected_reason
      else
        assert length(full_retained) == 1
        assert retained_trace == full_retained
        [{:application_context, _, _, context}] = retained_trace
        assert context.valid_beacons == fixture.expected
      end

      assert snapshot.covered_valid_beacons == fixture.expected
      assert result.reasons == full.reasons
      assert result.quarantine == full.quarantine
      assert result.holders == full.holders
      assert result.requests == full.requests
      assert term_bytes(result.state) == term_bytes(full_state)
      assert List.last(replay_trace) == List.last(full_trace)
      if options[:conflict], do: assert(full.reasons[fixture.valid.id] == :application_conflict)

      if options[:unsupported] do
        assert full.requests == []

        assert Enum.all?(full.reasons, fn {_id, reason} ->
                 reason == :unsupported_authority_profile
               end)
      end

      {snapshot.hash, term_bytes(snapshot), result, construction_trace, replay_trace, full_trace}
    after
      if previous,
        do: Process.put(:application_mirror_observer, previous),
        else: Process.delete(:application_mirror_observer)
    end
  end

  test "signed revoked invitation mirrors application refusal across a stable cut" do
    for revoked? <- [false, true] do
      {log, frontier, admission} = invitation_log(revoked?)
      assert :ok == Log.verify_authenticity(log)
      full = Authority.analyze(Space, log)
      full_state = Reduce.reduce(Space, log, quarantine: full.quarantine)

      assert {:ok, snapshot, retained} =
               CompactionSpike.compact_application(Space, log, frontier)

      assert %{} = result = CompactionSpike.reduce_application(Space, snapshot, retained)
      assert result.reasons == full.reasons
      assert result.quarantine == full.quarantine
      assert result.holders == full.holders
      assert result.requests == full.requests
      assert term_bytes(result.state) == term_bytes(full_state)

      expected = if revoked?, do: :application_invalid_invitation, else: :honored
      assert Map.get(result.reasons, admission.id, :honored) == expected
      assert_application_matches_full(Space, log, frontier)

      if revoked? do
        assert {:ok, legacy_snapshot, legacy_retained} =
                 CompactionSpike.compact(Space, log, frontier)

        legacy = CompactionSpike.reduce_compacted(Space, legacy_snapshot, legacy_retained)
        refute legacy.reasons == full.reasons
        refute Map.has_key?(legacy.reasons, admission.id)
      end
    end
  end

  test "legacy snapshot serialization and hash retain their pre-change bytes" do
    sim =
      Thread
      |> Sim.new("replica:application-snapshot-byte-pin", ["root"],
        seed: "application-snapshot-byte-pin"
      )
      |> Sim.create_replica("root")
      |> elem(0)

    {sim, _covered} = Sim.command(sim, "root", :post, ["covered"])
    log = Sim.log(sim, "root")
    assert {:ok, snapshot, retained} = CompactionSpike.compact(Thread, log, Log.frontier(log))

    assert Log.size(retained) == 0

    assert Map.keys(snapshot) |> Enum.sort() == [
             :__struct__,
             :covered_beacon_basis,
             :covered_beacon_epoch,
             :covered_beacon_policy,
             :covered_continuation_pin,
             :covered_genesis_ids,
             :covered_heights,
             :covered_honored_succession_ids,
             :covered_intros,
             :covered_revokes,
             :covered_succession_ids,
             :crdts,
             :delegations,
             :frontier,
             :frozen_holders,
             :frozen_reasons,
             :frozen_requests,
             :hash,
             :policies,
             :replica,
             :roles,
             :root
           ]

    assert Base.encode16(snapshot.hash, case: :lower) ==
             "a891a2379c5a49542264b34d745d0a242d46630f2dc1da42feb4fe13192dd72e"

    assert snapshot
           |> term_bytes()
           |> then(&:crypto.hash(:sha256, &1))
           |> Base.encode16(case: :lower) ==
             "8f8ce0f4403c2e8fd1ca6a157a2074271b3f78a3ab7aff0ca601a5cbc2941532"

    assert {:ok, application, application_retained} =
             CompactionSpike.compact_application(Thread, log, Log.frontier(log))

    assert Log.size(application_retained) == 0
    assert application.version == 1
    assert application.authority_profile == :covered_authority_v1

    assert Map.keys(application) |> Enum.sort() == [
             :__struct__,
             :authority_profile,
             :base_snapshot,
             :covered_conflict_losers,
             :covered_final_reasons,
             :covered_individual_reasons,
             :covered_ops,
             :covered_valid_beacons,
             :frontier,
             :hash,
             :replica,
             :version
           ]

    assert Base.encode16(application.hash, case: :lower) ==
             "20326e940f8085d8a0651973582c91d459d473eb5576102382287eb4125939c6"

    assert application
           |> term_bytes()
           |> then(&:crypto.hash(:sha256, &1))
           |> Base.encode16(case: :lower) ==
             "d4f85c7b1aa58d0303c3dc44c8145246c0b1fb8e1cc19f3871cfd12d40f20be6"
  end

  test "combined winner capture re-honors a covered loser through full raw replay" do
    {covered_log, full_log, frontier, covered_claims, retained_claim} = winner_capture_log()
    covered_analysis = Authority.analyze(PolicyReplica, covered_log)
    full_analysis = Authority.analyze(PolicyReplica, full_log)
    [_winner, covered_loser] = Enum.sort(covered_claims)

    assert covered_analysis.reasons[covered_loser] == :application_conflict
    refute Map.has_key?(full_analysis.reasons, covered_loser)
    assert retained_claim.id < Enum.min(covered_claims)

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(PolicyReplica, full_log, frontier)

    assert snapshot.covered_conflict_losers == %{covered_loser => :application_conflict}
    refute Map.has_key?(snapshot.covered_individual_reasons, covered_loser)

    result = CompactionSpike.reduce_application(PolicyReplica, snapshot, retained)
    full_state = Reduce.reduce(PolicyReplica, full_log, quarantine: full_analysis.quarantine)

    assert result.reasons == full_analysis.reasons
    assert term_bytes(result.state) == term_bytes(full_state)
    assert length(result.state.events) == 3

    legacy = CompactionSpike.reduce_compacted(PolicyReplica, snapshot.base_snapshot, retained)
    refute term_bytes(legacy.state) == term_bytes(full_state)
    assert_application_matches_full(PolicyReplica, full_log, frontier)
  end

  test "retained application context uses individual rather than covered conflict verdicts" do
    {_covered_log, full_log, frontier, covered_claims, retained_claim} = winner_capture_log()
    [_covered_winner, covered_loser] = Enum.sort(covered_claims)
    identity = test_identity(full_log)

    reference =
      Op.new(
        identity,
        full_log.replica,
        [retained_claim.id],
        :command,
        {:reference, [covered_loser]},
        cap: root_cap(full_log)
      )

    full_log = Log.append!(full_log, reference)
    full = Authority.analyze(PolicyReplica, full_log)
    assert full.reasons[reference.id] == :application_wrong_target

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(PolicyReplica, full_log, frontier)

    Process.put(:application_mirror_observer, self())
    on_exit(fn -> Process.delete(:application_mirror_observer) end)
    result = CompactionSpike.reduce_application(PolicyReplica, snapshot, retained)
    reference_id = reference.id

    assert result.reasons == full.reasons

    assert_received {:application_context, ^reference_id, visible_ids,
                     %{visible_ops: visible_ops, verdicts: verdicts}}

    assert MapSet.member?(visible_ids, covered_loser)
    assert visible_ops[covered_loser].id == covered_loser
    assert verdicts[covered_loser] == :honored
    assert snapshot.covered_final_reasons[covered_loser] == :application_conflict
    assert_application_matches_full(PolicyReplica, full_log, frontier)
  end

  test "covered conflict audit exactly reconstructs each captured individual context" do
    {covered_log, _full_log, frontier, _covered_claims, _retained_claim} = winner_capture_log()
    Process.put(:application_mirror_observer, self())
    on_exit(fn -> Process.delete(:application_mirror_observer) end)

    assert {:ok, snapshot, _retained} =
             CompactionSpike.compact_application(PolicyReplica, covered_log, frontier)

    contexts = drain_contexts([]) |> Enum.uniq()
    ancestors = Lattice.Dag.all_ancestors(snapshot.covered_ops)

    assert contexts != []

    for {op_id, visible_ids, %{visible_ops: visible_ops, verdicts: verdicts}} <- contexts do
      expected_ids = Map.fetch!(ancestors, op_id)

      assert visible_ids == expected_ids
      assert visible_ops == Map.take(snapshot.covered_ops, MapSet.to_list(expected_ids))

      assert verdicts ==
               Map.new(expected_ids, fn id ->
                 {id, Map.get(snapshot.covered_individual_reasons, id, :honored)}
               end)
    end

    assert Map.merge(snapshot.covered_individual_reasons, snapshot.covered_conflict_losers) ==
             snapshot.covered_final_reasons

    assert_application_matches_full(PolicyReplica, covered_log, frontier)
  end

  test "covered retained refused and concurrent targets expose exact causal contexts" do
    {sim, _genesis} = founded_policy("causal-contexts")
    {sim, covered_source} = Sim.command(sim, "root", :source, ["covered"])
    {sim, covered_denied} = Sim.command(sim, "root", :deny, ["covered-denied"])
    frontier = Log.frontier(Sim.log(sim, "root"))
    {sim, covered_reference} = Sim.command(sim, "root", :reference, [covered_source.id])
    {sim, refused_reference} = Sim.command(sim, "root", :reference, [covered_denied.id])
    {sim, retained_source} = Sim.command(sim, "root", :source, ["retained"])
    {sim, retained_reference} = Sim.command(sim, "root", :reference, [retained_source.id])
    log = Sim.log(sim, "root")
    full = Authority.analyze(PolicyReplica, log)

    refute Map.has_key?(full.reasons, covered_reference.id)
    assert full.reasons[refused_reference.id] == :application_target_quarantined
    refute Map.has_key?(full.reasons, retained_reference.id)

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(PolicyReplica, log, frontier)

    Process.put(:application_mirror_observer, self())
    on_exit(fn -> Process.delete(:application_mirror_observer) end)
    result = CompactionSpike.reduce_application(PolicyReplica, snapshot, retained)
    contexts = drain_messages([]) |> context_map()

    assert result.reasons == full.reasons
    assert contexts[covered_reference.id].verdicts[covered_source.id] == :honored
    assert contexts[covered_reference.id].visible_ops[covered_source.id] == covered_source
    assert contexts[refused_reference.id].verdicts[covered_denied.id] == :application_denied
    assert contexts[retained_reference.id].verdicts[retained_source.id] == :honored
    assert_application_matches_full(PolicyReplica, log, frontier)

    for order <- [:target_before, :target_after] do
      {concurrent_log, concurrent_frontier, concurrent_source, concurrent_reference} =
        concurrent_target_log(order)

      if order == :target_before,
        do: assert(concurrent_source.id < concurrent_reference.id),
        else: assert(concurrent_source.id > concurrent_reference.id)

      assert Authority.analyze(PolicyReplica, concurrent_log).reasons[concurrent_reference.id] ==
               :application_target_not_visible

      assert_application_matches_full(PolicyReplica, concurrent_log, concurrent_frontier)
    end
  end

  test "every retained authority and tombstone ID is refused in sorted order" do
    {sim, _genesis} = founded_policy("outside-profile")
    frontier = Log.frontier(Sim.log(sim, "root"))
    {sim, authority} = Sim.append(sim, "root", :authority, {:heartbeat, :owner, 1})
    {sim, tombstone} = Sim.append(sim, "root", :tombstone, {:delete, "anything"})
    log = Sim.log(sim, "root")

    expected = Enum.sort([authority.id, tombstone.id])

    for delivered <- delivery_sequences(log) do
      assert {:ok, snapshot, retained} =
               CompactionSpike.compact_application(PolicyReplica, delivered, frontier)

      assert {:error, {:application_authority_rebinding_outside_profile, ^expected}} =
               CompactionSpike.reduce_application(PolicyReplica, snapshot, retained)
    end
  end

  test "command and inbox revoke-shaped bodies remain inside profile and affect later caps" do
    for kind <- [:command, :inbox] do
      {sim, genesis} = founded_policy("revoke-shape-#{kind}")
      frontier = Log.frontier(Sim.log(sim, "root"))
      %Lattice.Authority.Delegation{id: cap_id} = elem(genesis.body, 1)
      {sim, revoke} = Sim.append(sim, "root", kind, {:revoke, cap_id})
      {sim, later} = Sim.command(sim, "root", :source, ["later"])
      log = Sim.log(sim, "root")
      full = Authority.analyze(PolicyReplica, log)

      assert full.reasons[later.id] == :revoked_capability

      assert Map.get(full.reasons, revoke.id, :honored) ==
               if(kind == :command, do: :malformed_command, else: :honored)

      assert_application_matches_full(PolicyReplica, log, frontier)
    end
  end

  test "parent, covered revoke-target, and root introductions are named refused examples" do
    {parent_sim, _genesis} = founded_policy("parent-introduction")
    parent_frontier = Log.frontier(Sim.log(parent_sim, "root"))
    {parent_sim, parent_delegation} = Sim.grant(parent_sim, "root", "root", ops: [:source])
    parent_log = Sim.log(parent_sim, "root")

    parent_intro_id =
      parent_log
      |> Log.topo_ops()
      |> Enum.find_value(fn
        %Op{id: id, body: {:grant, %{id: delegation_id}}}
        when delegation_id == parent_delegation.id ->
          id

        _other ->
          nil
      end)

    assert_single_outside_profile(
      PolicyReplica,
      parent_log,
      parent_frontier,
      parent_intro_id
    )

    {target_sim, _genesis} = founded_policy("covered-revoke-target")
    {_unused, delegation} = Sim.grant(target_sim, "root", "root", ops: [:source])

    {target_sim, _covered_revoke} =
      Sim.append(target_sim, "root", :command, {:revoke, delegation.id})

    target_frontier = Log.frontier(Sim.log(target_sim, "root"))

    {target_sim, target_intro} =
      Sim.append(target_sim, "root", :authority, {:grant, delegation})

    assert_single_outside_profile(
      PolicyReplica,
      Sim.log(target_sim, "root"),
      target_frontier,
      target_intro.id
    )

    {root_sim, genesis} = founded_policy("root-introduction")
    root_frontier = Log.frontier(Sim.log(root_sim, "root"))
    {root_sim, root_intro} = Sim.append(root_sim, "root", :authority, genesis.body)

    assert_single_outside_profile(
      PolicyReplica,
      Sim.log(root_sim, "root"),
      root_frontier,
      root_intro.id
    )
  end

  test "command precedence matches shape arity effects capability and application policy" do
    {sim, _genesis} = founded_policy("precedence")
    frontier = Log.frontier(Sim.log(sim, "root"))
    {sim, malformed} = Sim.append(sim, "root", :command, :malformed)
    {sim, bad_arity} = Sim.append(sim, "root", :command, {:source, []})
    {sim, unknown} = Sim.append(sim, "root", :command, {:unknown, []})
    {sim, bad_effect} = Sim.command(sim, "root", :explode, [])
    {sim, no_cap} = Sim.command(sim, "root", :source, ["no-cap"], cap: :none)
    {sim, denied} = Sim.command(sim, "root", :deny, ["denied"])
    {sim, honored} = Sim.command(sim, "root", :source, ["honored"])
    log = Sim.log(sim, "root")
    full = Authority.analyze(PolicyReplica, log)

    assert full.reasons[malformed.id] == :malformed_command
    assert full.reasons[bad_arity.id] == :bad_command_arity
    assert full.reasons[unknown.id] == :unknown_command
    assert full.reasons[bad_effect.id] == :malformed_command
    assert full.reasons[no_cap.id] == :no_capability
    assert full.reasons[denied.id] == :application_denied
    refute Map.has_key?(full.reasons, honored.id)

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(PolicyReplica, log, frontier)

    Process.put(:application_mirror_observer, self())
    on_exit(fn -> Process.delete(:application_mirror_observer) end)
    result = CompactionSpike.reduce_application(PolicyReplica, snapshot, retained)
    assert result.reasons == full.reasons
    honored_id = honored.id
    invalid_ids = Enum.map([malformed, bad_arity, unknown, bad_effect, no_cap], & &1.id)

    assert_received {:application_context, ^honored_id, _, _}

    for invalid_id <- invalid_ids do
      refute_received {:application_context, ^invalid_id, _, _}
    end

    assert_application_matches_full(PolicyReplica, log, frontier)
  end

  test "retained capability and holder precedence matches the full engine" do
    {sim, _genesis} =
      PolicyReplica
      |> Sim.new("replica:application-mirror:cap-precedence", ["root", "peer"],
        seed: "cap-precedence"
      )
      |> Sim.create_replica("root")

    {sim, narrow} = Sim.grant(sim, "root", "peer", ops: [:claim])
    {sim, live} = Sim.grant(sim, "root", "peer", ops: [:source])
    sim = Sim.sync_all(sim)
    frontier = Log.frontier(Sim.log(sim, "root"))
    {sim, no_cap} = Sim.command(sim, "peer", :source, ["none"], cap: :none)
    {sim, wrong_audience} = Sim.command(sim, "root", :source, ["wrong audience"], cap: live.id)
    {sim, out_of_scope} = Sim.command(sim, "peer", :source, ["scope"], cap: narrow.id)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "root")
    full = Authority.analyze(PolicyReplica, log)

    assert full.reasons[no_cap.id] == :no_capability
    assert full.reasons[wrong_audience.id] == :capability_wrong_audience
    assert full.reasons[out_of_scope.id] == :operation_not_granted
    assert_application_matches_full(PolicyReplica, log, frontier)

    {thread, _genesis} =
      Thread
      |> Sim.new("replica:application-mirror:holder", ["root", "peer"], seed: "holder")
      |> Sim.create_replica("root")

    {thread, peer_cap} =
      Sim.grant(thread, "root", "peer", ops: [:lock], roles: [:moderator])

    {thread, roleless_cap} = Sim.grant(thread, "root", "peer", ops: [:lock])

    thread = Sim.sync_all(thread)
    thread_frontier = Log.frontier(Sim.log(thread, "root"))
    {thread, wrong_holder} = Sim.command(thread, "peer", :lock, [], cap: peer_cap.id)
    {thread, roleless} = Sim.command(thread, "peer", :lock, [], cap: roleless_cap.id)
    thread_log = Sim.log(thread, "peer")

    assert Authority.analyze(Thread, thread_log).reasons[wrong_holder.id] == :not_holder
    assert Authority.analyze(Thread, thread_log).reasons[roleless.id] == :role_not_granted
    assert_application_matches_full(Thread, thread_log, thread_frontier)

    {leased, _genesis} =
      PolicyReplica
      |> Sim.new("replica:application-mirror:retained-expiry", ["root", "peer"],
        seed: "retained-expiry"
      )
      |> Sim.create_replica("root")

    {leased, lease} = Sim.grant(leased, "root", "peer", ops: [:source], expires_epoch: 3)
    leased = Sim.sync_all(leased)
    {leased, _beacon} = Sim.beacon(leased, "root", 4)
    leased = Sim.sync_all(leased)
    lease_frontier = Log.frontier(Sim.log(leased, "peer"))
    {leased, expired} = Sim.command(leased, "peer", :source, ["expired"], cap: lease.id)
    lease_log = Sim.log(leased, "peer")

    assert Authority.analyze(PolicyReplica, lease_log).reasons[expired.id] == :lease_expired
    assert_application_matches_full(PolicyReplica, lease_log, lease_frontier)
  end

  test "covered beacons are exact ordered evidence and are not a callback context key" do
    {sim, _genesis} = founded_policy("beacons")
    {sim, first} = Sim.beacon(sim, "root", 2)
    {sim, second} = Sim.beacon(sim, "root", 3)
    {sim, stale} = Sim.beacon(sim, "root", 3)
    frontier = Log.frontier(Sim.log(sim, "root"))
    {sim, retained} = Sim.command(sim, "root", :source, ["after-beacons"])
    log = Sim.log(sim, "root")

    assert {:ok, snapshot, retained_log} =
             CompactionSpike.compact_application(PolicyReplica, log, frontier)

    analysis = Authority.analyze(PolicyReplica, Log.from_ops(log.replica, snapshot.covered_ops))
    assert analysis.reasons[stale.id] == :stale_beacon

    assert snapshot.covered_valid_beacons ==
             [%{op_id: first.id, epoch: 2}, %{op_id: second.id, epoch: 3}]
             |> Enum.sort_by(& &1.op_id)

    Process.put(:application_mirror_observer, self())
    on_exit(fn -> Process.delete(:application_mirror_observer) end)
    result = CompactionSpike.reduce_application(PolicyReplica, snapshot, retained_log)
    retained_id = retained.id
    assert is_map(result)
    assert_received {:application_context, ^retained_id, _, context}
    assert Map.keys(context) |> Enum.sort() == [:verdicts, :visible_ops]
    assert_application_matches_full(PolicyReplica, log, frontier)
  end

  test "covered revoked expired invisible and stale evidence survives the mirror" do
    # These verdicts are intentionally below the stable cut. Retained authority
    # is outside the profile, and stability makes every covered introduction
    # visible to every retained op.
    {sim, _genesis} =
      Thread
      |> Sim.new("replica:application-mirror:frozen-precedence", ["root", "peer"],
        seed: "frozen-precedence"
      )
      |> Sim.create_replica("root")

    {sim, expiring} = Sim.grant(sim, "root", "peer", ops: [:post], expires_epoch: 3)
    sim = Sim.sync_all(sim)
    {sim, _beacon} = Sim.beacon(sim, "root", 4)
    sim = Sim.sync_all(sim)
    {sim, expired} = Sim.command(sim, "peer", :post, ["expired"], cap: expiring.id)
    sim = Sim.sync_all(sim)
    {sim, _revoke} = Sim.revoke(sim, "root", expiring.id)
    sim = Sim.sync_all(sim)
    {sim, revoked} = Sim.command(sim, "peer", :post, ["revoked"], cap: expiring.id)
    sim = Sim.sync_all(sim)
    log = Sim.log(sim, "root")
    frontier = Log.frontier(log)
    full = Authority.analyze(Thread, log)

    assert full.reasons[expired.id] == :lease_expired
    assert full.reasons[revoked.id] == :revoked_capability
    assert_application_matches_full(Thread, log, frontier)

    {parallel, root_claim, peer_claim} = parallel_claims()
    parallel_analysis = Authority.analyze(PolicyReplica, parallel)
    loser = Enum.max([root_claim.id, peer_claim.id])
    assert parallel_analysis.reasons[loser] == :application_conflict
    assert_application_matches_full(PolicyReplica, parallel, Log.frontier(parallel))

    {holder_sim, _genesis} =
      Thread
      |> Sim.new("replica:application-mirror:stale", ["root", "peer"], seed: "stale")
      |> Sim.create_replica("root")

    holder_sim = Sim.sync_all(holder_sim)
    {stale_branch, stale_lock} = Sim.command(holder_sim, "root", :lock, [])
    {holder_sim, _transfer} = Sim.transfer(holder_sim, "root", "peer", :moderator, at_tick: 1)
    holder_sim = Sim.sync_all(holder_sim)
    {holder_sim, _peer_lock} = Sim.command(holder_sim, "peer", :lock, [])

    {stale_log, _other, _report} =
      Sync.reconcile(Sim.log(holder_sim, "root"), Sim.log(stale_branch, "root"))

    assert Authority.analyze(Thread, stale_log).reasons[stale_lock.id] == :stale_holder
    assert_application_matches_full(Thread, stale_log, Log.frontier(stale_log))

    {visibility, _genesis} =
      PolicyReplica
      |> Sim.new("replica:application-mirror:invisible", ["root", "peer"], seed: "invisible")
      |> Sim.create_replica("root")

    visibility = Sim.sync_all(visibility)
    {grant_branch, invisible_cap} = Sim.grant(visibility, "root", "peer", ops: [:source])

    {command_branch, invisible} =
      Sim.command(visibility, "peer", :source, ["invisible"], cap: invisible_cap.id)

    {invisible_log, _other, _report} =
      Sync.reconcile(Sim.log(grant_branch, "root"), Sim.log(command_branch, "peer"))

    assert Authority.analyze(PolicyReplica, invisible_log).reasons[invisible.id] ==
             :capability_not_visible

    assert_application_matches_full(PolicyReplica, invisible_log, Log.frontier(invisible_log))
  end

  test "snapshot and retained envelope tampering refuse before a semantic result" do
    {sim, _genesis} = founded_policy("tamper")
    frontier = Log.frontier(Sim.log(sim, "root"))
    {sim, _source} = Sim.command(sim, "root", :source, ["retained"])
    log = Sim.log(sim, "root")

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(PolicyReplica, log, frontier)

    assert {:error, :application_snapshot_mismatch} =
             CompactionSpike.reduce_application(
               PolicyReplica,
               %{snapshot | replica: snapshot.replica <> ":forged"} |> rehash(),
               retained
             )

    [covered_id | _] = Map.keys(snapshot.covered_ops)
    covered = snapshot.covered_ops[covered_id]

    key_mismatch =
      snapshot
      |> Map.put(:covered_ops, %{(covered_id <> ":wrong-key") => covered})
      |> rehash()

    assert {:error, :application_snapshot_mismatch} =
             CompactionSpike.reduce_application(PolicyReplica, key_mismatch, retained)

    corrupt_base =
      snapshot
      |> Map.put(:base_snapshot, %{snapshot.base_snapshot | hash: <<0::256>>})
      |> rehash()

    assert {:error, :application_snapshot_mismatch} =
             CompactionSpike.reduce_application(PolicyReplica, corrupt_base, retained)

    assert {:error, :application_retained_log_mismatch} =
             CompactionSpike.reduce_application(
               PolicyReplica,
               snapshot,
               %{retained | replica: retained.replica <> ":wrong"}
             )

    assert {:error, :application_retained_log_mismatch} =
             CompactionSpike.reduce_application(
               PolicyReplica,
               snapshot,
               %{retained | referenced: MapSet.new()}
             )

    [retained_op] = Map.values(Log.ops(retained))

    moved_snapshot =
      snapshot
      |> Map.put(:covered_ops, Map.put(snapshot.covered_ops, retained_op.id, retained_op))
      |> rehash()

    assert {:error, :application_cut_mismatch} =
             CompactionSpike.reduce_application(
               PolicyReplica,
               moved_snapshot,
               Log.new(log.replica)
             )
  end

  test "all application snapshot evidence fields and covered signatures are committed" do
    {sim, _genesis} = founded_policy("field-tamper")
    {sim, first} = Sim.command(sim, "root", :source, ["covered"])
    log = Sim.log(sim, "root")

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(PolicyReplica, log, [first.id])

    mutations = [
      %{snapshot | authority_profile: :forged_profile},
      %{snapshot | frontier: []},
      %{snapshot | covered_individual_reasons: %{first.id => :forged}},
      %{snapshot | covered_final_reasons: %{first.id => :forged}},
      %{snapshot | covered_conflict_losers: %{first.id => :forged}},
      %{snapshot | covered_valid_beacons: [%{op_id: first.id, epoch: 99}]},
      %{snapshot | hash: <<0::256>>}
    ]

    for mutation <- mutations do
      tampered = if mutation.hash == snapshot.hash, do: rehash(mutation), else: mutation

      assert {:error, _reason} =
               CompactionSpike.reduce_application(PolicyReplica, tampered, retained)
    end

    covered = snapshot.covered_ops[first.id]
    forged = %{covered | sig: flip_signature(covered.sig)}

    signed_tamper =
      snapshot
      |> Map.put(:covered_ops, Map.put(snapshot.covered_ops, first.id, forged))
      |> rehash()

    assert {:error, :application_snapshot_mismatch} =
             CompactionSpike.reduce_application(PolicyReplica, signed_tamper, retained)
  end

  test "invalid source signature missing closure overlap and unstable cut refuse" do
    {sim, _genesis} = founded_policy("source-controls")
    covered_frontier = Log.frontier(Sim.log(sim, "root"))
    {sim, first} = Sim.command(sim, "root", :source, ["first"])
    {sim, second} = Sim.command(sim, "root", :source, ["second"])
    log = Sim.log(sim, "root")

    bad_ops = Map.put(Log.ops(log), second.id, %{second | sig: flip_signature(second.sig)})
    bad_log = Log.from_ops(log.replica, bad_ops)

    assert {:error, {:application_log_invalid, _errors}} =
             CompactionSpike.compact_application(PolicyReplica, bad_log, covered_frontier)

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(PolicyReplica, log, covered_frontier)

    only_second = Log.from_ops(log.replica, %{second.id => second})

    assert {:error, {:application_log_invalid, _errors}} =
             CompactionSpike.reduce_application(PolicyReplica, snapshot, only_second)

    covered_op = snapshot.covered_ops |> Map.values() |> hd()
    overlap = Log.from_ops(log.replica, %{covered_op.id => covered_op})

    assert {:error, :application_cut_mismatch} =
             CompactionSpike.reduce_application(PolicyReplica, snapshot, overlap)

    {parallel, root_claim, peer_claim} = parallel_claims()

    assert {:error, {:unstable_frontier, unstable_id}} =
             CompactionSpike.compact_application(PolicyReplica, parallel, [root_claim.id])

    assert unstable_id == peer_claim.id
    assert Log.size(retained) == 2
    assert first.id in Map.keys(Log.ops(retained))
  end

  test "application result and callbacks match across actual append and reconcile delivery" do
    {_covered_log, full_log, frontier, _covered_claims, _retained_claim} = winner_capture_log()
    identity = test_identity(full_log)

    request =
      Op.new(
        identity,
        full_log.replica,
        Log.frontier(full_log),
        :inbox,
        {:request, "request:one", {:source, ["queued"]}}
      )

    full_log = Log.append!(full_log, request)

    assert_application_matches_full(PolicyReplica, full_log, frontier)
  end

  test "covered same-id delegation forgeries cannot poison the application authority seed" do
    for order <- [:invalid_first, :valid_first] do
      {log, frontier, command, invalid_intro} = same_id_grant_log(order)
      full = Authority.analyze(PolicyReplica, log)

      assert full.reasons[invalid_intro.id] == :bad_delegation_sig
      refute Map.has_key?(full.reasons, command.id)
      assert_application_matches_full(PolicyReplica, log, frontier)
    end

    {invalid_only, frontier, command, invalid_intro} = same_id_grant_log(:invalid_only)
    full = Authority.analyze(PolicyReplica, invalid_only)
    assert full.reasons[invalid_intro.id] == :bad_delegation_sig
    assert full.reasons[command.id] == :invalid_capability
    assert_application_matches_full(PolicyReplica, invalid_only, frontier)
  end

  test "covered same-id transfer forgery preserves the genuine holder transition" do
    {log, frontier, command, invalid_intro} = same_id_transfer_log()
    full = Authority.analyze(Thread, log)

    assert full.reasons[invalid_intro.id] == :bad_delegation_sig
    refute Map.has_key?(full.reasons, command.id)
    assert full.holders.moderator == command.author
    assert_application_matches_full(Thread, log, frontier)
  end

  test "covered same-id delegation seed authorizes cross-kind retained revokes" do
    for kind <- [:command, :inbox] do
      {log, frontier, later, invalid_intro} = same_id_revoke_log(kind)
      full = Authority.analyze(PolicyReplica, log)

      assert full.reasons[invalid_intro.id] == :bad_delegation_sig
      assert full.reasons[later.id] == :revoked_capability
      assert_application_matches_full(PolicyReplica, log, frontier)
    end
  end

  test "callback counts separate covered verification from one retained fold and one final pass" do
    {_covered_log, full_log, frontier, _covered_claims, retained_claim} = winner_capture_log()

    assert {:ok, snapshot, retained} =
             CompactionSpike.compact_application(PolicyReplica, full_log, frontier)

    Process.put(:application_mirror_observer, self())
    on_exit(fn -> Process.delete(:application_mirror_observer) end)
    result = CompactionSpike.reduce_application(PolicyReplica, snapshot, retained)
    messages = drain_messages([])

    conflict_calls = Enum.filter(messages, &match?({:application_conflicts, _, _, _}, &1))
    retained_id = retained_claim.id

    retained_status_calls =
      Enum.count(messages, fn
        {:application_context, ^retained_id, _visible, _context} -> true
        _message -> false
      end)

    assert length(conflict_calls) == 4
    assert retained_status_calls == 1

    assert {:application_conflicts, combined_ops, verdicts, ancestors} =
             List.last(conflict_calls)

    assert combined_ops == Log.ops(full_log)
    assert Enum.sort(Map.keys(verdicts)) == Enum.sort(Map.keys(combined_ops))
    assert Enum.sort(Map.keys(ancestors)) == Enum.sort(Map.keys(combined_ops))
    assert result.reasons == Authority.analyze(PolicyReplica, full_log).reasons
    assert_application_matches_full(PolicyReplica, full_log, frontier)
  end

  test "source guard excludes full combined authority analysis from the reducer" do
    source = File.read!(Path.expand("../support/compaction_spike.ex", __DIR__))
    [reducer | _] = source |> String.split("defp reduce_verified_application", parts: 2) |> tl()
    reducer = reducer |> String.split("defp validate_application_commands", parts: 2) |> hd()

    refute reducer =~ "Authority.analyze"
    refute reducer =~ "Lattice.Authority.analyze"
    assert reducer =~ "Reduce.reduce(module, combined_log"
    refute reducer =~ "materialize_compacted"
  end

  defp invitation_log(revoked?) do
    sim =
      Space
      |> Sim.new("treehouse:compaction:ordinary", ["root", "member"],
        seed: "r19b-compaction-proof"
      )
      |> Sim.create_replica("root",
        ops: [
          :create_space,
          :create_thread,
          :issue_invitation,
          :revoke_invitation,
          :admit_member,
          :remove_member
        ]
      )
      |> elem(0)

    {sim, _} = Sim.command(sim, "root", :create_space, ["Canopy"])
    {sim, _} = Sim.command(sim, "root", :create_thread, ["treehouse:thread:one", "One"])
    recipient = Base.encode64(Sim.identity(sim, "member").pub)

    {sim, invitation} =
      Sim.command(sim, "root", :issue_invitation, [recipient, ["treehouse:thread:one"]])

    acceptance = Invitation.accept(Sim.identity(sim, "member"), Sim.replica(sim), invitation)

    sim =
      if revoked? do
        Sim.command(sim, "root", :revoke_invitation, [invitation.id]) |> elem(0)
      else
        sim
      end

    frontier = Log.frontier(Sim.log(sim, "root"))

    {sim, admission} =
      Sim.command(sim, "root", :admit_member, [
        invitation.id,
        recipient,
        "member",
        acceptance
      ])

    {Sim.log(sim, "root"), frontier, admission}
  end

  defp winner_capture_log do
    {base, genesis} =
      PolicyReplica
      |> Sim.new("replica:application-winner-capture", ["root"],
        seed: "application-winner-capture"
      )
      |> Sim.create_replica("root")

    {left, left_claim} = Sim.command(base, "root", :claim, ["seat", "left"])
    {right, right_claim} = Sim.command(base, "root", :claim, ["seat", "right"])

    {covered_log, _other_log, _report} =
      Sync.reconcile(Sim.log(left, "root"), Sim.log(right, "root"))

    frontier = Enum.sort([left_claim.id, right_claim.id])
    %Lattice.Authority.Delegation{id: cap_id} = elem(genesis.body, 1)

    retained_claim =
      0..1024
      |> Enum.find_value(fn suffix ->
        op =
          Op.new(
            Sim.identity(base, "root"),
            Sim.replica(base),
            frontier,
            :command,
            {:claim, ["seat", "retained-#{suffix}"]},
            cap: cap_id
          )

        if op.id < Enum.min(frontier), do: op
      end)

    assert %Op{} = retained_claim

    full_log = Log.append!(covered_log, retained_claim)
    assert :ok == Log.verify_authenticity(full_log)

    {covered_log, full_log, frontier, frontier, retained_claim}
  end

  defp founded_policy(suffix) do
    PolicyReplica
    |> Sim.new("replica:application-mirror:#{suffix}", ["root"], seed: suffix)
    |> Sim.create_replica("root")
  end

  defp parallel_claims do
    {sim, _genesis} =
      PolicyReplica
      |> Sim.new("replica:application-mirror:unstable", ["root", "peer"], seed: "unstable")
      |> Sim.create_replica("root")

    {sim, _delegation} = Sim.grant(sim, "root", "peer", ops: [:claim])
    sim = sim |> Sim.sync_all() |> Sim.partition("root", "peer")
    {sim, root_claim} = Sim.command(sim, "root", :claim, ["key", "root"])
    {sim, peer_claim} = Sim.command(sim, "peer", :claim, ["key", "peer"])
    sim = sim |> Sim.heal("root", "peer") |> Sim.sync_all()
    {Sim.log(sim, "root"), root_claim, peer_claim}
  end

  defp concurrent_target_log(order) do
    {base, _genesis} = founded_policy("concurrent-context-#{order}")
    log = Sim.log(base, "root")
    frontier = Log.frontier(log)
    identity = Sim.identity(base, "root")
    cap = root_cap(log)

    {source, reference} =
      Enum.find_value(0..1024, fn suffix ->
        source =
          Op.new(
            identity,
            log.replica,
            frontier,
            :command,
            {:source, ["concurrent-#{suffix}"]},
            cap: cap
          )

        reference =
          Op.new(
            identity,
            log.replica,
            frontier,
            :command,
            {:reference, [source.id]},
            cap: cap
          )

        matches? =
          case order do
            :target_before -> source.id < reference.id
            :target_after -> source.id > reference.id
          end

        if matches?, do: {source, reference}
      end)

    ops = log |> Log.ops() |> Map.put(source.id, source) |> Map.put(reference.id, reference)
    concurrent_log = Log.from_ops(log.replica, ops)
    assert :ok == Log.verify_authenticity(concurrent_log)
    {concurrent_log, frontier, source, reference}
  end

  defp same_id_grant_log(order) do
    {sim, _genesis} =
      PolicyReplica
      |> Sim.new("replica:application-mirror:same-id-grant-#{order}", ["root", "peer"],
        seed: "same-id-grant-#{order}"
      )
      |> Sim.create_replica("root")

    base = Sim.log(sim, "root")
    identity = Sim.identity(sim, "root")

    delegation =
      Delegation.new(identity, base.replica, Sim.identity(sim, "peer").pub,
        ops: [:source],
        parent_id: root_cap(base)
      )

    {valid_intro, invalid_intro} =
      same_id_introductions(identity, base, delegation, &{:grant, &1}, order)

    intro_ops =
      if order == :invalid_only,
        do: [invalid_intro],
        else: [valid_intro, invalid_intro]

    covered = append_ops(base, intro_ops)
    frontier = Log.frontier(covered)

    command =
      Op.new(
        Sim.identity(sim, "peer"),
        base.replica,
        frontier,
        :command,
        {:source, ["same-id"]},
        cap: delegation.id
      )

    {Log.append!(covered, command), frontier, command, invalid_intro}
  end

  defp same_id_transfer_log do
    {sim, _genesis} =
      Thread
      |> Sim.new("replica:application-mirror:same-id-transfer", ["root", "peer"],
        seed: "same-id-transfer"
      )
      |> Sim.create_replica("root")

    base = Sim.log(sim, "root")
    identity = Sim.identity(sim, "root")

    delegation =
      Delegation.new(identity, base.replica, Sim.identity(sim, "peer").pub,
        ops: [:lock],
        roles: [:moderator],
        parent_id: root_cap(base)
      )

    {valid_intro, invalid_intro} =
      same_id_introductions(
        identity,
        base,
        delegation,
        &{:transfer, :moderator, &1, 1},
        :invalid_first
      )

    covered = append_ops(base, [valid_intro, invalid_intro])
    frontier = Log.frontier(covered)

    command =
      Op.new(
        Sim.identity(sim, "peer"),
        base.replica,
        frontier,
        :command,
        {:lock, []},
        cap: delegation.id
      )

    {Log.append!(covered, command), frontier, command, invalid_intro}
  end

  defp same_id_revoke_log(kind) do
    {log, frontier, first, invalid_intro} = same_id_grant_log(:invalid_first)
    covered = Log.from_ops(log.replica, Map.drop(Log.ops(log), [first.id]))
    root = Lattice.Identity.from_seed("root", "same-id-grant-invalid_first:root")
    peer = Lattice.Identity.from_seed("peer", "same-id-grant-invalid_first:peer")
    delegation_id = first.cap

    revoke = Op.new(root, log.replica, frontier, kind, {:revoke, delegation_id})
    with_revoke = Log.append!(covered, revoke)

    later =
      Op.new(
        peer,
        log.replica,
        [revoke.id],
        :command,
        {:source, ["after-revoke"]},
        cap: delegation_id
      )

    {Log.append!(with_revoke, later), frontier, later, invalid_intro}
  end

  defp same_id_introductions(identity, base, delegation, body, order) do
    valid = Op.new(identity, base.replica, Log.frontier(base), :authority, body.(delegation))

    invalid =
      Enum.find_value(0..255, fn byte ->
        <<_first, rest::binary>> = delegation.sig
        forged = %{delegation | sig: <<byte, rest::binary>>}

        if not Delegation.valid_sig?(forged) do
          candidate =
            Op.new(identity, base.replica, Log.frontier(base), :authority, body.(forged))

          matches? =
            case order do
              :valid_first -> valid.id < candidate.id
              _ -> candidate.id < valid.id
            end

          if matches?, do: candidate
        end
      end)

    assert %Op{} = invalid
    {valid, invalid}
  end

  defp append_ops(log, ops) do
    Enum.reduce(Enum.sort_by(ops, & &1.id), log, fn op, acc -> Log.append!(acc, op) end)
  end

  defp assert_application_matches_full(module, log, frontier) do
    assert :ok == Log.verify_authenticity(log)
    full = Authority.analyze(module, log)
    state = Reduce.reduce(module, log, quarantine: full.quarantine)

    outcomes =
      for delivered <- delivery_sequences(log) do
        drain_messages([])
        previous_observer = Process.put(:application_mirror_observer, self())

        try do
          assert {:ok, snapshot, retained} =
                   CompactionSpike.compact_application(module, delivered, frontier)

          result = CompactionSpike.reduce_application(module, snapshot, retained)
          trace = drain_messages([]) |> normalize_callback_trace()
          assert result.reasons == full.reasons
          assert result.quarantine == full.quarantine
          assert result.holders == full.holders
          assert result.requests == full.requests
          assert term_bytes(result.state) == term_bytes(state)
          {result, trace}
        after
          if previous_observer,
            do: Process.put(:application_mirror_observer, previous_observer),
            else: Process.delete(:application_mirror_observer)
        end
      end

    [{first_result, first_trace}, {second_result, second_trace}] = outcomes
    assert term_bytes(first_result) == term_bytes(second_result)
    assert first_trace == second_trace
    first_result
  end

  defp assert_single_outside_profile(module, log, frontier, op_id) do
    assert :ok == Log.verify_authenticity(log)

    for delivered <- delivery_sequences(log) do
      assert {:ok, snapshot, retained} =
               CompactionSpike.compact_application(module, delivered, frontier)

      assert {:error, {:application_authority_rebinding_outside_profile, [^op_id]}} =
               CompactionSpike.reduce_application(module, snapshot, retained)
    end
  end

  defp delivery_sequences(log) do
    ops = Log.ops(log)
    ordered = Lattice.Dag.topo_sort(ops)
    appended = Enum.reduce(ordered, Log.new(log.replica), &Log.append!(&2, &1))

    reconciled =
      Enum.reduce(Enum.reverse(ordered), Log.new(log.replica), fn op, delivered ->
        closure_ids = Lattice.Dag.reachable(ops, [op.id])
        source = Log.from_ops(log.replica, Map.take(ops, MapSet.to_list(closure_ids)))
        {merged, _source, _report} = Sync.reconcile(delivered, source)
        merged
      end)

    assert Log.ops(appended) == ops
    assert Log.ops(reconciled) == ops
    [appended, reconciled]
  end

  defp normalize_callback_trace(messages) do
    Enum.map(messages, fn
      {:application_context, op_id, visible_ids, context} ->
        {:application_context, op_id, Enum.sort(visible_ids), normalize_context(context)}

      {:application_conflicts, ops, verdicts, ancestors} ->
        {:application_conflicts, sort_map(ops), sort_map(verdicts),
         normalize_ancestors(ancestors)}

      message ->
        message
    end)
  end

  defp normalize_context(%{visible_ops: visible_ops, verdicts: verdicts} = context),
    do: %{context | visible_ops: sort_map(visible_ops), verdicts: sort_map(verdicts)}

  defp normalize_context(context), do: context

  defp normalize_ancestors(ancestors) do
    ancestors
    |> Enum.map(fn {id, ids} -> {id, Enum.sort(ids)} end)
    |> Enum.sort()
  end

  defp sort_map(map), do: Enum.sort(map)

  defp root_cap(log) do
    log
    |> Log.topo_ops()
    |> Enum.find_value(fn
      %Op{body: {:genesis, %Lattice.Authority.Delegation{id: id}, _}} -> id
      _other -> nil
    end)
  end

  defp test_identity(log) do
    author = log |> Log.topo_ops() |> hd() |> Map.fetch!(:author)

    # The deterministic simulator key is recovered by rebuilding its fixture;
    # callers use this only for the fixed winner-capture log.
    {sim, _genesis} =
      PolicyReplica
      |> Sim.new("replica:application-winner-capture", ["root"],
        seed: "application-winner-capture"
      )
      |> Sim.create_replica("root")

    identity = Sim.identity(sim, "root")
    assert identity.pub == author
    identity
  end

  defp rehash(snapshot) do
    hash = :crypto.hash(:sha256, term_bytes(%{snapshot | hash: nil}))
    %{snapshot | hash: hash}
  end

  defp flip_signature(<<first, rest::binary>>), do: <<Bitwise.bxor(first, 1), rest::binary>>

  defp drain_contexts(contexts) do
    receive do
      {:application_context, op_id, visible, context} ->
        drain_contexts([{op_id, visible, context} | contexts])

      _other ->
        drain_contexts(contexts)
    after
      0 -> Enum.reverse(contexts)
    end
  end

  defp drain_messages(messages) do
    receive do
      message -> drain_messages([message | messages])
    after
      0 -> Enum.reverse(messages)
    end
  end

  defp context_map(messages) do
    Map.new(messages, fn
      {:application_context, op_id, _visible, context} -> {op_id, context}
      _message -> {nil, nil}
    end)
    |> Map.delete(nil)
  end

  defp term_bytes(term),
    do: :erlang.term_to_binary(term, [:deterministic, {:minor_version, 2}])
end
