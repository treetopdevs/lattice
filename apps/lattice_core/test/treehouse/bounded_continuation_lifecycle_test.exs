defmodule Treehouse.BoundedContinuationLifecycleTest do
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Log, Sim}
  alias Lattice.Authority.Delegation
  alias Treehouse.ContinuationFixtures, as: F

  test "V07 thirteen independent replicas survive two renewals without any founder record" do
    counters =
      Enum.reduce(0..12, %{beacons: 0, continuations: 0, grants: 0, signatures: 0}, fn index,
                                                                                       counts ->
        kind = if index == 0, do: :space, else: :thread
        fixture = F.two_cycles(kind: kind, label: "fanout-#{index}")
        sim = fixture.sim

        assert Enum.sort(Map.keys(Map.from_struct(sim))) == [
                 :caps,
                 :logs,
                 :module,
                 :net,
                 :realms,
                 :replica
               ]

        for collection <- [sim.realms, sim.logs, sim.caps],
            do: refute(Map.has_key?(collection, "founder"))

        [old, intermediate, current] = fixture.generations

        for {grants, expected} <- [
              {old, :lease_expired},
              {intermediate, :lease_expired},
              {current, nil}
            ],
            {d, i} <- Enum.with_index(grants, 1) do
          {branch, command} = Sim.command(sim, "member#{i}", :post, ["epoch fourteen"], cap: d.id)

          assert Sim.quarantined(branch, "member#{i}", command.id) ==
                   if(expected, do: {true, expected}, else: false)
        end

        {:succeed, _, parent, _} = List.last(fixture.acquisitions).body
        assert parent.parent_id == nil
        assert parent.expires_epoch == 16
        assert Enum.all?(current, &(&1.parent_id == parent.id))

        assert Authority.holder_epoch(sim.module, Sim.log(sim, "holder"), F.role(sim)).op_id ==
                 List.last(fixture.acquisitions).id

        # Post-bootstrap operational counters only: exclude E0, preview/enrollment,
        # initial transfer/grants, and the separate command validation branches.
        counts =
          Sim.log(sim, "holder")
          |> Log.topo_ops()
          |> Enum.reject(&MapSet.member?(fixture.bootstrap_ids, &1.id))
          |> Enum.reduce(counts, fn op, acc ->
            case op.body do
              {:beacon, _, certificate} ->
                %{
                  acc
                  | beacons: acc.beacons + 1,
                    signatures: acc.signatures + 1 + length(certificate.signatures)
                }

              {:succeed, _, _, {:continuation_v1, certificate}} ->
                %{
                  acc
                  | continuations: acc.continuations + 1,
                    signatures: acc.signatures + 2 + length(certificate.signatures)
                }

              {:grant, _} ->
                %{acc | grants: acc.grants + 1, signatures: acc.signatures + 2}
            end
          end)

        assert length(fixture.acquisitions) == 2
        counts
      end)

    assert counters == %{beacons: 182, continuations: 26, grants: 312, signatures: 1274}
    assert counters.beacons + counters.continuations + counters.grants == 520
    # Independent native purposes; these are operation counts, not measured prompts.
    assert 182 * 2 + 26 * 2 + 182 == 598
  end

  test "V08 surviving Space authority permits a new independent child, enrollment and moderator continuation" do
    fixture = F.two_cycles(label: "space-new-child")
    sim = fixture.sim
    {child, genesis} = F.new(kind: :thread, label: "child-after-two-cycles", creator: "observer")
    {:genesis, child_root, _} = genesis.body
    refute child_root.issuer == fixture.genesis.author
    {:succeed, _, space_authority, _} = List.last(fixture.acquisitions).body
    {sim, linked} = Sim.command(sim, "holder", :manage, [child.replica], cap: space_authority.id)
    assert Sim.quarantined(sim, "holder", linked.id) == false

    for collection <- [sim.realms, sim.logs, sim.caps],
        do: refute(Map.has_key?(collection, "founder"))

    {enrollments, child} =
      Enum.map_reduce(1..12, child, fn n, s ->
        realm = "member#{n}"
        {s, op} = Sim.append(s, realm, :inbox, {:enrollment, Sim.identity(s, realm).pub})
        {op, s}
      end)

    child = Sim.sync_all(child)
    {child, pin, _profile} = F.pin(child, author: "observer")
    enrolled_ids = Lattice.Dag.reachable(Log.ops(Sim.log(child, "observer")), pin.deps)
    assert Enum.all?(enrollments, &MapSet.member?(enrolled_ids, &1.id))
    {child, _} = Sim.beacon(child, "observer", 0)
    child = Sim.sync_all(child)

    {child, continuation} =
      Sim.continue_role(child, "nominee", :moderator,
        ops: [:manage, :post],
        expires_epoch: 6,
        witnesses: ["w1", "w2"]
      )

    assert Sim.quarantined(child, "nominee", continuation.id) == false
    child = Sim.sync_all(child)
    {child, grant} = Sim.grant(child, "nominee", "member1", ops: [:post], expires_epoch: 6)
    child = Sim.sync_all(child)
    {child, post} = Sim.command(child, "member1", :post, ["new child"], cap: grant.id)
    assert Sim.quarantined(child, "member1", post.id) == false
    {child, cross_replica} = Sim.append(child, "holder", :authority, {:grant, space_authority})
    assert Sim.quarantined(child, "holder", cross_replica.id) == {true, :wrong_replica}

    {child, wrong_cap} =
      Sim.command(child, "holder", :post, ["Space cap cannot cross"], cap: space_authority.id)

    assert Sim.quarantined(child, "holder", wrong_cap.id) != false
    {unready, _} = F.new(kind: :thread, label: "unpinned-child", creator: "observer")

    assert {:error, :continuation_not_configured} =
             Sim.continue_role(unready, "nominee", :moderator,
               ops: [:post],
               expires_epoch: 6,
               witnesses: ["w1", "w2"]
             )
  end

  test "V07 surviving issuer can admit and revoke a new finite member; membership alone does not revoke" do
    fixture = F.two_cycles(label: "space-new-member")
    sim = fixture.sim
    {sim, admit} = Sim.command(sim, "holder", :admit, ["observer"])
    {sim, grant} = Sim.grant(sim, "holder", "observer", ops: [:post], expires_epoch: 16)
    sim = Sim.sync_all(sim)
    assert Sim.quarantined(sim, "holder", admit.id) == false
    {sim, remove} = Sim.command(sim, "holder", :remove_member, ["observer"])
    sim = Sim.sync_all(sim)

    {sim, still_capable} =
      Sim.command(sim, "observer", :post, ["roster does not change Core capability"],
        cap: grant.id
      )

    assert Sim.quarantined(sim, "observer", still_capable.id) == false
    assert Sim.quarantined(sim, "holder", remove.id) == false
    {sim, revoke} = Sim.revoke(sim, "holder", grant.id)
    sim = Sim.sync_all(sim)
    {sim, refused} = Sim.command(sim, "observer", :post, ["revoked"], cap: grant.id)
    assert Sim.quarantined(sim, "holder", revoke.id) == false
    assert Sim.quarantined(sim, "observer", refused.id) == {true, :revoked_capability}
    assert %Delegation{expires_epoch: 16} = grant
  end
end
