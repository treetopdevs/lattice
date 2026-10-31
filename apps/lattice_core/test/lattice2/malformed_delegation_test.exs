defmodule Lattice2.MalformedDelegationTest do
  @moduledoc """
  Row 289: a correctly signed delegation whose `ops` or `roles` is a list, not a
  `MapSet`, must fail `Delegation.valid_sig?/1` and be judged `:bad_delegation_sig`.
  `Authority.analyze/2` and `Lattice.Verdict` must not raise on that log, including
  when a valid same-id introduction coexists with the malformed genesis, and when
  a bounded continuation carries the list-shaped field.
  """
  use ExUnit.Case, async: true

  alias Lattice.{Authority, Identity, Log, Op, Sim, Verdict}
  alias Lattice.Authority.Delegation
  alias Lattice.Demo.Thread
  alias Treehouse.ContinuationFixtures, as: Continuation

  @replica "replica:malformed-delegation"
  @module Thread

  defp issuer, do: Identity.from_seed("issuer", "malformed:issuer")
  defp audience, do: Identity.from_seed("audience", "malformed:audience")

  test "valid_sig? is false when ops is the signed names as a list" do
    d = Delegation.new(issuer(), @replica, audience().pub, ops: [:post])
    assert Delegation.valid_sig?(d)
    refute Delegation.valid_sig?(%{d | ops: [:post]})
  end

  test "valid_sig? is false when roles is the signed names as a list" do
    d = Delegation.new(issuer(), @replica, audience().pub, roles: [:moderator])
    assert Delegation.valid_sig?(d)
    refute Delegation.valid_sig?(%{d | roles: [:moderator]})
  end

  test "valid_sig? is false when roles is a MapSet with unusable :sets v1 backing" do
    d = Delegation.new(issuer(), @replica, audience().pub, roles: [:moderator])
    malformed = %{d | roles: unusable_mapset([:moderator])}
    assert MapSet.to_list(malformed.roles) == [:moderator]
    assert Delegation.valid_sig?(d)
    refute Delegation.valid_sig?(malformed)
  end

  test "attenuates? is false, not a raise, when the child's ops is a list" do
    parent = Delegation.new(issuer(), @replica, audience().pub, ops: [:post], live: true)

    child =
      Delegation.new(audience(), @replica, issuer().pub,
        ops: [:post],
        parent_id: parent.id
      )

    assert Delegation.attenuates?(child, parent)
    refute Delegation.attenuates?(%{child | ops: [:post]}, parent)
  end

  test "a grant whose ops is a list does not crash the judge" do
    {log, grant, post} = grant_log(ops: [:post], as_list: :ops, command: {:post, ["x"]})

    assert Op.valid?(grant)
    assert {:ok, _} = log |> Log.dump_bytes() |> Log.restore_verified_bytes()

    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[grant.id] == :bad_delegation_sig
    assert analysis.reasons[post.id] == :invalid_capability

    assert %{status: :invalid} = Verdict.delegation_status(@module, log, carried_id(grant))
  end

  test "a grant whose roles is a list does not crash the judge" do
    {log, grant, lock} =
      grant_log(ops: [:lock], roles: [:moderator], as_list: :roles, command: {:lock, []})

    assert Op.valid?(grant)

    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[grant.id] == :bad_delegation_sig
    assert analysis.reasons[lock.id] == :invalid_capability

    assert %{status: :invalid} = Verdict.delegation_status(@module, log, carried_id(grant))
  end

  test "a genesis whose roles MapSet has unusable :sets v1 backing does not crash the judge" do
    sim = Sim.new(@module, @replica, ["r0", "r1"], seed: "row-289-mapset-v1")
    {sim, _genesis} = Sim.create_replica(sim, "r0")
    log = Sim.log(sim, "r0")
    genesis = Enum.find(Log.topo_ops(log), &match?(%Op{body: {:genesis, _, _}}, &1))
    {:genesis, d, policies} = genesis.body
    malformed = %{d | roles: unusable_mapset(MapSet.to_list(d.roles))}
    rewritten = %{genesis | body: {:genesis, malformed, policies}}
    assert Op.valid?(rewritten)

    log = Log.from_ops(log.replica, Map.put(log.ops, genesis.id, rewritten))
    assert {:ok, _} = log |> Log.dump_bytes() |> Log.restore_verified_bytes()
    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[rewritten.id] == :bad_delegation_sig
    assert %{status: :invalid} = Verdict.delegation_status(@module, log, d.id)
  end

  test "a genesis whose roles is a list does not crash the judge" do
    sim = Sim.new(@module, @replica, ["r0", "r1"], seed: "row-289-genesis")
    {sim, _genesis} = Sim.create_replica(sim, "r0")
    log = Sim.log(sim, "r0")
    genesis = Enum.find(Log.topo_ops(log), &match?(%Op{body: {:genesis, _, _}}, &1))
    {:genesis, d, policies} = genesis.body
    rewritten = %{genesis | body: {:genesis, %{d | roles: MapSet.to_list(d.roles)}, policies}}
    assert Op.valid?(rewritten)

    log = Log.from_ops(log.replica, Map.put(log.ops, genesis.id, rewritten))
    analysis = Authority.analyze(@module, log)
    assert analysis.reasons[rewritten.id] == :bad_delegation_sig
    assert %{status: :invalid} = Verdict.delegation_status(@module, log, d.id)
  end

  test "a list-shaped empty genesis next to a valid same-id intro does not crash the judge" do
    for field <- [:ops, :roles] do
      {log, bad_pin, d} = same_id_empty_genesis_log(field)

      assert Op.valid?(bad_pin)
      assert {:ok, _} = log |> Log.dump_bytes() |> Log.restore_verified_bytes()

      analysis = Authority.analyze(@module, log)
      assert analysis.reasons[bad_pin.id] == :bad_delegation_sig

      assert %{status: :active} = Verdict.delegation_status(@module, log, d.id)
    end
  end

  test "a bounded continuation whose roles or ops is a list does not crash the judge" do
    for field <- [:ops, :roles] do
      {sim, _genesis} = Continuation.new(label: "row-289-#{field}")
      {sim, pin, profile} = Continuation.pin(sim)
      {sim, epoch} = Sim.beacon(sim, "founder", 0)
      sim = Sim.sync_all(sim)
      {sim, op} = Continuation.continue(sim, "nominee", pin, profile, epoch_basis: [epoch.id])
      {:succeed, role, d, proof} = op.body
      malformed = %{d | field => MapSet.to_list(Map.fetch!(d, field))}
      rewritten = %{op | body: {:succeed, role, malformed, proof}}
      assert Op.valid?(rewritten)

      log = Sim.log(sim, "nominee")
      log = Log.from_ops(log.replica, Map.put(log.ops, op.id, rewritten))
      assert {:ok, _} = log |> Log.dump_bytes() |> Log.restore_verified_bytes()

      analysis = Authority.analyze(sim.module, log)
      assert analysis.reasons[rewritten.id] in [:bad_delegation_sig, :unauthorized_continuation]
      assert %{status: :invalid} = Verdict.delegation_status(sim.module, log, d.id)
    end
  end

  defp grant_log(opts) do
    as_list = Keyword.fetch!(opts, :as_list)
    {cmd, args} = Keyword.fetch!(opts, :command)
    grant_opts = Keyword.take(opts, [:ops, :roles])

    sim = Sim.new(@module, @replica, ["r0", "r1"], seed: "row-289-#{as_list}")
    {sim, _genesis} = Sim.create_replica(sim, "r0")
    {_sim, good} = Sim.grant(sim, "r0", "r1", grant_opts)
    malformed = %{good | as_list => MapSet.to_list(Map.fetch!(good, as_list))}
    {sim, grant} = Sim.append(sim, "r0", :authority, {:grant, malformed})
    {sim, command} = Sim.command(Sim.sync_all(sim), "r1", cmd, args, cap: malformed.id)
    log = sim |> Sim.sync_all() |> Sim.log("r0")
    {log, grant, command}
  end

  defp carried_id(%Op{body: {:grant, %Delegation{id: id}}}), do: id

  defp unusable_mapset(elements) do
    v1 = :sets.from_list(elements, version: 1)
    {:set, n, slots, _maxn, a, b, c, t1, t2} = v1
    %MapSet{map: {:set, n, slots, 0, a, b, c, t1, t2}}
  end

  defp same_id_empty_genesis_log(field) do
    sim = Sim.new(@module, "#{@replica}-#{field}", ["r0", "r1"], seed: "row-289-coexist-#{field}")
    {sim, _genesis} = Sim.create_replica(sim, "r0")
    root = Sim.identity(sim, "r0")
    d = Delegation.genesis(root, sim.replica, ops: [], roles: [], live: false)
    {sim, pin} = Sim.append(sim, "r0", :authority, {:genesis, d, %{}})
    {sim, _grant} = Sim.append(sim, "r0", :authority, {:grant, d})
    malformed = %{d | field => []}
    bad_pin = %{pin | body: {:genesis, malformed, %{}}}
    log = sim |> Sim.sync_all() |> Sim.log("r0")
    {Log.from_ops(log.replica, Map.put(log.ops, pin.id, bad_pin)), bad_pin, d}
  end
end
