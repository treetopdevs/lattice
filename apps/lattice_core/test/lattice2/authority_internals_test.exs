defmodule Lattice2.AuthorityInternalsTest do
  use ExUnit.Case, async: true

  alias Lattice.Authority
  alias Lattice.Authority.{CommandVerdict, DelegationIndex, RoleTimeline}
  alias Lattice.{Dag, Log, Sim}
  alias Lattice.Demo.Thread

  @replica "replica:thread:authority-internals"

  test "delegation index owns chain admission, root resolution, and revocation" do
    {sim, _genesis} = base() |> Sim.create_replica("server")
    {sim, grant} = Sim.grant(sim, "server", "tab", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, _revoke} = Sim.revoke(sim, "server", grant.id)
    log = Sim.log(Sim.sync_all(sim), "server")

    {_ordered, _ancestors, index, _timelines} = internals(log)

    assert index.root == Sim.identity(sim, "server").pub
    assert DelegationIndex.active?(index, grant.id)
    assert DelegationIndex.revoked?(index, grant.id)
    assert index.entries[grant.id].op_ids != []
  end

  test "role timeline owns holder progression" do
    {sim, _genesis} = base() |> Sim.create_replica("server")
    sim = Sim.sync_all(sim)
    {sim, _transfer} = Sim.transfer(sim, "server", "tab", :moderator, at_tick: 1)
    log = Sim.log(Sim.sync_all(sim), "server")

    {_ordered, _ancestors, _index, timelines} = internals(log)

    assert MapSet.member?(RoleTimeline.roles(Thread), :moderator)
    assert timelines.moderator.holder == Sim.identity(sim, "tab").pub
    assert Enum.count(timelines.moderator.acquires) == 2
  end

  test "command verdict owns capability errors and inbox requests" do
    {sim, _genesis} = base() |> Sim.create_replica("server")
    {sim, grant} = Sim.grant(sim, "server", "tab", ops: [:post])
    sim = Sim.sync_all(sim)
    {sim, valid_post} = Sim.command(sim, "tab", :post, ["allowed"], cap: grant.id)
    {sim, denied_post} = Sim.command(sim, "phone", :post, ["denied"], cap: :none)
    {sim, request} = Sim.request(sim, "tab", "request-1", {:lock, []})
    log = Sim.log(Sim.sync_all(sim), "server")

    {ordered, ancestors, index, timelines} = internals(log)

    {reasons, audit, requests} =
      CommandVerdict.validate(Thread, ordered, ancestors, index, timelines)

    refute Map.has_key?(reasons, valid_post.id)
    assert reasons[denied_post.id] == :no_capability
    assert Enum.any?(audit, &(&1.op == denied_post.id and &1.reason == :no_capability))
    assert [%{op: request_id, ref: "request-1", payload: {:lock, []}}] = requests
    assert request_id == request.id

    analysis = Authority.analyze(Thread, log)
    assert analysis.reasons[denied_post.id] == reasons[denied_post.id]
    assert analysis.requests == requests
  end

  defp base do
    Sim.new(Thread, @replica, ["server", "tab", "phone"], seed: "authority-internals")
  end

  defp internals(log) do
    ops = Log.ops(log)
    ordered = Dag.topo_sort(ops)
    ancestors = Dag.all_ancestors(ops)
    index = DelegationIndex.build(ordered, Authority.replica_commitment(log.replica))

    timelines =
      Thread
      |> RoleTimeline.roles()
      |> Map.new(fn role ->
        {role, RoleTimeline.build(role, ordered, ancestors, index)}
      end)

    {ordered, ancestors, index, timelines}
  end
end
